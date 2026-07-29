import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { ulid } from 'ulid';
import { afterEach, describe, expect, it } from 'vitest';
import type { RuntimeSelection } from '@orion/contracts';

import { createDatabase } from '../src/database.js';
import { applyMigrations } from '../src/migrations.js';
import { ApplicationError } from '../src/errors.js';
import {
  canonicalProfileConfigJson,
  sha256Hex,
} from '../src/repositories/agent-profile-repository.js';
import { AgentDefinitionRepository } from '../src/repositories/agent-definition-repository.js';
import { AgentProfileVersionRepository } from '../src/repositories/agent-profile-version-repository.js';
import { AgentRegistryReadModel } from '../src/repositories/agent-registry-read-model.js';
import { AgentEmploymentRepository } from '../src/repositories/agent-employment-repository.js';
import { HireProposalRepository } from '../src/repositories/hire-proposal-repository.js';

/**
 * M3 `HireProposalRepository` (plan-delta-003 §2.5/§7.2, Security §8.3/§8.4,
 * WFM-019/020/022/024/027).
 *
 * A proposal is a request for a user decision. These tests pin the three things
 * that keeps it from becoming an authorization on its own: the proposal payload
 * is immutable, a decision is bound to the exact content hash and the expiry
 * window, and the only route from a proposal to `state='active'` consumes an
 * approved, unexpired, hash-matching proposal exactly once.
 */

const iso = '2026-07-27T00:00:00.000Z';
const tenMinutesLater = '2026-07-27T00:10:00.000Z';
const twentyMinutesLater = '2026-07-27T00:20:00.000Z';
const thirtyMinutesLater = '2026-07-27T00:30:00.000Z';
const oneHourLater = '2026-07-27T01:00:00.000Z';

const SOUL = '# SOUL\nI review changes carefully and never weaken a gate.\n';

const OVERRIDE_SELECTION: RuntimeSelection = {
  selectionMode: 'override',
  selectionSource: 'manager',
  provider: 'openai',
  model: 'gpt-5.6-sol',
  reasoningEffort: 'high',
  fallbackModels: [],
};

/** The manager agent that authors proposals; never the approver (Security §8.4). */
const AUTHOR = 'orion';
const APPROVER = 'local-user';

const PROPOSED_DEFINITION = {
  id: 'proposed-001',
  name: 'Proposed One',
  origin: 'manager_proposed',
} as const;
const PROPOSED_PROFILE = {
  id: 'proposed-001',
  version: 1,
  description: 'a manager-proposed agent profile body',
} as const;
const VALIDATION = { schema: 'ok', ceiling: 'ok', collaborators: 'ok' } as const;

/** The hash `create()` must compute: canonical definition + profile, no verdict. */
const EXPECTED_SHA256 = sha256Hex(
  canonicalProfileConfigJson({ definition: PROPOSED_DEFINITION, profile: PROPOSED_PROFILE }),
);

const cleanup: string[] = [];
const handles: Array<{ close: () => void }> = [];
const extraConnections: DatabaseSync[] = [];
afterEach(() => {
  extraConnections.splice(0).forEach((connection) => connection.close());
  handles.splice(0).forEach((handle) => handle.close());
  cleanup.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'orion-m3-hire-proposals-'));
  cleanup.push(directory);
  const databasePath = join(directory, 'orion.db');
  const handle = createDatabase(databasePath);
  handles.push(handle);
  applyMigrations(handle.database);
  const now = () => new Date(iso);
  const registry = new AgentRegistryReadModel(handle.database);
  const employments = new AgentEmploymentRepository(handle.database, registry, now);
  return {
    database: handle.database,
    databasePath,
    registry,
    employments,
    definitions: new AgentDefinitionRepository(handle.database, now),
    versions: new AgentProfileVersionRepository(handle.database, now),
    proposals: new HireProposalRepository(handle.database, employments, now),
  };
}

type Harness = ReturnType<typeof setup>;
type Database = Harness['database'];

function count(database: Database, sql: string, ...parameters: unknown[]): number {
  const row = database.prepare(sql).get(...(parameters as [])) as { count: number };
  return Number(row.count);
}

interface ProposalCounts {
  readonly proposals: number;
  readonly pending: number;
  readonly activated: number;
  readonly auditEntries: number;
}

function snapshotCounts(database: Database): ProposalCounts {
  return {
    proposals: count(database, 'SELECT COUNT(*) AS count FROM hire_proposals'),
    pending: count(
      database,
      "SELECT COUNT(*) AS count FROM hire_proposals WHERE status = 'pending_approval'",
    ),
    activated: count(
      database,
      "SELECT COUNT(*) AS count FROM hire_proposals WHERE status = 'activated'",
    ),
    auditEntries: count(database, 'SELECT COUNT(*) AS count FROM audit_log'),
  };
}

/** Every employment row, so "no employment changed" can be asserted exactly. */
function employmentSnapshot(database: Database): unknown[] {
  return database
    .prepare(
      `SELECT agent_id, state, active_version, last_active_version, revision, updated_at
       FROM agent_employments ORDER BY agent_id`,
    )
    .all();
}

function proposalRow(database: Database, id: string): Record<string, unknown> {
  return database
    .prepare(
      `SELECT status, decided_at, decided_by, activated_agent_id, activated_version,
              requested_by, authored_by, proposed_agent_id, proposal_sha256, created_at, expires_at
       FROM hire_proposals WHERE id = ?`,
    )
    .get(id) as Record<string, unknown>;
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

/** The custom agent a proposal activates: defined, versioned and still `draft`. */
function proposedAgent(harness: Harness, agentId = 'proposed-001'): string {
  harness.definitions.create({
    id: agentId,
    name: 'Proposed One',
    origin: 'manager_proposed',
    createdBy: AUTHOR,
    createdAt: iso,
  });
  harness.versions.appendVersion({
    agentId,
    version: 1,
    config: { id: agentId, version: 1, description: 'a manager-proposed agent profile body' },
    soulMarkdown: SOUL,
    runtimeSelection: OVERRIDE_SELECTION,
    createdBy: AUTHOR,
    createdAt: iso,
  });
  return agentId;
}

function createProposal(
  harness: Harness,
  overrides: Partial<Parameters<HireProposalRepository['create']>[0]> = {},
) {
  return harness.proposals.create({
    requestedBy: APPROVER,
    authoredBy: AUTHOR,
    proposedAgentId: 'proposed-001',
    proposedDefinition: PROPOSED_DEFINITION,
    proposedProfile: PROPOSED_PROFILE,
    validation: VALIDATION,
    createdAt: iso,
    ...overrides,
  });
}

describe('M3 HireProposalRepository — creation', () => {
  it('WFM-019: stores a pending proposal, its content hash and one audit row', () => {
    const harness = setup();
    const employmentsBefore = employmentSnapshot(harness.database);

    const proposal = createProposal(harness);

    expect(proposal).toMatchObject({
      requestedBy: APPROVER,
      authoredBy: AUTHOR,
      proposedAgentId: 'proposed-001',
      proposalSha256: EXPECTED_SHA256,
      status: 'pending_approval',
      createdAt: iso,
      // Security §8.3/§8.4: the default window is exactly 30 minutes.
      expiresAt: thirtyMinutesLater,
      decidedAt: null,
      decidedBy: null,
      activatedAgentId: null,
      activatedVersion: null,
    });
    expect(harness.proposals.findById(proposal.id)).toEqual(proposal);

    // The immutable body is stored verbatim and its hash is reproducible.
    const content = harness.proposals.findContentById(proposal.id);
    expect(content).toEqual({
      id: proposal.id,
      proposedDefinition: PROPOSED_DEFINITION,
      proposedProfile: PROPOSED_PROFILE,
      validation: VALIDATION,
      proposalSha256: EXPECTED_SHA256,
    });
    expect(
      sha256Hex(
        canonicalProfileConfigJson({
          definition: content!.proposedDefinition,
          profile: content!.proposedProfile,
        }),
      ),
    ).toBe(proposal.proposalSha256);

    const audit = harness.database
      .prepare(
        "SELECT actor, action, project_id, payload_json FROM audit_log WHERE action = 'agent.proposal_created'",
      )
      .all() as { actor: string; project_id: string | null; payload_json: string }[];
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actor).toBe(APPROVER);
    expect(audit[0]!.project_id).toBeNull();
    expect(JSON.parse(audit[0]!.payload_json)).toMatchObject({
      proposalId: proposal.id,
      agentId: 'proposed-001',
      authoredBy: AUTHOR,
      proposalSha256: EXPECTED_SHA256,
      status: 'pending_approval',
    });

    // WFM-020: a pending proposal changes no employment row whatsoever.
    expect(employmentSnapshot(harness.database)).toEqual(employmentsBefore);
  });

  it('rejects a disagreeing hash and an out-of-policy expiry window', () => {
    const harness = setup();
    const before = snapshotCounts(harness.database);

    const mismatch = expectApplicationError(() =>
      createProposal(harness, { expectedProposalSha256: 'b'.repeat(64) }),
    );
    expect(mismatch.code).toBe('VALIDATION_FAILED');

    // Security §8.3: at most 30 minutes, and strictly after creation.
    const tooLong = expectApplicationError(() =>
      createProposal(harness, { expiresAt: oneHourLater }),
    );
    expect(tooLong.code).toBe('VALIDATION_FAILED');
    expect(tooLong.message).toContain('30 minutes');

    for (const expiresAt of [iso, '2026-07-26T23:59:00.000Z']) {
      const notAfter = expectApplicationError(() => createProposal(harness, { expiresAt }));
      expect(notAfter.code).toBe('VALIDATION_FAILED');
    }

    // Every rejected create leaves no partial row and no partial audit entry.
    expect(snapshotCounts(harness.database)).toEqual(before);

    // A shorter window inside the ceiling is accepted.
    expect(createProposal(harness, { expiresAt: tenMinutesLater }).expiresAt).toBe(tenMinutesLater);
  });

  it('exposes no way to rewrite the immutable proposal payload', () => {
    const harness = setup();
    const proposal = createProposal(harness);

    for (const name of [
      'update',
      'save',
      'upsert',
      'rewrite',
      'setStatus',
      'setContent',
      'rehash',
      'delete',
      'remove',
    ]) {
      expect(name in HireProposalRepository.prototype).toBe(false);
    }

    // Two layers now defend the create-only envelope. The repository exposes no
    // generic mutator (above), and migration 0010 refuses an UPDATE of any of
    // the ten immutable columns — `authored_by` among them — with an exact
    // trigger label. Before 0010 the database accepted this write and the
    // repository was the only guard; that is the boundary plan-delta-005 §7
    // moved, so this asserts rejection rather than acceptance.
    expect(() =>
      harness.database
        .prepare("UPDATE hire_proposals SET authored_by = 'imposter' WHERE id = ?")
        .run(proposal.id),
    ).toThrow(/HIRE_PROPOSAL_ENVELOPE_IMMUTABLE/);
    expect(() =>
      harness.database.prepare('DELETE FROM hire_proposals WHERE id = ?').run(proposal.id),
    ).toThrow(/HIRE_PROPOSALS_APPEND_ONLY/);
  });
});

describe('M3 HireProposalRepository — decisions (WFM-020)', () => {
  it('approves a pending proposal without touching any employment row', () => {
    const harness = setup();
    proposedAgent(harness);
    const proposal = createProposal(harness);
    const employmentsBefore = employmentSnapshot(harness.database);

    const approved = harness.proposals.decide({
      id: proposal.id,
      decision: 'approve',
      proposalSha256: proposal.proposalSha256,
      decidedBy: APPROVER,
      decidedAt: tenMinutesLater,
    });
    expect(approved).toMatchObject({
      status: 'approved',
      decidedAt: tenMinutesLater,
      decidedBy: APPROVER,
      activatedAgentId: null,
      activatedVersion: null,
    });

    expect(employmentSnapshot(harness.database)).toEqual(employmentsBefore);
    expect(
      count(
        harness.database,
        "SELECT COUNT(*) AS count FROM audit_log WHERE action = 'agent.proposal_approved'",
      ),
    ).toBe(1);
  });

  it('records a rejection and refuses to reuse the rejected proposal', () => {
    const harness = setup();
    const proposal = createProposal(harness);

    const rejected = harness.proposals.decide({
      id: proposal.id,
      decision: 'reject',
      proposalSha256: proposal.proposalSha256,
      decidedBy: APPROVER,
      decidedAt: tenMinutesLater,
      reason: 'ceiling too wide',
    });
    expect(rejected).toMatchObject({ status: 'rejected', decidedBy: APPROVER });
    expect(
      count(
        harness.database,
        "SELECT COUNT(*) AS count FROM audit_log WHERE action = 'agent.proposal_rejected'",
      ),
    ).toBe(1);

    const before = snapshotCounts(harness.database);
    const row = proposalRow(harness.database, proposal.id);
    const reused = expectApplicationError(() =>
      harness.proposals.decide({
        id: proposal.id,
        decision: 'approve',
        proposalSha256: proposal.proposalSha256,
        decidedBy: APPROVER,
        decidedAt: twentyMinutesLater,
      }),
    );
    expect(reused.code).toBe('INVALID_STATE_TRANSITION');
    expect(reused.statusCode).toBe(409);
    expect(proposalRow(harness.database, proposal.id)).toEqual(row);
    expect(snapshotCounts(harness.database)).toEqual(before);
  });

  it('binds the decision to the exact content hash and to the expiry window', () => {
    const harness = setup();
    const proposal = createProposal(harness, { expiresAt: tenMinutesLater });
    const before = snapshotCounts(harness.database);
    const row = proposalRow(harness.database, proposal.id);

    const mismatch = expectApplicationError(() =>
      harness.proposals.decide({
        id: proposal.id,
        decision: 'approve',
        proposalSha256: 'c'.repeat(64),
        decidedBy: APPROVER,
        decidedAt: iso,
      }),
    );
    expect(mismatch.code).toBe('VALIDATION_FAILED');
    expect(mismatch.statusCode).toBe(422);

    const expired = expectApplicationError(() =>
      harness.proposals.decide({
        id: proposal.id,
        decision: 'approve',
        proposalSha256: proposal.proposalSha256,
        decidedBy: APPROVER,
        decidedAt: twentyMinutesLater,
      }),
    );
    expect(expired.code).toBe('VALIDATION_FAILED');
    expect(expired.message).toContain('expired');

    const malformed = expectApplicationError(() =>
      harness.proposals.decide({
        id: proposal.id,
        decision: 'approve',
        proposalSha256: 'not-a-hash',
        decidedBy: APPROVER,
      }),
    );
    expect(malformed.code).toBe('VALIDATION_FAILED');

    const unknown = expectApplicationError(() =>
      harness.proposals.decide({
        id: ulid(),
        decision: 'approve',
        proposalSha256: proposal.proposalSha256,
        decidedBy: APPROVER,
      }),
    );
    expect(unknown.code).toBe('NOT_FOUND');
    expect(unknown.statusCode).toBe(404);

    expect(proposalRow(harness.database, proposal.id)).toEqual(row);
    expect(snapshotCounts(harness.database)).toEqual(before);
  });

  it('Security §8.4: the authoring agent cannot decide its own proposal', () => {
    const harness = setup();
    const proposal = createProposal(harness);
    const before = snapshotCounts(harness.database);
    const row = proposalRow(harness.database, proposal.id);

    for (const decision of ['approve', 'reject'] as const) {
      const error = expectApplicationError(() =>
        harness.proposals.decide({
          id: proposal.id,
          decision,
          proposalSha256: proposal.proposalSha256,
          decidedBy: AUTHOR,
          decidedAt: tenMinutesLater,
        }),
      );
      expect(error.code, decision).toBe('VALIDATION_FAILED');
      expect(error.statusCode).toBe(422);
    }

    expect(proposalRow(harness.database, proposal.id)).toEqual(row);
    expect(snapshotCounts(harness.database)).toEqual(before);
  });

  it('leaves exactly one winner when two connections decide the same proposal', () => {
    const harness = setup();
    const proposal = createProposal(harness);

    // A genuinely separate connection to the same database file, keeping the
    // default zero busy timeout so a contended write fails at once.
    const second = new DatabaseSync(harness.databasePath);
    extraConnections.push(second);
    second.exec('PRAGMA foreign_keys = ON;');
    const contender = new HireProposalRepository(
      second,
      new AgentEmploymentRepository(
        second,
        new AgentRegistryReadModel(second),
        () => new Date(iso),
      ),
      () => new Date(iso),
    );

    // Connection A holds the write lock; B's decision cannot even start.
    harness.database.exec('BEGIN IMMEDIATE');
    const blocked = expectApplicationError(() =>
      contender.decide({
        id: proposal.id,
        decision: 'reject',
        proposalSha256: proposal.proposalSha256,
        decidedBy: APPROVER,
        decidedAt: tenMinutesLater,
      }),
    );
    expect(blocked.code).toBe('DATABASE_UNAVAILABLE');
    expect(blocked.statusCode).toBe(503);
    harness.database.exec('ROLLBACK');

    const approved = harness.proposals.decide({
      id: proposal.id,
      decision: 'approve',
      proposalSha256: proposal.proposalSha256,
      decidedBy: APPROVER,
      decidedAt: tenMinutesLater,
    });
    expect(approved.status).toBe('approved');

    // The loser sees the settled row and is refused; the decision stays A's.
    const late = expectApplicationError(() =>
      contender.decide({
        id: proposal.id,
        decision: 'reject',
        proposalSha256: proposal.proposalSha256,
        decidedBy: APPROVER,
        decidedAt: twentyMinutesLater,
      }),
    );
    expect(late.code).toBe('INVALID_STATE_TRANSITION');
    expect(late.statusCode).toBe(409);
    expect(harness.proposals.findById(proposal.id)).toMatchObject({
      status: 'approved',
      decidedAt: tenMinutesLater,
    });
    expect(
      count(
        harness.database,
        "SELECT COUNT(*) AS count FROM audit_log WHERE action IN ('agent.proposal_approved', 'agent.proposal_rejected')",
      ),
    ).toBe(1);
  });
});

describe('M3 HireProposalRepository — activation (WFM-027(b))', () => {
  function approvedProposal(harness: Harness) {
    proposedAgent(harness);
    const proposal = createProposal(harness);
    return harness.proposals.decide({
      id: proposal.id,
      decision: 'approve',
      proposalSha256: proposal.proposalSha256,
      decidedBy: APPROVER,
      decidedAt: tenMinutesLater,
    });
  }

  it('activates the agent and the proposal in one transaction', () => {
    const harness = setup();
    const proposal = approvedProposal(harness);
    const auditBefore = count(harness.database, 'SELECT COUNT(*) AS count FROM audit_log');

    const result = harness.proposals.activate({
      id: proposal.id,
      proposalSha256: proposal.proposalSha256,
      agentId: 'proposed-001',
      version: 1,
      actor: APPROVER,
      expectedRevision: 1,
      occurredAt: twentyMinutesLater,
    });

    expect(result.proposal).toMatchObject({
      status: 'activated',
      activatedAgentId: 'proposed-001',
      activatedVersion: 1,
      decidedBy: APPROVER,
      decidedAt: tenMinutesLater,
    });
    expect(result.employment).toMatchObject({
      agentId: 'proposed-001',
      state: 'active',
      activeVersion: 1,
      lastActiveVersion: 1,
      revision: 2,
    });
    expect(harness.registry.getRunTargetVersion('proposed-001')).toBe(1);

    // Exactly one audit row, and it ties the state change to the approval.
    expect(count(harness.database, 'SELECT COUNT(*) AS count FROM audit_log')).toBe(
      auditBefore + 1,
    );
    const audit = harness.database
      .prepare('SELECT action, actor, payload_json FROM audit_log ORDER BY id DESC')
      .get() as { action: string; actor: string; payload_json: string };
    expect(audit.action).toBe('agent.hired');
    expect(JSON.parse(audit.payload_json)).toMatchObject({
      agentId: 'proposed-001',
      proposalId: proposal.id,
      toState: 'active',
      activeVersion: 1,
    });
  });

  it('refuses a second activation of the same proposal', () => {
    const harness = setup();
    const proposal = approvedProposal(harness);
    harness.proposals.activate({
      id: proposal.id,
      proposalSha256: proposal.proposalSha256,
      agentId: 'proposed-001',
      version: 1,
      actor: APPROVER,
      expectedRevision: 1,
      occurredAt: twentyMinutesLater,
    });

    const before = snapshotCounts(harness.database);
    const row = proposalRow(harness.database, proposal.id);
    const employments = employmentSnapshot(harness.database);

    const reused = expectApplicationError(() =>
      harness.proposals.activate({
        id: proposal.id,
        proposalSha256: proposal.proposalSha256,
        agentId: 'proposed-001',
        version: 1,
        actor: APPROVER,
        expectedRevision: 2,
        occurredAt: twentyMinutesLater,
      }),
    );
    expect(reused.code).toBe('INVALID_STATE_TRANSITION');
    expect(reused.statusCode).toBe(409);

    expect(proposalRow(harness.database, proposal.id)).toEqual(row);
    expect(employmentSnapshot(harness.database)).toEqual(employments);
    expect(snapshotCounts(harness.database)).toEqual(before);
  });

  it('refuses to activate a proposal that is not approved, expired or hash-matched', () => {
    const harness = setup();
    proposedAgent(harness);
    const pending = createProposal(harness, { expiresAt: tenMinutesLater });
    const before = snapshotCounts(harness.database);
    const employments = employmentSnapshot(harness.database);

    // Not approved yet: 423, the API Contract code for "approval first".
    const unapproved = expectApplicationError(() =>
      harness.proposals.activate({
        id: pending.id,
        proposalSha256: pending.proposalSha256,
        agentId: 'proposed-001',
        version: 1,
        actor: APPROVER,
        expectedRevision: 1,
        occurredAt: iso,
      }),
    );
    expect(unapproved.code).toBe('APPROVAL_REQUIRED');
    expect(unapproved.statusCode).toBe(423);

    // Wrong content hash.
    const mismatch = expectApplicationError(() =>
      harness.proposals.activate({
        id: pending.id,
        proposalSha256: 'd'.repeat(64),
        agentId: 'proposed-001',
        version: 1,
        actor: APPROVER,
        expectedRevision: 1,
        occurredAt: iso,
      }),
    );
    expect(mismatch.code).toBe('VALIDATION_FAILED');

    // Approved, then left to expire.
    harness.proposals.decide({
      id: pending.id,
      decision: 'approve',
      proposalSha256: pending.proposalSha256,
      decidedBy: APPROVER,
      decidedAt: iso,
    });
    const expired = expectApplicationError(() =>
      harness.proposals.activate({
        id: pending.id,
        proposalSha256: pending.proposalSha256,
        agentId: 'proposed-001',
        version: 1,
        actor: APPROVER,
        expectedRevision: 1,
        occurredAt: twentyMinutesLater,
      }),
    );
    expect(expired.code).toBe('VALIDATION_FAILED');
    expect(expired.message).toContain('expired');

    // An unknown proposal is a 404, never a silent activation.
    expect(
      expectApplicationError(() =>
        harness.proposals.activate({
          id: ulid(),
          proposalSha256: pending.proposalSha256,
          agentId: 'proposed-001',
          version: 1,
          actor: APPROVER,
          expectedRevision: 1,
        }),
      ).code,
    ).toBe('NOT_FOUND');

    // No agent was employed on any of those paths.
    expect(employmentSnapshot(harness.database)).toEqual(employments);
    expect(harness.employments.findByAgentId('proposed-001')?.state).toBe('draft');
    expect(snapshotCounts(harness.database)).toMatchObject({
      proposals: before.proposals,
      activated: 0,
    });
  });

  it('WFM-024: a throwing idempotency completion rolls the activation back in full', () => {
    const harness = setup();
    const proposal = approvedProposal(harness);
    const before = snapshotCounts(harness.database);
    const row = proposalRow(harness.database, proposal.id);
    const employments = employmentSnapshot(harness.database);

    let observed: string | undefined;
    const error = expectApplicationError(() =>
      harness.proposals.activate({
        id: proposal.id,
        proposalSha256: proposal.proposalSha256,
        agentId: 'proposed-001',
        version: 1,
        actor: APPROVER,
        expectedRevision: 1,
        occurredAt: twentyMinutesLater,
        idempotencyCompletion: (result) => {
          observed = result.employment.state;
          throw new ApplicationError('IDEMPOTENCY_CONFLICT', 'The reservation was not available.', {
            statusCode: 409,
          });
        },
      }),
    );
    expect(error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(observed).toBe('active');

    // Proposal status, employment row and audit rows all rolled back together.
    expect(proposalRow(harness.database, proposal.id)).toEqual(row);
    expect(employmentSnapshot(harness.database)).toEqual(employments);
    expect(snapshotCounts(harness.database)).toEqual(before);
    expect(harness.employments.findByAgentId('proposed-001')?.state).toBe('draft');
  });

  it('rolls back when the employment half is refused', () => {
    const harness = setup();
    const proposal = approvedProposal(harness);
    const before = snapshotCounts(harness.database);
    const row = proposalRow(harness.database, proposal.id);

    // A version the agent does not have: the employment half fails, so the
    // proposal must not be consumed either.
    const badVersion = expectApplicationError(() =>
      harness.proposals.activate({
        id: proposal.id,
        proposalSha256: proposal.proposalSha256,
        agentId: 'proposed-001',
        version: 7,
        actor: APPROVER,
        expectedRevision: 1,
        occurredAt: twentyMinutesLater,
      }),
    );
    expect(badVersion.code).toBe('VALIDATION_FAILED');

    // A stale CAS value on the employment row does the same.
    const staleCas = expectApplicationError(() =>
      harness.proposals.activate({
        id: proposal.id,
        proposalSha256: proposal.proposalSha256,
        agentId: 'proposed-001',
        version: 1,
        actor: APPROVER,
        expectedRevision: 9,
        occurredAt: twentyMinutesLater,
      }),
    );
    expect(staleCas.code).toBe('INVALID_STATE_TRANSITION');

    expect(proposalRow(harness.database, proposal.id)).toEqual(row);
    expect(snapshotCounts(harness.database)).toEqual(before);
    expect(harness.employments.findByAgentId('proposed-001')?.state).toBe('draft');

    // The proposal is still usable once the request is correct, which proves
    // the failed attempts consumed nothing.
    expect(
      harness.proposals.activate({
        id: proposal.id,
        proposalSha256: proposal.proposalSha256,
        agentId: 'proposed-001',
        version: 1,
        actor: APPROVER,
        expectedRevision: 1,
        occurredAt: twentyMinutesLater,
      }).employment.state,
    ).toBe('active');
  });
});

describe('M3 HireProposalRepository — expiry, invalidation and reads', () => {
  it('expires open proposals automatically, without recording a decider', () => {
    const harness = setup();
    const pending = createProposal(harness, { expiresAt: tenMinutesLater });
    const approvedThenStale = createProposal(harness, { expiresAt: tenMinutesLater });
    const stillOpen = createProposal(harness, { expiresAt: thirtyMinutesLater });
    harness.proposals.decide({
      id: approvedThenStale.id,
      decision: 'approve',
      proposalSha256: approvedThenStale.proposalSha256,
      decidedBy: APPROVER,
      decidedAt: iso,
    });
    const auditBefore = count(harness.database, 'SELECT COUNT(*) AS count FROM audit_log');

    const expired = harness.proposals.expire(twentyMinutesLater);

    expect(expired.map((proposal) => proposal.id).sort()).toEqual(
      [pending.id, approvedThenStale.id].sort(),
    );
    for (const proposal of expired) {
      expect(proposal).toMatchObject({
        status: 'expired',
        decidedBy: null,
        decidedAt: twentyMinutesLater,
      });
    }
    expect(harness.proposals.findById(stillOpen.id)?.status).toBe('pending_approval');
    expect(count(harness.database, 'SELECT COUNT(*) AS count FROM audit_log')).toBe(
      auditBefore + 2,
    );
    expect(
      count(
        harness.database,
        "SELECT COUNT(*) AS count FROM audit_log WHERE action = 'agent.proposal_expired'",
      ),
    ).toBe(2);

    // Running it again settles nothing new.
    expect(harness.proposals.expire(twentyMinutesLater)).toEqual([]);

    // An expired proposal can no longer be decided or activated.
    expect(
      expectApplicationError(() =>
        harness.proposals.decide({
          id: pending.id,
          decision: 'approve',
          proposalSha256: pending.proposalSha256,
          decidedBy: APPROVER,
          decidedAt: twentyMinutesLater,
        }),
      ).code,
    ).toBe('VALIDATION_FAILED');
  });

  it('invalidates an open proposal and refuses to invalidate a settled one', () => {
    const harness = setup();
    const pending = createProposal(harness);
    const approved = createProposal(harness);
    harness.proposals.decide({
      id: approved.id,
      decision: 'approve',
      proposalSha256: approved.proposalSha256,
      decidedBy: APPROVER,
      decidedAt: tenMinutesLater,
    });
    const auditBefore = count(harness.database, 'SELECT COUNT(*) AS count FROM audit_log');

    for (const proposal of [pending, approved]) {
      const invalidated = harness.proposals.invalidate({
        id: proposal.id,
        decidedBy: APPROVER,
        decidedAt: twentyMinutesLater,
      });
      expect(invalidated).toMatchObject({
        status: 'invalidated',
        decidedBy: APPROVER,
        decidedAt: twentyMinutesLater,
      });
    }

    // `agentAuditActionSchema` has no `agent.proposal_invalidated` member, so
    // no audit row can be written without editing a frozen contract. The gap is
    // pinned here rather than hidden behind a mislabelled row.
    expect(count(harness.database, 'SELECT COUNT(*) AS count FROM audit_log')).toBe(auditBefore);

    const settled = expectApplicationError(() =>
      harness.proposals.invalidate({ id: pending.id, decidedBy: APPROVER }),
    );
    expect(settled.code).toBe('INVALID_STATE_TRANSITION');
    expect(settled.statusCode).toBe(409);

    expect(
      expectApplicationError(() =>
        harness.proposals.invalidate({ id: ulid(), decidedBy: APPROVER }),
      ).code,
    ).toBe('NOT_FOUND');
  });

  it('lists proposals in a total order and paginates without skipping or repeating', () => {
    const harness = setup();
    const created = [1, 2, 3, 4, 5].map((index) =>
      createProposal(harness, {
        createdAt: `2026-07-27T00:0${index}:00.000Z`,
        expiresAt: `2026-07-27T00:1${index}:00.000Z`,
      }),
    );
    harness.proposals.decide({
      id: created[0]!.id,
      decision: 'reject',
      proposalSha256: created[0]!.proposalSha256,
      decidedBy: APPROVER,
      decidedAt: '2026-07-27T00:02:00.000Z',
    });

    const all = harness.proposals.list();
    expect(all.map((proposal) => proposal.id)).toEqual(created.map((proposal) => proposal.id));
    expect(harness.proposals.list({ status: 'rejected' }).map((proposal) => proposal.id)).toEqual([
      created[0]!.id,
    ]);
    expect(harness.proposals.list({ status: 'pending_approval' })).toHaveLength(4);
    expect(harness.proposals.list({ status: 'activated' })).toEqual([]);

    const pages: string[] = [];
    let cursorId: string | undefined;
    for (let page = 0; page < 6; page += 1) {
      const next = harness.proposals.list(
        cursorId === undefined ? { limit: 2 } : { limit: 2, cursorId },
      );
      if (next.length === 0) {
        break;
      }
      pages.push(...next.map((proposal) => proposal.id));
      cursorId = next[next.length - 1]!.id;
    }
    expect(pages).toEqual(all.map((proposal) => proposal.id));

    expect(expectApplicationError(() => harness.proposals.list({ cursorId: ulid() })).code).toBe(
      'VALIDATION_FAILED',
    );
    for (const limit of [0, 201, 1.5]) {
      expect(expectApplicationError(() => harness.proposals.list({ limit })).code).toBe(
        'VALIDATION_FAILED',
      );
    }
  });

  it('returns undefined for an unknown proposal instead of inventing one', () => {
    const harness = setup();
    expect(harness.proposals.findById(ulid())).toBeUndefined();
    expect(harness.proposals.findContentById(ulid())).toBeUndefined();
    expect(harness.proposals.list()).toEqual([]);
  });
});
