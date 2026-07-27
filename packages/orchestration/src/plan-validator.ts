import type {
  DataClassification,
  OrchestrationPlanDocument,
  OrchestrationStep,
  PermissionTemplate,
  PlanValidationIssue,
  PlanValidationIssueCode,
  Provider,
  ProviderModelState,
  ProviderPolicy,
} from '@orion/contracts';

import { selectModel, type ModelSelectionCandidate } from './model-selection.js';

const MAX_UNIQUE_AGENTS = 12;
const QA_AGENT_IDS = new Set(['verify', 'sentinel']);
const PLANNING_AGENT_IDS = new Set(['nexus', 'archon']);

export interface PlanValidatorAgentPermissions {
  readonly artifactWriteAllowed: boolean;
  readonly worktreeWriteAllowed: boolean;
  readonly localCommitAllowed: boolean;
}

export interface PlanValidatorAgent {
  readonly id: string;
  readonly version: number;
  readonly enabled: boolean;
  readonly permissionTemplate: PermissionTemplate;
  readonly permissions: PlanValidatorAgentPermissions;
  readonly provider: Provider;
  readonly model: string;
  readonly fallbackModels: readonly ModelSelectionCandidate[];
}

export interface PlanValidatorTaskLimits {
  readonly maxAgentRuns: number;
  readonly existingRunCount: number;
}

export interface PlanValidatorProject {
  readonly classification: DataClassification;
  readonly providerPolicy: ProviderPolicy;
}

export interface PlanValidatorInput {
  readonly plan: OrchestrationPlanDocument;
  readonly taskLimits: PlanValidatorTaskLimits;
  readonly taskTags: readonly string[];
  readonly agents: readonly PlanValidatorAgent[];
  readonly modelStates: readonly ProviderModelState[];
  readonly project: PlanValidatorProject;
}

export interface PlanValidationResult {
  readonly valid: boolean;
  readonly issues: PlanValidationIssue[];
}

function issue(
  code: PlanValidationIssueCode,
  path: string | null,
  message: string,
): PlanValidationIssue {
  return { code, path, message };
}

/** Builds the transitive closure reachable from `start` via `adjacency` (excludes `start` itself). */
function transitiveClosure(
  start: string,
  adjacency: ReadonlyMap<string, readonly string[]>,
): Set<string> {
  const visited = new Set<string>();
  const queue = [...(adjacency.get(start) ?? [])];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);
    for (const next of adjacency.get(current) ?? []) {
      queue.push(next);
    }
  }
  return visited;
}

function detectCycleStepIds(
  ids: readonly string[],
  forward: ReadonlyMap<string, readonly string[]>,
): Set<string> {
  const color = new Map<string, 'white' | 'gray' | 'black'>(ids.map((id) => [id, 'white']));
  const cycleIds = new Set<string>();
  const stack: string[] = [];

  function visit(id: string): void {
    color.set(id, 'gray');
    stack.push(id);
    for (const dep of forward.get(id) ?? []) {
      const depColor = color.get(dep);
      if (depColor === 'gray') {
        const startIndex = stack.indexOf(dep);
        for (const cycleMember of stack.slice(startIndex)) {
          cycleIds.add(cycleMember);
        }
      } else if (depColor === 'white') {
        visit(dep);
      }
    }
    stack.pop();
    color.set(id, 'black');
  }

  for (const id of ids) {
    if (color.get(id) === 'white') {
      visit(id);
    }
  }
  return cycleIds;
}

/**
 * Pure, deterministic plan validator. Accumulates every contract violation
 * (does not short-circuit on the first failure) and returns the full issue
 * list alongside an overall `valid` flag.
 */
export function validatePlan(input: PlanValidatorInput): PlanValidationResult {
  const { plan, taskLimits, taskTags, agents, modelStates, project } = input;
  const steps = plan.steps;
  const issues: PlanValidationIssue[] = [];

  const idCounts = new Map<string, number>();
  for (const step of steps) {
    idCounts.set(step.id, (idCounts.get(step.id) ?? 0) + 1);
  }
  for (const [id, count] of idCounts) {
    if (count > 1) {
      issues.push(issue('DUPLICATE_STEP_ID', id, `Step id "${id}" is used ${count} times.`));
    }
  }

  const allIds = new Set(idCounts.keys());
  const stepById = new Map<string, OrchestrationStep>();
  for (const step of steps) {
    if (!stepById.has(step.id)) {
      stepById.set(step.id, step);
    }
  }

  for (const step of steps) {
    for (const dep of step.dependsOn) {
      if (!allIds.has(dep)) {
        issues.push(
          issue(
            'MISSING_DEPENDENCY',
            step.id,
            `Step "${step.id}" depends on unknown step "${dep}".`,
          ),
        );
      }
    }
  }

  const forward = new Map<string, readonly string[]>();
  const reverse = new Map<string, string[]>();
  for (const id of allIds) {
    reverse.set(id, []);
  }
  for (const id of allIds) {
    const step = stepById.get(id)!;
    const validDeps = step.dependsOn.filter((dep) => allIds.has(dep));
    forward.set(id, validDeps);
    for (const dep of validDeps) {
      reverse.get(dep)!.push(id);
    }
  }

  const idList = [...allIds];
  const cycleIds = detectCycleStepIds(idList, forward);
  for (const id of cycleIds) {
    issues.push(issue('DAG_CYCLE', id, `Step "${id}" participates in a dependency cycle.`));
  }

  const agentsById = new Map(agents.map((agent) => [agent.id, agent] as const));

  for (const step of steps) {
    const agent = agentsById.get(step.agentId);
    if (!agent) {
      issues.push(
        issue(
          'UNKNOWN_AGENT',
          step.id,
          `Step "${step.id}" references unknown agent "${step.agentId}".`,
        ),
      );
      continue;
    }
    if (!agent.enabled) {
      issues.push(
        issue(
          'DISABLED_AGENT',
          step.id,
          `Step "${step.id}" references disabled agent "${agent.id}".`,
        ),
      );
      continue;
    }

    switch (step.executionMode) {
      case 'read_only':
        break;
      case 'artifact_write':
        if (!agent.permissions.artifactWriteAllowed) {
          issues.push(
            issue(
              'EXECUTION_MODE_PERMISSION_MISMATCH',
              step.id,
              `Agent "${agent.id}" lacks artifact-write permission required by step "${step.id}".`,
            ),
          );
        }
        break;
      case 'worktree_write':
        if (!(agent.permissions.worktreeWriteAllowed && agent.permissions.localCommitAllowed)) {
          issues.push(
            issue(
              'EXECUTION_MODE_PERMISSION_MISMATCH',
              step.id,
              `Agent "${agent.id}" lacks worktree-write/local-commit permission required by step "${step.id}".`,
            ),
          );
        }
        break;
      case 'integration':
        if (agent.permissionTemplate !== 'integrator') {
          issues.push(
            issue(
              'EXECUTION_MODE_PERMISSION_MISMATCH',
              step.id,
              `Agent "${agent.id}" is not an integrator required by integration step "${step.id}".`,
            ),
          );
        }
        break;
      case 'external_action': {
        const hasApprovalRequest = step.expectedArtifacts.includes('approval-request');
        const hasNoVerificationCommands = step.verificationCommands.length === 0;
        if (!(hasApprovalRequest && hasNoVerificationCommands)) {
          issues.push(
            issue(
              'EXTERNAL_ACTION_WITHOUT_APPROVAL',
              step.id,
              `External action step "${step.id}" requires an "approval-request" artifact and zero verification commands.`,
            ),
          );
        }
        break;
      }
      default:
        break;
    }

    const modelResult = selectModel({
      profile: {
        provider: agent.provider,
        model: agent.model,
        fallbackModels: agent.fallbackModels,
      },
      projectClassification: project.classification,
      providerPolicy: project.providerPolicy,
      modelStates,
      isArca: agent.id === 'arca',
    });

    if (!modelResult.ok) {
      if (modelResult.code === 'CONTROLLED_EXECUTION_BLOCKED') {
        issues.push(
          issue(
            'CLASSIFICATION_TRANSFER_VIOLATION',
            step.id,
            `Step "${step.id}" cannot execute a remote model under a controlled project classification.`,
          ),
        );
      } else {
        const allPolicyBlocked =
          modelResult.reasons.length > 0 &&
          modelResult.reasons.every((reason) => reason.reason === 'CLASSIFICATION_POLICY_BLOCKED');
        issues.push(
          allPolicyBlocked
            ? issue(
                'PROVIDER_POLICY_VIOLATION',
                step.id,
                `No model candidate for agent "${agent.id}" clears the project provider policy.`,
              )
            : issue(
                'UNAVAILABLE_AGENT',
                step.id,
                `No available model candidate for agent "${agent.id}" on step "${step.id}".`,
              ),
        );
      }
    }
  }

  if (taskLimits.existingRunCount + steps.length > taskLimits.maxAgentRuns) {
    issues.push(
      issue(
        'RUN_LIMIT_EXCEEDED',
        null,
        `Plan would exceed the task run limit (${taskLimits.existingRunCount} + ${steps.length} > ${taskLimits.maxAgentRuns}).`,
      ),
    );
  }

  const finalStep = stepById.get(plan.finalSynthesisStepId);
  if (finalStep) {
    if (finalStep.agentId !== 'orion') {
      issues.push(
        issue(
          'FINAL_SYNTHESIS_MISSING',
          finalStep.id,
          `Final synthesis step "${finalStep.id}" must be assigned to agent "orion", got "${finalStep.agentId}".`,
        ),
      );
    }

    const finalAncestors = transitiveClosure(finalStep.id, forward);
    const missingAncestors = idList.filter((id) => id !== finalStep.id && !finalAncestors.has(id));
    if (missingAncestors.length > 0) {
      issues.push(
        issue(
          'FINAL_SYNTHESIS_INCOMPLETE_DEPENDENCIES',
          finalStep.id,
          `Final synthesis step "${finalStep.id}" is not a transitive descendant of: ${missingAncestors.join(', ')}.`,
        ),
      );
    }
  }

  for (const step of steps) {
    if (step.executionMode !== 'worktree_write') {
      continue;
    }
    const descendants = transitiveClosure(step.id, reverse);
    const hasQaDescendant = [...descendants].some((id) =>
      QA_AGENT_IDS.has(stepById.get(id)!.agentId),
    );
    if (!hasQaDescendant) {
      issues.push(
        issue(
          'BUILDER_WITHOUT_QA',
          step.id,
          `Worktree-write step "${step.id}" has no downstream verify/sentinel QA step.`,
        ),
      );
    }
  }

  const hasWorktreeWrite = steps.some((step) => step.executionMode === 'worktree_write');
  if (taskTags.includes('code') || hasWorktreeWrite) {
    const hasPlanningStep = steps.some((step) => PLANNING_AGENT_IDS.has(step.agentId));
    const hasBuilderStep = steps.some(
      (step) => agentsById.get(step.agentId)?.permissionTemplate === 'builder',
    );
    const hasQaStep = steps.some((step) => QA_AGENT_IDS.has(step.agentId));
    const hasArchonIntegrationStep = steps.some(
      (step) => step.agentId === 'archon' && step.executionMode === 'integration',
    );
    if (!(hasPlanningStep && hasBuilderStep && hasQaStep && hasArchonIntegrationStep)) {
      issues.push(
        issue(
          'CODE_WORKFLOW_INCOMPLETE',
          null,
          'Code workflow requires a planning step (nexus/archon), a builder step, a QA step (verify/sentinel), and an archon integration step.',
        ),
      );
    }
  }

  const hasAegis = steps.some((step) => step.agentId === 'aegis');
  const hasHelios = steps.some((step) => step.agentId === 'helios');
  const coatingTrigger = taskTags.includes('coating') || hasAegis !== hasHelios;
  if (coatingTrigger && !(hasAegis && hasHelios)) {
    issues.push(
      issue(
        'COATING_CROSS_REVIEW_MISSING',
        null,
        'Coating tasks require both aegis and helios cross-review steps.',
      ),
    );
  }

  if (taskTags.includes('regulatory') && !steps.some((step) => step.agentId === 'regula')) {
    issues.push(
      issue('REGULATORY_REVIEW_MISSING', null, 'Regulatory tasks require a regula review step.'),
    );
  }

  if (taskTags.includes('financial') && !steps.some((step) => step.agentId === 'ledger')) {
    issues.push(
      issue('FINANCIAL_REVIEW_MISSING', null, 'Financial tasks require a ledger review step.'),
    );
  }

  if (taskTags.includes('infrastructure')) {
    const hasKeystone = steps.some((step) => step.agentId === 'keystone');
    const hasSentinel = steps.some((step) => step.agentId === 'sentinel');
    if (!(hasKeystone && hasSentinel)) {
      issues.push(
        issue(
          'INFRASTRUCTURE_REVIEW_MISSING',
          null,
          'Infrastructure tasks require both keystone and sentinel review steps.',
        ),
      );
    }
  }

  const uniqueAgentCount = new Set(steps.map((step) => step.agentId)).size;
  if (uniqueAgentCount > MAX_UNIQUE_AGENTS) {
    issues.push(
      issue(
        'EXCESSIVE_AGENT_SELECTION',
        null,
        `Plan selects ${uniqueAgentCount} distinct agents, exceeding the limit of ${MAX_UNIQUE_AGENTS}.`,
      ),
    );
  }

  return { valid: issues.length === 0, issues };
}
