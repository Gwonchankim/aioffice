import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import { loadFullAgentProfiles } from '@orion/agent-catalog';
import { createDatabase } from '../src/database.js';
import { applyMigrations } from '../src/migrations.js';

const cleanup: string[] = [];
const handles: Array<{ close: () => void }> = [];
afterEach(() => {
  handles.splice(0).forEach((handle) => handle.close());
  cleanup.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'orion-m3-full-profile-seeds-'));
  cleanup.push(directory);
  const handle = createDatabase(join(directory, 'orion.db'));
  handles.push(handle);
  return handle;
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortKeysDeep(item));
  }
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

interface AgentProfileRow {
  id: string;
  version: number;
  seed_order: number;
  config_sha256: string;
  config_json: string;
  enabled: number;
  execution_mode: string;
  created_at: string;
}

describe('M3 full profile seeds (migration 0006)', () => {
  it('applies exactly 9 migrations and seeds 36 total agent_profiles rows (18 v1 + 18 v2)', () => {
    const handle = setup();
    applyMigrations(handle.database);
    expect(
      handle.database.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get(),
    ).toMatchObject({ count: 9 });
    expect(
      handle.database.prepare('SELECT COUNT(*) AS count FROM agent_profiles').get(),
    ).toMatchObject({ count: 36 });
  });

  it('stores 18 v2 full-execution-mode rows whose config_json matches loadFullAgentProfiles() and whose config_sha256 matches sha256(config_json)', () => {
    const handle = setup();
    applyMigrations(handle.database);

    const rows = handle.database
      .prepare(
        'SELECT id, version, seed_order, config_sha256, config_json, enabled, execution_mode, created_at FROM agent_profiles WHERE version = 2 ORDER BY seed_order',
      )
      .all() as unknown as AgentProfileRow[];
    expect(rows).toHaveLength(18);

    const profiles = loadFullAgentProfiles();
    expect(profiles).toHaveLength(18);

    for (const [index, row] of rows.entries()) {
      const profile = profiles[index]!;
      expect(row.id).toBe(profile.id);
      expect(row.execution_mode).toBe('full');
      expect(row.seed_order).toBe(index + 1);
      expect(row.created_at).toBe('2026-07-24T00:00:00.000Z');

      const parsedConfig = JSON.parse(row.config_json) as unknown;
      expect(sortKeysDeep(parsedConfig)).toEqual(sortKeysDeep(profile));

      const recomputedHash = createHash('sha256').update(row.config_json, 'utf8').digest('hex');
      expect(row.config_sha256).toBe(recomputedHash);
    }
  });

  it('marks Arca v2 disabled and every other v2 profile enabled', () => {
    const handle = setup();
    applyMigrations(handle.database);

    const arcaRow = handle.database
      .prepare("SELECT enabled FROM agent_profiles WHERE id = 'arca' AND version = 2")
      .get() as { enabled: number };
    expect(arcaRow.enabled).toBe(0);

    const enabledOthers = handle.database
      .prepare(
        "SELECT COUNT(*) AS count FROM agent_profiles WHERE version = 2 AND id <> 'arca' AND enabled = 1",
      )
      .get() as { count: number };
    expect(enabledOthers.count).toBe(17);

    const disabledOthers = handle.database
      .prepare(
        "SELECT COUNT(*) AS count FROM agent_profiles WHERE version = 2 AND id <> 'arca' AND enabled = 0",
      )
      .get() as { count: number };
    expect(disabledOthers.count).toBe(0);
  });

  it('leaves the 18 v1 skeleton rows exactly unchanged', () => {
    const handle = setup();
    applyMigrations(handle.database);

    const v1Rows = handle.database
      .prepare(
        'SELECT id, config_sha256, config_json, enabled, execution_mode FROM agent_profiles WHERE version = 1 ORDER BY id',
      )
      .all() as unknown as AgentProfileRow[];
    expect(v1Rows).toHaveLength(18);
    for (const row of v1Rows) {
      expect(row.execution_mode).toBe('skeleton');
      expect(row.enabled).toBe(0);
      const recomputedHash = createHash('sha256').update(row.config_json, 'utf8').digest('hex');
      expect(row.config_sha256).toBe(recomputedHash);
    }
  });

  it('re-applying all migrations is a no-op', () => {
    const handle = setup();
    applyMigrations(handle.database);
    const before = handle.database
      .prepare('SELECT id, version, config_sha256 FROM agent_profiles ORDER BY id, version')
      .all();
    expect(() => applyMigrations(handle.database)).not.toThrow();
    const after = handle.database
      .prepare('SELECT id, version, config_sha256 FROM agent_profiles ORDER BY id, version')
      .all();
    expect(after).toEqual(before);
    expect(
      handle.database.prepare('SELECT COUNT(*) AS count FROM agent_profiles').get(),
    ).toMatchObject({ count: 36 });
  });
});
