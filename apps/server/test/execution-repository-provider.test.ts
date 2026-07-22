import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { ulid } from 'ulid';

import { createDatabase } from '../src/database.js';
import { applyMigrations } from '../src/migrations.js';
import { ExecutionRepository } from '../src/repositories/execution-repository.js';

const iso = '2026-07-22T00:00:00.000Z';
const cleanup: string[] = [];
const handles: Array<{ close(): void }> = [];
afterEach(() => {
  handles.splice(0).forEach((handle) => handle.close());
  cleanup.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});

describe('provider execution repository', () => {
  it('EVT-010 atomically allocates append-only task/run sequences and snapshots sanitized state', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orion-provider-events-'));
    cleanup.push(directory);
    const handle = createDatabase(join(directory, 'orion.db'));
    handles.push(handle);
    applyMigrations(handle.database);
    const db = handle.database;
    const projectId = ulid();
    const taskId = ulid();
    const stepId = ulid();
    const runId = ulid();
    db.prepare(
      `INSERT INTO projects (id, project_key, name, repository_path, default_branch, classification, provider_policy_json, allowed_agent_ids_json, allowed_commands_json, created_at, updated_at)
       VALUES (?, ?, 'p', ?, 'main', 'internal', ?, '[]', '{"read":[],"verify":[],"localWrite":[]}', ?, ?)`,
    ).run(
      projectId,
      `events-${projectId.slice(-6).toLowerCase()}`,
      directory,
      '{"openai":true,"anthropic":false,"allowFable":false}',
      iso,
      iso,
    );
    db.prepare(
      `INSERT INTO tasks (id, project_id, title, objective, success_criteria_json, input_artifact_ids_json, max_duration_minutes, max_agent_runs, status, created_at, updated_at)
       VALUES (?, ?, 'task', 'objective', '[]', '[]', 1, 1, 'draft', ?, ?)`,
    ).run(taskId, projectId, iso, iso);
    db.prepare(
      "INSERT INTO task_plans (task_id, version, plan_json, validation_json, created_at) VALUES (?, 1, '{}', '{}', ?)",
    ).run(taskId, iso);
    db.prepare(
      "INSERT INTO task_steps (id, task_id, plan_version, step_json, status, created_at, updated_at) VALUES (?, ?, 1, '{}', 'ready', ?, ?)",
    ).run(stepId, taskId, iso, iso);
    db.prepare(
      `INSERT INTO runs (id, step_id, attempt, provider, model, profile_snapshot_json, profile_snapshot_sha256, status, created_at)
       VALUES (?, ?, 1, 'openai', 'synthetic', '{}', ?, 'starting', ?)`,
    ).run(runId, stepId, 'a'.repeat(64), iso);
    const repository = new ExecutionRepository(db, () => new Date(iso));
    const started = repository.persistProviderRunEvent(runId, {
      status: 'running',
      sessionId: 'session-synthetic',
      event: { type: 'run.started', payload: { attempt: 1 } },
    });
    const output = repository.persistProviderRunEvent(runId, {
      event: { type: 'run.output.delta', payload: { channel: 'raw', text: '[REDACTED]' } },
    });
    const completed = repository.persistProviderRunEvent(runId, {
      status: 'succeeded',
      event: { type: 'run.completed', payload: { status: 'succeeded' } },
    });
    expect([started.taskSequence, output.taskSequence, completed.taskSequence]).toEqual([1, 2, 3]);
    expect([started.runSequence, output.runSequence, completed.runSequence]).toEqual([1, 2, 3]);
    expect(repository.taskEvents(taskId, 1, 3).map((value) => value.taskSequence)).toEqual([2, 3]);
    expect(repository.taskSnapshot(taskId)).toMatchObject({
      taskId,
      status: 'draft',
      highWaterSequence: 3,
      runs: [{ id: runId, status: 'succeeded', provider: 'openai', model: 'synthetic' }],
    });
    expect(() => db.prepare('DELETE FROM events WHERE id = ?').run(started.id)).toThrow(
      /EVENTS_APPEND_ONLY/,
    );
  });
});
