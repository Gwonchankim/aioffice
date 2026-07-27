import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ulid } from 'ulid';

import type { PlannerPrompt } from '@orion/orchestration';
import { plannerPromptDelimiterToken } from '@orion/orchestration';
import type {
  DataClassification,
  PlannerRequest,
  ProviderModelState,
  ProviderPolicy,
} from '@orion/contracts';
import {
  createFakePlanningAdapter,
  fakePlannerAgentDescriptors,
  fakePlanningRoster,
  fakePlanningTaskId,
  type FakePlanningScript,
} from '@orion/test-fixtures';

import { createDatabase } from '../src/database.js';
import { applyMigrations } from '../src/migrations.js';
import { ApplicationError } from '../src/errors.js';
import { ProjectRepository } from '../src/repositories/project-repository.js';
import { ExecutionRepository } from '../src/repositories/execution-repository.js';
import { PlanningRunRepository } from '../src/repositories/planning-run-repository.js';
import {
  PlanningService,
  type PlanningAdapter,
  type PlanningPlannerProfile,
  type PlanTaskInput,
} from '../src/planning-service.js';

const iso = '2026-07-27T00:00:00.000Z';

const cleanup: string[] = [];
const handles: Array<{ close: () => void }> = [];
afterEach(() => {
  handles.splice(0).forEach((handle) => handle.close());
  cleanup.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});

const MODEL_STATES: readonly ProviderModelState[] = [
  { provider: 'openai', model: 'gpt-5.6-sol', status: 'available' },
  { provider: 'openai', model: 'gpt-5.6-terra', status: 'available' },
  { provider: 'anthropic', model: 'claude-sonnet-5', status: 'available' },
  { provider: 'anthropic', model: 'claude-opus-5', status: 'available' },
];

const PROVIDER_POLICY: ProviderPolicy = { openai: true, anthropic: true, allowFable: false };

const PLANNER_SNAPSHOT = {
  id: 'orion',
  version: 2,
  permissionTemplate: 'orchestrator',
  soulSha256: 'c'.repeat(64),
};

const PLANNER_PROFILE: PlanningPlannerProfile = {
  id: 'orion',
  provider: 'openai',
  model: 'gpt-5.6-sol',
  fallbackModels: [],
  snapshot: PLANNER_SNAPSHOT,
};

/** Primary model is deliberately distinct from every roster model, so only the planner falls back. */
const FALLBACK_PLANNER_PROFILE: PlanningPlannerProfile = {
  id: 'orion',
  provider: 'anthropic',
  model: 'claude-opus-5',
  fallbackModels: [{ provider: 'anthropic', model: 'claude-sonnet-5' }],
  snapshot: PLANNER_SNAPSHOT,
};

interface RecordingAdapter extends PlanningAdapter {
  readonly requests: PlannerRequest[];
  readonly prompts: PlannerPrompt[];
}

function recordingAdapter(script: FakePlanningScript): RecordingAdapter {
  const fake = createFakePlanningAdapter(script);
  const requests: PlannerRequest[] = [];
  const prompts: PlannerPrompt[] = [];
  return {
    requests,
    prompts,
    plan(request: PlannerRequest, prompt: PlannerPrompt) {
      requests.push(request);
      prompts.push(prompt);
      return fake.plan(request);
    },
  };
}

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'orion-m3-planning-service-'));
  cleanup.push(directory);
  const handle = createDatabase(join(directory, 'orion.db'));
  handles.push(handle);
  applyMigrations(handle.database);
  const database = handle.database;
  const projectId = ulid();
  new ProjectRepository(database, () => new Date(iso)).insert({
    id: projectId,
    projectKey: 'planning-service-project',
    name: 'Planning service',
    repositoryPath: 'C:\\projects\\planning-service',
    defaultBranch: 'main',
    classification: 'internal',
    providerPolicy: PROVIDER_POLICY,
    allowedAgentIds: ['atlas'],
    allowedCommands: {
      read: [['git', 'status']],
      verify: [['pnpm', 'test']],
      localWrite: [['git', 'add']],
    },
    createdAt: iso,
    updatedAt: iso,
    unregisteredAt: null,
  });
  return { database, projectId };
}

function seedTask(
  database: ReturnType<typeof setup>['database'],
  projectId: string,
  options: { taskId?: string; maxAgentRuns?: number } = {},
): string {
  const taskId = options.taskId ?? fakePlanningTaskId;
  database
    .prepare(
      `INSERT INTO tasks (id, project_id, title, objective, success_criteria_json, input_artifact_ids_json,
       max_duration_minutes, max_agent_runs, requested_agent_ids_json, status, created_at, updated_at, completed_at)
       VALUES (?, ?, 'task', 'objective', '[]', '[]', 60, ?, '[]', 'planning', ?, ?, NULL)`,
    )
    .run(taskId, projectId, options.maxAgentRuns ?? 60, iso, iso);
  return taskId;
}

function planningRuns(database: ReturnType<typeof setup>['database']): PlanningRunRepository {
  return new PlanningRunRepository(database, () => new Date(iso));
}

function service(
  database: ReturnType<typeof setup>['database'],
  adapter: PlanningAdapter,
): PlanningService {
  return new PlanningService({
    planningRuns: planningRuns(database),
    plans: new ExecutionRepository(database, () => new Date(iso)),
    adapter,
    now: () => new Date(iso),
  });
}

function planInput(
  taskId: string,
  overrides: {
    maxAgentRuns?: number;
    tags?: readonly string[];
    title?: string;
    classification?: DataClassification;
    plannerProfile?: PlanningPlannerProfile;
    modelStates?: readonly ProviderModelState[];
  } = {},
): PlanTaskInput {
  return {
    task: {
      taskId,
      title: overrides.title ?? 'Fixture planning task',
      objective: 'Produce a deterministic fixture plan for the planning service test suite.',
      successCriteria: ['The plan passes the deterministic server validator.'],
      tags: overrides.tags ?? [],
      maxDurationMinutes: 60,
      maxAgentRuns: overrides.maxAgentRuns ?? 60,
    },
    project: {
      classification: overrides.classification ?? 'internal',
      providerPolicy: PROVIDER_POLICY,
      allowedAgentIds: fakePlannerAgentDescriptors.map((agent) => agent.id),
    },
    plannerProfile: overrides.plannerProfile ?? PLANNER_PROFILE,
    plannerAgents: fakePlannerAgentDescriptors,
    validatorAgents: fakePlanningRoster,
    modelStates: overrides.modelStates ?? MODEL_STATES,
  };
}

interface EventRow {
  readonly type: string;
  readonly provider: string | null;
  readonly run_id: string | null;
  readonly run_sequence: number | null;
  readonly task_sequence: number;
  readonly payload_json: string;
}

function events(
  database: ReturnType<typeof setup>['database'],
  taskId: string,
): readonly EventRow[] {
  return database
    .prepare(
      `SELECT type, provider, run_id, run_sequence, task_sequence, payload_json FROM events
       WHERE task_id = ? ORDER BY task_sequence`,
    )
    .all(taskId) as unknown as EventRow[];
}

interface PlanRow {
  readonly version: number;
  readonly plan_json: string;
  readonly validation_json: string;
}

function plans(database: ReturnType<typeof setup>['database'], taskId: string): readonly PlanRow[] {
  return database
    .prepare(
      'SELECT version, plan_json, validation_json FROM task_plans WHERE task_id = ? ORDER BY version',
    )
    .all(taskId) as unknown as PlanRow[];
}

describe('M3 S4B planning service', () => {
  it('plans a task from fake planner output and records exactly one planning run', () => {
    const { database, projectId } = setup();
    const taskId = seedTask(database, projectId);
    const adapter = recordingAdapter('valid');

    const result = service(database, adapter).planTask(planInput(taskId));

    expect(result.outcome).toBe('planned');
    if (result.outcome !== 'planned') {
      return;
    }
    expect(result.planVersion).toBe(1);
    expect(result.plan.taskId).toBe(taskId);
    expect(result.modelSelection).toMatchObject({
      provider: 'openai',
      model: 'gpt-5.6-sol',
      viaFallback: false,
      fallbackReasonCode: null,
    });
    expect(result.attempts).toEqual([
      { attempt: 1, planningRunId: expect.any(String), outcome: 'accepted', planVersion: 1 },
    ]);

    const runs = planningRuns(database).listForTask(taskId);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ attempt: 1, status: 'succeeded', fallbackReason: null });

    const storedPlans = plans(database, taskId);
    expect(storedPlans).toHaveLength(1);
    expect(JSON.parse(storedPlans[0]!.validation_json)).toEqual({ valid: true, issues: [] });

    // Planning alone never starts execution: no steps and no agent runs exist yet.
    expect(database.prepare('SELECT COUNT(*) AS count FROM task_steps').get()).toMatchObject({
      count: 0,
    });
    expect(database.prepare('SELECT COUNT(*) AS count FROM runs').get()).toMatchObject({
      count: 0,
    });
    expect(adapter.requests).toHaveLength(1);
    expect(adapter.requests[0]).toMatchObject({ attempt: 1, previousIssues: [] });
    expect(adapter.prompts[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('emits ordered task-level planning events that carry no run identity', () => {
    const { database, projectId } = setup();
    const taskId = seedTask(database, projectId);

    service(database, recordingAdapter('valid')).planTask(planInput(taskId));

    const rows = events(database, taskId);
    expect(rows.map((row) => row.type)).toEqual(['run.started', 'run.completed']);
    expect(rows.map((row) => row.task_sequence)).toEqual([1, 2]);
    for (const row of rows) {
      expect(row.run_id).toBeNull();
      expect(row.run_sequence).toBeNull();
      expect(row.provider).toBe('openai');
    }
    const started = JSON.parse(rows[0]!.payload_json) as Record<string, unknown>;
    expect(started).toMatchObject({ attempt: 1, provider: 'openai', model: 'gpt-5.6-sol' });
    expect(started['promptSha256']).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ['malformedJson', 'MALFORMED_JSON'],
    ['emptyOutput', 'EMPTY_OUTPUT'],
    ['notAnObject', 'NOT_AN_OBJECT'],
    ['schemaInvalid', 'SCHEMA_INVALID'],
  ] as const)('rejects %s planner output without repairing it', (scenario, rejectionCode) => {
    const { database, projectId } = setup();
    const taskId = seedTask(database, projectId);
    const adapter = recordingAdapter(scenario);

    const result = service(database, adapter).planTask(planInput(taskId));

    expect(result).toMatchObject({
      outcome: 'failed',
      reason: 'PLANNER_OUTPUT_REJECTED',
      recommendedTaskStatus: 'failed',
    });
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]).toMatchObject({ outcome: 'output_rejected', rejectionCode });

    // Rejected output never becomes a plan, and the cycle stops instead of replanning.
    expect(plans(database, taskId)).toHaveLength(0);
    expect(adapter.requests).toHaveLength(1);
    const runs = planningRuns(database).listForTask(taskId);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'failed' });

    const failed = events(database, taskId).find((row) => row.type === 'run.failed');
    expect(failed).toBeDefined();
    const payload = JSON.parse(failed!.payload_json) as Record<string, unknown>;
    expect(payload).toMatchObject({ rejection: 'output_rejected', rejectionCode });
    // The raw planner output is never persisted into the event payload.
    expect(failed!.payload_json).not.toContain('unexpectedField');
    expect(failed!.payload_json).not.toContain('finalSynthesisStepId');
  });

  it('refuses planner output that plans a different task', () => {
    const { database, projectId } = setup();
    const taskId = seedTask(database, projectId, { taskId: ulid() });
    const adapter = recordingAdapter('valid');

    const result = service(database, adapter).planTask(planInput(taskId));

    expect(result).toMatchObject({ outcome: 'failed', reason: 'PLANNER_OUTPUT_REJECTED' });
    expect(result.attempts[0]).toMatchObject({
      outcome: 'output_rejected',
      rejectionCode: 'TASK_ID_MISMATCH',
    });
    expect(plans(database, taskId)).toHaveLength(0);
    expect(planningRuns(database).listForTask(taskId)[0]).toMatchObject({ status: 'failed' });
  });

  it('replans after a validation failure and keeps every plan version and validation record', () => {
    const { database, projectId } = setup();
    const taskId = seedTask(database, projectId);
    const adapter = recordingAdapter(['dagCycle', 'valid']);

    const result = service(database, adapter).planTask(planInput(taskId));

    expect(result.outcome).toBe('planned');
    if (result.outcome !== 'planned') {
      return;
    }
    expect(result.planVersion).toBe(2);
    expect(result.attempts.map((attempt) => attempt.outcome)).toEqual([
      'validation_rejected',
      'accepted',
    ]);

    const storedPlans = plans(database, taskId);
    expect(storedPlans.map((plan) => plan.version)).toEqual([1, 2]);
    const firstValidation = JSON.parse(storedPlans[0]!.validation_json) as {
      valid: boolean;
      issues: string[];
    };
    expect(firstValidation.valid).toBe(false);
    expect(firstValidation.issues.some((entry) => entry.startsWith('DAG_CYCLE at '))).toBe(true);
    expect(JSON.parse(storedPlans[1]!.validation_json)).toEqual({ valid: true, issues: [] });

    const runs = planningRuns(database).listForTask(taskId);
    expect(runs.map((run) => [run.attempt, run.status])).toEqual([
      [1, 'failed'],
      [2, 'succeeded'],
    ]);

    // The replan request must carry the issues it has to fix.
    expect(adapter.requests).toHaveLength(2);
    expect(adapter.requests[1]?.attempt).toBe(2);
    expect(adapter.requests[1]?.previousIssues.map((issue) => issue.code)).toContain('DAG_CYCLE');
    expect(events(database, taskId).map((row) => row.type)).toEqual([
      'run.started',
      'run.failed',
      'run.started',
      'run.completed',
    ]);
  });

  it('fails the task after the third invalid plan and never starts a fourth attempt', () => {
    const { database, projectId } = setup();
    const taskId = seedTask(database, projectId);
    const adapter = recordingAdapter(['dagCycle', 'dagCycle', 'dagCycle']);

    const result = service(database, adapter).planTask(planInput(taskId));

    expect(result).toMatchObject({
      outcome: 'failed',
      reason: 'PLAN_VALIDATION_FAILED',
      recommendedTaskStatus: 'failed',
    });
    expect(result.attempts).toHaveLength(3);
    expect(adapter.requests.map((request) => request.attempt)).toEqual([1, 2, 3]);

    const runs = planningRuns(database).listForTask(taskId);
    expect(runs.map((run) => [run.attempt, run.status])).toEqual([
      [1, 'failed'],
      [2, 'failed'],
      [3, 'failed'],
    ]);
    expect(plans(database, taskId).map((plan) => plan.version)).toEqual([1, 2, 3]);
    for (const plan of plans(database, taskId)) {
      expect(JSON.parse(plan.validation_json)).toMatchObject({ valid: false });
    }
    if (result.outcome === 'failed') {
      expect(result.issues.map((issue) => issue.code)).toContain('DAG_CYCLE');
    }
  });

  it('stops before inserting a planning run when the task run budget is exhausted', () => {
    const { database, projectId } = setup();
    const taskId = seedTask(database, projectId, { maxAgentRuns: 1 });
    const runs = planningRuns(database);
    const spent = runs.createRunning({
      taskId,
      attempt: 1,
      provider: 'openai',
      model: 'gpt-5.6-sol',
      profileSnapshot: PLANNER_SNAPSHOT,
      createdAt: iso,
    });
    runs.complete(spent.id, { status: 'failed', completedAt: iso });
    const adapter = recordingAdapter('valid');

    const result = service(database, adapter).planTask(planInput(taskId, { maxAgentRuns: 1 }));

    expect(result).toMatchObject({
      outcome: 'failed',
      reason: 'RUN_LIMIT_REACHED',
      recommendedTaskStatus: 'limit_reached',
    });
    expect(adapter.requests).toHaveLength(0);
    expect(runs.countForTask(taskId)).toBe(1);
    expect(plans(database, taskId)).toHaveLength(0);
  });

  it('counts earlier planning runs against the next planning cycle budget', () => {
    const { database, projectId } = setup();
    const taskId = seedTask(database, projectId);

    service(database, recordingAdapter('valid')).planTask(planInput(taskId));
    const second = recordingAdapter('valid');
    service(database, second).planTask(planInput(taskId));

    // The first cycle's planning run is already counted when the second cycle starts.
    expect(second.requests[0]?.limits).toMatchObject({
      maxAgentRuns: 60,
      existingRunCount: 1,
      remainingRuns: 59,
    });
    expect(planningRuns(database).totalRunCountForTask(taskId)).toBe(2);
  });

  it('spawns no planning run when no planner model is eligible', () => {
    const { database, projectId } = setup();
    const taskId = seedTask(database, projectId);
    const adapter = recordingAdapter('valid');

    const result = service(database, adapter).planTask(
      planInput(taskId, {
        plannerProfile: {
          ...PLANNER_PROFILE,
          provider: 'anthropic',
          model: 'claude-opus-5',
          fallbackModels: [],
        },
        modelStates: [
          { provider: 'anthropic', model: 'claude-opus-5', status: 'unavailable' },
          ...MODEL_STATES.filter((state) => state.model !== 'claude-opus-5'),
        ],
      }),
    );

    expect(result).toMatchObject({
      outcome: 'failed',
      reason: 'MODEL_SELECTION_FAILED',
      modelSelection: null,
      recommendedTaskStatus: 'failed',
    });
    expect(result.attempts).toHaveLength(0);
    expect(adapter.requests).toHaveLength(0);
    expect(planningRuns(database).countForTask(taskId)).toBe(0);
    expect(events(database, taskId)).toHaveLength(0);
    expect(plans(database, taskId)).toHaveLength(0);
  });

  it('blocks remote planning entirely for a controlled project classification', () => {
    const { database, projectId } = setup();
    const taskId = seedTask(database, projectId);
    const adapter = recordingAdapter('valid');

    const result = service(database, adapter).planTask(
      planInput(taskId, { classification: 'controlled' }),
    );

    expect(result).toMatchObject({
      outcome: 'failed',
      reason: 'CONTROLLED_EXECUTION_BLOCKED',
      modelSelection: null,
    });
    expect(adapter.requests).toHaveLength(0);
    expect(planningRuns(database).countForTask(taskId)).toBe(0);
    expect(events(database, taskId)).toHaveLength(0);
  });

  it('records the fallback model and its reason on the planning run', () => {
    const { database, projectId } = setup();
    const taskId = seedTask(database, projectId);
    const adapter = recordingAdapter('valid');

    const result = service(database, adapter).planTask(
      planInput(taskId, {
        plannerProfile: FALLBACK_PLANNER_PROFILE,
        modelStates: [
          { provider: 'anthropic', model: 'claude-opus-5', status: 'unavailable' },
          ...MODEL_STATES.filter((state) => state.model !== 'claude-opus-5'),
        ],
      }),
    );

    expect(result.outcome).toBe('planned');
    expect(result.modelSelection).toMatchObject({
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      viaFallback: true,
      fallbackReasonCode: 'MODEL_UNAVAILABLE',
      fromProvider: 'anthropic',
      fromModel: 'claude-opus-5',
    });

    const runs = planningRuns(database).listForTask(taskId);
    expect(runs[0]).toMatchObject({
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      fallbackReason: 'MODEL_UNAVAILABLE',
      status: 'succeeded',
    });

    const rows = events(database, taskId);
    expect(rows.map((row) => row.type)).toEqual([
      'run.started',
      'run.model_fallback',
      'run.completed',
    ]);
    expect(JSON.parse(rows[1]!.payload_json)).toMatchObject({
      fromProvider: 'anthropic',
      fromModel: 'claude-opus-5',
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      fallbackReasonCode: 'MODEL_UNAVAILABLE',
    });
  });

  it('closes the running planning run when the adapter throws, then allows a new cycle', () => {
    const { database, projectId } = setup();
    const taskId = seedTask(database, projectId);
    const failure = new Error('adapter failure');
    const throwing: PlanningAdapter = {
      plan() {
        throw failure;
      },
    };

    expect(() => service(database, throwing).planTask(planInput(taskId))).toThrow(failure);

    const runs = planningRuns(database);
    expect(runs.findRunningForTask(taskId)).toBeUndefined();
    expect(runs.listForTask(taskId)).toHaveLength(1);
    expect(runs.listForTask(taskId)[0]).toMatchObject({ status: 'failed' });
    expect(plans(database, taskId)).toHaveLength(0);

    // No running row is left behind, so the next cycle is not blocked by the conflict guard.
    const result = service(database, recordingAdapter('valid')).planTask(planInput(taskId));
    expect(result.outcome).toBe('planned');
    expect(runs.listForTask(taskId).map((run) => run.status)).toEqual(['failed', 'succeeded']);
  });

  it('refuses to start a second concurrent planning cycle for the same task', () => {
    const { database, projectId } = setup();
    const taskId = seedTask(database, projectId);
    const runs = planningRuns(database);
    runs.createRunning({
      taskId,
      attempt: 1,
      provider: 'openai',
      model: 'gpt-5.6-sol',
      profileSnapshot: PLANNER_SNAPSHOT,
      createdAt: iso,
    });
    const adapter = recordingAdapter('valid');

    try {
      service(database, adapter).planTask(planInput(taskId));
      expect.unreachable('a concurrent planning cycle must be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(ApplicationError);
      expect((error as ApplicationError).code).toBe('TASK_EXECUTION_CONFLICT');
    }

    expect(adapter.requests).toHaveLength(0);
    expect(runs.countForTask(taskId)).toBe(1);
    expect(plans(database, taskId)).toHaveLength(0);
  });

  it('fails closed when task text forges the untrusted-data fence', () => {
    const { database, projectId } = setup();
    const taskId = seedTask(database, projectId);
    const adapter = recordingAdapter('valid');

    const result = service(database, adapter).planTask(
      planInput(taskId, { title: `forged ${plannerPromptDelimiterToken} fence` }),
    );

    expect(result).toMatchObject({ outcome: 'failed', reason: 'PROMPT_REJECTED' });
    expect(adapter.requests).toHaveLength(0);
    expect(planningRuns(database).countForTask(taskId)).toBe(0);
    expect(events(database, taskId)).toHaveLength(0);
  });

  it('keeps the planning run profile snapshot immutable across the cycle', () => {
    const { database, projectId } = setup();
    const taskId = seedTask(database, projectId);

    service(database, recordingAdapter(['dagCycle', 'valid'])).planTask(planInput(taskId));

    const runs = planningRuns(database).listForTask(taskId);
    const hashes = new Set(runs.map((run) => run.profileSnapshotSha256));
    expect(hashes.size).toBe(1);
    expect(() =>
      database
        .prepare("UPDATE planning_runs SET profile_snapshot_sha256 = 'x' WHERE id = ?")
        .run(runs[0]!.id),
    ).toThrow(/IMMUTABLE_PROFILE_SNAPSHOT/);
    expect(() =>
      database
        .prepare("UPDATE planning_runs SET status = 'running', completed_at = NULL WHERE id = ?")
        .run(runs[0]!.id),
    ).toThrow(/INVALID_STATE_TRANSITION/);
  });

  it('has no provider spawn path: planning reaches providers only through the injected adapter', () => {
    const sources = [
      '../src/planning-service.ts',
      '../src/repositories/planning-run-repository.ts',
    ];
    for (const relative of sources) {
      const source = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
      for (const forbidden of [
        'node:child_process',
        'child_process',
        'node:net',
        'node:http',
        'node:https',
        'node:worker_threads',
        'fetch(',
        'ORION_REAL_PROVIDER_TESTS',
        'process.env',
        'providers/',
      ]) {
        expect(source).not.toContain(forbidden);
      }
    }
    expect(process.env['ORION_REAL_PROVIDER_TESTS']).toBeUndefined();
  });
});
