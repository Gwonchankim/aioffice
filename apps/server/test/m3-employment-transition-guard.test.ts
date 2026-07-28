import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import { createDatabase } from '../src/database.js';
import { applyMigrations, loadMigrations, migrationDirectory } from '../src/migrations.js';

/**
 * Migration 0008 — employment self-transition guard (WFM-MIG-001, plan-delta-004).
 *
 * The 0007 guard carried a `NEW.state <> OLD.state` term that let a same-state
 * UPDATE slip past the RAISE, so the four self-transitions were accepted by the
 * database even though WFM-005 requires all nine rejected ordered pairs to be
 * refused by the trigger AND the service. 0008 drops that term.
 */

const cleanup: string[] = [];
const handles: Array<{ close: () => void }> = [];
afterEach(() => {
  handles.splice(0).forEach((handle) => handle.close());
  cleanup.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});

const iso = '2026-07-27T00:00:00.000Z';

const STATES = ['draft', 'active', 'suspended', 'retired'] as const;
type State = (typeof STATES)[number];

/** The 7 transitions plan-delta-003 §3 permits; every other ordered pair is rejected. */
const ALLOWED_PAIRS: readonly `${State}->${State}`[] = [
  'draft->active',
  'draft->retired',
  'active->suspended',
  'active->retired',
  'suspended->active',
  'suspended->retired',
  'retired->active',
];

/**
 * The triggers 0007 leaves behind, minus the one 0008 replaces
 * (plan-delta-004 §3.2). Triggers created by 0001..0006 — the four on
 * `agent_profiles` — are deliberately not listed here; the whole-schema
 * comparison below covers them.
 */
const NON_TARGET_0007_TRIGGERS: readonly string[] = [
  'agent_definitions_append_only_delete',
  'agent_definitions_append_only_update',
  'agent_definitions_builtin_seed_only',
  'agent_employments_append_only_delete',
  'agent_employments_arca_blocked',
  'agent_employments_initial_state',
  'agent_profile_versions_append_only_delete',
  'agent_profile_versions_append_only_update',
  'agent_profile_versions_custom_space',
  'agent_profiles_builtin_space',
  'hire_proposals_append_only_delete',
  'hire_proposals_transition_guard',
];

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'orion-m3-transition-guard-'));
  cleanup.push(directory);
  const handle = createDatabase(join(directory, 'orion.db'));
  handles.push(handle);
  applyMigrations(handle.database);
  return handle.database;
}

type Database = ReturnType<typeof setup>;

function count(database: Database, sql: string, ...parameters: unknown[]): number {
  const row = database.prepare(sql).get(...(parameters as [])) as { count: number };
  return Number(row.count);
}

let nextAgentSuffix = 0;

/**
 * Creates a fresh custom agent sitting in `state`, reached only through legal
 * edges from the mandatory `draft` starting point: `active` via hire,
 * `suspended` via hire then suspend, `retired` via dismiss.
 *
 * A fresh row per case is what keeps each ordered pair independent. Reusing one
 * row would need an illegal reset edge such as `active -> draft`, which 0008
 * now correctly refuses — the very behaviour under test.
 *
 * The two 0007 CHECKs tie `state = 'active'` to a non-null `active_version` in
 * both directions, so `active` carries a version and every other state does not.
 */
function agentIn(database: Database, state: State): string {
  nextAgentSuffix += 1;
  const agentId = `zeta-${nextAgentSuffix}`;
  database
    .prepare(
      `INSERT INTO agent_definitions (id, name, origin, created_by, created_at)
       VALUES (?, 'Zeta', 'user_created', 'local-user', ?)`,
    )
    .run(agentId, iso);
  database
    .prepare(
      `INSERT INTO agent_employments (agent_id, state, active_version, last_active_version,
       activated_at, deactivated_at, actor, reason, revision, updated_at)
       VALUES (?, 'draft', NULL, NULL, NULL, NULL, 'local-user', NULL, 1, ?)`,
    )
    .run(agentId, iso);

  if (state === 'retired') {
    database
      .prepare("UPDATE agent_employments SET state = 'retired' WHERE agent_id = ?")
      .run(agentId);
  } else if (state === 'active' || state === 'suspended') {
    database
      .prepare(
        "UPDATE agent_employments SET state = 'active', active_version = 1 WHERE agent_id = ?",
      )
      .run(agentId);
    if (state === 'suspended') {
      database
        .prepare(
          "UPDATE agent_employments SET state = 'suspended', active_version = NULL WHERE agent_id = ?",
        )
        .run(agentId);
    }
  }
  return agentId;
}

/** Attempts one ordered pair by direct SQL and reports the raised label, if any. */
function attempt(database: Database, from: State, to: State): string | undefined {
  const agentId = agentIn(database, from);
  // Satisfies both 0007 CHECKs for the target state, so any rejection below
  // comes from the transition trigger rather than a CHECK constraint.
  const activeVersion = to === 'active' ? 1 : null;
  try {
    database
      .prepare('UPDATE agent_employments SET state = ?, active_version = ? WHERE agent_id = ?')
      .run(to, activeVersion, agentId);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe('M3 migration 0008 — employment self-transition guard', () => {
  it('applies 0001..0008 on a fresh database and leaves 0007 byte-identical', () => {
    const database = setup();
    expect(count(database, 'SELECT COUNT(*) AS count FROM schema_migrations')).toBe(8);

    const applied = database
      .prepare('SELECT version, name FROM schema_migrations ORDER BY version')
      .all() as { version: number; name: string }[];
    expect(applied[7]).toMatchObject({
      version: 8,
      name: '0008_m3_agent_employment_self_transition_guard.sql',
    });

    // 0007 is frozen: its content hash is pinned by plan-delta-004 §6 item 3.
    const sql = readFileSync(join(migrationDirectory(), '0007_m3_agent_workforce.sql'), 'utf8');
    expect(createHash('sha256').update(sql).digest('hex')).toBe(
      '2cef10ef9c91913b546e57103e7f036e1bb425e2f2ed8e1f28175af5a3ad1f03',
    );
  });

  it('replaces exactly one trigger and leaves every other one untouched', () => {
    // Whole-schema comparison: apply up to 0007, snapshot every trigger, then
    // apply 0008 and require the ONLY difference to be the body of the guard it
    // replaces. This covers the 0001..0006 triggers as well as the 0007 ones,
    // without depending on a hand-maintained name list.
    const beforeDirectory = mkdtempSync(join(tmpdir(), 'orion-m3-transition-guard-triggers-'));
    cleanup.push(beforeDirectory);
    const beforeHandle = createDatabase(join(beforeDirectory, 'orion.db'));
    handles.push(beforeHandle);
    applyMigrations(
      beforeHandle.database,
      loadMigrations().filter((migration) => migration.version <= 7),
    );
    const before = beforeHandle.database
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
      .all() as { name: string; sql: string }[];

    const database = setup();
    const after = database
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
      .all() as { name: string; sql: string }[];

    expect(after.map((row) => row.name)).toEqual(before.map((row) => row.name));
    const changed = after.filter((row, index) => row.sql !== before[index]!.sql);
    expect(changed.map((row) => row.name)).toEqual(['agent_employments_transition_guard']);

    // The 0007-created non-target triggers are all still present by name.
    const names = after.map((row) => row.name);
    for (const trigger of NON_TARGET_0007_TRIGGERS) {
      expect(names, `${trigger} must survive 0008`).toContain(trigger);
    }
    expect(names.filter((name) => name === 'agent_employments_transition_guard')).toHaveLength(1);

    // The verify guard 0007 uses to check its own seed is dropped by 0007 itself.
    expect(names).not.toContain('migration_0007_verify_guard');

    // The replacement no longer carries the term that let self-transitions pass.
    expect(changed[0]!.sql).not.toContain('NEW.state <> OLD.state');
    expect(changed[0]!.sql).toContain('INVALID_STATE_TRANSITION');
    expect(before.find((row) => row.name === 'agent_employments_transition_guard')!.sql).toContain(
      'NEW.state <> OLD.state',
    );
  });

  it('WFM-005: accepts exactly the 7 allowed pairs and rejects the other 9', () => {
    const database = setup();

    const accepted: string[] = [];
    const rejected: string[] = [];
    for (const from of STATES) {
      for (const to of STATES) {
        const failure = attempt(database, from, to);
        const pair = `${from}->${to}`;
        if (failure === undefined) {
          accepted.push(pair);
        } else {
          rejected.push(pair);
          // Every rejection uses the existing error contract; no new code.
          expect(failure).toContain('INVALID_STATE_TRANSITION');
        }
      }
    }

    expect(accepted.sort()).toEqual([...ALLOWED_PAIRS].sort());
    expect(accepted).toHaveLength(7);
    expect(rejected).toHaveLength(9);
  });

  it('WFM-005: rejects all four self-transitions, the case 0007 let through', () => {
    const database = setup();

    for (const state of STATES) {
      const failure = attempt(database, state, state);
      expect(failure, `${state}->${state} must be rejected`).toContain('INVALID_STATE_TRANSITION');
    }
  });

  it('rejects an active self-transition through the trigger, not a CHECK constraint', () => {
    const database = setup();
    const agentId = agentIn(database, 'active');

    // `active_version` stays non-null, so both 0007 CHECKs are satisfied and the
    // only thing left that can refuse this UPDATE is the transition trigger.
    let message = '';
    try {
      database
        .prepare(
          "UPDATE agent_employments SET state = 'active', active_version = 1 WHERE agent_id = ?",
        )
        .run(agentId);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('INVALID_STATE_TRANSITION');
    expect(message).not.toContain('CHECK constraint failed');

    const row = database
      .prepare('SELECT state, active_version FROM agent_employments WHERE agent_id = ?')
      .get(agentId) as { state: string; active_version: number | null };
    expect(row).toEqual({ state: 'active', active_version: 1 });
  });

  it('WFM-028: keeps ARCA_ACTIVATION_BLOCKED deterministic on every reachable activation path', () => {
    const database = setup();

    // draft -> active: the pair is allowed, so only the arca guard matches.
    let message = '';
    try {
      database
        .prepare(
          "UPDATE agent_employments SET state = 'active', active_version = 2 WHERE agent_id = 'arca'",
        )
        .run();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('ARCA_ACTIVATION_BLOCKED');

    // Blocked, and nothing moved.
    expect(
      database
        .prepare('SELECT state, active_version FROM agent_employments WHERE agent_id = ?')
        .get('arca'),
    ).toEqual({ state: 'draft', active_version: null });

    // arca `active->active` is deliberately NOT asserted: both triggers match it
    // and SQLite leaves their firing order undefined. The state is unreachable
    // in a canonical M3 database (plan-delta-004 §3.4, R2-001).
    //
    // `suspended->active` is likewise not asserted, and cannot be: reaching
    // `suspended` requires passing through `active`, which is exactly what is
    // blocked. WFM-028 already excludes it for this reason.
  });

  it('WFM-028: blocks arca on the retired activation path too', () => {
    const database = setup();

    // draft -> retired is an allowed pair and arca is not being activated, so
    // this succeeds and gives the second reachable activation path a starting
    // point (plan-delta-004 §3.4, R2-001).
    database
      .prepare("UPDATE agent_employments SET state = 'retired' WHERE agent_id = 'arca'")
      .run();

    let raised = '';
    try {
      database
        .prepare(
          "UPDATE agent_employments SET state = 'active', active_version = 2 WHERE agent_id = 'arca'",
        )
        .run();
    } catch (error) {
      raised = error instanceof Error ? error.message : String(error);
    }
    expect(raised, 'arca retired->active').toContain('ARCA_ACTIVATION_BLOCKED');

    expect(
      database
        .prepare('SELECT state, active_version FROM agent_employments WHERE agent_id = ?')
        .get('arca'),
    ).toEqual({ state: 'retired', active_version: null });
  });

  it('changes no seed, profile or workforce row', () => {
    const beforeDirectory = mkdtempSync(join(tmpdir(), 'orion-m3-transition-guard-pre-'));
    cleanup.push(beforeDirectory);
    const beforeHandle = createDatabase(join(beforeDirectory, 'orion.db'));
    handles.push(beforeHandle);
    applyMigrations(
      beforeHandle.database,
      loadMigrations().filter((migration) => migration.version <= 7),
    );
    const beforeProfiles = beforeHandle.database
      .prepare('SELECT id, version, config_sha256 FROM agent_profiles ORDER BY id, version')
      .all();
    const beforeEmployments = beforeHandle.database
      .prepare(
        'SELECT agent_id, state, active_version, last_active_version, revision FROM agent_employments ORDER BY agent_id',
      )
      .all();
    const beforeDefinitions = beforeHandle.database
      .prepare('SELECT id, name, origin, created_by, created_at FROM agent_definitions ORDER BY id')
      .all();

    const database = setup();
    expect(
      database
        .prepare('SELECT id, version, config_sha256 FROM agent_profiles ORDER BY id, version')
        .all(),
    ).toEqual(beforeProfiles);
    expect(
      database
        .prepare(
          'SELECT agent_id, state, active_version, last_active_version, revision FROM agent_employments ORDER BY agent_id',
        )
        .all(),
    ).toEqual(beforeEmployments);
    expect(
      database
        .prepare(
          'SELECT id, name, origin, created_by, created_at FROM agent_definitions ORDER BY id',
        )
        .all(),
    ).toEqual(beforeDefinitions);

    expect(beforeProfiles).toHaveLength(36);
    expect(count(database, 'SELECT COUNT(*) AS count FROM agent_employments')).toBe(18);
    expect(
      count(database, "SELECT COUNT(*) AS count FROM agent_employments WHERE state = 'active'"),
    ).toBe(17);
    expect(
      count(
        database,
        "SELECT COUNT(*) AS count FROM agent_employments WHERE agent_id = 'arca' AND state = 'draft' AND active_version IS NULL",
      ),
    ).toBe(1);
    expect(count(database, 'SELECT COUNT(*) AS count FROM agent_profile_versions')).toBe(0);
    expect(count(database, 'SELECT COUNT(*) AS count FROM hire_proposals')).toBe(0);
  });

  it('re-applying the migrations is a no-op that neither duplicates nor re-runs 0008', () => {
    const database = setup();
    const triggersBefore = database
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
      .all();
    const appliedBefore = database
      .prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version')
      .all();

    applyMigrations(database);
    applyMigrations(database);

    expect(
      database
        .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
        .all(),
    ).toEqual(triggersBefore);
    expect(
      database
        .prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version')
        .all(),
    ).toEqual(appliedBefore);
    expect(count(database, 'SELECT COUNT(*) AS count FROM schema_migrations')).toBe(8);
    expect(count(database, 'SELECT COUNT(*) AS count FROM agent_employments')).toBe(18);
  });

  it('fails closed and applies nothing when the predecessor trigger is missing', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orion-m3-transition-guard-drift-'));
    cleanup.push(directory);
    const handle = createDatabase(join(directory, 'orion.db'));
    handles.push(handle);
    const database = handle.database;

    const upToSeven = loadMigrations().filter((migration) => migration.version <= 7);
    applyMigrations(database, upToSeven);
    // Simulate drift: the guard 0008 expects to replace is gone.
    database.exec('DROP TRIGGER agent_employments_transition_guard');

    expect(() => applyMigrations(database)).toThrowError(/migration/i);

    // Nothing partial: 0008 is not recorded and no replacement trigger appeared.
    expect(count(database, 'SELECT COUNT(*) AS count FROM schema_migrations')).toBe(7);
    expect(
      count(
        database,
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name = 'agent_employments_transition_guard'",
      ),
    ).toBe(0);
    // The rest of the schema and its data are untouched by the failed attempt.
    expect(count(database, 'SELECT COUNT(*) AS count FROM agent_employments')).toBe(18);
    expect(count(database, 'SELECT COUNT(*) AS count FROM agent_profiles')).toBe(36);
  });
});
