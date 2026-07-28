import type { DatabaseSync } from 'node:sqlite';
import { ulid } from 'ulid';
import {
  hireProposalSchema,
  sha256HexSchema,
  utcIso8601Schema,
  type AgentEmployment,
  type HireProposal,
  type HireProposalStatus,
} from '@orion/contracts';

import { withImmediateTransaction } from '../database.js';
import { ApplicationError } from '../errors.js';
import { canonicalProfileConfigJson, sha256Hex } from './agent-profile-repository.js';
import type { AgentEmploymentRepository } from './agent-employment-repository.js';
import { appendAgentAuditEntry, workforceError } from './agent-workforce-support.js';

/**
 * Security §8.3/§8.4: a hire proposal expires 30 minutes after it was created.
 * The window is an upper bound, not a default the caller may widen.
 */
const MAX_PROPOSAL_LIFETIME_MS = 30 * 60 * 1000;

/** API Contract §3 page ceiling; the default page size belongs to the route. */
const MAX_HIRE_PROPOSAL_PAGE_SIZE = 200;

export interface HireProposalInsert {
  readonly requestedBy: string;
  /** The manager agent that authored the proposal; never the approver. */
  readonly authoredBy: string;
  readonly proposedAgentId: string;
  /** Proposal body, stored verbatim as canonical JSON and hashed. */
  readonly proposedDefinition: unknown;
  readonly proposedProfile: unknown;
  /** The server's own validation verdict for the proposal (WFM-019). */
  readonly validation: unknown;
  readonly id?: string;
  readonly createdAt?: string;
  /** Defaults to `createdAt` + 30 minutes; a longer window is rejected. */
  readonly expiresAt?: string;
  /** A caller-supplied hash that disagrees with the recomputed one is rejected. */
  readonly expectedProposalSha256?: string;
}

export interface HireProposalDecisionInput {
  readonly id: string;
  readonly decision: 'approve' | 'reject';
  /** Security §8.3: the decision must re-state the exact content it decides on. */
  readonly proposalSha256: string;
  readonly decidedBy: string;
  readonly decidedAt?: string;
  readonly reason?: string;
}

export interface HireProposalActivationInput {
  readonly id: string;
  readonly proposalSha256: string;
  readonly agentId: string;
  /** The version to activate; the server never selects one (plan §2.3). */
  readonly version: number;
  readonly actor: string;
  readonly expectedRevision: number;
  readonly occurredAt?: string;
  readonly reason?: string;
  /**
   * Invoked inside the same transaction, after every write, so an idempotency
   * completion failure rolls the activation back in full (WFM-024).
   */
  readonly idempotencyCompletion?: (result: HireProposalActivation) => void;
}

export interface HireProposalActivation {
  readonly proposal: HireProposal;
  readonly employment: AgentEmployment;
}

export interface HireProposalInvalidationInput {
  readonly id: string;
  readonly decidedBy: string;
  readonly decidedAt?: string;
}

export interface HireProposalListOptions {
  readonly status?: HireProposalStatus;
  readonly limit?: number;
  readonly cursorId?: string;
}

/** The immutable proposal body, for a caller that must read what was proposed. */
export interface HireProposalContent {
  readonly id: string;
  readonly proposedDefinition: unknown;
  readonly proposedProfile: unknown;
  readonly validation: unknown;
  readonly proposalSha256: string;
}

interface HireProposalRow {
  readonly id: string;
  readonly requested_by: string;
  readonly authored_by: string;
  readonly proposed_agent_id: string;
  readonly proposal_sha256: string;
  readonly status: string;
  readonly created_at: string;
  readonly expires_at: string;
  readonly decided_at: string | null;
  readonly decided_by: string | null;
  readonly activated_agent_id: string | null;
  readonly activated_version: number | null;
}

const HIRE_PROPOSAL_COLUMNS =
  'id, requested_by, authored_by, proposed_agent_id, proposal_sha256, status, created_at, expires_at, decided_at, decided_by, activated_agent_id, activated_version';

/** Parses a row through `hireProposalSchema` so a corrupt row can never flow onward. */
function readHireProposalRow(row: HireProposalRow): HireProposal {
  return hireProposalSchema.parse({
    id: row.id,
    requestedBy: row.requested_by,
    authoredBy: row.authored_by,
    proposedAgentId: row.proposed_agent_id,
    proposalSha256: row.proposal_sha256,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
    activatedAgentId: row.activated_agent_id,
    activatedVersion: row.activated_version === null ? null : Number(row.activated_version),
  });
}

/**
 * Persistence boundary for manager-authored hire proposals
 * (plan-delta-003 §2.5/§7.2, Security §8.3/§8.4, WFM-019/020/027).
 *
 * A proposal is a request for a user decision, never an authorization by
 * itself. The separation is structural: `activate()` is the only method that
 * can move an employment row to `active` through this class, it requires the
 * proposal id **and** its `proposal_sha256`, and its guarded UPDATE only
 * matches a row that is already `approved` and not expired. There is no
 * "activate without a proposal" and no "approve and activate" shortcut
 * (WFM-027(b)).
 *
 * **The proposal payload is immutable after creation.** `requestedBy`,
 * `authoredBy`, `proposedAgentId`, `proposedDefinitionJson`,
 * `proposedProfileJson`, `validationJson`, `proposalSha256`, `createdAt` and
 * `expiresAt` are written exactly once, by `create()`. Migration 0007 guards
 * the `status` column with a transition trigger and forbids DELETE, but a plain
 * `UPDATE hire_proposals SET authored_by = ...` is something the database still
 * permits — so this repository is the guard: it deliberately exposes **no**
 * update, rewrite, re-hash or generic `save` method, and every UPDATE it does
 * issue names only `status`, `decided_at`, `decided_by`, `activated_agent_id`
 * and `activated_version`.
 */
export class HireProposalRepository {
  public constructor(
    private readonly database: DatabaseSync,
    private readonly employments: AgentEmploymentRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Records one `pending_approval` proposal and its `agent.proposal_created`
   * audit entry in a single `BEGIN IMMEDIATE` transaction.
   *
   * `proposal_sha256` is computed here, over the canonical JSON of the proposed
   * definition and profile — the content a later approval re-states. The
   * server's `validation_json` verdict is deliberately outside the hash: it is
   * the server's own finding about the proposal, not part of what the user is
   * being asked to approve.
   */
  public create(input: HireProposalInsert): HireProposal {
    try {
      return withImmediateTransaction(this.database, () => {
        const createdAt = this.parseInstant(input.createdAt ?? this.now().toISOString(), 'created');
        const expiresAt = this.parseInstant(
          input.expiresAt ??
            new Date(Date.parse(createdAt) + MAX_PROPOSAL_LIFETIME_MS).toISOString(),
          'expiry',
        );
        this.assertLifetime(createdAt, expiresAt);

        const proposedDefinitionJson = canonicalProfileConfigJson(input.proposedDefinition);
        const proposedProfileJson = canonicalProfileConfigJson(input.proposedProfile);
        const validationJson = canonicalProfileConfigJson(input.validation);
        const proposalSha256 = sha256Hex(
          canonicalProfileConfigJson({
            definition: input.proposedDefinition,
            profile: input.proposedProfile,
          }),
        );
        if (
          input.expectedProposalSha256 !== undefined &&
          input.expectedProposalSha256 !== proposalSha256
        ) {
          throw new ApplicationError(
            'VALIDATION_FAILED',
            'The supplied proposal hash does not match the proposed content.',
          );
        }

        const proposal = this.parseProposal({
          id: input.id ?? ulid(),
          requestedBy: input.requestedBy,
          authoredBy: input.authoredBy,
          proposedAgentId: input.proposedAgentId,
          proposalSha256,
          status: 'pending_approval',
          createdAt,
          expiresAt,
          decidedAt: null,
          decidedBy: null,
          activatedAgentId: null,
          activatedVersion: null,
        });

        this.database
          .prepare(
            `INSERT INTO hire_proposals (id, requested_by, authored_by, proposed_agent_id,
             proposed_definition_json, proposed_profile_json, validation_json, proposal_sha256,
             status, created_at, expires_at, decided_at, decided_by, activated_agent_id, activated_version)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending_approval', ?, ?, NULL, NULL, NULL, NULL)`,
          )
          .run(
            proposal.id,
            proposal.requestedBy,
            proposal.authoredBy,
            proposal.proposedAgentId,
            proposedDefinitionJson,
            proposedProfileJson,
            validationJson,
            proposal.proposalSha256,
            proposal.createdAt,
            proposal.expiresAt,
          );

        appendAgentAuditEntry(
          this.database,
          {
            action: 'agent.proposal_created',
            actor: proposal.requestedBy,
            payload: {
              proposalId: proposal.id,
              agentId: proposal.proposedAgentId,
              authoredBy: proposal.authoredBy,
              proposalSha256: proposal.proposalSha256,
              status: proposal.status,
              expiresAt: proposal.expiresAt,
            },
            createdAt: proposal.createdAt,
          },
          () => this.now(),
        );

        return proposal;
      });
    } catch (error) {
      throw workforceError(error, input.id === undefined ? {} : { proposalId: input.id });
    }
  }

  /**
   * Approves or rejects a `pending_approval` proposal.
   *
   * The three approval invariants of Security §8.3 are all in the WHERE clause
   * of one guarded UPDATE — still pending, exact hash, not yet expired — so the
   * decision cannot be split from the state it was checked against. A
   * `changes !== 1` result is then diagnosed against the row that was read in
   * the same transaction, which is what turns "no rows matched" into a precise
   * 404/422/409 instead of a generic conflict.
   *
   * No employment row is touched here. Approval is permission to activate, and
   * activation is a separate, explicit call (WFM-020, WFM-027(b)).
   */
  public decide(input: HireProposalDecisionInput): HireProposal {
    const decision = this.parseDecision(input.decision);
    const proposalSha256 = this.parseSha256(input.proposalSha256);
    try {
      return withImmediateTransaction(this.database, () => {
        const current = this.requireProposal(input.id);
        const decidedAt = this.parseInstant(
          input.decidedAt ?? this.now().toISOString(),
          'decision',
        );

        // Security §8.3: the approver and the authoring agent are distinct
        // subjects. A proposal that could approve itself would make the manager
        // agent its own authorization, which §8.4 forbids outright.
        if (input.decidedBy === current.authoredBy) {
          throw new ApplicationError(
            'VALIDATION_FAILED',
            'A hire proposal cannot be decided by the agent that authored it.',
          );
        }

        const status: HireProposalStatus = decision === 'approve' ? 'approved' : 'rejected';
        const changed = Number(
          this.database
            .prepare(
              `UPDATE hire_proposals
                 SET status = ?, decided_at = ?, decided_by = ?
               WHERE id = ?
                 AND status = 'pending_approval'
                 AND proposal_sha256 = ?
                 AND expires_at > ?`,
            )
            .run(status, decidedAt, input.decidedBy, input.id, proposalSha256, decidedAt).changes,
        );
        if (changed !== 1) {
          throw this.diagnoseGuardMiss(current, proposalSha256, decidedAt, 'pending_approval');
        }

        const updated = this.requireProposal(input.id);
        appendAgentAuditEntry(
          this.database,
          {
            action: decision === 'approve' ? 'agent.proposal_approved' : 'agent.proposal_rejected',
            actor: input.decidedBy,
            payload: {
              proposalId: updated.id,
              agentId: updated.proposedAgentId,
              authoredBy: updated.authoredBy,
              proposalSha256: updated.proposalSha256,
              status: updated.status,
              ...(input.reason === undefined ? {} : { reason: input.reason }),
            },
            createdAt: decidedAt,
          },
          () => this.now(),
        );

        return updated;
      });
    } catch (error) {
      throw workforceError(error, { proposalId: input.id });
    }
  }

  /**
   * Consumes an approved proposal: `approved -> activated` plus the employment
   * activation, in ONE `BEGIN IMMEDIATE` transaction.
   *
   * The guarded UPDATE re-checks the hash and the expiry, and it only matches
   * `status = 'approved'` — so the proposal is single-use by construction: a
   * second activation finds the row already `activated` and is refused with 409
   * before anything else runs. The employment change goes through
   * `applyTransitionInTransaction`, which keeps the proposal status, the
   * employment row, the audit entry and the idempotency completion in this one
   * transaction; any failure rolls all four back together.
   *
   * The employment action is always `hire`: a proposal creates a new agent, and
   * a new agent's employment row is `draft` by trigger. Any other current state
   * is refused by the transition matrix rather than quietly re-interpreted.
   */
  public activate(input: HireProposalActivationInput): HireProposalActivation {
    const proposalSha256 = this.parseSha256(input.proposalSha256);
    try {
      return withImmediateTransaction(this.database, () => {
        const current = this.requireProposal(input.id);
        const occurredAt = this.parseInstant(
          input.occurredAt ?? this.now().toISOString(),
          'activation',
        );

        const changed = Number(
          this.database
            .prepare(
              `UPDATE hire_proposals
                 SET status = 'activated', activated_agent_id = ?, activated_version = ?
               WHERE id = ?
                 AND status = 'approved'
                 AND proposal_sha256 = ?
                 AND expires_at > ?`,
            )
            .run(input.agentId, input.version, input.id, proposalSha256, occurredAt).changes,
        );
        if (changed !== 1) {
          throw this.diagnoseGuardMiss(current, proposalSha256, occurredAt, 'approved');
        }

        const employment = this.employments.applyTransitionInTransaction({
          agentId: input.agentId,
          action: 'hire',
          expectedRevision: input.expectedRevision,
          version: input.version,
          actor: input.actor,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
          occurredAt,
          proposalId: input.id,
        });

        // The activation audit row is the `agent.hired` entry the employment
        // transition just appended; it carries `proposalId`, so the approval and
        // the state change it authorized are linked. `agentAuditActionSchema`
        // has no `agent.proposal_activated` member (plan §3 does not define
        // one), and inventing an action here would mean editing a frozen
        // contract, so no second row is written.
        const result: HireProposalActivation = {
          proposal: this.requireProposal(input.id),
          employment,
        };
        input.idempotencyCompletion?.(result);
        return result;
      });
    } catch (error) {
      throw workforceError(error, { proposalId: input.id, agentId: input.agentId });
    }
  }

  /**
   * Settles every proposal whose window has closed (Security §8.4).
   *
   * Expiry is an automatic transition, not a user decision: `decided_by` stays
   * NULL — the 0007 `status <> 'expired' OR decided_by IS NULL` CHECK also
   * enforces that — and `decided_at` records when expiry was observed, which is
   * why an already-`approved` row has its `decided_by` cleared on the way out.
   * Returns the settled proposals, one audit row each.
   */
  public expire(now?: string): readonly HireProposal[] {
    const observedAt = this.parseInstant(now ?? this.now().toISOString(), 'expiry observation');
    try {
      return withImmediateTransaction(this.database, () => {
        const rows = this.database
          .prepare(
            `SELECT ${HIRE_PROPOSAL_COLUMNS} FROM hire_proposals
             WHERE status IN ('pending_approval', 'approved') AND expires_at <= ?
             ORDER BY created_at ASC, id ASC`,
          )
          .all(observedAt) as unknown as HireProposalRow[];

        const expired: HireProposal[] = [];
        for (const row of rows) {
          const changed = Number(
            this.database
              .prepare(
                `UPDATE hire_proposals
                   SET status = 'expired', decided_at = ?, decided_by = NULL
                 WHERE id = ? AND status IN ('pending_approval', 'approved') AND expires_at <= ?`,
              )
              .run(observedAt, row.id, observedAt).changes,
          );
          if (changed !== 1) {
            throw new ApplicationError(
              'INVALID_STATE_TRANSITION',
              `Hire proposal "${row.id}" changed while it was being expired.`,
              { statusCode: 409 },
            );
          }
          const updated = this.requireProposal(row.id);
          appendAgentAuditEntry(
            this.database,
            {
              action: 'agent.proposal_expired',
              actor: 'system',
              payload: {
                proposalId: updated.id,
                agentId: updated.proposedAgentId,
                proposalSha256: updated.proposalSha256,
                previousStatus: row.status,
                status: updated.status,
                expiresAt: updated.expiresAt,
              },
              createdAt: observedAt,
            },
            () => this.now(),
          );
          expired.push(updated);
        }
        return expired;
      });
    } catch (error) {
      throw workforceError(error, {});
    }
  }

  /**
   * Withdraws an open proposal whose content is no longer the content that was
   * proposed — the "hash changed, the approval is void" half of Security §8.3.
   * Unlike expiry this is attributable, so `decided_by` is recorded.
   *
   * No audit row is written: `agentAuditActionSchema` has no
   * `agent.proposal_invalidated` member and plan §3's action namespace does not
   * define one, so the only ways to audit this would be to edit a frozen
   * contract or to mislabel it as a rejection. Neither is acceptable; the gap is
   * reported rather than papered over.
   */
  public invalidate(input: HireProposalInvalidationInput): HireProposal {
    const decidedAt = this.parseInstant(
      input.decidedAt ?? this.now().toISOString(),
      'invalidation',
    );
    try {
      return withImmediateTransaction(this.database, () => {
        const current = this.requireProposal(input.id);
        const changed = Number(
          this.database
            .prepare(
              `UPDATE hire_proposals
                 SET status = 'invalidated', decided_at = ?, decided_by = ?
               WHERE id = ? AND status IN ('pending_approval', 'approved')`,
            )
            .run(decidedAt, input.decidedBy, input.id).changes,
        );
        if (changed !== 1) {
          throw new ApplicationError(
            'INVALID_STATE_TRANSITION',
            `Hire proposal "${input.id}" is "${current.status}" and can no longer be invalidated.`,
            { statusCode: 409 },
          );
        }
        return this.requireProposal(input.id);
      });
    } catch (error) {
      throw workforceError(error, { proposalId: input.id });
    }
  }

  public findById(id: string): HireProposal | undefined {
    const row = this.database
      .prepare(`SELECT ${HIRE_PROPOSAL_COLUMNS} FROM hire_proposals WHERE id = ?`)
      .get(id) as HireProposalRow | undefined;
    return row === undefined ? undefined : readHireProposalRow(row);
  }

  /**
   * The immutable proposal body. Read-only by construction: the three JSON
   * columns are written once by `create()` and this class offers no way to
   * write them again.
   */
  public findContentById(id: string): HireProposalContent | undefined {
    const row = this.database
      .prepare(
        `SELECT id, proposed_definition_json, proposed_profile_json, validation_json, proposal_sha256
         FROM hire_proposals WHERE id = ?`,
      )
      .get(id) as
      | {
          id: string;
          proposed_definition_json: string;
          proposed_profile_json: string;
          validation_json: string;
          proposal_sha256: string;
        }
      | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id,
      proposedDefinition: JSON.parse(row.proposed_definition_json),
      proposedProfile: JSON.parse(row.proposed_profile_json),
      validation: JSON.parse(row.validation_json),
      proposalSha256: row.proposal_sha256,
    };
  }

  /**
   * Proposals in `created_at ASC, id ASC` order. The order is total, so the
   * keyset cursor can neither skip nor repeat a row.
   */
  public list(options: HireProposalListOptions = {}): readonly HireProposal[] {
    const limit = this.parseLimit(options.limit);
    const cursor = this.resolveCursor(options.cursorId);

    const conditions: string[] = [];
    const parameters: (string | number)[] = [];
    if (options.status !== undefined) {
      conditions.push('status = ?');
      parameters.push(options.status);
    }
    if (cursor !== undefined) {
      conditions.push('(created_at > ? OR (created_at = ? AND id > ?))');
      parameters.push(cursor.created_at, cursor.created_at, cursor.id);
    }
    let limitClause = '';
    if (limit !== undefined) {
      limitClause = 'LIMIT ?';
      parameters.push(limit);
    }

    const rows = this.database
      .prepare(
        `SELECT ${HIRE_PROPOSAL_COLUMNS} FROM hire_proposals
         ${conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`}
         ORDER BY created_at ASC, id ASC
         ${limitClause}`,
      )
      .all(...(parameters as [])) as unknown as HireProposalRow[];
    return rows.map((row) => readHireProposalRow(row));
  }

  /**
   * Turns "the guarded UPDATE matched nothing" into the precise reason, using
   * the row read inside the same transaction. The order is fixed: an invalid
   * input (wrong hash) is reported before a stale one (expired), and a status
   * mismatch last, so a caller presenting the wrong content is never told the
   * proposal was merely already decided.
   */
  private diagnoseGuardMiss(
    current: HireProposal,
    proposalSha256: string,
    at: string,
    requiredStatus: 'pending_approval' | 'approved',
  ): ApplicationError {
    if (current.proposalSha256 !== proposalSha256) {
      return new ApplicationError(
        'VALIDATION_FAILED',
        `Hire proposal "${current.id}" has different content than the decision states; the approval is void (Security §8.3).`,
      );
    }
    if (current.expiresAt <= at) {
      return new ApplicationError(
        'VALIDATION_FAILED',
        `Hire proposal "${current.id}" expired at ${current.expiresAt} and can no longer be used.`,
      );
    }
    if (requiredStatus === 'approved' && current.status === 'pending_approval') {
      return new ApplicationError(
        'APPROVAL_REQUIRED',
        `Hire proposal "${current.id}" has not been approved, so no agent may be activated from it.`,
      );
    }
    return new ApplicationError(
      'INVALID_STATE_TRANSITION',
      `Hire proposal "${current.id}" is "${current.status}", not "${requiredStatus}".`,
      { statusCode: 409 },
    );
  }

  private assertLifetime(createdAt: string, expiresAt: string): void {
    const lifetime = Date.parse(expiresAt) - Date.parse(createdAt);
    if (lifetime <= 0) {
      throw new ApplicationError(
        'VALIDATION_FAILED',
        'A hire proposal must expire after it was created.',
      );
    }
    if (lifetime > MAX_PROPOSAL_LIFETIME_MS) {
      throw new ApplicationError(
        'VALIDATION_FAILED',
        `A hire proposal expires at most ${MAX_PROPOSAL_LIFETIME_MS / 60000} minutes after creation (Security §8.3).`,
      );
    }
  }

  private parseDecision(decision: 'approve' | 'reject'): 'approve' | 'reject' {
    if (decision !== 'approve' && decision !== 'reject') {
      throw new ApplicationError(
        'VALIDATION_FAILED',
        'A hire proposal decision is either "approve" or "reject".',
      );
    }
    return decision;
  }

  private parseSha256(value: string): string {
    const parsed = sha256HexSchema.safeParse(value);
    if (!parsed.success) {
      throw new ApplicationError(
        'VALIDATION_FAILED',
        'The proposal hash is not a lowercase SHA-256 hex digest.',
        { details: parsed.error.issues },
      );
    }
    return parsed.data;
  }

  /** Normalizes an instant so string comparison against a stored one is exact. */
  private parseInstant(value: string, label: string): string {
    const parsed = utcIso8601Schema.safeParse(value);
    if (!parsed.success) {
      throw new ApplicationError(
        'VALIDATION_FAILED',
        `The hire proposal ${label} instant is not a UTC ISO 8601 timestamp.`,
        { details: parsed.error.issues },
      );
    }
    return parsed.data;
  }

  private parseProposal(candidate: unknown): HireProposal {
    const parsed = hireProposalSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new ApplicationError(
        'VALIDATION_FAILED',
        'The hire proposal failed schema validation.',
        {
          details: parsed.error.issues,
        },
      );
    }
    return parsed.data;
  }

  private parseLimit(limit: number | undefined): number | undefined {
    if (limit === undefined) {
      return undefined;
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_HIRE_PROPOSAL_PAGE_SIZE) {
      throw new ApplicationError(
        'VALIDATION_FAILED',
        `A hire proposal page size must be between 1 and ${MAX_HIRE_PROPOSAL_PAGE_SIZE}.`,
      );
    }
    return limit;
  }

  private resolveCursor(cursorId: string | undefined): HireProposalRow | undefined {
    if (cursorId === undefined) {
      return undefined;
    }
    const row = this.database
      .prepare(`SELECT ${HIRE_PROPOSAL_COLUMNS} FROM hire_proposals WHERE id = ?`)
      .get(cursorId) as HireProposalRow | undefined;
    if (row === undefined) {
      throw new ApplicationError(
        'VALIDATION_FAILED',
        'The pagination cursor does not identify a known hire proposal.',
      );
    }
    return row;
  }

  private requireProposal(id: string): HireProposal {
    const proposal = this.findById(id);
    if (proposal === undefined) {
      throw new ApplicationError('NOT_FOUND', `Hire proposal "${id}" does not exist.`);
    }
    return proposal;
  }
}
