import type { DatabaseSync } from 'node:sqlite';
import {
  agentEmploymentSchema,
  allowedEmploymentTransitions,
  employmentActionSchema,
  type AgentAuditAction,
  type AgentEmployment,
  type EmploymentAction,
  type EmploymentState,
} from '@orion/contracts';

import { withImmediateTransaction } from '../database.js';
import { ApplicationError } from '../errors.js';
import type { AgentRegistryReadModel } from './agent-registry-read-model.js';
import { appendAgentAuditEntry, workforceError } from './agent-workforce-support.js';

/** The audit action recorded for each lifecycle action (plan §3, WFM-022). */
const EMPLOYMENT_AUDIT_ACTIONS = {
  hire: 'agent.hired',
  suspend: 'agent.suspended',
  resume: 'agent.resumed',
  dismiss: 'agent.dismissed',
  rehire: 'agent.rehired',
} as const satisfies Record<EmploymentAction, AgentAuditAction>;

/** Actions that put an agent to work, and are therefore blocked for Arca in M3. */
const ACTIVATING_ACTIONS: readonly EmploymentAction[] = ['hire', 'rehire', 'resume'];

/** The agent whose registry runtime is out of M3 scope (plan §2.3, DEC-035). */
const RUNTIME_UNIMPLEMENTED_AGENT_ID = 'arca';

export interface EmploymentTransitionInput {
  readonly agentId: string;
  readonly action: EmploymentAction;
  /** Compare-and-swap guard: the revision the caller believes is current. */
  readonly expectedRevision: number;
  /** Required for `hire`, optional for `rehire`, rejected for the other actions. */
  readonly version?: number;
  readonly actor: string;
  readonly reason?: string;
  readonly occurredAt?: string;
  /**
   * The approved hire proposal this activation is executing, when there is one.
   * It is recorded in the audit payload so the approval record and the state
   * change it authorized can be tied together (Security §8.3: the approver and
   * the executing subject are recorded separately). It never relaxes a check.
   */
  readonly proposalId?: string;
  /**
   * Invoked inside the same transaction, after the audit row is appended, so an
   * idempotency completion failure rolls the whole mutation back (WFM-024).
   */
  readonly idempotencyCompletion?: (employment: AgentEmployment) => void;
}

interface EmploymentRow {
  readonly agent_id: string;
  readonly state: string;
  readonly active_version: number | null;
  readonly last_active_version: number | null;
  readonly activated_at: string | null;
  readonly deactivated_at: string | null;
  readonly actor: string;
  readonly reason: string | null;
  readonly revision: number;
  readonly updated_at: string;
}

const EMPLOYMENT_COLUMNS =
  'agent_id, state, active_version, last_active_version, activated_at, deactivated_at, actor, reason, revision, updated_at';

/** Parses a row through `agentEmploymentSchema` so a corrupt row can never flow onward. */
function readEmploymentRow(row: EmploymentRow): AgentEmployment {
  return agentEmploymentSchema.parse({
    agentId: row.agent_id,
    state: row.state,
    activeVersion: row.active_version === null ? null : Number(row.active_version),
    lastActiveVersion: row.last_active_version === null ? null : Number(row.last_active_version),
    activatedAt: row.activated_at,
    deactivatedAt: row.deactivated_at,
    actor: row.actor,
    reason: row.reason,
    revision: Number(row.revision),
    updatedAt: row.updated_at,
  });
}

/**
 * The state an action moves `from` to, or `undefined` when the pair is rejected.
 *
 * The lookup is `(from, action)` rather than `(from, to)` because the service
 * API is action-shaped. No entry in `allowedEmploymentTransitions` has
 * `from === to`, so a self transition can never be produced here: the four
 * self pairs are refused as "this action is not permitted in this state".
 */
function targetStateFor(
  from: EmploymentState,
  action: EmploymentAction,
): EmploymentState | undefined {
  return allowedEmploymentTransitions.find(
    (transition) => transition.from === from && transition.action === action,
  )?.to;
}

/**
 * Persistence boundary for the agent employment lifecycle
 * (plan-delta-003 §2.3/§3, WFM-005/006/020/024/028/031).
 *
 * `agent_employments` is the sole runtime authority for "may this agent be
 * planned or spawned". Every mutation goes through one of the two transition
 * entry points below: there is deliberately **no** generic `save`, `update` or
 * `setState` method, because a caller that can write `state` directly bypasses
 * the CAS guard, the Arca block and the version-existence check at once.
 *
 * Layer boundary, stated exactly (plan §2.3 J-1). The database enforces the
 * initial state (`AGENT_EMPLOYMENT_INITIAL_STATE`, migration 0007), the Arca
 * activation block (`agent_employments_arca_blocked`, 0007) and the legality of
 * every state UPDATE (`agent_employments_transition_guard`, replaced by
 * migration 0008). Since 0008 that last guard also rejects the four **self**
 * transitions: 0007 carried a `NEW.state <> OLD.state` term that let a
 * same-state UPDATE slip past the `RAISE(ABORT)`, and 0008 dropped it, so all
 * nine rejected ordered pairs are now refused by the trigger as well as here.
 * What the database still cannot enforce is **approval** and **version
 * existence** — `draft -> active` is a legal pair whatever authorized it, and
 * `active_version` has no foreign key because its target table depends on the
 * agent's origin (plan §2.3 H-7). Those two are enforced in this class alone.
 */
export class AgentEmploymentRepository {
  public constructor(
    private readonly database: DatabaseSync,
    private readonly registry: AgentRegistryReadModel,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Applies one lifecycle transition in its own `BEGIN IMMEDIATE` transaction. */
  public transition(input: EmploymentTransitionInput): AgentEmployment {
    try {
      return withImmediateTransaction(this.database, () => this.applyTransition(input));
    } catch (error) {
      throw workforceError(error, { agentId: input.agentId });
    }
  }

  /**
   * The same transition, for a caller that **MUST already hold an IMMEDIATE
   * transaction**.
   *
   * `HireProposalRepository.activate()` needs the proposal status change, this
   * activation, the audit rows and the idempotency completion to commit or roll
   * back as one unit. SQLite has no nested transactions, so this method never
   * opens one — calling `withImmediateTransaction` from inside an open
   * transaction would raise "cannot start a transaction within a transaction".
   * The precondition is asserted rather than merely documented, so a caller that
   * forgets it fails loudly instead of committing a half-applied activation.
   */
  public applyTransitionInTransaction(input: EmploymentTransitionInput): AgentEmployment {
    try {
      if (!this.database.isTransaction) {
        throw new ApplicationError(
          'DATABASE_UNAVAILABLE',
          'An in-transaction employment transition requires the caller to hold an open transaction.',
        );
      }
      return this.applyTransition(input);
    } catch (error) {
      throw workforceError(error, { agentId: input.agentId });
    }
  }

  public findByAgentId(agentId: string): AgentEmployment | undefined {
    const row = this.database
      .prepare(`SELECT ${EMPLOYMENT_COLUMNS} FROM agent_employments WHERE agent_id = ?`)
      .get(agentId) as EmploymentRow | undefined;
    return row === undefined ? undefined : readEmploymentRow(row);
  }

  public listByState(state: EmploymentState): readonly AgentEmployment[] {
    const rows = this.database
      .prepare(
        `SELECT ${EMPLOYMENT_COLUMNS} FROM agent_employments WHERE state = ?
         ORDER BY agent_id ASC`,
      )
      .all(state) as unknown as EmploymentRow[];
    return rows.map((row) => readEmploymentRow(row));
  }

  /**
   * One transition, in the order plan §2.3 and §3 fix. The order is part of the
   * contract, not an implementation detail: it decides which status code an
   * ambiguous request receives.
   */
  private applyTransition(input: EmploymentTransitionInput): AgentEmployment {
    // 0. Input shape. A caller that bypasses the compile-time type with an
    //    unknown action gets a 422 rather than a misleading "illegal transition".
    const action = this.parseAction(input.action);

    // 1. The current row, which is also the 404 boundary.
    const current = this.requireEmployment(input.agentId);

    // 2. Compare-and-swap: a caller working from a stale view must be told its
    //    view is stale, whatever it was trying to do (WFM-024).
    if (current.revision !== input.expectedRevision) {
      throw new ApplicationError(
        'INVALID_STATE_TRANSITION',
        `Agent "${input.agentId}" employment revision is ${current.revision}, not the expected ${input.expectedRevision}.`,
        { statusCode: 409 },
      );
    }

    // 3. Arca before the transition matrix (plan §2.3 H-5, DEC-035). Evaluating
    //    the matrix first would answer `rehire`/`resume` on a `draft` Arca with
    //    a 409 "illegal transition", but WFM-028(a) requires all three
    //    activating actions to be refused with 422 for the stated reason —
    //    Arca has no registry runtime in M3 — regardless of its current state.
    if (input.agentId === RUNTIME_UNIMPLEMENTED_AGENT_ID && ACTIVATING_ACTIONS.includes(action)) {
      throw new ApplicationError(
        'VALIDATION_FAILED',
        `Agent "${RUNTIME_UNIMPLEMENTED_AGENT_ID}" cannot be employed: its registry runtime is not implemented in M3.`,
      );
    }

    // 4. Transition legality. A self transition has no entry in the matrix and
    //    is rejected here with 409 — the service half of WFM-005, whose database
    //    half migration 0008 delivers.
    const nextState = targetStateFor(current.state, action);
    if (nextState === undefined) {
      throw new ApplicationError(
        'INVALID_STATE_TRANSITION',
        `Action "${action}" is not permitted for agent "${input.agentId}" in state "${current.state}".`,
        { statusCode: 409 },
      );
    }

    // 5-6. Version resolution and version existence.
    const activation = this.resolveActivation(input, action, current);

    const timestamp = input.occurredAt ?? this.now().toISOString();
    const reason = input.reason ?? null;
    // `activated_at` and `deactivated_at` each record the most recent event of
    // their own kind, so the other one is carried forward untouched rather than
    // cleared: a resumed agent keeps the instant it was last suspended.
    const activatedAt = nextState === 'active' ? timestamp : current.activatedAt;
    const deactivatedAt = nextState === 'active' ? current.deactivatedAt : timestamp;

    // 7. Guarded UPDATE. The revision is part of the WHERE, so the CAS check
    //    above and the write cannot be separated by a concurrent writer.
    const changed = Number(
      this.database
        .prepare(
          `UPDATE agent_employments
             SET state = ?,
                 active_version = ?,
                 last_active_version = ?,
                 activated_at = ?,
                 deactivated_at = ?,
                 actor = ?,
                 reason = ?,
                 revision = revision + 1,
                 updated_at = ?
           WHERE agent_id = ? AND revision = ?`,
        )
        .run(
          nextState,
          activation.activeVersion,
          activation.lastActiveVersion,
          activatedAt,
          deactivatedAt,
          input.actor,
          reason,
          timestamp,
          input.agentId,
          input.expectedRevision,
        ).changes,
    );
    if (changed !== 1) {
      throw new ApplicationError(
        'INVALID_STATE_TRANSITION',
        `Agent "${input.agentId}" employment was modified concurrently.`,
        { statusCode: 409 },
      );
    }

    const updated = this.requireEmployment(input.agentId);

    // 8. Exactly one audit row, in this transaction (WFM-022).
    appendAgentAuditEntry(
      this.database,
      {
        action: EMPLOYMENT_AUDIT_ACTIONS[action],
        actor: input.actor,
        payload: {
          agentId: input.agentId,
          action,
          fromState: current.state,
          toState: updated.state,
          activeVersion: updated.activeVersion,
          lastActiveVersion: updated.lastActiveVersion,
          revision: updated.revision,
          ...(reason === null ? {} : { reason }),
          ...(input.proposalId === undefined ? {} : { proposalId: input.proposalId }),
        },
        createdAt: timestamp,
      },
      () => this.now(),
    );

    // 9. The idempotency completion runs last and inside the transaction, so a
    //    throw here rolls the state change and its audit row back with it.
    input.idempotencyCompletion?.(updated);

    // 10. The reparsed row, never the in-memory projection of what was written.
    return updated;
  }

  /**
   * Resolves the version columns for one action (plan §2.3 table).
   *
   * No action promotes an agent onto a newer version: `hire` activates the
   * version the request named, `rehire` the named one or the last active one,
   * and `resume` restores the last active one even when newer versions appeared
   * while the agent was suspended (G-4/I-9). A version that cannot be resolved,
   * or that does not exist in the agent's union version set, is a 422 rather
   * than a silent fallback to the newest version.
   */
  private resolveActivation(
    input: EmploymentTransitionInput,
    action: EmploymentAction,
    current: AgentEmployment,
  ): { readonly activeVersion: number | null; readonly lastActiveVersion: number | null } {
    if (action === 'suspend' || action === 'dismiss') {
      this.rejectUnusedVersion(input, action);
      // "the previous `active_version`, preserved" (plan §2.3). While a row is
      // `active` the two columns hold the same number, and while it is not,
      // `active_version` is NULL by CHECK — so reading the active one first and
      // falling back keeps the rule literal for every legal starting state
      // (`active` for suspend; `draft`, `active` or `suspended` for dismiss).
      return {
        activeVersion: null,
        lastActiveVersion: current.activeVersion ?? current.lastActiveVersion,
      };
    }

    if (action === 'hire') {
      if (input.version === undefined) {
        throw new ApplicationError(
          'VALIDATION_FAILED',
          `Hiring agent "${input.agentId}" requires the version to activate; the server never selects one.`,
        );
      }
      this.requireExistingVersion(input.agentId, input.version);
      return { activeVersion: input.version, lastActiveVersion: input.version };
    }

    if (action === 'rehire') {
      const version = input.version ?? current.lastActiveVersion;
      if (version === null) {
        throw new ApplicationError(
          'VALIDATION_FAILED',
          `Rehiring agent "${input.agentId}" requires a version: it has no last active version to restore.`,
        );
      }
      this.requireExistingVersion(input.agentId, version);
      return { activeVersion: version, lastActiveVersion: version };
    }

    // resume: the last active version is restored, never a newer one.
    this.rejectUnusedVersion(input, action);
    if (current.lastActiveVersion === null) {
      throw new ApplicationError(
        'VALIDATION_FAILED',
        `Resuming agent "${input.agentId}" requires a last active version to restore.`,
      );
    }
    this.requireExistingVersion(input.agentId, current.lastActiveVersion);
    return {
      activeVersion: current.lastActiveVersion,
      lastActiveVersion: current.lastActiveVersion,
    };
  }

  /** `version` is meaningful only for `hire` and `rehire` (plan §8, J-3). */
  private rejectUnusedVersion(input: EmploymentTransitionInput, action: EmploymentAction): void {
    if (input.version !== undefined) {
      throw new ApplicationError(
        'VALIDATION_FAILED',
        `Action "${action}" does not take a version.`,
      );
    }
  }

  /**
   * The version must exist in the agent's UNION version set. `active_version`
   * cannot carry a foreign key because its target table depends on the agent's
   * origin (plan §2.3 H-7), so this check is the only thing standing between a
   * request and an employment row pointing at a version that was never stored.
   */
  private requireExistingVersion(agentId: string, version: number): void {
    const entry = this.registry.find(agentId);
    if (entry === undefined || !entry.versions.includes(version)) {
      throw new ApplicationError(
        'VALIDATION_FAILED',
        `Agent "${agentId}" has no stored profile version ${version}.`,
      );
    }
  }

  private parseAction(action: EmploymentAction): EmploymentAction {
    const parsed = employmentActionSchema.safeParse(action);
    if (!parsed.success) {
      throw new ApplicationError(
        'VALIDATION_FAILED',
        'The employment action is not one of "hire", "dismiss", "rehire", "suspend" or "resume".',
        { details: parsed.error.issues },
      );
    }
    return parsed.data;
  }

  private requireEmployment(agentId: string): AgentEmployment {
    const employment = this.findByAgentId(agentId);
    if (employment === undefined) {
      throw new ApplicationError('NOT_FOUND', `Agent "${agentId}" has no employment record.`);
    }
    return employment;
  }
}
