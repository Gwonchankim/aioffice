import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  agentDefinitionSchema,
  requestableAgentOriginSchema,
  type RequestableAgentOrigin,
} from '@orion/contracts';

import { MAX_REGISTERED_AGENTS } from '../src/config.js';
import { createDatabase, withImmediateTransaction } from '../src/database.js';
import { applyMigrations } from '../src/migrations.js';
import { ApplicationError } from '../src/errors.js';
import { AgentDefinitionRepository } from '../src/repositories/agent-definition-repository.js';
import {
  appendAgentAuditEntry,
  isBuiltinAgentId,
  workforceError,
} from '../src/repositories/agent-workforce-support.js';

const iso = '2026-07-27T00:00:00.000Z';

/** Migration 0007 seeds one definition per built-in agent. */
const SEEDED_DEFINITIONS = 18;

const cleanup: string[] = [];
const handles: Array<{ close: () => void }> = [];
const extraConnections: DatabaseSync[] = [];
afterEach(() => {
  extraConnections.splice(0).forEach((connection) => connection.close());
  handles.splice(0).forEach((handle) => handle.close());
  cleanup.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'orion-m3-agent-definitions-'));
  cleanup.push(directory);
  const databasePath = join(directory, 'orion.db');
  const handle = createDatabase(databasePath);
  handles.push(handle);
  applyMigrations(handle.database);
  return {
    database: handle.database,
    databasePath,
    repository: new AgentDefinitionRepository(handle.database, () => new Date(iso)),
  };
}

type Database = ReturnType<typeof setup>['database'];

function count(database: Database, sql: string, ...parameters: unknown[]): number {
  const row = database.prepare(sql).get(...(parameters as [])) as { count: number };
  return Number(row.count);
}

interface RegistryCounts {
  readonly definitions: number;
  readonly employments: number;
  readonly auditEntries: number;
}

function snapshotCounts(database: Database): RegistryCounts {
  return {
    definitions: count(database, 'SELECT COUNT(*) AS count FROM agent_definitions'),
    employments: count(database, 'SELECT COUNT(*) AS count FROM agent_employments'),
    auditEntries: count(database, 'SELECT COUNT(*) AS count FROM audit_log'),
  };
}

/** Asserts that `run` threw an `ApplicationError` and returns it for further checks. */
function expectApplicationError(run: () => unknown): ApplicationError {
  let caught: unknown;
  let threw = false;
  try {
    run();
  } catch (error) {
    threw = true;
    caught = error;
  }
  expect(threw).toBe(true);
  expect(caught).toBeInstanceOf(ApplicationError);
  return caught as ApplicationError;
}

/** A deterministic, schema-valid custom agent id (`agentIdSchema` needs 2-32 chars). */
function customId(index: number): string {
  return `custom-${String(index).padStart(3, '0')}`;
}

function createCustom(
  repository: AgentDefinitionRepository,
  index: number,
  origin: RequestableAgentOrigin = 'user_created',
  createdAt: string = iso,
) {
  return repository.create({
    id: customId(index),
    name: `Custom ${index}`,
    origin,
    createdBy: 'local-user',
    createdAt,
  });
}

describe('M3 AgentDefinitionRepository', () => {
  it('WFM-002: creating a custom agent stores the definition, a draft employment and one audit row', () => {
    const { database, repository } = setup();

    const definition = createCustom(repository, 1);

    expect(definition).toEqual({
      id: 'custom-001',
      name: 'Custom 1',
      origin: 'user_created',
      createdBy: 'local-user',
      createdAt: iso,
    });
    expect(repository.findById('custom-001')).toEqual(definition);
    expect(
      database
        .prepare(
          'SELECT state, active_version, last_active_version, revision FROM agent_employments WHERE agent_id = ?',
        )
        .get('custom-001'),
    ).toMatchObject({
      state: 'draft',
      active_version: null,
      last_active_version: null,
      revision: 1,
    });

    const auditRows = database
      .prepare(
        "SELECT actor, action, project_id, payload_json FROM audit_log WHERE action = 'agent.created'",
      )
      .all() as {
      actor: string;
      action: string;
      project_id: string | null;
      payload_json: string;
    }[];
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]!.project_id).toBeNull();
    expect(JSON.parse(auditRows[0]!.payload_json)).toEqual({
      agentId: 'custom-001',
      origin: 'user_created',
      employmentState: 'draft',
      registeredCount: SEEDED_DEFINITIONS + 1,
    });
  });

  it('WFM-029: the cap admits the 64th agent and rejects the 65th, and retirement never frees a slot', () => {
    const { database, repository } = setup();

    for (let index = 1; index <= MAX_REGISTERED_AGENTS - SEEDED_DEFINITIONS; index += 1) {
      createCustom(repository, index);
    }
    expect(repository.count()).toBe(MAX_REGISTERED_AGENTS);

    const before = snapshotCounts(database);
    const overflow = expectApplicationError(() =>
      createCustom(repository, MAX_REGISTERED_AGENTS - SEEDED_DEFINITIONS + 1),
    );
    expect(overflow.code).toBe('VALIDATION_FAILED');
    expect(overflow.statusCode).toBe(422);
    // The rejected 65th create leaves no partial row and no partial audit entry.
    expect(snapshotCounts(database)).toEqual(before);

    // Dismissal is a lifecycle transition, not a deletion: the slot stays taken.
    database
      .prepare("UPDATE agent_employments SET state = 'retired' WHERE agent_id = ?")
      .run(customId(1));
    expect(
      database.prepare('SELECT state FROM agent_employments WHERE agent_id = ?').get(customId(1)),
    ).toMatchObject({ state: 'retired' });
    expect(expectApplicationError(() => createCustom(repository, MAX_REGISTERED_AGENTS)).code).toBe(
      'VALIDATION_FAILED',
    );
    expect(repository.count()).toBe(MAX_REGISTERED_AGENTS);
  });

  it('WFM-029: the registration count and the insert are atomic against a second connection', () => {
    const { database, databasePath, repository } = setup();

    // Fill the registry to one slot below the cap.
    for (let index = 1; index <= MAX_REGISTERED_AGENTS - SEEDED_DEFINITIONS - 1; index += 1) {
      createCustom(repository, index);
    }
    expect(repository.count()).toBe(MAX_REGISTERED_AGENTS - 1);

    // A genuinely separate connection to the same database file. It keeps the
    // default zero busy timeout, so a contended write fails at once instead of
    // waiting, which is exactly the interleaving this test needs to observe.
    const second = new DatabaseSync(databasePath);
    extraConnections.push(second);
    second.exec('PRAGMA foreign_keys = ON;');
    const contender = new AgentDefinitionRepository(second, () => new Date(iso));

    // Connection A holds the write lock and takes the last free slot.
    database.exec('BEGIN IMMEDIATE');
    database
      .prepare(
        `INSERT INTO agent_definitions (id, name, origin, created_by, created_at)
         VALUES (?, 'Last Slot', 'user_created', 'local-user', ?)`,
      )
      .run(customId(900), iso);
    database
      .prepare(
        `INSERT INTO agent_employments (agent_id, state, active_version, last_active_version,
         activated_at, deactivated_at, actor, reason, revision, updated_at)
         VALUES (?, 'draft', NULL, NULL, NULL, NULL, 'local-user', NULL, 1, ?)`,
      )
      .run(customId(900), iso);

    // Connection B still sees 63 rows, but it cannot act on that number: its
    // own BEGIN IMMEDIATE is refused, so the count is never read outside the
    // write lock and no second writer can claim the same slot.
    expect(contender.count()).toBe(MAX_REGISTERED_AGENTS - 1);
    const blocked = expectApplicationError(() => createCustom(contender, 901));
    expect(blocked.code).toBe('DATABASE_UNAVAILABLE');
    expect(blocked.statusCode).toBe(503);
    expect(second.prepare('SELECT COUNT(*) AS count FROM agent_definitions').get()).toMatchObject({
      count: MAX_REGISTERED_AGENTS - 1,
    });

    database.exec('COMMIT');

    // Once A commits, B sees the full registry and is refused by the cap, so no
    // 65th row can exist on either path.
    expect(contender.count()).toBe(MAX_REGISTERED_AGENTS);
    expect(expectApplicationError(() => createCustom(contender, 901)).code).toBe(
      'VALIDATION_FAILED',
    );
    expect(repository.count()).toBe(MAX_REGISTERED_AGENTS);
  });

  it('WFM-003: a built-in id is refused by the service layer and by the database', () => {
    const { database, repository } = setup();
    const before = snapshotCounts(database);

    // Service layer: the stored `origin = 'builtin'` marks the id as reserved.
    const shadow = expectApplicationError(() =>
      repository.create({
        id: 'atlas',
        name: 'Shadow Atlas',
        origin: 'user_created',
        createdBy: 'local-user',
        createdAt: iso,
      }),
    );
    expect(shadow.code).toBe('VALIDATION_FAILED');
    expect(shadow.message).toContain('reserved by a built-in agent');
    expect(snapshotCounts(database)).toEqual(before);
    expect(isBuiltinAgentId(database, 'atlas')).toBe(true);
    expect(isBuiltinAgentId(database, 'custom-001')).toBe(false);

    // Database layer: the primary key refuses the same id even without the check.
    expect(() =>
      database
        .prepare(
          `INSERT INTO agent_definitions (id, name, origin, created_by, created_at)
           VALUES ('atlas', 'Shadow Atlas', 'user_created', 'local-user', ?)`,
        )
        .run(iso),
    ).toThrow(/UNIQUE constraint failed: agent_definitions\.id/);
    expect(snapshotCounts(database)).toEqual(before);
  });

  it('WFM-032: the builtin origin is unrepresentable for a created agent and reserved by the database', () => {
    const { database, repository } = setup();

    // The contract enum a request path may produce excludes `builtin` entirely,
    // so a request body naming it cannot parse.
    expect(requestableAgentOriginSchema.safeParse('builtin').success).toBe(false);
    for (const origin of ['user_created', 'manager_proposed', 'imported'] as const) {
      expect(requestableAgentOriginSchema.safeParse(origin).success).toBe(true);
    }

    // The stored definition contract is strict: an unknown field in a body is
    // rejected rather than ignored.
    expect(
      agentDefinitionSchema.safeParse({
        id: 'custom-001',
        name: 'Custom 1',
        origin: 'user_created',
        createdBy: 'local-user',
        createdAt: iso,
        unexpected: true,
      }).success,
    ).toBe(false);

    // Runtime defence for a caller that bypasses the compile-time type.
    const reserved = expectApplicationError(() =>
      repository.create({
        id: 'custom-002',
        name: 'Custom 2',
        origin: 'builtin' as unknown as RequestableAgentOrigin,
        createdBy: 'local-user',
        createdAt: iso,
      }),
    );
    expect(reserved.code).toBe('VALIDATION_FAILED');
    expect(repository.findById('custom-002')).toBeUndefined();

    // The origin actually stored is the server-decided one.
    for (const origin of ['user_created', 'manager_proposed', 'imported'] as const) {
      const created = repository.create({
        id: `origin-${origin.replace(/_/g, '-')}`,
        name: `Origin ${origin}`,
        origin,
        createdBy: 'local-user',
        createdAt: iso,
      });
      expect(created.origin).toBe(origin);
      expect(repository.findById(created.id)?.origin).toBe(origin);
    }

    // And `builtin` stays seed-only at the database level.
    expect(() =>
      database
        .prepare(
          `INSERT INTO agent_definitions (id, name, origin, created_by, created_at)
           VALUES ('custom-003', 'Custom 3', 'builtin', 'local-user', ?)`,
        )
        .run(iso),
    ).toThrow(/BUILTIN_ORIGIN_SEED_ONLY/);
  });

  it('WFM-032: definitions are append-only and the repository exposes no mutation method', () => {
    const { database, repository } = setup();
    createCustom(repository, 1);

    expect(() =>
      database
        .prepare("UPDATE agent_definitions SET name = 'Renamed' WHERE id = ?")
        .run('custom-001'),
    ).toThrow(/AGENT_DEFINITION_APPEND_ONLY/);
    expect(() =>
      database.prepare('DELETE FROM agent_definitions WHERE id = ?').run('custom-001'),
    ).toThrow(/AGENT_DEFINITION_APPEND_ONLY/);
    expect(repository.findById('custom-001')?.name).toBe('Custom 1');

    // There is no update/delete/rename/save entry point to attempt either with.
    for (const name of ['update', 'delete', 'remove', 'rename', 'save', 'upsert', 'setOrigin']) {
      expect(name in AgentDefinitionRepository.prototype).toBe(false);
    }
  });

  it('lists definitions in a total order and paginates without skipping or repeating', () => {
    const { repository } = setup();
    // The 18 seeded built-in definitions share the migration timestamp; the
    // customs are created afterwards, so `created_at ASC, id ASC` puts every
    // custom behind every built-in.
    for (let index = 1; index <= 5; index += 1) {
      createCustom(repository, index, 'user_created', `2026-07-27T01:0${index}:00.000Z`);
    }

    const all = repository.list();
    expect(all).toHaveLength(SEEDED_DEFINITIONS + 5);
    expect(
      all.slice(0, SEEDED_DEFINITIONS).every((definition) => definition.origin === 'builtin'),
    ).toBe(true);
    expect(all.slice(SEEDED_DEFINITIONS).map((definition) => definition.id)).toEqual([
      'custom-001',
      'custom-002',
      'custom-003',
      'custom-004',
      'custom-005',
    ]);

    // Paging walks the whole order without gaps or repeats, including across
    // the built-in/custom boundary.
    const pages: string[] = [];
    let cursorId: string | undefined;
    for (let page = 0; page < 12; page += 1) {
      const next = repository.list(cursorId === undefined ? { limit: 2 } : { limit: 2, cursorId });
      if (next.length === 0) {
        break;
      }
      pages.push(...next.map((definition) => definition.id));
      cursorId = next[next.length - 1]!.id;
    }
    expect(pages).toEqual(all.map((definition) => definition.id));

    expect(expectApplicationError(() => repository.list({ cursorId: 'no-such-agent' })).code).toBe(
      'VALIDATION_FAILED',
    );
    expect(expectApplicationError(() => repository.list({ limit: 0 })).code).toBe(
      'VALIDATION_FAILED',
    );
  });

  it('rejects a schema-invalid definition before touching the database', () => {
    const { database, repository } = setup();
    const before = snapshotCounts(database);

    for (const candidate of [
      { id: 'X', name: 'Bad Id' },
      { id: 'custom-001', name: '' },
    ]) {
      const error = expectApplicationError(() =>
        repository.create({
          id: candidate.id,
          name: candidate.name,
          origin: 'user_created',
          createdBy: 'local-user',
          createdAt: iso,
        }),
      );
      expect(error.code).toBe('VALIDATION_FAILED');
    }
    expect(snapshotCounts(database)).toEqual(before);
  });
});

describe('M3 agent workforce support', () => {
  it('maps every workforce trigger label to its transport error', () => {
    // An ApplicationError raised by the repository itself is never downgraded.
    const precise = new ApplicationError('NOT_FOUND', 'Already diagnosed.');
    expect(workforceError(precise)).toBe(precise);

    for (const label of [
      'AGENT_DEFINITION_APPEND_ONLY',
      'PROFILE_VERSIONS_APPEND_ONLY',
      'AGENT_EMPLOYMENT_APPEND_ONLY',
      'HIRE_PROPOSALS_APPEND_ONLY',
      'AUDIT_APPEND_ONLY',
      'INVALID_STATE_TRANSITION',
    ]) {
      const mapped = workforceError(new Error(`SqliteError: ${label}`));
      expect(mapped.code).toBe('INVALID_STATE_TRANSITION');
      expect(mapped.statusCode).toBe(409);
      expect(mapped.details).toBe(label);
    }

    for (const label of [
      'BUILTIN_ORIGIN_SEED_ONLY',
      'CUSTOM_VERSION_SPACE_VIOLATION',
      'BUILTIN_PROFILE_SPACE_VIOLATION',
      'AGENT_EMPLOYMENT_INITIAL_STATE',
      'ARCA_ACTIVATION_BLOCKED',
    ]) {
      const mapped = workforceError(new Error(`SqliteError: ${label}`));
      expect(mapped.code).toBe('VALIDATION_FAILED');
      expect(mapped.statusCode).toBe(422);
      expect(mapped.details).toBe(label);
    }

    const duplicate = workforceError(new Error('UNIQUE constraint failed: agent_definitions.id'), {
      agentId: 'zeta',
    });
    expect(duplicate.code).toBe('VALIDATION_FAILED');
    expect(duplicate.statusCode).toBe(422);
    expect(duplicate.message).toContain('agent "zeta"');

    const missingParent = workforceError(new Error('FOREIGN KEY constraint failed'), {
      proposalId: '01FAKEPRP00000000000000000',
    });
    expect(missingParent.code).toBe('NOT_FOUND');
    expect(missingParent.statusCode).toBe(404);
    expect(missingParent.message).toContain('proposal "01FAKEPRP00000000000000000"');

    const both = workforceError(new Error('database is locked'), {
      agentId: 'zeta',
      proposalId: '01FAKEPRP00000000000000000',
    });
    expect(both.code).toBe('DATABASE_UNAVAILABLE');
    expect(both.statusCode).toBe(503);
    expect(both.retryable).toBe(true);
    expect(both.message).toContain('agent "zeta" and proposal "01FAKEPRP00000000000000000"');

    // A non-Error value still produces a typed, subject-free failure.
    const unknown = workforceError('not an error');
    expect(unknown.code).toBe('DATABASE_UNAVAILABLE');
    expect(unknown.message).toContain('could not be persisted.');
  });

  it('WFM-022: rejects an audit payload that carries a secret, even nested', () => {
    const { database } = setup();
    const before = snapshotCounts(database);

    const forbidden: Record<string, unknown>[] = [
      { agentId: 'zeta', promptText: 'ignore all policies' },
      { agentId: 'zeta', context: { nested: { apiKey: 'value' } } },
      { agentId: 'zeta', bodies: [{ soulMarkdown: '# SOUL' }] },
      { agentId: 'zeta', 'access-token': 'value' },
      { agentId: 'zeta', raw_output: 'value' },
    ];
    for (const payload of forbidden) {
      const error = expectApplicationError(() =>
        appendAgentAuditEntry(
          database,
          { action: 'agent.created', actor: 'local-user', payload },
          () => new Date(iso),
        ),
      );
      expect(error.code).toBe('VALIDATION_FAILED');
    }

    // An unknown action is refused before anything is written.
    expect(
      expectApplicationError(() =>
        appendAgentAuditEntry(
          database,
          {
            action: 'agent.not_a_real_action' as unknown as 'agent.created',
            actor: 'local-user',
            payload: { agentId: 'zeta' },
          },
          () => new Date(iso),
        ),
      ).code,
    ).toBe('VALIDATION_FAILED');

    // A payload nested deeper than the hygiene check can inspect fails closed.
    let deep: Record<string, unknown> = { agentId: 'zeta' };
    for (let depth = 0; depth < 12; depth += 1) {
      deep = { level: deep };
    }
    expect(
      expectApplicationError(() =>
        appendAgentAuditEntry(
          database,
          { action: 'agent.created', actor: 'local-user', payload: deep },
          () => new Date(iso),
        ),
      ).code,
    ).toBe('VALIDATION_FAILED');

    expect(snapshotCounts(database)).toEqual(before);

    // A clean payload is appended as exactly one project-less row.
    const id = appendAgentAuditEntry(
      database,
      {
        action: 'agent.version_added',
        actor: 'local-user',
        payload: { agentId: 'zeta', version: 2, configSha256: 'a'.repeat(64) },
      },
      () => new Date(iso),
    );
    expect(
      database.prepare('SELECT actor, action, project_id FROM audit_log WHERE id = ?').get(id),
    ).toMatchObject({ actor: 'local-user', action: 'agent.version_added', project_id: null });
    expect(snapshotCounts(database).auditEntries).toBe(before.auditEntries + 1);
  });

  it('WFM-022: a failure rolls the state change and its audit row back together', () => {
    const { database } = setup();
    const before = snapshotCounts(database);

    expect(() =>
      withImmediateTransaction(database, () => {
        database
          .prepare(
            `INSERT INTO agent_definitions (id, name, origin, created_by, created_at)
             VALUES ('rollback-agent', 'Rollback', 'user_created', 'local-user', ?)`,
          )
          .run(iso);
        appendAgentAuditEntry(
          database,
          {
            action: 'agent.created',
            actor: 'local-user',
            payload: { agentId: 'rollback-agent' },
          },
          () => new Date(iso),
        );
        // Anything failing after the audit append must undo both writes.
        throw new Error('audit append and state change share one transaction');
      }),
    ).toThrow(/share one transaction/);

    expect(snapshotCounts(database)).toEqual(before);
    expect(
      count(
        database,
        'SELECT COUNT(*) AS count FROM agent_definitions WHERE id = ?',
        'rollback-agent',
      ),
    ).toBe(0);
  });

  it('WFM-022: audit rows are append-only', () => {
    const { database } = setup();
    appendAgentAuditEntry(
      database,
      { action: 'agent.created', actor: 'local-user', payload: { agentId: 'zeta' } },
      () => new Date(iso),
    );

    expect(() => database.prepare("UPDATE audit_log SET actor = 'other'").run()).toThrow(
      /AUDIT_APPEND_ONLY/,
    );
    expect(() => database.prepare('DELETE FROM audit_log').run()).toThrow(/AUDIT_APPEND_ONLY/);
  });
});
