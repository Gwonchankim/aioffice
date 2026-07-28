import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { ulid } from 'ulid';
import { afterEach, describe, expect, it } from 'vitest';
import {
  allowedEmploymentTransitions,
  type EmploymentAction,
  type EmploymentState,
  type RuntimeSelection,
} from '@orion/contracts';

import { createDatabase, withImmediateTransaction } from '../src/database.js';
import { applyMigrations } from '../src/migrations.js';
import { ApplicationError } from '../src/errors.js';
import { AgentDefinitionRepository } from '../src/repositories/agent-definition-repository.js';
import { AgentProfileVersionRepository } from '../src/repositories/agent-profile-version-repository.js';
import { AgentRegistryReadModel } from '../src/repositories/agent-registry-read-model.js';
import { AgentEmploymentRepository } from '../src/repositories/agent-employment-repository.js';
import { ProjectRepository } from '../src/repositories/project-repository.js';
import { PlanningRunRepository } from '../src/repositories/planning-run-repository.js';

/**
 * M3 `AgentEmploymentRepository` (plan-delta-003 §2.3/§3,
 * WFM-005/006/020/022/024/028/031).
 *
 * The employment row is the sole runtime authority for "may this agent be
 * planned or spawned", so these tests pin both halves of every guard: what the
 * service refuses, and what the database refuses when the same thing is
 * attempted by direct SQL. Since migration 0008 those two sets finally agree on
 * all nine rejected ordered pairs, self transitions included.
 */

const iso = '2026-07-27T00:00:00.000Z';

const SOUL = '# SOUL\nI review changes carefully and never weaken a gate.\n';

const OVERRIDE_SELECTION: RuntimeSelection = {
  selectionMode: 'override',
  selectionSource: 'user',
  provider: 'openai',
  model: 'gpt-5.6-sol',
  reasoningEffort: 'high',
  fallbackModels: [],
};

const STATES = ['draft', 'active', 'suspended', 'retired'] as const;

/** The 7 transitions plan-delta-003 §3 permits; every other ordered pair is rejected. */
const ALLOWED_PAIRS: readonly `${EmploymentState}->${EmploymentState}`[] = [
  'draft->active',
  'draft->retired',
  'active->suspended',
  'active->retired',
  'suspended->active',
  'suspended->retired',
  'retired->active',
];

const cleanup: string[] = [];
const handles: Array<{ close: () => void }> = [];
const extraConnections: DatabaseSync[] = [];
afterEach(() => {
  extraConnections.splice(0).forEach((connection) => connection.close());
  handles.splice(0).forEach((handle) => handle.close());
  cleanup.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'orion-m3-agent-employment-'));
  cleanup.push(directory);
  const databasePath = join(directory, 'orion.db');
  const handle = createDatabase(databasePath);
  handles.push(handle);
  applyMigrations(handle.database);
  const now = () => new Date(iso);
  const registry = new AgentRegistryReadModel(handle.database);
  return {
    database: handle.database,
    databasePath,
    registry,
    definitions: new AgentDefinitionRepository(handle.database, now),
    versions: new AgentProfileVersionRepository(handle.database, now),
    employments: new AgentEmploymentRepository(handle.database, registry, now),
  };
}

type Harness = ReturnType<typeof setup>;
type Database = Harness['database'];

function count(database: Database, sql: string, ...parameters: unknown[]): number {
  const row = database.prepare(sql).get(...(parameters as [])) as { count: number };
  return Number(row.count);
}

interface WorkforceCounts {
  readonly definitions: number;
  readonly employments: number;
  readonly profileVersions: number;
  readonly auditEntries: number;
}

function snapshotCounts(database: Database): WorkforceCounts {
  return {
    definitions: count(database, 'SELECT COUNT(*) AS count FROM agent_definitions'),
    employments: count(database, 'SELECT COUNT(*) AS count FROM agent_employments'),
    profileVersions: count(database, 'SELECT COUNT(*) AS count FROM agent_profile_versions'),
    auditEntries: count(database, 'SELECT COUNT(*) AS count FROM audit_log'),
  };
}

function employmentRow(database: Database, agentId: string): Record<string, unknown> {
  return database
    .prepare(
      `SELECT state, active_version, last_active_version, activated_at, deactivated_at, actor, reason, revision, updated_at
       FROM agent_employments WHERE agent_id = ?`,
    )
    .get(agentId) as Record<string, unknown>;
}

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

let nextAgentSuffix = 0;

/** A custom agent with `versionCount` stored versions and a `draft` employment. */
function customAgent(harness: Harness, versionCount = 1): string {
  nextAgentSuffix += 1;
  const agentId = `zeta-${nextAgentSuffix}`;
  harness.definitions.create({
    id: agentId,
    name: 'Zeta',
    origin: 'user_created',
    createdBy: 'local-user',
    createdAt: iso,
  });
  for (let version = 1; version <= versionCount; version += 1) {
    addVersion(harness, agentId, version);
  }
  return agentId;
}

function addVersion(harness: Harness, agentId: string, version: number): void {
  harness.versions.appendVersion({
    agentId,
    version,
    config: { id: agentId, version, description: 'a custom agent profile body' },
    soulMarkdown: SOUL,
    runtimeSelection: OVERRIDE_SELECTION,
    createdBy: 'local-user',
    createdAt: iso,
  });
}

function currentRevision(harness: Harness, agentId: string): number {
  const employment = harness.employments.findByAgentId(agentId);
  expect(employment).toBeDefined();
  return employment!.revision;
}

function act(
  harness: Harness,
  agentId: string,
  action: EmploymentAction,
  extra: { version?: number; actor?: string } = {},
) {
  return harness.employments.transition({
    agentId,
    action,
    expectedRevision: currentRevision(harness, agentId),
    actor: extra.actor ?? 'local-user',
    ...(extra.version === undefined ? {} : { version: extra.version }),
  });
}

/**
 * A fresh custom agent sitting in `state`, reached **through the service** and
 * only over legal edges. A fresh agent per case is what keeps each ordered pair
 * independent: reusing one row would need an illegal reset edge, which is the
 * very thing under test.
 */
function reach(harness: Harness, state: EmploymentState, versionCount = 1): string {
  const agentId = customAgent(harness, versionCount);
  if (state === 'retired') {
    act(harness, agentId, 'dismiss');
  } else if (state === 'active' || state === 'suspended') {
    act(harness, agentId, 'hire', { version: 1 });
    if (state === 'suspended') {
      act(harness, agentId, 'suspend');
    }
  }
  expect(harness.employments.findByAgentId(agentId)?.state).toBe(state);
  return agentId;
}

/**
 * The same starting point built with direct SQL, for the database half of the
 * guard. It bypasses the repository on purpose — that is the attack the trigger
 * has to stop — but still only walks legal edges to get there.
 */
function sqlAgentIn(database: Database, state: EmploymentState): string {
  nextAgentSuffix += 1;
  const agentId = `raw-${nextAgentSuffix}`;
  database
    .prepare(
      `INSERT INTO agent_definitions (id, name, origin, created_by, created_at)
       VALUES (?, 'Raw', 'user_created', 'local-user', ?)`,
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

/** Attempts one ordered pair by direct SQL and returns the raised message, if any. */
function sqlAttempt(
  database: Database,
  from: EmploymentState,
  to: EmploymentState,
): string | undefined {
  const agentId = sqlAgentIn(database, from);
  // Satisfies both 0007 CHECKs for the target state, so any rejection comes
  // from the transition trigger rather than from a CHECK constraint.
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

/** Every action whose target state is `to`, per the contract matrix. */
function actionsTargeting(to: EmploymentState): readonly EmploymentAction[] {
  return [
    ...new Set(
      allowedEmploymentTransitions
        .filter((transition) => transition.to === to)
        .map((transition) => transition.action),
    ),
  ];
}

describe('M3 AgentEmploymentRepository — transitions', () => {
  it('WFM-024: a stale expectedRevision is a 409 and leaves the row untouched', () => {
    const harness = setup();
    const agentId = reach(harness, 'active');
    const before = employmentRow(harness.database, agentId);
    const counts = snapshotCounts(harness.database);

    const stale = expectApplicationError(() =>
      harness.employments.transition({
        agentId,
        action: 'suspend',
        expectedRevision: 1,
        actor: 'local-user',
      }),
    );
    expect(stale.code).toBe('INVALID_STATE_TRANSITION');
    expect(stale.statusCode).toBe(409);

    expect(employmentRow(harness.database, agentId)).toEqual(before);
    expect(snapshotCounts(harness.database)).toEqual(counts);

    // The same call with the current revision succeeds, so nothing but the CAS
    // value was wrong.
    expect(act(harness, agentId, 'suspend').state).toBe('suspended');
  });

  it('WFM-005: the service accepts exactly the 7 allowed pairs', () => {
    const harness = setup();

    const accepted: string[] = [];
    for (const { from, to, action } of allowedEmploymentTransitions) {
      const agentId = reach(harness, from);
      const result = act(
        harness,
        agentId,
        action,
        action === 'hire' || action === 'rehire' ? { version: 1 } : {},
      );
      expect(result.state, `${from}->${to} via ${action}`).toBe(to);
      accepted.push(`${from}->${to}`);
    }

    expect(accepted.sort()).toEqual([...ALLOWED_PAIRS].sort());
    expect(accepted).toHaveLength(7);
  });

  it('WFM-005: the service refuses the 9 rejected pairs, and so does the database', () => {
    const harness = setup();

    const rejected: string[] = [];
    for (const from of STATES) {
      for (const to of STATES) {
        if (ALLOWED_PAIRS.includes(`${from}->${to}`)) {
          continue;
        }
        rejected.push(`${from}->${to}`);

        // Database half (migration 0007 + 0008): direct SQL is refused too.
        expect(sqlAttempt(harness.database, from, to), `SQL ${from}->${to}`).toContain(
          'INVALID_STATE_TRANSITION',
        );

        // Service half: every action that targets `to` is refused from `from`.
        // `draft` is targeted by no action at all, so the four `* -> draft`
        // pairs cannot even be expressed through this API — asserted below.
        for (const action of actionsTargeting(to)) {
          const agentId = reach(harness, from);
          const before = employmentRow(harness.database, agentId);
          const counts = snapshotCounts(harness.database);
          const error = expectApplicationError(() =>
            act(
              harness,
              agentId,
              action,
              action === 'hire' || action === 'rehire' ? { version: 1 } : {},
            ),
          );
          expect(error.code, `${from}->${to} via ${action}`).toBe('INVALID_STATE_TRANSITION');
          expect(error.statusCode).toBe(409);
          expect(employmentRow(harness.database, agentId)).toEqual(before);
          expect(snapshotCounts(harness.database)).toEqual(counts);
        }
      }
    }

    expect(rejected.sort()).toEqual(
      [
        'draft->draft',
        'draft->suspended',
        'active->draft',
        'active->active',
        'suspended->draft',
        'suspended->suspended',
        'retired->draft',
        'retired->retired',
        'retired->suspended',
      ].sort(),
    );
    expect(rejected).toHaveLength(9);
  });

  it('WFM-005: no action can produce a self transition or return an agent to draft', () => {
    const harness = setup();

    // Structural half of the service contract: the matrix has no self edge, and
    // nothing targets `draft`, so those five pairs are unrepresentable rather
    // than merely refused.
    expect(allowedEmploymentTransitions.filter((entry) => entry.from === entry.to)).toEqual([]);
    expect(actionsTargeting('draft')).toEqual([]);

    // Behavioural half: the actions that could plausibly re-enter a state find
    // no matching edge and are refused with 409.
    for (const state of STATES) {
      for (const action of actionsTargeting(state)) {
        const agentId = reach(harness, state);
        const error = expectApplicationError(() =>
          act(
            harness,
            agentId,
            action,
            action === 'hire' || action === 'rehire' ? { version: 1 } : {},
          ),
        );
        expect(error.code, `${state}->${state} via ${action}`).toBe('INVALID_STATE_TRANSITION');
        expect(harness.employments.findByAgentId(agentId)?.state).toBe(state);
      }
    }
  });

  it('WFM-005: an active employment always carries a version, and an active INSERT is refused', () => {
    const harness = setup();

    for (const state of STATES) {
      const agentId = reach(harness, state);
      const employment = harness.employments.findByAgentId(agentId)!;
      expect(employment.state === 'active').toBe(employment.activeVersion !== null);
    }

    // A definition without an employment row, so the INSERT guard is the only
    // thing that can refuse the row below.
    harness.database
      .prepare(
        `INSERT INTO agent_definitions (id, name, origin, created_by, created_at)
         VALUES ('insert-guard', 'Insert Guard', 'user_created', 'local-user', ?)`,
      )
      .run(iso);
    expect(() =>
      harness.database
        .prepare(
          `INSERT INTO agent_employments (agent_id, state, active_version, last_active_version,
           activated_at, deactivated_at, actor, reason, revision, updated_at)
           VALUES ('insert-guard', 'active', 1, 1, ?, NULL, 'local-user', NULL, 1, ?)`,
        )
        .run(iso, iso),
    ).toThrow(/AGENT_EMPLOYMENT_INITIAL_STATE/);
    expect(
      count(
        harness.database,
        'SELECT COUNT(*) AS count FROM agent_employments WHERE agent_id = ?',
        'insert-guard',
      ),
    ).toBe(0);

    // A `draft` row carrying a pre-seeded `last_active_version` is refused for
    // the same reason (plan §2.3-4), which is what closes the
    // `INSERT(draft, last_active_version=N) -> dismiss -> rehire` bypass.
    expect(() =>
      harness.database
        .prepare(
          `INSERT INTO agent_employments (agent_id, state, active_version, last_active_version,
           activated_at, deactivated_at, actor, reason, revision, updated_at)
           VALUES ('insert-guard', 'draft', NULL, 2, NULL, NULL, 'local-user', NULL, 1, ?)`,
        )
        .run(iso),
    ).toThrow(/AGENT_EMPLOYMENT_INITIAL_STATE/);
  });

  it('exposes no generic mutation entry point', () => {
    for (const name of ['save', 'update', 'setState', 'upsert', 'delete', 'remove', 'activate']) {
      expect(name in AgentEmploymentRepository.prototype).toBe(false);
    }
    expect('transition' in AgentEmploymentRepository.prototype).toBe(true);
    expect('applyTransitionInTransaction' in AgentEmploymentRepository.prototype).toBe(true);
  });

  it('rejects an unknown action before touching the row', () => {
    const harness = setup();
    const agentId = reach(harness, 'active');
    const before = employmentRow(harness.database, agentId);

    const error = expectApplicationError(() =>
      harness.employments.transition({
        agentId,
        action: 'promote' as unknown as EmploymentAction,
        expectedRevision: currentRevision(harness, agentId),
        actor: 'local-user',
      }),
    );
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.statusCode).toBe(422);
    expect(employmentRow(harness.database, agentId)).toEqual(before);
  });

  it('reports an unknown agent as 404 and lists employments by state', () => {
    const harness = setup();
    expect(harness.employments.findByAgentId('no-such-agent')).toBeUndefined();
    expect(
      expectApplicationError(() =>
        harness.employments.transition({
          agentId: 'no-such-agent',
          action: 'suspend',
          expectedRevision: 1,
          actor: 'local-user',
        }),
      ).code,
    ).toBe('NOT_FOUND');

    // The 0007 seed: 17 active built-ins and Arca in `draft`.
    expect(harness.employments.listByState('active')).toHaveLength(17);
    expect(harness.employments.listByState('draft').map((row) => row.agentId)).toEqual(['arca']);
    expect(harness.employments.listByState('retired')).toHaveLength(0);

    const agentId = reach(harness, 'retired');
    expect(harness.employments.listByState('retired').map((row) => row.agentId)).toEqual([agentId]);
  });
});

describe('M3 AgentEmploymentRepository — version rules (WFM-031)', () => {
  it('follows the §2.3 column table for all five actions', () => {
    const harness = setup();
    const agentId = customAgent(harness, 2);

    const hired = act(harness, agentId, 'hire', { version: 1 });
    expect(hired).toMatchObject({
      state: 'active',
      activeVersion: 1,
      lastActiveVersion: 1,
      revision: 2,
    });
    expect(hired.activatedAt).toBe(iso);

    const suspended = act(harness, agentId, 'suspend');
    expect(suspended).toMatchObject({
      state: 'suspended',
      activeVersion: null,
      lastActiveVersion: 1,
      revision: 3,
    });
    expect(suspended.deactivatedAt).toBe(iso);
    // The activation instant is preserved rather than cleared.
    expect(suspended.activatedAt).toBe(iso);

    const resumed = act(harness, agentId, 'resume');
    expect(resumed).toMatchObject({
      state: 'active',
      activeVersion: 1,
      lastActiveVersion: 1,
      revision: 4,
    });

    const dismissed = act(harness, agentId, 'dismiss');
    expect(dismissed).toMatchObject({
      state: 'retired',
      activeVersion: null,
      lastActiveVersion: 1,
      revision: 5,
    });

    const rehired = act(harness, agentId, 'rehire');
    expect(rehired).toMatchObject({
      state: 'active',
      activeVersion: 1,
      lastActiveVersion: 1,
      revision: 6,
    });

    // An explicit version on `rehire` moves both columns to it.
    act(harness, agentId, 'dismiss');
    const rehiredOnTwo = act(harness, agentId, 'rehire', { version: 2 });
    expect(rehiredOnTwo).toMatchObject({
      state: 'active',
      activeVersion: 2,
      lastActiveVersion: 2,
    });
  });

  it('never auto-promotes: resume restores the version that was active, not the newest', () => {
    const harness = setup();
    const agentId = customAgent(harness, 1);
    act(harness, agentId, 'hire', { version: 1 });
    act(harness, agentId, 'suspend');

    // A new version appears while the agent is suspended.
    addVersion(harness, agentId, 2);
    expect(harness.registry.find(agentId)?.versions).toEqual([1, 2]);
    expect(harness.registry.find(agentId)?.latestProfileVersion).toBe(2);

    const resumed = act(harness, agentId, 'resume');
    expect(resumed.activeVersion).toBe(1);
    expect(harness.registry.getRunTargetVersion(agentId)).toBe(1);
  });

  it('rejects a hire without a version and never invents one', () => {
    const harness = setup();
    const agentId = customAgent(harness, 2);
    const counts = snapshotCounts(harness.database);

    const error = expectApplicationError(() =>
      harness.employments.transition({
        agentId,
        action: 'hire',
        expectedRevision: 1,
        actor: 'local-user',
      }),
    );
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.statusCode).toBe(422);
    expect(harness.employments.findByAgentId(agentId)).toMatchObject({
      state: 'draft',
      activeVersion: null,
      revision: 1,
    });
    expect(snapshotCounts(harness.database)).toEqual(counts);
  });

  it('rejects a version outside the agent union set and writes nothing', () => {
    const harness = setup();
    const agentId = customAgent(harness, 1);
    const counts = snapshotCounts(harness.database);

    const hire = expectApplicationError(() => act(harness, agentId, 'hire', { version: 9 }));
    expect(hire.code).toBe('VALIDATION_FAILED');
    expect(hire.statusCode).toBe(422);
    expect(employmentRow(harness.database, agentId)).toMatchObject({ state: 'draft', revision: 1 });
    expect(snapshotCounts(harness.database)).toEqual(counts);

    act(harness, agentId, 'hire', { version: 1 });
    act(harness, agentId, 'dismiss');
    const afterDismiss = snapshotCounts(harness.database);
    const rehire = expectApplicationError(() => act(harness, agentId, 'rehire', { version: 9 }));
    expect(rehire.code).toBe('VALIDATION_FAILED');
    expect(employmentRow(harness.database, agentId)).toMatchObject({ state: 'retired' });
    expect(snapshotCounts(harness.database)).toEqual(afterDismiss);
  });

  it('rejects draft -> dismiss -> rehire without a version', () => {
    const harness = setup();
    const agentId = customAgent(harness, 1);

    act(harness, agentId, 'dismiss');
    expect(harness.employments.findByAgentId(agentId)).toMatchObject({
      state: 'retired',
      activeVersion: null,
      lastActiveVersion: null,
    });

    const counts = snapshotCounts(harness.database);
    const error = expectApplicationError(() => act(harness, agentId, 'rehire'));
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.statusCode).toBe(422);
    expect(employmentRow(harness.database, agentId)).toMatchObject({ state: 'retired' });
    expect(snapshotCounts(harness.database)).toEqual(counts);

    // The database refuses the same combination independently.
    expect(() =>
      harness.database
        .prepare("UPDATE agent_employments SET state = 'active' WHERE agent_id = ?")
        .run(agentId),
    ).toThrow(/CHECK constraint failed/);

    // Naming the version explicitly is the supported way through.
    expect(act(harness, agentId, 'rehire', { version: 1 }).activeVersion).toBe(1);
  });

  it('rejects a version on an action that does not take one', () => {
    const harness = setup();
    const agentId = reach(harness, 'active', 2);

    for (const action of ['suspend', 'dismiss'] as const) {
      const error = expectApplicationError(() => act(harness, agentId, action, { version: 2 }));
      expect(error.code).toBe('VALIDATION_FAILED');
    }
    act(harness, agentId, 'suspend');
    expect(expectApplicationError(() => act(harness, agentId, 'resume', { version: 2 })).code).toBe(
      'VALIDATION_FAILED',
    );
  });
});

describe('M3 AgentEmploymentRepository — Arca (WFM-028)', () => {
  it('refuses hire, rehire and resume with 422 whatever the current state is', () => {
    const harness = setup();
    const counts = snapshotCounts(harness.database);

    for (const action of ['hire', 'rehire', 'resume'] as const) {
      const error = expectApplicationError(() =>
        harness.employments.transition({
          agentId: 'arca',
          action,
          expectedRevision: 1,
          actor: 'local-user',
          ...(action === 'resume' ? {} : { version: 2 }),
        }),
      );
      expect(error.code, action).toBe('VALIDATION_FAILED');
      expect(error.statusCode, action).toBe(422);
      // Not a 409: the Arca block is evaluated before the transition matrix, so
      // `rehire`/`resume` on a `draft` Arca report the real reason (plan H-5).
      expect(error.message).toContain('registry runtime is not implemented');

      expect(harness.employments.findByAgentId('arca')).toMatchObject({
        state: 'draft',
        activeVersion: null,
        lastActiveVersion: null,
        revision: 1,
      });
    }
    expect(snapshotCounts(harness.database)).toEqual(counts);
  });

  it('blocks a direct SQL activation and leaves Arca in draft', () => {
    const harness = setup();

    expect(() =>
      harness.database
        .prepare(
          "UPDATE agent_employments SET state = 'active', active_version = 2 WHERE agent_id = 'arca'",
        )
        .run(),
    ).toThrow(/ARCA_ACTIVATION_BLOCKED/);

    expect(employmentRow(harness.database, 'arca')).toMatchObject({
      state: 'draft',
      active_version: null,
      last_active_version: null,
      revision: 1,
    });
  });

  it('still allows the non-activating actions the matrix permits', () => {
    const harness = setup();
    // `dismiss` is not an activating action, so the Arca block does not apply
    // and `draft -> retired` proceeds. Arca still never becomes `active`.
    const dismissed = harness.employments.transition({
      agentId: 'arca',
      action: 'dismiss',
      expectedRevision: 1,
      actor: 'local-user',
      reason: 'runtime-not-implemented',
    });
    expect(dismissed.state).toBe('retired');
    expect(dismissed.activeVersion).toBeNull();

    expect(
      expectApplicationError(() =>
        harness.employments.transition({
          agentId: 'arca',
          action: 'rehire',
          expectedRevision: dismissed.revision,
          version: 2,
          actor: 'local-user',
        }),
      ).code,
    ).toBe('VALIDATION_FAILED');
    expect(harness.employments.findByAgentId('arca')?.state).toBe('retired');
  });
});

describe('M3 AgentEmploymentRepository — preservation and atomicity', () => {
  it('WFM-006: dismissal deletes nothing and adds exactly one audit row', () => {
    const harness = setup();
    const agentId = reach(harness, 'active');

    // A project, a task, a running planning run and a finished agent run, so
    // every table WFM-006 names actually has rows to preserve.
    const projectId = ulid();
    new ProjectRepository(harness.database, () => new Date(iso)).insert({
      id: projectId,
      projectKey: 'employment-project',
      name: 'Employment',
      repositoryPath: 'C:\\projects\\employment',
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
    const taskId = ulid();
    harness.database
      .prepare(
        `INSERT INTO tasks (id, project_id, title, objective, success_criteria_json, input_artifact_ids_json,
         max_duration_minutes, max_agent_runs, requested_agent_ids_json, status, created_at, updated_at, completed_at)
         VALUES (?, ?, 'task', 'objective', '[]', '[]', 60, 60, '[]', 'planning', ?, ?, NULL)`,
      )
      .run(taskId, projectId, iso, iso);
    const stepId = ulid();
    const runId = ulid();
    harness.database
      .prepare(
        "INSERT INTO task_plans (task_id, version, plan_json, validation_json, created_at) VALUES (?, 1, '{}', '{}', ?)",
      )
      .run(taskId, iso);
    harness.database
      .prepare(
        `INSERT INTO task_steps (id, task_id, plan_version, step_json, status, created_at, updated_at, completed_at)
         VALUES (?, ?, 1, '{}', 'running', ?, ?, NULL)`,
      )
      .run(stepId, taskId, iso, iso);
    harness.database
      .prepare(
        `INSERT INTO runs (id, step_id, attempt, provider, model, profile_snapshot_json, profile_snapshot_sha256,
         status, created_at, completed_at)
         VALUES (?, ?, 1, 'openai', 'gpt-5.6-sol', '{}', ?, 'running', ?, NULL)`,
      )
      .run(runId, stepId, 'a'.repeat(64), iso);
    new PlanningRunRepository(harness.database, () => new Date(iso)).createRunning({
      taskId,
      attempt: 1,
      provider: 'openai',
      model: 'gpt-5.6-sol',
      profileSnapshot: { id: agentId, version: 1 },
      createdAt: iso,
    });

    const inventory = () => ({
      definitions: harness.database
        .prepare(
          'SELECT id, name, origin, created_by, created_at FROM agent_definitions ORDER BY id',
        )
        .all(),
      profileVersions: harness.database
        .prepare(
          'SELECT agent_id, version, config_sha256 FROM agent_profile_versions ORDER BY agent_id, version',
        )
        .all(),
      profiles: harness.database
        .prepare('SELECT id, version, config_sha256 FROM agent_profiles ORDER BY id, version')
        .all(),
      runs: harness.database
        .prepare('SELECT id, status, profile_snapshot_sha256 FROM runs ORDER BY id')
        .all(),
      planningRuns: harness.database
        .prepare('SELECT id, status, profile_snapshot_sha256 FROM planning_runs ORDER BY id')
        .all(),
    });

    const before = inventory();
    const auditBefore = count(harness.database, 'SELECT COUNT(*) AS count FROM audit_log');

    const dismissed = act(harness, agentId, 'dismiss');
    expect(dismissed.state).toBe('retired');

    // Identical row sets, and the running run was not terminated.
    expect(inventory()).toEqual(before);
    expect(count(harness.database, 'SELECT COUNT(*) AS count FROM audit_log')).toBe(
      auditBefore + 1,
    );
    const audit = harness.database
      .prepare('SELECT action, actor, project_id, payload_json FROM audit_log ORDER BY id DESC')
      .get() as { action: string; project_id: string | null; payload_json: string };
    expect(audit.action).toBe('agent.dismissed');
    expect(audit.project_id).toBeNull();
    expect(JSON.parse(audit.payload_json)).toMatchObject({
      agentId,
      action: 'dismiss',
      fromState: 'active',
      toState: 'retired',
      activeVersion: null,
      lastActiveVersion: 1,
    });
  });

  it('WFM-022: every action appends exactly one audit row with its own action name', () => {
    const harness = setup();
    const agentId = customAgent(harness, 1);

    const expected: Array<[EmploymentAction, string]> = [
      ['hire', 'agent.hired'],
      ['suspend', 'agent.suspended'],
      ['resume', 'agent.resumed'],
      ['dismiss', 'agent.dismissed'],
      ['rehire', 'agent.rehired'],
    ];
    for (const [action, auditAction] of expected) {
      const before = count(harness.database, 'SELECT COUNT(*) AS count FROM audit_log');
      act(harness, agentId, action, action === 'hire' ? { version: 1 } : {});
      expect(count(harness.database, 'SELECT COUNT(*) AS count FROM audit_log')).toBe(before + 1);
      const row = harness.database
        .prepare('SELECT action FROM audit_log ORDER BY id DESC')
        .get() as { action: string };
      expect(row.action).toBe(auditAction);
    }
  });

  it('rolls the transition back when the audit append fails', () => {
    const harness = setup();
    const agentId = reach(harness, 'active');
    const before = employmentRow(harness.database, agentId);
    const counts = snapshotCounts(harness.database);

    // A real database failure at the audit step, not a mock: the trigger aborts
    // the INSERT the repository issues from inside its own transaction.
    harness.database.exec(
      `CREATE TRIGGER test_block_dismiss_audit BEFORE INSERT ON audit_log
       WHEN NEW.action = 'agent.dismissed'
       BEGIN SELECT RAISE(ABORT, 'TEST_AUDIT_APPEND_FAILURE'); END`,
    );
    try {
      expectApplicationError(() => act(harness, agentId, 'dismiss'));
    } finally {
      harness.database.exec('DROP TRIGGER test_block_dismiss_audit');
    }

    expect(employmentRow(harness.database, agentId)).toEqual(before);
    expect(snapshotCounts(harness.database)).toEqual(counts);

    // The path works once the audit append can succeed again.
    expect(act(harness, agentId, 'dismiss').state).toBe('retired');
  });

  it('WFM-024: a throwing idempotency completion rolls the whole mutation back', () => {
    const harness = setup();
    const agentId = reach(harness, 'active');
    const before = employmentRow(harness.database, agentId);
    const counts = snapshotCounts(harness.database);

    let observed: string | undefined;
    const error = expectApplicationError(() =>
      harness.employments.transition({
        agentId,
        action: 'suspend',
        expectedRevision: currentRevision(harness, agentId),
        actor: 'local-user',
        idempotencyCompletion: (employment) => {
          // The completion sees the committed-to-be row, then fails.
          observed = employment.state;
          throw new ApplicationError('IDEMPOTENCY_CONFLICT', 'The reservation was not available.', {
            statusCode: 409,
          });
        },
      }),
    );
    expect(error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(observed).toBe('suspended');

    // Nothing survived: no state change and no audit row.
    expect(employmentRow(harness.database, agentId)).toEqual(before);
    expect(snapshotCounts(harness.database)).toEqual(counts);
  });

  it('runs the idempotency completion inside the same transaction on success', () => {
    const harness = setup();
    const agentId = reach(harness, 'active');
    let seenRevision = 0;

    const suspended = harness.employments.transition({
      agentId,
      action: 'suspend',
      expectedRevision: currentRevision(harness, agentId),
      actor: 'local-user',
      idempotencyCompletion: (employment) => {
        seenRevision = employment.revision;
      },
    });
    expect(seenRevision).toBe(suspended.revision);
    expect(harness.employments.findByAgentId(agentId)?.state).toBe('suspended');
  });

  it('requires the caller to hold a transaction for the in-transaction entry point', () => {
    const harness = setup();
    const agentId = reach(harness, 'active');
    const before = employmentRow(harness.database, agentId);

    const error = expectApplicationError(() =>
      harness.employments.applyTransitionInTransaction({
        agentId,
        action: 'suspend',
        expectedRevision: currentRevision(harness, agentId),
        actor: 'local-user',
      }),
    );
    expect(error.code).toBe('DATABASE_UNAVAILABLE');
    expect(employmentRow(harness.database, agentId)).toEqual(before);

    // Inside a transaction it behaves exactly like `transition`.
    const revision = currentRevision(harness, agentId);
    const suspended = withImmediateTransaction(harness.database, () =>
      harness.employments.applyTransitionInTransaction({
        agentId,
        action: 'suspend',
        expectedRevision: revision,
        actor: 'local-user',
      }),
    );
    expect(suspended.state).toBe('suspended');
    expect(harness.employments.findByAgentId(agentId)?.revision).toBe(revision + 1);
  });

  it('serializes two connections racing for the same employment row', () => {
    const harness = setup();
    const agentId = reach(harness, 'active');

    // A genuinely separate connection to the same database file, keeping the
    // default zero busy timeout so a contended write fails at once.
    const second = new DatabaseSync(harness.databasePath);
    extraConnections.push(second);
    second.exec('PRAGMA foreign_keys = ON;');
    const contender = new AgentEmploymentRepository(
      second,
      new AgentRegistryReadModel(second),
      () => new Date(iso),
    );

    const revision = currentRevision(harness, agentId);

    // Connection A takes the write lock and suspends the agent.
    harness.database.exec('BEGIN IMMEDIATE');
    harness.employments.applyTransitionInTransaction({
      agentId,
      action: 'suspend',
      expectedRevision: revision,
      actor: 'local-user',
    });

    // Connection B still reads the pre-transaction row, but it cannot act on it.
    expect(contender.findByAgentId(agentId)).toMatchObject({ state: 'active', revision });
    const blocked = expectApplicationError(() =>
      contender.transition({
        agentId,
        action: 'dismiss',
        expectedRevision: revision,
        actor: 'other-user',
      }),
    );
    expect(blocked.code).toBe('DATABASE_UNAVAILABLE');
    expect(blocked.statusCode).toBe(503);

    harness.database.exec('COMMIT');

    // After the commit B sees the new revision, and its stale CAS is a 409 —
    // so exactly one of the two racing transitions took effect.
    expect(contender.findByAgentId(agentId)).toMatchObject({
      state: 'suspended',
      revision: revision + 1,
    });
    const stale = expectApplicationError(() =>
      contender.transition({
        agentId,
        action: 'dismiss',
        expectedRevision: revision,
        actor: 'other-user',
      }),
    );
    expect(stale.code).toBe('INVALID_STATE_TRANSITION');
    expect(stale.statusCode).toBe(409);
    expect(harness.employments.findByAgentId(agentId)?.state).toBe('suspended');
  });
});
