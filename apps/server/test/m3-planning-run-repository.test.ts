import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { ulid } from 'ulid';

import { createDatabase } from '../src/database.js';
import { applyMigrations } from '../src/migrations.js';
import { ApplicationError } from '../src/errors.js';
import { ProjectRepository } from '../src/repositories/project-repository.js';
import {
  canonicalProfileConfigJson,
  sha256Hex,
} from '../src/repositories/agent-profile-repository.js';
import { PlanningRunRepository } from '../src/repositories/planning-run-repository.js';

const iso = '2026-07-27T00:00:00.000Z';
const later = '2026-07-27T00:05:00.000Z';

const cleanup: string[] = [];
const handles: Array<{ close: () => void }> = [];
afterEach(() => {
  handles.splice(0).forEach((handle) => handle.close());
  cleanup.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'orion-m3-planning-runs-'));
  cleanup.push(directory);
  const handle = createDatabase(join(directory, 'orion.db'));
  handles.push(handle);
  applyMigrations(handle.database);
  const projectId = ulid();
  new ProjectRepository(handle.database, () => new Date(iso)).insert({
    id: projectId,
    projectKey: 'planning-project',
    name: 'Planning',
    repositoryPath: 'C:\\projects\\planning',
    defaultBranch: 'main',
    classification: 'internal',
    providerPolicy: { openai: true, anthropic: true, allowFable: false },
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
  return { database: handle.database, projectId };
}

function seedTask(
  database: ReturnType<typeof setup>['database'],
  projectId: string,
  taskId = ulid(),
): string {
  database
    .prepare(
      `INSERT INTO tasks (id, project_id, title, objective, success_criteria_json, input_artifact_ids_json,
       max_duration_minutes, max_agent_runs, requested_agent_ids_json, status, created_at, updated_at, completed_at)
       VALUES (?, ?, 'task', 'objective', '[]', '[]', 60, 60, '[]', 'planning', ?, ?, NULL)`,
    )
    .run(taskId, projectId, iso, iso);
  return taskId;
}

/** Adds one `runs` row reached through a task step, so run accounting has both sources. */
function seedAgentRun(
  database: ReturnType<typeof setup>['database'],
  taskId: string,
  status = 'succeeded',
): void {
  const stepId = ulid();
  const runId = ulid();
  database
    .prepare(
      "INSERT INTO task_plans (task_id, version, plan_json, validation_json, created_at) VALUES (?, 1, '{}', '{}', ?)",
    )
    .run(taskId, iso);
  database
    .prepare(
      `INSERT INTO task_steps (id, task_id, plan_version, step_json, status, created_at, updated_at, completed_at)
       VALUES (?, ?, 1, '{}', 'ready', ?, ?, NULL)`,
    )
    .run(stepId, taskId, iso, iso);
  database
    .prepare(
      `INSERT INTO runs (id, step_id, attempt, provider, model, profile_snapshot_json, profile_snapshot_sha256,
       status, created_at, completed_at)
       VALUES (?, ?, 1, 'openai', 'gpt-5.6-sol', '{}', ?, ?, ?, ?)`,
    )
    .run(runId, stepId, 'a'.repeat(64), status, iso, iso);
}

function repository(database: ReturnType<typeof setup>['database']): PlanningRunRepository {
  return new PlanningRunRepository(database, () => new Date(iso));
}

const snapshot = {
  id: 'orion',
  version: 2,
  permissionTemplate: 'orchestrator',
  soulSha256: 'b'.repeat(64),
};

function insertRunning(
  runs: PlanningRunRepository,
  taskId: string,
  attempt: 1 | 2 | 3 = 1,
): ReturnType<PlanningRunRepository['createRunning']> {
  return runs.createRunning({
    taskId,
    attempt,
    provider: 'openai',
    model: 'gpt-5.6-sol',
    profileSnapshot: snapshot,
    createdAt: iso,
  });
}

describe('M3 S4B planning run repository', () => {
  it('canonicalizes and hashes the profile snapshot independently of key order', () => {
    const { database, projectId } = setup();
    const taskId = seedTask(database, projectId);
    const runs = repository(database);

    const first = insertRunning(runs, taskId);
    const stored = database
      .prepare(
        'SELECT profile_snapshot_json, profile_snapshot_sha256 FROM planning_runs WHERE id = ?',
      )
      .get(first.id) as { profile_snapshot_json: string; profile_snapshot_sha256: string };

    const canonical = canonicalProfileConfigJson(snapshot);
    expect(stored.profile_snapshot_json).toBe(canonical);
    expect(stored.profile_snapshot_sha256).toBe(sha256Hex(canonical));
    expect(first.profileSnapshotSha256).toBe(sha256Hex(canonical));

    runs.complete(first.id, { status: 'succeeded', completedAt: later });
    const reordered = runs.createRunning({
      taskId,
      attempt: 2,
      provider: 'openai',
      model: 'gpt-5.6-sol',
      profileSnapshot: {
        soulSha256: snapshot.soulSha256,
        permissionTemplate: snapshot.permissionTemplate,
        version: snapshot.version,
        id: snapshot.id,
      },
      createdAt: iso,
    });
    expect(reordered.profileSnapshotSha256).toBe(first.profileSnapshotSha256);
  });

  it('completes a running run exactly once and preserves fallback provenance', () => {
    const { database, projectId } = setup();
    const taskId = seedTask(database, projectId);
    const runs = repository(database);

    const run = runs.createRunning({
      taskId,
      attempt: 1,
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      profileSnapshot: snapshot,
      fallbackReason: 'MODEL_UNAVAILABLE',
      createdAt: iso,
    });
    expect(run.status).toBe('running');
    expect(run.completedAt).toBeNull();

    const completed = runs.complete(run.id, { status: 'succeeded', completedAt: later });
    expect(completed).toMatchObject({
      id: run.id,
      status: 'succeeded',
      completedAt: later,
      fallbackReason: 'MODEL_UNAVAILABLE',
    });

    const second = (): unknown => runs.complete(run.id, { status: 'failed', completedAt: later });
    expect(second).toThrow(ApplicationError);
    try {
      second();
    } catch (error) {
      expect(error).toBeInstanceOf(ApplicationError);
      expect((error as ApplicationError).code).toBe('INVALID_STATE_TRANSITION');
      expect((error as ApplicationError).statusCode).toBe(409);
    }
    expect(runs.findById(run.id)).toMatchObject({ status: 'succeeded' });
  });

  it('reports NOT_FOUND for an unknown planning run and an unknown task', () => {
    const { database, projectId } = setup();
    seedTask(database, projectId);
    const runs = repository(database);

    try {
      runs.complete(ulid(), { status: 'succeeded', completedAt: later });
      expect.unreachable('completing an unknown planning run must fail');
    } catch (error) {
      expect((error as ApplicationError).code).toBe('NOT_FOUND');
    }

    try {
      insertRunning(runs, ulid());
      expect.unreachable('a planning run for an unknown task must fail');
    } catch (error) {
      expect((error as ApplicationError).code).toBe('NOT_FOUND');
    }
    expect(runs.findById(ulid())).toBeUndefined();
  });

  it('keeps planning history append-only and the stored snapshot immutable', () => {
    const { database, projectId } = setup();
    const taskId = seedTask(database, projectId);
    const runs = repository(database);

    const first = insertRunning(runs, taskId, 1);
    runs.complete(first.id, { status: 'failed', completedAt: later });
    const second = insertRunning(runs, taskId, 2);
    runs.complete(second.id, { status: 'succeeded', completedAt: later });

    expect(runs.listForTask(taskId).map((run) => [run.attempt, run.status])).toEqual([
      [1, 'failed'],
      [2, 'succeeded'],
    ]);
    expect(() => database.prepare('DELETE FROM planning_runs WHERE id = ?').run(first.id)).toThrow(
      /PLANNING_RUNS_APPEND_ONLY/,
    );
    expect(() =>
      database
        .prepare("UPDATE planning_runs SET profile_snapshot_json = '{}' WHERE id = ?")
        .run(first.id),
    ).toThrow(/IMMUTABLE_PROFILE_SNAPSHOT/);
    expect(runs.listForTask(taskId)).toHaveLength(2);
    expect(runs.findById(first.id)?.profileSnapshotSha256).toBe(first.profileSnapshotSha256);
  });

  it('serializes planning attempts per task and surfaces the conflict as TASK_EXECUTION_CONFLICT', () => {
    const { database, projectId } = setup();
    const taskId = seedTask(database, projectId);
    const otherTaskId = seedTask(database, projectId);
    const runs = repository(database);

    const running = insertRunning(runs, taskId, 1);
    try {
      insertRunning(runs, taskId, 2);
      expect.unreachable('a second running planning run for the same task must be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(ApplicationError);
      expect((error as ApplicationError).code).toBe('TASK_EXECUTION_CONFLICT');
      expect((error as ApplicationError).statusCode).toBe(409);
      expect((error as ApplicationError).message).toContain(taskId);
    }
    expect(runs.countForTask(taskId)).toBe(1);
    expect(runs.findRunningForTask(taskId)?.id).toBe(running.id);

    // A different task is unaffected by the per-task serialization.
    expect(() => insertRunning(runs, otherTaskId, 1)).not.toThrow();
    expect(runs.findRunningForTask(otherTaskId)).toBeDefined();
  });

  it('closes stale running planning runs conservatively and never resumes them', () => {
    const { database, projectId } = setup();
    const taskId = seedTask(database, projectId);
    const otherTaskId = seedTask(database, projectId);
    const runs = repository(database);

    expect(runs.failStaleRunning()).toBe(0);

    const stale = insertRunning(runs, taskId, 1);
    const otherStale = insertRunning(runs, otherTaskId, 1);
    expect(runs.failStaleRunning()).toBe(2);

    for (const id of [stale.id, otherStale.id]) {
      expect(runs.findById(id)).toMatchObject({ status: 'failed', completedAt: iso });
    }
    expect(runs.findRunningForTask(taskId)).toBeUndefined();
    // Fail-closed: a recovered run cannot be revived, and it still consumes budget.
    try {
      runs.complete(stale.id, { status: 'succeeded', completedAt: later });
      expect.unreachable('a recovered planning run must not be completable');
    } catch (error) {
      expect((error as ApplicationError).code).toBe('INVALID_STATE_TRANSITION');
    }
    expect(runs.countForTask(taskId)).toBe(1);
    expect(runs.failStaleRunning()).toBe(0);
  });

  it('counts agent runs and planning runs together, including running planning runs', () => {
    const { database, projectId } = setup();
    const taskId = seedTask(database, projectId);
    const otherTaskId = seedTask(database, projectId);
    const runs = repository(database);

    expect(runs.totalRunCountForTask(taskId)).toBe(0);
    seedAgentRun(database, taskId);
    expect(runs.totalRunCountForTask(taskId)).toBe(1);

    const first = insertRunning(runs, taskId, 1);
    expect(runs.totalRunCountForTask(taskId)).toBe(2);
    runs.complete(first.id, { status: 'failed', completedAt: later });
    expect(runs.totalRunCountForTask(taskId)).toBe(2);
    insertRunning(runs, taskId, 2);
    expect(runs.totalRunCountForTask(taskId)).toBe(3);
    expect(runs.countForTask(taskId)).toBe(2);

    // Accounting is per task.
    expect(runs.totalRunCountForTask(otherTaskId)).toBe(0);
  });

  it('allocates plan versions monotonically and never reuses one', () => {
    const { database, projectId } = setup();
    const taskId = seedTask(database, projectId);
    const runs = repository(database);

    expect(runs.nextPlanVersion(taskId)).toBe(1);
    database
      .prepare(
        "INSERT INTO task_plans (task_id, version, plan_json, validation_json, created_at) VALUES (?, 1, '{}', '{}', ?)",
      )
      .run(taskId, iso);
    expect(runs.nextPlanVersion(taskId)).toBe(2);
    database
      .prepare(
        "INSERT INTO task_plans (task_id, version, plan_json, validation_json, created_at) VALUES (?, 2, '{}', '{}', ?)",
      )
      .run(taskId, iso);
    expect(runs.nextPlanVersion(taskId)).toBe(3);
  });

  it('appends planning events as task-level events with contiguous task sequences', () => {
    const { database, projectId } = setup();
    const taskId = seedTask(database, projectId);
    const runs = repository(database);
    const run = insertRunning(runs, taskId);

    const started = runs.appendPlanningEvent(taskId, {
      type: 'run.started',
      provider: 'openai',
      payload: { planningRunId: run.id, attempt: 1 },
      timestamp: iso,
    });
    const completed = runs.appendPlanningEvent(taskId, {
      type: 'run.completed',
      payload: { planningRunId: run.id, attempt: 1 },
      timestamp: later,
    });

    expect([started.taskSequence, completed.taskSequence]).toEqual([1, 2]);
    expect(started).toMatchObject({
      runId: null,
      runSequence: null,
      stepId: null,
      provider: 'openai',
    });
    // A planning event carries no run id, so it defaults to the system provider.
    expect(completed).toMatchObject({ runId: null, runSequence: null, provider: 'system' });

    const rows = database
      .prepare(
        'SELECT run_id, run_sequence, task_sequence FROM events WHERE task_id = ? ORDER BY task_sequence',
      )
      .all(taskId) as {
      run_id: string | null;
      run_sequence: number | null;
      task_sequence: number;
    }[];
    expect(rows).toEqual([
      { run_id: null, run_sequence: null, task_sequence: 1 },
      { run_id: null, run_sequence: null, task_sequence: 2 },
    ]);
    expect(() => database.prepare('DELETE FROM events WHERE id = ?').run(started.id)).toThrow(
      /EVENTS_APPEND_ONLY/,
    );
  });

  it('rejects an event payload that carries a forbidden field', () => {
    const { database, projectId } = setup();
    const taskId = seedTask(database, projectId);
    const runs = repository(database);

    expect(() =>
      runs.appendPlanningEvent(taskId, {
        type: 'run.failed',
        payload: { prompt: 'raw planner prompt' },
        timestamp: iso,
      }),
    ).toThrow();
    expect(
      database.prepare('SELECT COUNT(*) AS count FROM events WHERE task_id = ?').get(taskId),
    ).toMatchObject({ count: 0 });
  });

  it('refuses to hand out a corrupt planning run row', () => {
    const { database, projectId } = setup();
    const taskId = seedTask(database, projectId);
    const runs = repository(database);
    const runId = ulid();

    database
      .prepare(
        `INSERT INTO planning_runs (id, task_id, attempt, provider, model, profile_snapshot_json,
         profile_snapshot_sha256, status, fallback_reason, created_at, completed_at)
         VALUES (?, ?, 1, 'openai', 'gpt-5.6-sol', '{}', 'not-a-sha256', 'running', NULL, ?, NULL)`,
      )
      .run(runId, taskId, iso);

    expect(() => runs.findById(runId)).toThrow();
    expect(() => runs.listForTask(taskId)).toThrow();
    expect(runs.countForTask(taskId)).toBe(1);
  });
});
