import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import { createDatabase } from '../src/database.js';
import { applyMigrations, loadMigrations, migrationDirectory } from '../src/migrations.js';

const cleanup: string[] = [];
const handles: Array<{ close: () => void }> = [];
afterEach(() => {
  handles.splice(0).forEach((handle) => handle.close());
  cleanup.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});

const iso = '2026-07-27T00:00:00.000Z';
const sha = 'a'.repeat(64);

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'orion-m3-workforce-'));
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

/** Inserts a custom definition so the custom id space has an owner. */
function seedCustomDefinition(database: Database, id = 'zeta'): string {
  database
    .prepare(
      `INSERT INTO agent_definitions (id, name, origin, created_by, created_at)
       VALUES (?, 'Zeta', 'user_created', 'local-user', ?)`,
    )
    .run(id, iso);
  return id;
}

function insertDraftEmployment(database: Database, agentId: string): void {
  database
    .prepare(
      `INSERT INTO agent_employments (agent_id, state, active_version, last_active_version,
       activated_at, deactivated_at, actor, reason, revision, updated_at)
       VALUES (?, 'draft', NULL, NULL, NULL, NULL, 'local-user', NULL, 1, ?)`,
    )
    .run(agentId, iso);
}

describe('M3 workforce migration 0007', () => {
  it('WFM-001/WFM-023: preserves the seeded profile baseline exactly', () => {
    const beforeDirectory = mkdtempSync(join(tmpdir(), 'orion-m3-workforce-pre-'));
    cleanup.push(beforeDirectory);
    const beforeHandle = createDatabase(join(beforeDirectory, 'orion.db'));
    handles.push(beforeHandle);
    applyMigrations(
      beforeHandle.database,
      loadMigrations().filter((migration) => migration.version <= 6),
    );
    const before = beforeHandle.database
      .prepare('SELECT id, version, config_sha256 FROM agent_profiles ORDER BY id, version')
      .all();

    const database = setup();
    const after = database
      .prepare('SELECT id, version, config_sha256 FROM agent_profiles ORDER BY id, version')
      .all();

    expect(after).toEqual(before);
    expect(after).toHaveLength(36);
    expect(count(database, 'SELECT COUNT(*) AS count FROM schema_migrations')).toBe(10);
  });

  it('WFM-023: re-applying the migrations and re-executing 0006 stay no-ops', () => {
    const database = setup();
    const before = database
      .prepare('SELECT id, version, config_sha256 FROM agent_profiles ORDER BY id, version')
      .all();

    // (a) applyMigrations twice — skipped by schema_migrations bookkeeping.
    expect(() => applyMigrations(database)).not.toThrow();

    // (b) the 0006 body itself re-executed against a migrated database: the
    //     INSERT OR IGNORE rows must not trip the 0007 space guard, which is why
    //     that guard only fires for ids outside the built-in definition set.
    const seedSql = readFileSync(
      join(migrationDirectory(), '0006_m3_full_profile_seeds.sql'),
      'utf8',
    ).split('CREATE TABLE migration_0006_verify')[0]!;
    expect(() => database.exec(seedSql)).not.toThrow();

    expect(
      database
        .prepare('SELECT id, version, config_sha256 FROM agent_profiles ORDER BY id, version')
        .all(),
    ).toEqual(before);
  });

  it('WFM-005/WFM-028: seeds 17 employed agents and leaves Arca unemployed', () => {
    const database = setup();

    expect(
      count(database, "SELECT COUNT(*) AS count FROM agent_definitions WHERE origin = 'builtin'"),
    ).toBe(18);
    expect(count(database, 'SELECT COUNT(*) AS count FROM agent_employments')).toBe(18);
    expect(
      count(
        database,
        "SELECT COUNT(*) AS count FROM agent_employments WHERE state = 'active' AND active_version = 2",
      ),
    ).toBe(17);
    expect(
      database
        .prepare(
          "SELECT state, active_version, last_active_version FROM agent_employments WHERE agent_id = 'arca'",
        )
        .get(),
    ).toMatchObject({ state: 'draft', active_version: null, last_active_version: null });
    expect(count(database, 'SELECT COUNT(*) AS count FROM agent_profile_versions')).toBe(0);
  });

  it('WFM-032: agent definitions are append-only and the builtin origin is seed-only', () => {
    const database = setup();

    expect(() =>
      database.prepare("UPDATE agent_definitions SET name = 'Renamed' WHERE id = 'atlas'").run(),
    ).toThrow(/AGENT_DEFINITION_APPEND_ONLY/);
    expect(() =>
      database.prepare("DELETE FROM agent_definitions WHERE id = 'atlas'").run(),
    ).toThrow(/AGENT_DEFINITION_APPEND_ONLY/);
    expect(() =>
      database
        .prepare(
          `INSERT INTO agent_definitions (id, name, origin, created_by, created_at)
           VALUES ('zeta', 'Zeta', 'builtin', 'local-user', ?)`,
        )
        .run(iso),
    ).toThrow(/BUILTIN_ORIGIN_SEED_ONLY/);

    // A non-builtin origin is the only thing a runtime path may create.
    expect(() => seedCustomDefinition(database)).not.toThrow();
    expect(count(database, 'SELECT COUNT(*) AS count FROM agent_definitions')).toBe(19);
  });

  it('WFM-030: the built-in and custom version spaces stay disjoint in both directions', () => {
    const database = setup();
    seedCustomDefinition(database);

    // A built-in id may not enter the custom version table.
    expect(() =>
      database
        .prepare(
          `INSERT INTO agent_profile_versions (agent_id, version, config_sha256, config_json,
           soul_sha256, harness_sha256, runtime_selection_json, origin, created_by, created_at)
           VALUES ('atlas', 3, ?, '{}', ?, NULL, '{}', 'user_created', 'local-user', ?)`,
        )
        .run(sha, sha, iso),
    ).toThrow(/CUSTOM_VERSION_SPACE_VIOLATION/);

    // A custom id may not enter the built-in profile table.
    expect(() =>
      database
        .prepare(
          `INSERT INTO agent_profiles (id, version, seed_order, config_sha256, config_json, enabled, execution_mode, created_at)
           VALUES ('zeta', 1, 1, ?, '{"id":"zeta"}', 1, 'full', ?)`,
        )
        .run(sha, iso),
    ).toThrow(/BUILTIN_PROFILE_SPACE_VIOLATION/);

    // A new version of a built-in agent still works: this is the existing
    // insertFullVersion/import path, which the guard must not break.
    expect(() =>
      database
        .prepare(
          `INSERT INTO agent_profiles (id, version, seed_order, config_sha256, config_json, enabled, execution_mode, created_at)
           VALUES ('atlas', 3, 1, ?, '{"id":"atlas"}', 1, 'full', ?)`,
        )
        .run(sha, iso),
    ).not.toThrow();

    // Custom versions live in their own table, so `(id, version)` stays unique
    // across the union.
    expect(() =>
      database
        .prepare(
          `INSERT INTO agent_profile_versions (agent_id, version, config_sha256, config_json,
           soul_sha256, harness_sha256, runtime_selection_json, origin, created_by, created_at)
           VALUES ('zeta', 1, ?, '{}', ?, NULL, '{}', 'user_created', 'local-user', ?)`,
        )
        .run(sha, sha, iso),
    ).not.toThrow();
    const duplicates = database
      .prepare(
        `SELECT id, version FROM (
           SELECT id, version FROM agent_profiles
           UNION ALL
           SELECT agent_id AS id, version FROM agent_profile_versions
         ) GROUP BY id, version HAVING COUNT(*) > 1`,
      )
      .all();
    expect(duplicates).toEqual([]);
  });

  it('WFM-002/I-1: every new employment row is born unemployed', () => {
    const database = setup();
    seedCustomDefinition(database);

    for (const [state, activeVersion, lastActiveVersion] of [
      ['active', 1, 1],
      ['suspended', null, 1],
      ['draft', null, 1],
    ] as const) {
      expect(() =>
        database
          .prepare(
            `INSERT INTO agent_employments (agent_id, state, active_version, last_active_version,
             activated_at, deactivated_at, actor, reason, revision, updated_at)
             VALUES ('zeta', ?, ?, ?, NULL, NULL, 'local-user', NULL, 1, ?)`,
          )
          .run(state, activeVersion, lastActiveVersion, iso),
      ).toThrow(/AGENT_EMPLOYMENT_INITIAL_STATE|CHECK constraint failed/);
    }

    insertDraftEmployment(database, 'zeta');
    expect(
      database
        .prepare("SELECT state, active_version FROM agent_employments WHERE agent_id = 'zeta'")
        .get(),
    ).toMatchObject({ state: 'draft', active_version: null });
  });

  it('WFM-005: only the seven permitted employment transitions are accepted', () => {
    const database = setup();
    seedCustomDefinition(database);
    insertDraftEmployment(database, 'zeta');

    const move = (state: string, activeVersion: number | null) =>
      database
        .prepare('UPDATE agent_employments SET state = ?, active_version = ? WHERE agent_id = ?')
        .run(state, activeVersion, 'zeta');

    // draft -> suspended is not a permitted pair.
    expect(() => move('suspended', null)).toThrow(/INVALID_STATE_TRANSITION/);
    // hire -> suspend -> resume -> dismiss -> rehire all succeed.
    expect(() => move('active', 1)).not.toThrow();
    expect(() => move('suspended', null)).not.toThrow();
    expect(() => move('active', 1)).not.toThrow();
    expect(() => move('retired', null)).not.toThrow();
    expect(() => move('active', 1)).not.toThrow();
    // retired -> suspended is not permitted.
    expect(() => move('retired', null)).not.toThrow();
    expect(() => move('suspended', null)).toThrow(/INVALID_STATE_TRANSITION/);
    // An active row can never be stored without an active version.
    expect(() => move('active', null)).toThrow(/CHECK constraint failed/);
  });

  it('WFM-028: Arca activation is blocked deterministically on the update path', () => {
    const database = setup();

    expect(() =>
      database
        .prepare(
          "UPDATE agent_employments SET state = 'active', active_version = 2 WHERE agent_id = 'arca'",
        )
        .run(),
    ).toThrow(/ARCA_ACTIVATION_BLOCKED/);
    expect(
      database
        .prepare("SELECT state, active_version FROM agent_employments WHERE agent_id = 'arca'")
        .get(),
    ).toMatchObject({ state: 'draft', active_version: null });

    // Employment history is never deleted, not even for an unemployed agent.
    expect(() =>
      database.prepare("DELETE FROM agent_employments WHERE agent_id = 'arca'").run(),
    ).toThrow(/AGENT_EMPLOYMENT_APPEND_ONLY/);
  });

  it('WFM-019/DEC-039: hire proposals reject every invalid status combination', () => {
    const database = setup();
    const insert = (overrides: Partial<Record<string, unknown>> = {}) => {
      const row = {
        id: '01FAKEPRP00000000000000000',
        status: 'pending_approval',
        decided_at: null,
        decided_by: null,
        activated_agent_id: null,
        activated_version: null,
        ...overrides,
      };
      return database
        .prepare(
          `INSERT INTO hire_proposals (id, requested_by, authored_by, proposed_agent_id,
           proposed_definition_json, proposed_profile_json, validation_json, proposal_sha256,
           status, created_at, expires_at, decided_at, decided_by, activated_agent_id, activated_version)
           VALUES (?, 'local-user', 'orion', 'zeta', '{}', '{}', '{}', ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.id,
          sha,
          row.status,
          iso,
          '2026-07-27T00:30:00.000Z',
          row.decided_at,
          row.decided_by,
          row.activated_agent_id,
          row.activated_version,
        );
    };

    expect(() => insert()).not.toThrow();
    expect(() => insert({ id: '01FAKEPRQ00000000000000000', decided_by: 'local-user' })).toThrow(
      /CHECK constraint failed/,
    );
    expect(() => insert({ id: '01FAKEPRR00000000000000000', status: 'approved' })).toThrow(
      /CHECK constraint failed/,
    );
    // Expiry is automatic: it is timestamped but has no deciding user.
    expect(() =>
      insert({
        id: '01FAKEPRS00000000000000000',
        status: 'expired',
        decided_at: iso,
        decided_by: 'local-user',
      }),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      insert({ id: '01FAKEPRT00000000000000000', status: 'expired', decided_at: iso }),
    ).not.toThrow();
    // An activation records both the agent and the version.
    expect(() =>
      insert({
        id: '01FAKEPRV00000000000000000',
        status: 'activated',
        decided_at: iso,
        decided_by: 'local-user',
        activated_agent_id: 'atlas',
      }),
    ).toThrow(/CHECK constraint failed/);

    // A rejected proposal can never be resurrected into an activation.
    database
      .prepare(
        "UPDATE hire_proposals SET status = 'rejected', decided_at = ?, decided_by = 'local-user' WHERE id = ?",
      )
      .run(iso, '01FAKEPRP00000000000000000');
    expect(() =>
      database
        .prepare("UPDATE hire_proposals SET status = 'activated' WHERE id = ?")
        .run('01FAKEPRP00000000000000000'),
    ).toThrow(/INVALID_STATE_TRANSITION/);
  });
});
