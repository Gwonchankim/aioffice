import {
  buildPlannerPrompt,
  decideReplanning,
  parsePlannerOutput,
  PlannerPromptDelimiterError,
  selectModel,
  validatePlan,
  type ModelSelectionCandidate,
  type PlannerOutputRejectionCode,
  type PlannerPrompt,
  type PlanningAttempt,
  type PlanValidationResult,
  type PlanValidatorAgent,
} from '@orion/orchestration';
import type {
  DataClassification,
  EventPayload,
  ModelSelection,
  OrchestrationPlanDocument,
  Plan,
  PlannerAgentDescriptor,
  PlannerRequest,
  PlanValidationIssue,
  Provider,
  ProviderModelState,
  ProviderPolicy,
  TaskStatus,
} from '@orion/contracts';

import type { PlanningRunRepository } from './repositories/planning-run-repository.js';

/** PLN-019: attempt 1 plus at most 2 replans. */
const MAX_PLANNING_ATTEMPTS = 3;
const MAX_STORED_ISSUES = 100;
const MAX_STORED_ISSUE_LENGTH = 1000;

export interface PlanningAdapterResponse {
  /** Raw, untrusted planner output; never parsed or repaired by the adapter. */
  readonly raw: unknown;
}

/**
 * Seam between the planning service and whatever produces planner output.
 *
 * The service never spawns a process, opens a socket, or calls a provider: it
 * only calls the injected adapter. `createFakePlanningAdapter` from
 * `@orion/test-fixtures` satisfies this interface.
 */
export interface PlanningAdapter {
  plan(request: PlannerRequest, prompt: PlannerPrompt): PlanningAdapterResponse;
}

/** Narrow write seam over `task_plans`; `ExecutionRepository` satisfies it. */
export interface PlanningPlanStore {
  createPlan(plan: Plan): void;
}

export interface PlanningPlannerProfile {
  readonly id: string;
  readonly provider: Provider;
  readonly model: string;
  readonly fallbackModels: readonly ModelSelectionCandidate[];
  /** Stored verbatim with every planning run of this cycle, then immutable. */
  readonly snapshot: unknown;
}

export interface PlanningTaskInput {
  readonly taskId: string;
  readonly title: string;
  readonly objective: string;
  readonly successCriteria: readonly string[];
  readonly tags: readonly string[];
  readonly maxDurationMinutes: number;
  readonly maxAgentRuns: number;
  readonly requestedAgentIds?: readonly string[];
}

export interface PlanningProjectPolicy {
  readonly classification: DataClassification;
  readonly providerPolicy: ProviderPolicy;
  readonly allowedAgentIds: readonly string[];
}

export interface PlanTaskInput {
  readonly task: PlanningTaskInput;
  readonly project: PlanningProjectPolicy;
  readonly plannerProfile: PlanningPlannerProfile;
  /** Roster handed to the planner inside the prompt. */
  readonly plannerAgents: readonly PlannerAgentDescriptor[];
  /** Roster the deterministic validator judges the returned plan against. */
  readonly validatorAgents: readonly PlanValidatorAgent[];
  readonly modelStates: readonly ProviderModelState[];
  readonly fableConfirmationValid?: boolean;
}

/** Planner output the service refuses, including the task-identity mismatch it checks itself. */
export type PlanningRejectionCode = PlannerOutputRejectionCode | 'TASK_ID_MISMATCH';

export type PlanningFailureReason =
  | 'CONTROLLED_EXECUTION_BLOCKED'
  | 'MODEL_SELECTION_FAILED'
  | 'RUN_LIMIT_REACHED'
  | 'PROMPT_REJECTED'
  | 'PLANNER_OUTPUT_REJECTED'
  | 'PLAN_VALIDATION_FAILED';

interface PlanningAttemptBase {
  readonly attempt: PlanningAttempt;
  readonly planningRunId: string;
}

export type PlanningAttemptOutcome =
  | (PlanningAttemptBase & { readonly outcome: 'accepted'; readonly planVersion: number })
  | (PlanningAttemptBase & {
      readonly outcome: 'output_rejected';
      readonly rejectionCode: PlanningRejectionCode;
      readonly outputIssues: readonly string[];
    })
  | (PlanningAttemptBase & {
      readonly outcome: 'validation_rejected';
      readonly planVersion: number;
      readonly issues: readonly PlanValidationIssue[];
    });

export interface PlanningPlanned {
  readonly outcome: 'planned';
  readonly taskId: string;
  readonly planVersion: number;
  readonly plan: OrchestrationPlanDocument;
  readonly modelSelection: ModelSelection;
  readonly attempts: readonly PlanningAttemptOutcome[];
}

export interface PlanningFailed {
  readonly outcome: 'failed';
  readonly taskId: string;
  readonly reason: PlanningFailureReason;
  readonly message: string;
  /** `null` only when planning stopped before a model could be selected. */
  readonly modelSelection: ModelSelection | null;
  /** Validation issues of the last attempt that reached the validator. */
  readonly issues: readonly PlanValidationIssue[];
  readonly attempts: readonly PlanningAttemptOutcome[];
  /** The task status this outcome calls for; the lifecycle owner performs it. */
  readonly recommendedTaskStatus: Extract<TaskStatus, 'failed' | 'limit_reached'>;
}

export type PlanningResult = PlanningPlanned | PlanningFailed;

export interface PlanningServiceDependencies {
  readonly planningRuns: PlanningRunRepository;
  readonly plans: PlanningPlanStore;
  readonly adapter: PlanningAdapter;
  readonly now?: () => Date;
}

/** `CODE at path: message`, bounded to what `storedPlanValidationSchema` accepts. */
function formatIssue(issue: PlanValidationIssue): string {
  return `${issue.code} at ${issue.path ?? 'plan'}: ${issue.message}`.slice(
    0,
    MAX_STORED_ISSUE_LENGTH,
  );
}

function storedValidation(validation: PlanValidationResult): Plan['validationJson'] {
  return {
    valid: validation.valid,
    issues: validation.issues.slice(0, MAX_STORED_ISSUES).map(formatIssue),
  };
}

/**
 * Orchestrates the planning cycle of ONE task (prompt §8.5, PLN-011..020,
 * DEC-013/DEC-020/DEC-021).
 *
 * Everything is injected: clock, planning adapter, agent rosters and live model
 * states. Nothing here spawns a process, reads the environment, or contacts a
 * provider. Planner output is untrusted throughout: it is strict-parsed, then
 * judged by the deterministic validator, and is never repaired.
 */
export class PlanningService {
  private readonly planningRuns: PlanningRunRepository;
  private readonly plans: PlanningPlanStore;
  private readonly adapter: PlanningAdapter;
  private readonly now: () => Date;

  public constructor(dependencies: PlanningServiceDependencies) {
    this.planningRuns = dependencies.planningRuns;
    this.plans = dependencies.plans;
    this.adapter = dependencies.adapter;
    this.now = dependencies.now ?? (() => new Date());
  }

  public planTask(input: PlanTaskInput): PlanningResult {
    const { task, project, plannerProfile } = input;

    const selection = selectModel({
      profile: {
        provider: plannerProfile.provider,
        model: plannerProfile.model,
        fallbackModels: plannerProfile.fallbackModels,
      },
      projectClassification: project.classification,
      providerPolicy: project.providerPolicy,
      modelStates: input.modelStates,
      isArca: plannerProfile.id === 'arca',
      ...(input.fableConfirmationValid === undefined
        ? {}
        : { fableConfirmationValid: input.fableConfirmationValid }),
    });

    // No eligible planner model: zero attempts, zero planning runs, nothing stored.
    if (!selection.ok) {
      return {
        outcome: 'failed',
        taskId: task.taskId,
        reason:
          selection.code === 'CONTROLLED_EXECUTION_BLOCKED'
            ? 'CONTROLLED_EXECUTION_BLOCKED'
            : 'MODEL_SELECTION_FAILED',
        message:
          selection.code === 'CONTROLLED_EXECUTION_BLOCKED'
            ? 'A controlled project classification blocks remote planning entirely.'
            : `No eligible model for planner profile "${plannerProfile.id}".`,
        modelSelection: null,
        issues: [],
        attempts: [],
        recommendedTaskStatus: 'failed',
      };
    }

    const model = selection.selection;
    const attempts: PlanningAttemptOutcome[] = [];
    let previousIssues: readonly PlanValidationIssue[] = [];

    for (let index = 0; index < MAX_PLANNING_ATTEMPTS; index += 1) {
      const attempt = (index + 1) as PlanningAttempt;
      const existingRunCount = this.planningRuns.totalRunCountForTask(task.taskId);

      // LIM-004: the attempt itself counts as a run, so refuse before inserting one.
      if (existingRunCount + 1 > task.maxAgentRuns) {
        return {
          outcome: 'failed',
          taskId: task.taskId,
          reason: 'RUN_LIMIT_REACHED',
          message: `Task "${task.taskId}" has no run budget left for planning attempt ${attempt} (${existingRunCount}/${task.maxAgentRuns}).`,
          modelSelection: model,
          issues: previousIssues,
          attempts,
          recommendedTaskStatus: 'limit_reached',
        };
      }

      const request = buildPlannerRequest(input, attempt, existingRunCount, previousIssues);

      let prompt: PlannerPrompt;
      try {
        prompt = buildPlannerPrompt(request);
      } catch (error) {
        if (error instanceof PlannerPromptDelimiterError) {
          return {
            outcome: 'failed',
            taskId: task.taskId,
            reason: 'PROMPT_REJECTED',
            message: error.message,
            modelSelection: model,
            issues: previousIssues,
            attempts,
            recommendedTaskStatus: 'failed',
          };
        }
        throw error;
      }

      const run = this.planningRuns.createRunning({
        taskId: task.taskId,
        attempt,
        provider: model.provider,
        model: model.model,
        profileSnapshot: plannerProfile.snapshot,
        fallbackReason: model.fallbackReasonCode,
        createdAt: this.now().toISOString(),
      });

      this.appendEvent(task.taskId, 'run.started', model.provider, {
        planningRunId: run.id,
        attempt,
        provider: model.provider,
        model: model.model,
        promptSha256: prompt.sha256,
        viaFallback: model.viaFallback,
      });

      if (model.viaFallback) {
        this.appendEvent(task.taskId, 'run.model_fallback', model.provider, {
          planningRunId: run.id,
          attempt,
          fromProvider: model.fromProvider,
          fromModel: model.fromModel,
          provider: model.provider,
          model: model.model,
          fallbackReasonCode: model.fallbackReasonCode,
        });
      }

      let response: PlanningAdapterResponse;
      try {
        response = this.adapter.plan(request, prompt);
      } catch (error) {
        // Never leave a running planning run behind, then surface the fault as-is.
        this.planningRuns.complete(run.id, { status: 'failed' });
        throw error;
      }

      const parsed = parsePlannerOutput(response.raw);
      if (!parsed.ok) {
        return this.rejectOutput(task.taskId, run.id, attempt, model, attempts, parsed.code, [
          ...parsed.issues,
        ]);
      }
      if (parsed.plan.taskId !== task.taskId) {
        return this.rejectOutput(
          task.taskId,
          run.id,
          attempt,
          model,
          attempts,
          'TASK_ID_MISMATCH',
          ['Planner output plans a different task than the one being planned.'],
        );
      }

      const validation = validatePlan({
        plan: parsed.plan,
        taskLimits: {
          maxAgentRuns: task.maxAgentRuns,
          // Includes the planning run just inserted (DEC-020 conservative accounting).
          existingRunCount: this.planningRuns.totalRunCountForTask(task.taskId),
        },
        taskTags: task.tags,
        agents: input.validatorAgents,
        modelStates: input.modelStates,
        project: {
          classification: project.classification,
          providerPolicy: project.providerPolicy,
        },
      });

      // Every attempt keeps its own plan version and its validation record, valid or not.
      const planVersion = this.planningRuns.nextPlanVersion(task.taskId);
      this.plans.createPlan({
        taskId: task.taskId,
        version: planVersion,
        planJson: parsed.plan,
        validationJson: storedValidation(validation),
        createdAt: this.now().toISOString(),
      });

      const decision = decideReplanning(attempt, validation);
      if (decision.action === 'accept') {
        this.planningRuns.complete(run.id, { status: 'succeeded' });
        this.appendEvent(task.taskId, 'run.completed', model.provider, {
          planningRunId: run.id,
          attempt,
          planVersion,
          stepCount: parsed.plan.steps.length,
        });
        attempts.push({ attempt, planningRunId: run.id, outcome: 'accepted', planVersion });
        return {
          outcome: 'planned',
          taskId: task.taskId,
          planVersion,
          plan: parsed.plan,
          modelSelection: model,
          attempts,
        };
      }

      this.planningRuns.complete(run.id, { status: 'failed' });
      this.appendEvent(task.taskId, 'run.failed', model.provider, {
        planningRunId: run.id,
        attempt,
        rejection: 'validation_rejected',
        planVersion,
        issueCodes: validation.issues.slice(0, MAX_STORED_ISSUES).map((issue) => issue.code),
      });
      attempts.push({
        attempt,
        planningRunId: run.id,
        outcome: 'validation_rejected',
        planVersion,
        issues: validation.issues,
      });

      if (decision.action === 'fail') {
        return {
          outcome: 'failed',
          taskId: task.taskId,
          reason: 'PLAN_VALIDATION_FAILED',
          message: `Planning attempt ${attempt} of ${MAX_PLANNING_ATTEMPTS} produced an invalid plan; the replan budget is exhausted.`,
          modelSelection: model,
          issues: decision.issues,
          attempts,
          recommendedTaskStatus: 'failed',
        };
      }

      previousIssues = decision.issues;
    }

    /* c8 ignore next 11 -- decideReplanning returns `fail` on attempt 3, so the loop always returns. */
    return {
      outcome: 'failed',
      taskId: task.taskId,
      reason: 'PLAN_VALIDATION_FAILED',
      message: 'The planning attempt ceiling was reached without an accepted plan.',
      modelSelection: model,
      issues: previousIssues,
      attempts,
      recommendedTaskStatus: 'failed',
    };
  }

  /**
   * Closes the attempt whose output never became a plan document.
   *
   * A rejected output carries no `PlanValidationIssue`, and
   * `plannerRequestSchema` refuses a replan request without the validation
   * issues it must fix, so the cycle stops here rather than sending the planner
   * a replan whose stated reasons would not describe the actual failure.
   */
  private rejectOutput(
    taskId: string,
    planningRunId: string,
    attempt: PlanningAttempt,
    model: ModelSelection,
    attempts: PlanningAttemptOutcome[],
    rejectionCode: PlanningRejectionCode,
    outputIssues: readonly string[],
  ): PlanningFailed {
    this.planningRuns.complete(planningRunId, { status: 'failed' });
    this.appendEvent(taskId, 'run.failed', model.provider, {
      planningRunId,
      attempt,
      rejection: 'output_rejected',
      rejectionCode,
    });
    attempts.push({
      attempt,
      planningRunId,
      outcome: 'output_rejected',
      rejectionCode,
      outputIssues,
    });
    return {
      outcome: 'failed',
      taskId,
      reason: 'PLANNER_OUTPUT_REJECTED',
      message: `Planning attempt ${attempt} produced output the strict planner contract rejected (${rejectionCode}).`,
      modelSelection: model,
      issues: [],
      attempts,
      recommendedTaskStatus: 'failed',
    };
  }

  /** DEC-013: planning events are task-level events with no run id and no run sequence. */
  private appendEvent(
    taskId: string,
    type: 'run.started' | 'run.completed' | 'run.failed' | 'run.model_fallback',
    provider: Provider,
    payload: EventPayload,
  ): void {
    this.planningRuns.appendPlanningEvent(taskId, {
      type,
      provider,
      payload,
      timestamp: this.now().toISOString(),
    });
  }
}

function buildPlannerRequest(
  input: PlanTaskInput,
  attempt: PlanningAttempt,
  existingRunCount: number,
  previousIssues: readonly PlanValidationIssue[],
): PlannerRequest {
  const { task, project } = input;
  return {
    attempt,
    task: {
      taskId: task.taskId,
      title: task.title,
      objective: task.objective,
      successCriteria: [...task.successCriteria],
      tags: [...task.tags],
      maxDurationMinutes: task.maxDurationMinutes,
      maxAgentRuns: task.maxAgentRuns,
      ...(task.requestedAgentIds === undefined
        ? {}
        : { requestedAgentIds: [...task.requestedAgentIds] }),
    },
    project: {
      classification: project.classification,
      providerPolicy: project.providerPolicy,
      allowedAgentIds: [...project.allowedAgentIds],
    },
    agents: [...input.plannerAgents],
    limits: {
      maxAgentRuns: task.maxAgentRuns,
      existingRunCount,
      remainingRuns: Math.max(0, task.maxAgentRuns - existingRunCount),
    },
    previousIssues: previousIssues.slice(0, MAX_STORED_ISSUES).map((issue) => ({ ...issue })),
  };
}
