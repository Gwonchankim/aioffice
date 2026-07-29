import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import { createDatabase } from '../src/database.js';
import { applyMigrations, loadMigrations, migrationDirectory } from '../src/migrations.js';

/**
 * Migration 0009 — hire proposal self-transition guard (WFM-MIG-002,
 * plan-delta-005 §1).
 *
 * The 0007 guard carried a `NEW.status <> OLD.status` term that let a
 * same-status UPDATE slip past the RAISE, so all six proposal self-transitions
 * were accepted by the database. It is the same defect 0008 removed from the
 * employment guard, still present on the proposal side. 0009 drops the term.
 *
 * Six statuses give 36 ordered pairs: 7 allowed, 29 rejected, and the 6
 * self-transitions all belong to the rejected 29.
 */

const cleanup: string[] = [];
const handles: Array<{ close: () => void }> = [];
afterEach(() => {
  handles.splice(0).forEach((handle) => handle.close());
  cleanup.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});

const iso = '2026-07-27T00:00:00.000Z';
const expiry = '2026-07-27T00:30:00.000Z';

const STATUSES = [
  'pending_approval',
  'approved',
  'rejected',
  'expired',
  'activated',
  'invalidated',
] as const;
type Status = (typeof STATUSES)[number];

/** The 7 transitions 0007 permits; 0009 leaves the allow-list untouched. */
const ALLOWED_PAIRS: readonly `${Status}->${Status}`[] = [
  'pending_approval->approved',
  'pending_approval->rejected',
  'pending_approval->expired',
  'pending_approval->invalidated',
  'approved->activated',
  'approved->expired',
  'approved->invalidated',
];

/**
 * The triggers 0008 leaves behind, minus the one 0009 replaces. The
 * whole-schema comparison below is the real completeness check; this list only
 * pins the workforce triggers by name.
 */
const NON_TARGET_TRIGGERS: readonly string[] = [
  'agent_definitions_append_only_delete',
  'agent_definitions_append_only_update',
  'agent_definitions_builtin_seed_only',
  'agent_employments_append_only_delete',
  'agent_employments_arca_blocked',
  'agent_employments_initial_state',
  'agent_employments_transition_guard',
  'agent_profile_versions_append_only_delete',
  'agent_profile_versions_append_only_update',
  'agent_profile_versions_custom_space',
  'agent_profiles_builtin_space',
  'hire_proposals_append_only_delete',
];

function databaseAt(version: number, label: string) {
  const directory = mkdtempSync(join(tmpdir(), `orion-m3-proposal-guard-${label}-`));
  cleanup.push(directory);
  const handle = createDatabase(join(directory, 'orion.db'));
  handles.push(handle);
  applyMigrations(
    handle.database,
    loadMigrations().filter((migration) => migration.version <= version),
  );
  return handle.database;
}

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'orion-m3-proposal-guard-'));
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

function triggers(database: Database): { name: string; sql: string }[] {
  return database
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
    .all() as { name: string; sql: string }[];
}

/**
 * Column values every target status needs so the 0007 CHECKs are satisfied.
 * Without this, a rejected pair could fail on a CHECK instead of the trigger and
 * the assertion would prove nothing about the guard. `expired` is the
 * non-obvious row: `CHECK(status <> 'expired' OR decided_by IS NULL)` (0007:56)
 * forces `decided_by` back to NULL even when coming from `approved`.
 */
function columnsFor(to: Status): {
  decidedAt: string | null;
  decidedBy: string | null;
  activatedAgentId: string | null;
  activatedVersion: number | null;
} {
  if (to === 'pending_approval') {
    return { decidedAt: null, decidedBy: null, activatedAgentId: null, activatedVersion: null };
  }
  if (to === 'expired') {
    return { decidedAt: iso, decidedBy: null, activatedAgentId: null, activatedVersion: null };
  }
  if (to === 'activated') {
    // `activated_agent_id` carries a FK to agent_definitions, so it must name a
    // row that really exists: the 0007 builtin seed provides one.
    return {
      decidedAt: iso,
      decidedBy: 'local-user',
      activatedAgentId: 'atlas',
      activatedVersion: 2,
    };
  }
  return {
    decidedAt: iso,
    decidedBy: 'local-user',
    activatedAgentId: null,
    activatedVersion: null,
  };
}

let nextProposalSuffix = 0;

function moveTo(database: Database, proposalId: string, to: Status): void {
  const columns = columnsFor(to);
  database
    .prepare(
      `UPDATE hire_proposals
       SET status = ?, decided_at = ?, decided_by = ?, activated_agent_id = ?, activated_version = ?
       WHERE id = ?`,
    )
    .run(
      to,
      columns.decidedAt,
      columns.decidedBy,
      columns.activatedAgentId,
      columns.activatedVersion,
      proposalId,
    );
}

/**
 * Creates a fresh proposal sitting in `status`, reached only through legal
 * edges from the mandatory `pending_approval` starting point. `activated` is the
 * only two-hop case: pending_approval -> approved -> activated.
 *
 * A fresh row per case keeps each ordered pair independent. Reusing one row
 * would need an illegal reset edge such as `approved -> pending_approval`, which
 * is exactly what is under test.
 */
function proposalIn(database: Database, status: Status): string {
  nextProposalSuffix += 1;
  const proposalId = `proposal-${nextProposalSuffix}`;
  database
    .prepare(
      `INSERT INTO hire_proposals (
         id, requested_by, authored_by, proposed_agent_id,
         proposed_definition_json, proposed_profile_json, validation_json,
         proposal_sha256, status, created_at, expires_at,
         decided_at, decided_by, activated_agent_id, activated_version
       ) VALUES (?, 'local-user', 'nova', ?, '{}', '{}', '{}', ?, 'pending_approval', ?, ?,
                 NULL, NULL, NULL, NULL)`,
    )
    .run(proposalId, `agent-${nextProposalSuffix}`, `sha-${nextProposalSuffix}`, iso, expiry);

  if (status === 'activated') {
    moveTo(database, proposalId, 'approved');
    moveTo(database, proposalId, 'activated');
  } else if (status !== 'pending_approval') {
    moveTo(database, proposalId, status);
  }
  return proposalId;
}

/** Attempts one ordered pair by direct SQL and reports the raised label, if any. */
function attempt(database: Database, from: Status, to: Status): string | undefined {
  const proposalId = proposalIn(database, from);
  try {
    moveTo(database, proposalId, to);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe('M3 migration 0009 — hire proposal self-transition guard', () => {
  it('applies 0001..0009 on a fresh database and leaves 0007 and 0008 byte-identical', () => {
    const database = setup();
    expect(count(database, 'SELECT COUNT(*) AS count FROM schema_migrations')).toBe(9);

    const applied = database
      .prepare('SELECT version, name FROM schema_migrations ORDER BY version')
      .all() as { version: number; name: string }[];
    expect(applied[8]).toMatchObject({
      version: 9,
      name: '0009_m3_hire_proposal_self_transition_guard.sql',
    });

    // 0007 and 0008 are frozen: their content hashes are pinned by
    // plan-delta-005 §7 item 7.
    const sql0007 = readFileSync(join(migrationDirectory(), '0007_m3_agent_workforce.sql'), 'utf8');
    expect(createHash('sha256').update(sql0007).digest('hex')).toBe(
      '2cef10ef9c91913b546e57103e7f036e1bb425e2f2ed8e1f28175af5a3ad1f03',
    );
    const sql0008 = readFileSync(
      join(migrationDirectory(), '0008_m3_agent_employment_self_transition_guard.sql'),
      'utf8',
    );
    expect(createHash('sha256').update(sql0008).digest('hex')).toBe(
      '927fb497e29ee03e3fa5053c88e8e138e1e8f59705eb92c4e53010c2d62e1d32',
    );
  });

  it('replaces exactly one trigger between <= 8 and <= 9 and leaves every other one untouched', () => {
    // Both sides are pinned to a version: `before` at 0008 and `after` at 0009.
    // Comparing against a full `setup()` would silently start measuring 0010 and
    // anything later instead of this migration (plan-delta-005 §1).
    const before = triggers(databaseAt(8, 'before'));
    const after = triggers(databaseAt(9, 'after'));

    expect(after.map((row) => row.name)).toEqual(before.map((row) => row.name));
    const changed = after.filter((row, index) => row.sql !== before[index]!.sql);
    expect(changed.map((row) => row.name)).toEqual(['hire_proposals_transition_guard']);

    const names = after.map((row) => row.name);
    for (const trigger of NON_TARGET_TRIGGERS) {
      expect(names, `${trigger} must survive 0009`).toContain(trigger);
    }
    expect(names.filter((name) => name === 'hire_proposals_transition_guard')).toHaveLength(1);

    // The replacement no longer carries the term that let self-transitions pass,
    // and the predecessor demonstrably did.
    expect(changed[0]!.sql).not.toContain('NEW.status <> OLD.status');
    expect(changed[0]!.sql).toContain('INVALID_STATE_TRANSITION');
    expect(before.find((row) => row.name === 'hire_proposals_transition_guard')!.sql).toContain(
      'NEW.status <> OLD.status',
    );
  });

  it('WFM-MIG-002: accepts exactly the 7 allowed pairs and rejects the other 29', () => {
    const database = setup();

    const accepted: string[] = [];
    const rejected: string[] = [];
    for (const from of STATUSES) {
      for (const to of STATUSES) {
        const failure = attempt(database, from, to);
        const pair = `${from}->${to}`;
        if (failure === undefined) {
          accepted.push(pair);
        } else {
          rejected.push(pair);
          // Every rejection uses the existing error contract; no new label.
          expect(failure, pair).toContain('INVALID_STATE_TRANSITION');
          // The BEFORE trigger runs ahead of constraint evaluation, so a
          // rejected pair must never surface as a CHECK failure instead.
          expect(failure, pair).not.toContain('CHECK constraint failed');
        }
      }
    }

    expect(accepted.sort()).toEqual([...ALLOWED_PAIRS].sort());
    expect(accepted).toHaveLength(7);
    expect(rejected).toHaveLength(29);
    expect(accepted.length + rejected.length).toBe(36);
  });

  it('WFM-MIG-002: rejects all six self-transitions, the case 0007 let through', () => {
    const database = setup();

    for (const status of STATUSES) {
      const failure = attempt(database, status, status);
      expect(failure, `${status}->${status} must be rejected`).toContain(
        'INVALID_STATE_TRANSITION',
      );
      expect(failure, `${status}->${status}`).not.toContain('CHECK constraint failed');
    }
  });

  it('demonstrates the defect: a <= 8 database still accepts a proposal self-transition', () => {
    // Recorded as the reason 0009 exists, not as an accepted behaviour: the same
    // pair is refused above on a 0009 database.
    const database = databaseAt(8, 'defect');
    const proposalId = proposalIn(database, 'pending_approval');

    expect(() => moveTo(database, proposalId, 'pending_approval')).not.toThrow();
    expect(
      database.prepare('SELECT status FROM hire_proposals WHERE id = ?').get(proposalId),
    ).toEqual({ status: 'pending_approval' });
  });

  it('leaves a rejected proposal row completely unchanged', () => {
    const database = setup();
    const proposalId = proposalIn(database, 'approved');
    const before = database.prepare('SELECT * FROM hire_proposals WHERE id = ?').get(proposalId);

    expect(() => moveTo(database, proposalId, 'pending_approval')).toThrowError(
      /INVALID_STATE_TRANSITION/,
    );

    expect(database.prepare('SELECT * FROM hire_proposals WHERE id = ?').get(proposalId)).toEqual(
      before,
    );
  });

  it('changes no seed, profile, employment or proposal row', () => {
    const before = databaseAt(8, 'rows');
    const beforeProfiles = before
      .prepare('SELECT id, version, config_sha256 FROM agent_profiles ORDER BY id, version')
      .all();
    const beforeEmployments = before
      .prepare(
        'SELECT agent_id, state, active_version, last_active_version, revision FROM agent_employments ORDER BY agent_id',
      )
      .all();
    const beforeDefinitions = before
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
    expect(count(database, 'SELECT COUNT(*) AS count FROM hire_proposals')).toBe(0);
  });

  it('re-applying the migrations is a no-op that neither duplicates nor re-runs 0009', () => {
    const database = setup();
    const triggersBefore = triggers(database);
    const appliedBefore = database
      .prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version')
      .all();

    applyMigrations(database);
    applyMigrations(database);

    expect(triggers(database)).toEqual(triggersBefore);
    expect(
      database
        .prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version')
        .all(),
    ).toEqual(appliedBefore);
    expect(count(database, 'SELECT COUNT(*) AS count FROM schema_migrations')).toBe(9);
    expect(count(database, 'SELECT COUNT(*) AS count FROM agent_employments')).toBe(18);
  });

  it('fails closed and applies nothing when the predecessor trigger is missing', () => {
    const database = databaseAt(8, 'drift');
    // Simulate drift: the guard 0009 expects to replace is gone.
    database.exec('DROP TRIGGER hire_proposals_transition_guard');

    expect(() => applyMigrations(database)).toThrowError(/migration/i);

    // Nothing partial: 0009 is not recorded and no replacement trigger appeared.
    expect(count(database, 'SELECT COUNT(*) AS count FROM schema_migrations')).toBe(8);
    expect(
      count(
        database,
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name = 'hire_proposals_transition_guard'",
      ),
    ).toBe(0);
    // The rest of the schema and its data are untouched by the failed attempt.
    expect(count(database, 'SELECT COUNT(*) AS count FROM agent_employments')).toBe(18);
    expect(count(database, 'SELECT COUNT(*) AS count FROM agent_profiles')).toBe(36);
  });
});
