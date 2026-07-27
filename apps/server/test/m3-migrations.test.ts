import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { ulid } from 'ulid';

import { createDatabase } from '../src/database.js';
import { applyMigrations, loadMigrations } from '../src/migrations.js';
import { ProjectRepository } from '../src/repositories/project-repository.js';

const cleanup: string[] = [];
const handles: Array<{ close: () => void }> = [];
afterEach(() => {
  handles.splice(0).forEach((handle) => handle.close());
  cleanup.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});

const iso = '2026-07-21T00:00:00.000Z';

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'orion-m3-migrations-'));
  cleanup.push(directory);
  const handle = createDatabase(join(directory, 'orion.db'));
  handles.push(handle);
  return handle;
}

function commands() {
  return {
    read: [['git', 'status']] as string[][],
    verify: [['pnpm', 'test']] as string[][],
    localWrite: [['git', 'add']] as string[][],
  };
}

function project(id = ulid()) {
  return {
    id,
    projectKey: 'demo-project',
    name: 'Demo',
    repositoryPath: 'C:\\projects\\demo',
    defaultBranch: 'main',
    classification: 'internal' as const,
    providerPolicy: { openai: false, anthropic: false, allowFable: false },
    allowedAgentIds: ['atlas'],
    allowedCommands: commands(),
    createdAt: iso,
    updatedAt: iso,
    unregisteredAt: null,
  };
}
function insertTask(db: ReturnType<typeof setup>['database'], projectId: string, status: string) {
  const taskId = ulid();
  db.prepare(
    `INSERT INTO tasks (id, project_id, title, objective, success_criteria_json, input_artifact_ids_json, max_duration_minutes, max_agent_runs, requested_agent_ids_json, status, created_at, updated_at, completed_at)
    VALUES (?, ?, 'task', 'objective', '[]', '[]', 1, 1, '[]', ?, ?, ?, NULL)`,
  ).run(taskId, projectId, status, iso, iso);
  return { taskId };
}

function insertTaskAndStep(
  db: ReturnType<typeof setup>['database'],
  projectId: string,
  status: string,
) {
  const taskId = ulid();
  const stepId = ulid();
  db.prepare(
    `INSERT INTO tasks (id, project_id, title, objective, success_criteria_json, input_artifact_ids_json, max_duration_minutes, max_agent_runs, requested_agent_ids_json, status, created_at, updated_at, completed_at)
    VALUES (?, ?, 'task', 'objective', '[]', '[]', 1, 1, '[]', ?, ?, ?, NULL)`,
  ).run(taskId, projectId, status, iso, iso);
  db.prepare(
    "INSERT INTO task_plans (task_id, version, plan_json, validation_json, created_at) VALUES (?, 1, '{}', '{}', ?)",
  ).run(taskId, iso);
  db.prepare(
    "INSERT INTO task_steps (id, task_id, plan_version, step_json, status, created_at, updated_at, completed_at) VALUES (?, ?, 1, '{}', ?, ?, ?, NULL)",
  ).run(stepId, taskId, status, iso, iso);
  return { taskId, stepId };
}

describe('M3 migrations 0004/0005', () => {
  it('applies exactly 7 forward migrations and re-applies as a no-op', () => {
    const handle = setup();
    applyMigrations(handle.database);
    expect(
      handle.database.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get(),
    ).toMatchObject({ count: 7 });
    const before = handle.database
      .prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version')
      .all();
    expect(() => applyMigrations(handle.database)).not.toThrow();
    const after = handle.database
      .prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version')
      .all();
    expect(after).toEqual(before);
    expect(
      handle.database.prepare('SELECT COUNT(*) AS count FROM planning_runs').get(),
    ).toMatchObject({ count: 0 });
  });

  it('preserves v1 skeleton config_sha256 and config_json exactly across the 0004 rebuild', () => {
    const preM3Handle = setup();
    const preM3Migrations = loadMigrations().filter((migration) => migration.version <= 3);
    applyMigrations(preM3Handle.database, preM3Migrations);
    const preM3Rows = preM3Handle.database
      .prepare(
        'SELECT id, config_sha256, config_json, seed_order, enabled, execution_mode FROM agent_profiles WHERE version = 1 ORDER BY id',
      )
      .all();
    expect(preM3Rows).toHaveLength(18);

    const fullHandle = setup();
    applyMigrations(fullHandle.database);
    const fullRows = fullHandle.database
      .prepare(
        'SELECT id, config_sha256, config_json, seed_order, enabled, execution_mode FROM agent_profiles WHERE version = 1 ORDER BY id',
      )
      .all();
    expect(fullRows).toEqual(preM3Rows);
    expect(fullRows).toHaveLength(18);
    expect(
      fullHandle.database
        .prepare(
          "SELECT COUNT(*) AS count FROM agent_profiles WHERE version = 1 AND enabled = 0 AND execution_mode = 'skeleton'",
        )
        .get(),
    ).toMatchObject({ count: 18 });
  });

  it('rejects direct UPDATE and DELETE against agent_profiles rows', () => {
    const handle = setup();
    applyMigrations(handle.database);
    expect(() =>
      handle.database
        .prepare("UPDATE agent_profiles SET enabled = 1 WHERE id = 'atlas' AND version = 1")
        .run(),
    ).toThrow(/PROFILE_VERSIONS_APPEND_ONLY/);
    expect(() =>
      handle.database
        .prepare("DELETE FROM agent_profiles WHERE id = 'atlas' AND version = 1")
        .run(),
    ).toThrow(/PROFILE_VERSIONS_APPEND_ONLY/);
    expect(
      handle.database
        .prepare("SELECT enabled FROM agent_profiles WHERE id = 'atlas' AND version = 1")
        .get(),
    ).toMatchObject({ enabled: 0 });
  });

  it('rejects a new version row for an existing id whose seed_order disagrees with the canonical order', () => {
    const handle = setup();
    applyMigrations(handle.database);
    expect(() =>
      handle.database
        .prepare(
          `INSERT INTO agent_profiles (id, version, seed_order, config_sha256, config_json, enabled, execution_mode, created_at)
          VALUES ('atlas', 3, 99, ?, '{"id":"atlas"}', 1, 'full', ?)`,
        )
        .run('f'.repeat(64), iso),
    ).toThrow(/SEED_ORDER_MISMATCH/);
    expect(
      handle.database
        .prepare("SELECT COUNT(*) AS count FROM agent_profiles WHERE id = 'atlas' AND version = 3")
        .get(),
    ).toMatchObject({ count: 0 });
  });

  it('rejects a re-insert of an existing (id, version) whose content disagrees (SEED_CONFLICT)', () => {
    const handle = setup();
    applyMigrations(handle.database);
    expect(() =>
      handle.database
        .prepare(
          `INSERT INTO agent_profiles (id, version, seed_order, config_sha256, config_json, enabled, execution_mode, created_at)
          VALUES ('atlas', 1, 1, ?, '{"id":"atlas","mutated":true}', 0, 'skeleton', ?)`,
        )
        .run('f'.repeat(64), iso),
    ).toThrow(/SEED_CONFLICT/);
  });

  it('models the planning_runs lifecycle: single running run per task, forward-only transitions, and immutability', () => {
    const handle = setup();
    const db = handle.database;
    applyMigrations(db);
    const seededProject = project();
    new ProjectRepository(db, () => new Date(iso)).insert(seededProject);
    const { taskId } = insertTask(db, seededProject.id, 'planning');
    const runId = ulid();
    db.prepare(
      `INSERT INTO planning_runs (id, task_id, attempt, provider, model, profile_snapshot_json, profile_snapshot_sha256, status, fallback_reason, created_at, completed_at)
      VALUES (?, ?, 1, 'openai', 'gpt-5.6-sol', '{"id":"atlas"}', ?, 'running', NULL, ?, NULL)`,
    ).run(runId, taskId, 'a'.repeat(64), iso);

    const secondRunId = ulid();
    expect(() =>
      db
        .prepare(
          `INSERT INTO planning_runs (id, task_id, attempt, provider, model, profile_snapshot_json, profile_snapshot_sha256, status, fallback_reason, created_at, completed_at)
          VALUES (?, ?, 2, 'openai', 'gpt-5.6-sol', '{"id":"atlas"}', ?, 'running', NULL, ?, NULL)`,
        )
        .run(secondRunId, taskId, 'b'.repeat(64), iso),
    ).toThrow();

    expect(() =>
      db
        .prepare(
          "INSERT INTO planning_runs (id, task_id, attempt, provider, model, profile_snapshot_json, profile_snapshot_sha256, status, fallback_reason, created_at, completed_at) VALUES (?, ?, 1, 'openai', 'gpt-5.6-sol', '{}', ?, 'succeeded', NULL, ?, NULL)",
        )
        .run(ulid(), taskId, 'c'.repeat(64), iso),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          "INSERT INTO planning_runs (id, task_id, attempt, provider, model, profile_snapshot_json, profile_snapshot_sha256, status, fallback_reason, created_at, completed_at) VALUES (?, ?, 1, 'openai', 'gpt-5.6-sol', '{}', ?, 'running', NULL, ?, ?)",
        )
        .run(ulid(), taskId, 'd'.repeat(64), iso, iso),
    ).toThrow();

    expect(() =>
      db
        .prepare("UPDATE planning_runs SET status = 'running', completed_at = NULL WHERE id = ?")
        .run(runId),
    ).not.toThrow();
    db.prepare("UPDATE planning_runs SET status = 'succeeded', completed_at = ? WHERE id = ?").run(
      iso,
      runId,
    );
    expect(db.prepare('SELECT status FROM planning_runs WHERE id = ?').get(runId)).toMatchObject({
      status: 'succeeded',
    });

    expect(() =>
      db
        .prepare("UPDATE planning_runs SET status = 'running', completed_at = NULL WHERE id = ?")
        .run(runId),
    ).toThrow(/INVALID_STATE_TRANSITION/);
    expect(() =>
      db
        .prepare("UPDATE planning_runs SET status = 'failed', completed_at = ? WHERE id = ?")
        .run(iso, runId),
    ).toThrow(/INVALID_STATE_TRANSITION/);

    expect(() =>
      db.prepare("UPDATE planning_runs SET profile_snapshot_json = '{}' WHERE id = ?").run(runId),
    ).toThrow(/IMMUTABLE_PROFILE_SNAPSHOT/);
    expect(() => db.prepare('DELETE FROM planning_runs WHERE id = ?').run(runId)).toThrow(
      /PLANNING_RUNS_APPEND_ONLY/,
    );

    const thirdRunId = ulid();
    expect(() =>
      db
        .prepare(
          `INSERT INTO planning_runs (id, task_id, attempt, provider, model, profile_snapshot_json, profile_snapshot_sha256, status, fallback_reason, created_at, completed_at)
          VALUES (?, ?, 2, 'openai', 'gpt-5.6-sol', '{"id":"atlas"}', ?, 'running', NULL, ?, NULL)`,
        )
        .run(thirdRunId, taskId, 'e'.repeat(64), iso),
    ).not.toThrow();
    db.prepare("UPDATE planning_runs SET status = 'failed', completed_at = ? WHERE id = ?").run(
      iso,
      thirdRunId,
    );
    expect(
      db.prepare('SELECT status FROM planning_runs WHERE id = ?').get(thirdRunId),
    ).toMatchObject({ status: 'failed' });
  });

  it('allows the M3 retry transitions (step failed->ready, task failed->queued) and keeps other illegal transitions rejected', () => {
    const handle = setup();
    const db = handle.database;
    applyMigrations(db);
    const seededProject = project();
    new ProjectRepository(db, () => new Date(iso)).insert(seededProject);

    const failedStep = insertTaskAndStep(db, seededProject.id, 'failed');
    expect(() =>
      db.prepare("UPDATE task_steps SET status = 'ready' WHERE id = ?").run(failedStep.stepId),
    ).not.toThrow();
    expect(
      db.prepare('SELECT status FROM task_steps WHERE id = ?').get(failedStep.stepId),
    ).toMatchObject({ status: 'ready' });

    const failedTask = insertTaskAndStep(db, seededProject.id, 'failed');
    expect(() =>
      db.prepare("UPDATE tasks SET status = 'queued' WHERE id = ?").run(failedTask.taskId),
    ).not.toThrow();
    expect(
      db.prepare('SELECT status FROM tasks WHERE id = ?').get(failedTask.taskId),
    ).toMatchObject({ status: 'queued' });

    const anotherFailedStep = insertTaskAndStep(db, seededProject.id, 'failed');
    expect(() =>
      db
        .prepare("UPDATE task_steps SET status = 'running' WHERE id = ?")
        .run(anotherFailedStep.stepId),
    ).toThrow(/INVALID_STATE_TRANSITION/);
    expect(
      db.prepare('SELECT status FROM task_steps WHERE id = ?').get(anotherFailedStep.stepId),
    ).toMatchObject({ status: 'failed' });
  });
});
