import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import { createDatabase } from '../src/database.js';
import { applyMigrations, loadMigrations, migrationDirectory } from '../src/migrations.js';
import { workforceError } from '../src/repositories/agent-workforce-support.js';

/**
 * Migration 0010 — hire proposal envelope immutability (plan-delta-005 §7).
 *
 * Ten columns are written once at INSERT and describe what was proposed and
 * when. `BEFORE UPDATE OF <cols>` with no WHEN clause fires whenever the SET
 * clause mentions one of them, even if the value is unchanged, so there is no
 * "write it back identically" path around the guard.
 *
 * SCOPE. This is defense-in-depth against repository/service defects and
 * after-the-fact UPDATE tampering. It does not block an arbitrary same-user DB
 * writer, INSERT forgery, or audit_log INSERT forgery, and the tests below
 * assert nothing of the sort.
 */

const cleanup: string[] = [];
const handles: Array<{ close: () => void }> = [];
afterEach(() => {
  handles.splice(0).forEach((handle) => handle.close());
  cleanup.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});

const iso = '2026-07-27T00:00:00.000Z';
const expiry = '2026-07-27T00:30:00.000Z';

/** The 10 create-only columns 0010 locks. */
const IMMUTABLE_COLUMNS = [
  'id',
  'requested_by',
  'authored_by',
  'proposed_agent_id',
  'proposed_definition_json',
  'proposed_profile_json',
  'validation_json',
  'proposal_sha256',
  'created_at',
  'expires_at',
] as const;

/** The 5 lifecycle columns that must stay writable. */
const MUTABLE_COLUMNS = [
  'status',
  'decided_at',
  'decided_by',
  'activated_agent_id',
  'activated_version',
] as const;

function databaseAt(version: number, label: string) {
  const directory = mkdtempSync(join(tmpdir(), `orion-m3-envelope-${label}-`));
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
  const directory = mkdtempSync(join(tmpdir(), 'orion-m3-envelope-'));
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

let nextProposalSuffix = 0;

function insertProposal(database: Database): string {
  nextProposalSuffix += 1;
  const proposalId = `envelope-${nextProposalSuffix}`;
  database
    .prepare(
      `INSERT INTO hire_proposals (
         id, requested_by, authored_by, proposed_agent_id,
         proposed_definition_json, proposed_profile_json, validation_json,
         proposal_sha256, status, created_at, expires_at,
         decided_at, decided_by, activated_agent_id, activated_version
       ) VALUES (?, 'local-user', 'nova', ?, '{"id":"x"}', '{"agentId":"x"}', '{"status":"pass"}',
                 ?, 'pending_approval', ?, ?, NULL, NULL, NULL, NULL)`,
    )
    .run(proposalId, `agent-${nextProposalSuffix}`, `sha-${nextProposalSuffix}`, iso, expiry);
  return proposalId;
}

/** Runs one UPDATE and reports the raised message, if any. */
function raised(run: () => void): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** A syntactically valid replacement value of the right type for each column. */
function tamperValue(column: string): string | number {
  if (column === 'activated_version') {
    return 99;
  }
  if (column === 'created_at' || column === 'expires_at') {
    return '2030-01-01T00:00:00.000Z';
  }
  return 'tampered';
}

describe('M3 migration 0010 — hire proposal envelope immutability', () => {
  it('applies 0001..0010 on a fresh database and leaves 0007..0009 byte-identical', () => {
    const database = setup();
    expect(count(database, 'SELECT COUNT(*) AS count FROM schema_migrations')).toBe(10);

    const applied = database
      .prepare('SELECT version, name FROM schema_migrations ORDER BY version')
      .all() as { version: number; name: string }[];
    expect(applied[9]).toMatchObject({
      version: 10,
      name: '0010_m3_hire_proposal_envelope_immutability.sql',
    });

    const pinned: Record<string, string> = {
      '0007_m3_agent_workforce.sql':
        '2cef10ef9c91913b546e57103e7f036e1bb425e2f2ed8e1f28175af5a3ad1f03',
      '0008_m3_agent_employment_self_transition_guard.sql':
        '927fb497e29ee03e3fa5053c88e8e138e1e8f59705eb92c4e53010c2d62e1d32',
    };
    for (const [name, digest] of Object.entries(pinned)) {
      const sql = readFileSync(join(migrationDirectory(), name), 'utf8');
      expect(createHash('sha256').update(sql).digest('hex'), name).toBe(digest);
    }
  });

  it('adds exactly one trigger between <= 9 and <= 10 and changes none', () => {
    // Both sides pinned to a version, so this measures 0010 and nothing later.
    const before = triggers(databaseAt(9, 'before'));
    const after = triggers(databaseAt(10, 'after'));

    const beforeByName = new Map(before.map((row) => [row.name, row.sql]));
    const added = after.filter((row) => !beforeByName.has(row.name));
    const changed = after.filter(
      (row) => beforeByName.has(row.name) && beforeByName.get(row.name) !== row.sql,
    );
    const removed = before.filter((row) => !after.some((other) => other.name === row.name));

    expect(added.map((row) => row.name)).toEqual(['hire_proposals_envelope_immutable']);
    expect(changed).toEqual([]);
    expect(removed).toEqual([]);
    expect(after).toHaveLength(before.length + 1);
    expect(added[0]!.sql).toContain('HIRE_PROPOSAL_ENVELOPE_IMMUTABLE');
  });

  it('rejects an UPDATE of each of the 10 immutable columns', () => {
    const database = setup();

    for (const column of IMMUTABLE_COLUMNS) {
      const proposalId = insertProposal(database);
      const before = database.prepare('SELECT * FROM hire_proposals WHERE id = ?').get(proposalId);

      const message = raised(() =>
        database
          .prepare(`UPDATE hire_proposals SET ${column} = ? WHERE id = ?`)
          .run(tamperValue(column), proposalId),
      );

      expect(message, `${column} must be immutable`).toContain('HIRE_PROPOSAL_ENVELOPE_IMMUTABLE');
      expect(
        database.prepare('SELECT * FROM hire_proposals WHERE id = ?').get(proposalId),
        `${column} rollback`,
      ).toEqual(before);
    }
  });

  it('rejects a same-value no-op UPDATE on an existing row', () => {
    // The row really exists and the value really is unchanged: `BEFORE UPDATE OF`
    // fires on the SET clause, not on a value difference. This is the case a
    // `changes = 0` assertion would wrongly report as success.
    const database = setup();
    const proposalId = insertProposal(database);

    expect(
      count(database, 'SELECT COUNT(*) AS count FROM hire_proposals WHERE id = ?', proposalId),
    ).toBe(1);

    for (const column of IMMUTABLE_COLUMNS) {
      const message = raised(() =>
        database
          .prepare(`UPDATE hire_proposals SET ${column} = ${column} WHERE id = ?`)
          .run(proposalId),
      );
      expect(message, `${column} self-assignment`).toContain('HIRE_PROPOSAL_ENVELOPE_IMMUTABLE');
    }

    const message = raised(() =>
      database
        .prepare('UPDATE hire_proposals SET proposal_sha256 = ? WHERE id = ?')
        .run(`sha-${nextProposalSuffix}`, proposalId),
    );
    expect(message, 'literal same value').toContain('HIRE_PROPOSAL_ENVELOPE_IMMUTABLE');
  });

  it('does not count a zero-row UPDATE as evidence that the trigger fired', () => {
    // An UPDATE matching no row raises nothing at all. Recorded explicitly so a
    // future edit cannot pass this suite by targeting an id that does not exist.
    const database = setup();
    insertProposal(database);

    const message = raised(() =>
      database
        .prepare('UPDATE hire_proposals SET proposal_sha256 = ? WHERE id = ?')
        .run('tampered', 'no-such-proposal'),
    );
    expect(message).toBeUndefined();

    // ...whereas the same statement against a real row is refused.
    const proposalId = insertProposal(database);
    expect(
      raised(() =>
        database
          .prepare('UPDATE hire_proposals SET proposal_sha256 = ? WHERE id = ?')
          .run('tampered', proposalId),
      ),
    ).toContain('HIRE_PROPOSAL_ENVELOPE_IMMUTABLE');
  });

  it('keeps the 5 lifecycle columns writable through a normal proposal lifecycle', () => {
    const database = setup();
    const proposalId = insertProposal(database);

    // pending_approval -> approved
    expect(
      raised(() =>
        database
          .prepare(
            "UPDATE hire_proposals SET status = 'approved', decided_at = ?, decided_by = 'local-user' WHERE id = ?",
          )
          .run(iso, proposalId),
      ),
    ).toBeUndefined();

    // approved -> activated
    expect(
      raised(() =>
        database
          .prepare(
            "UPDATE hire_proposals SET status = 'activated', activated_agent_id = 'atlas', activated_version = 2 WHERE id = ?",
          )
          .run(proposalId),
      ),
    ).toBeUndefined();

    expect(
      database
        .prepare(
          'SELECT status, decided_by, activated_agent_id, activated_version FROM hire_proposals WHERE id = ?',
        )
        .get(proposalId),
    ).toEqual({
      status: 'activated',
      decided_by: 'local-user',
      activated_agent_id: 'atlas',
      activated_version: 2,
    });

    // Each mutable column on its own is accepted by 0010 as well; `status` is
    // excluded here because 0009 governs which status values may follow.
    //
    // The values below keep the 0007 CHECKs satisfied for an `approved` row:
    // `decided_at`/`decided_by` must stay non-null, and `activated_*` must stay
    // null until the row really reaches `activated`. A CHECK failure here would
    // say nothing about 0010, which is the property under test.
    const mutableValue: Record<string, string | number | null> = {
      decided_at: '2026-07-27T00:05:00.000Z',
      decided_by: 'another-user',
      activated_agent_id: null,
      activated_version: null,
    };
    for (const column of MUTABLE_COLUMNS.filter((name) => name !== 'status')) {
      const other = insertProposal(database);
      database
        .prepare(
          "UPDATE hire_proposals SET status = 'approved', decided_at = ?, decided_by = 'local-user' WHERE id = ?",
        )
        .run(iso, other);
      expect(
        raised(() =>
          database
            .prepare(`UPDATE hire_proposals SET ${column} = ? WHERE id = ?`)
            .run(mutableValue[column] ?? null, other),
        ),
        `${column} must stay mutable`,
      ).toBeUndefined();
    }
  });

  it('rejects a mixed UPDATE that touches an immutable column alongside a mutable one', () => {
    const database = setup();
    const proposalId = insertProposal(database);
    const before = database.prepare('SELECT * FROM hire_proposals WHERE id = ?').get(proposalId);

    const message = raised(() =>
      database
        .prepare(
          `UPDATE hire_proposals
           SET status = 'approved', decided_at = ?, decided_by = 'local-user', proposal_sha256 = 'tampered'
           WHERE id = ?`,
        )
        .run(iso, proposalId),
    );

    expect(message).toContain('HIRE_PROPOSAL_ENVELOPE_IMMUTABLE');
    // The legal half of the statement is rolled back with the illegal half.
    expect(database.prepare('SELECT * FROM hire_proposals WHERE id = ?').get(proposalId)).toEqual(
      before,
    );
  });

  it('maps the trigger label to the existing 409 conflict, adding no public error code', () => {
    const database = setup();
    const proposalId = insertProposal(database);

    let caught: unknown;
    try {
      database
        .prepare('UPDATE hire_proposals SET proposal_sha256 = ? WHERE id = ?')
        .run('tampered', proposalId);
    } catch (error) {
      caught = error;
    }

    const mapped = workforceError(caught, { proposalId });
    expect(mapped.code).toBe('INVALID_STATE_TRANSITION');
    expect(mapped.statusCode).toBe(409);
    expect(mapped.details).toBe('HIRE_PROPOSAL_ENVELOPE_IMMUTABLE');
  });

  it('WFM-MIG-002 stays enforced: 0010 does not loosen the 0009 status guard', () => {
    const database = setup();
    const proposalId = insertProposal(database);

    expect(
      raised(() =>
        database
          .prepare("UPDATE hire_proposals SET status = 'pending_approval' WHERE id = ?")
          .run(proposalId),
      ),
    ).toContain('INVALID_STATE_TRANSITION');
  });

  it('keeps the repository free of INSERT OR REPLACE / INSERT OR IGNORE on the guarded tables', () => {
    // `INSERT OR REPLACE` is DELETE+INSERT in SQLite: it does not fire
    // `BEFORE UPDATE OF` triggers, so it would walk straight past 0010 and past
    // the audit_log append-only guard. The repository must not use it on either
    // table. An arbitrary DB writer running REPLACE directly is out of what 0010
    // claims to stop; that case stays an open finding.
    const directory = join(migrationDirectory(), '..', 'apps', 'server', 'src', 'repositories');
    const offenders: string[] = [];
    for (const name of readdirSync(directory).filter((file) => file.endsWith('.ts'))) {
      const source = readFileSync(join(directory, name), 'utf8');
      if (/INSERT\s+OR\s+(REPLACE|IGNORE)/i.test(source)) {
        offenders.push(name);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('changes no seed, profile, employment or proposal row', () => {
    const before = databaseAt(9, 'rows');
    const beforeProfiles = before
      .prepare('SELECT id, version, config_sha256 FROM agent_profiles ORDER BY id, version')
      .all();
    const beforeEmployments = before
      .prepare(
        'SELECT agent_id, state, active_version, last_active_version, revision FROM agent_employments ORDER BY agent_id',
      )
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
    expect(beforeProfiles).toHaveLength(36);
    expect(count(database, 'SELECT COUNT(*) AS count FROM agent_employments')).toBe(18);
    expect(count(database, 'SELECT COUNT(*) AS count FROM hire_proposals')).toBe(0);
  });

  it('re-applying the migrations is a no-op that neither duplicates nor re-runs 0010', () => {
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
    expect(count(database, 'SELECT COUNT(*) AS count FROM schema_migrations')).toBe(10);
  });
});
