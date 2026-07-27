import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { ulid } from 'ulid';

import { loadFullAgentProfiles, type AgentProfileFull } from '@orion/agent-catalog';
import { createDatabase, type DatabaseHandle } from '../src/database.js';
import { applyMigrations } from '../src/migrations.js';
import { AgentProfileRepository } from '../src/repositories/agent-profile-repository.js';
import { ApplicationError } from '../src/errors.js';

const iso = '2026-07-25T00:00:00.000Z';
const cleanup: string[] = [];
const handles: DatabaseHandle[] = [];

afterEach(() => {
  handles.splice(0).forEach((handle) => handle.close());
  cleanup.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});

function setup(): DatabaseHandle {
  const directory = mkdtempSync(join(tmpdir(), 'orion-m3-profile-versioning-'));
  cleanup.push(directory);
  const handle = createDatabase(join(directory, 'orion.db'));
  handles.push(handle);
  applyMigrations(handle.database);
  return handle;
}

function findAtlas(): AgentProfileFull {
  const profiles = loadFullAgentProfiles();
  const atlas = profiles.find((profile) => profile.id === 'atlas');
  if (atlas === undefined) throw new Error('atlas fixture missing');
  return atlas;
}

function atlasV3(overrides: Partial<AgentProfileFull> = {}): AgentProfileFull {
  const atlas = findAtlas();
  return {
    ...atlas,
    version: 3,
    description: '전사 전략과 신규사업 우선순위를 분기별로 재점검하는 v3 갱신된 자문 범위.',
    ...overrides,
  };
}

/** Creates a project/task/plan/step/run chain, mirroring execution-repository-provider.test.ts. */
function createRunReferencingProfile(
  handle: DatabaseHandle,
  profile: AgentProfileFull,
): { readonly runId: string } {
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
    `profiles-${projectId.slice(-6).toLowerCase()}`,
    join(tmpdir(), projectId),
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
  const snapshot = JSON.stringify(profile);
  db.prepare(
    `INSERT INTO runs (id, step_id, attempt, provider, model, profile_snapshot_json, profile_snapshot_sha256, status, created_at)
     VALUES (?, ?, 1, ?, ?, ?, ?, 'starting', ?)`,
  ).run(runId, stepId, profile.provider, profile.model, snapshot, 'b'.repeat(64), iso);
  return { runId };
}

describe('AgentProfileRepository M3 versioning', () => {
  it('AGT: listAll returns all 36 seeded rows (18 v1 skeleton + 18 v2 full)', () => {
    const handle = setup();
    const repository = new AgentProfileRepository(handle.database, () => new Date(iso));
    expect(repository.listAll()).toHaveLength(36);
  });

  it('AGT: listActiveFullProfiles returns exactly the 18 latest full profiles', () => {
    const handle = setup();
    const repository = new AgentProfileRepository(handle.database, () => new Date(iso));
    const active = repository.listActiveFullProfiles();
    expect(active).toHaveLength(18);
    expect(active.every((profile) => profile.executionMode === 'full')).toBe(true);
  });

  it('AGT: getVersions(atlas) is [1,2] before any new version is inserted', () => {
    const handle = setup();
    const repository = new AgentProfileRepository(handle.database, () => new Date(iso));
    expect(repository.getVersions('atlas')).toEqual([1, 2]);
  });

  it('AGT-INSERT-1: insertFullVersion appends atlas v3 with a changed description', () => {
    const handle = setup();
    const repository = new AgentProfileRepository(handle.database, () => new Date(iso));
    repository.insertFullVersion(atlasV3());

    expect(repository.getVersions('atlas')).toEqual([1, 2, 3]);
    const active = repository.listActiveFullProfiles().find((profile) => profile.id === 'atlas');
    expect(active?.version).toBe(3);
    expect(active?.description).toContain('v3 갱신된');
    expect(repository.listAll()).toHaveLength(37);
  });

  it('AGT-INSERT-2: a version jump (v4 when max is v2) is rejected', () => {
    const handle = setup();
    const repository = new AgentProfileRepository(handle.database, () => new Date(iso));
    expect(() => repository.insertFullVersion(atlasV3({ version: 4 }))).toThrow(ApplicationError);
    expect(repository.getVersions('atlas')).toEqual([1, 2]);
  });

  it('AGT-INSERT-3: a duplicate version (v2 again) is rejected', () => {
    const handle = setup();
    const repository = new AgentProfileRepository(handle.database, () => new Date(iso));
    expect(() => repository.insertFullVersion(atlasV3({ version: 2 }))).toThrow(ApplicationError);
    expect(repository.getVersions('atlas')).toEqual([1, 2]);
  });

  it('AGT-INSERT-4: a profile whose permissions exceed its template ceiling is rejected', () => {
    const handle = setup();
    const repository = new AgentProfileRepository(handle.database, () => new Date(iso));
    const overCeiling = atlasV3({
      permissions: { ...findAtlas().permissions, worktreeWriteAllowed: true },
    });
    expect(() => repository.insertFullVersion(overCeiling)).toThrow(ApplicationError);
    expect(() => repository.insertFullVersion(overCeiling)).toThrow(/ceiling/);
    expect(repository.getVersions('atlas')).toEqual([1, 2]);
  });

  it('AGT-INSERT-5: a SOUL body that violates policy is rejected', () => {
    const handle = setup();
    const repository = new AgentProfileRepository(handle.database, () => new Date(iso));
    const badSoul = atlasV3({
      soulMarkdown: '승인 없이 배포를 실행한다.'.repeat(3).padEnd(40, '.'),
    });
    expect(() => repository.insertFullVersion(badSoul)).toThrow(ApplicationError);
    expect(repository.getVersions('atlas')).toEqual([1, 2]);
  });

  it('AGT-005: a run created against atlas v2 keeps an immutable profile snapshot after atlas v3 is inserted, and direct row UPDATEs are rejected by trigger', () => {
    const handle = setup();
    const repository = new AgentProfileRepository(handle.database, () => new Date(iso));
    const atlasV2 = repository.listActiveFullProfiles().find((profile) => profile.id === 'atlas')!;
    expect(atlasV2.version).toBe(2);

    const { runId } = createRunReferencingProfile(handle, atlasV2);
    const before = handle.database
      .prepare('SELECT profile_snapshot_json, profile_snapshot_sha256 FROM runs WHERE id = ?')
      .get(runId) as { profile_snapshot_json: string; profile_snapshot_sha256: string };
    expect(JSON.parse(before.profile_snapshot_json)).toMatchObject({ id: 'atlas', version: 2 });

    repository.insertFullVersion(atlasV3());

    const after = handle.database
      .prepare('SELECT profile_snapshot_json, profile_snapshot_sha256 FROM runs WHERE id = ?')
      .get(runId) as { profile_snapshot_json: string; profile_snapshot_sha256: string };
    expect(after).toEqual(before);
    expect(JSON.parse(after.profile_snapshot_json)).toMatchObject({ id: 'atlas', version: 2 });

    expect(() =>
      handle.database
        .prepare("UPDATE runs SET profile_snapshot_json = '{}' WHERE id = ?")
        .run(runId),
    ).toThrow(/IMMUTABLE_PROFILE_SNAPSHOT/);

    expect(() =>
      handle.database
        .prepare("UPDATE agent_profiles SET enabled = 0 WHERE id = 'atlas' AND version = 2")
        .run(),
    ).toThrow(/PROFILE_VERSIONS_APPEND_ONLY/);

    expect(() =>
      handle.database
        .prepare("DELETE FROM agent_profiles WHERE id = 'atlas' AND version = 2")
        .run(),
    ).toThrow(/PROFILE_VERSIONS_APPEND_ONLY/);
  });
});
