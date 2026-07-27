import type { DatabaseSync } from 'node:sqlite';
import { ulid } from 'ulid';
import { agentAuditActionSchema, type AgentAuditAction } from '@orion/contracts';

import { ApplicationError } from '../errors.js';

/**
 * Shared seam for every agent-workforce repository (plan-delta-003 §2, §12).
 *
 * `agent_definitions`, `agent_profile_versions`, `agent_employments` and
 * `hire_proposals` are all guarded by migration 0007 triggers that raise a
 * fixed label. This module owns the single translation of those labels into
 * `ApplicationError`, plus the audit-append and built-in-id checks every
 * workforce repository needs, so the mapping can never drift between them.
 */

/** The number of `origin = 'builtin'` definitions seeded by migration 0007. */
export const BUILTIN_AGENT_ID_COUNT = 18;

/**
 * Trigger labels that mean "this mutation is not permitted in the current
 * state": append-only violations and rejected lifecycle transitions. They are
 * conflicts (409), not malformed input.
 */
const WORKFORCE_CONFLICT_LABELS: readonly string[] = [
  'AGENT_DEFINITION_APPEND_ONLY',
  'PROFILE_VERSIONS_APPEND_ONLY',
  'AGENT_EMPLOYMENT_APPEND_ONLY',
  'HIRE_PROPOSALS_APPEND_ONLY',
  'AUDIT_APPEND_ONLY',
  'INVALID_STATE_TRANSITION',
];

/**
 * Trigger labels that mean "the request itself was never legal": a reserved
 * origin, an id-space violation, an illegal initial employment state, or the
 * Arca activation block. They are validation failures (422).
 */
const WORKFORCE_VALIDATION_LABELS: readonly string[] = [
  'BUILTIN_ORIGIN_SEED_ONLY',
  'CUSTOM_VERSION_SPACE_VIOLATION',
  'BUILTIN_PROFILE_SPACE_VIOLATION',
  'AGENT_EMPLOYMENT_INITIAL_STATE',
  'ARCA_ACTIVATION_BLOCKED',
];

export interface WorkforceErrorContext {
  readonly agentId?: string;
  readonly proposalId?: string;
}

/**
 * Maps a raised SQLite guard into the transport-visible `ApplicationError`.
 *
 * SQLite reports `RAISE(ABORT, '<LABEL>')` as the raised label inside the
 * error *message* text rather than as a structured error code, so the label is
 * matched on `Error.message` — the same technique `sqliteErrorCode()` uses in
 * `database.ts`. An `ApplicationError` raised by the repository itself passes
 * through untouched so a precise service-layer diagnosis is never downgraded.
 */
export function workforceError(
  error: unknown,
  context: WorkforceErrorContext = {},
): ApplicationError {
  if (error instanceof ApplicationError) {
    return error;
  }

  const message = error instanceof Error ? error.message : '';
  const subject = describeSubject(context);

  for (const label of WORKFORCE_CONFLICT_LABELS) {
    if (message.includes(label)) {
      return new ApplicationError(
        'INVALID_STATE_TRANSITION',
        `The requested agent workforce change is not permitted${subject}.`,
        { statusCode: 409, details: label },
      );
    }
  }

  for (const label of WORKFORCE_VALIDATION_LABELS) {
    if (message.includes(label)) {
      return new ApplicationError(
        'VALIDATION_FAILED',
        `The agent workforce request violates a registry invariant${subject}.`,
        { statusCode: 422, details: label },
      );
    }
  }

  if (message.includes('UNIQUE constraint failed: agent_definitions.id')) {
    return new ApplicationError(
      'VALIDATION_FAILED',
      `An agent definition with this id already exists${subject}.`,
      { statusCode: 422 },
    );
  }

  if (message.includes('FOREIGN KEY constraint failed')) {
    return new ApplicationError(
      'NOT_FOUND',
      `The referenced agent definition does not exist${subject}.`,
      { statusCode: 404 },
    );
  }

  return new ApplicationError(
    'DATABASE_UNAVAILABLE',
    `The agent workforce change could not be persisted${subject}.`,
    { statusCode: 503, retryable: true },
  );
}

function describeSubject(context: WorkforceErrorContext): string {
  const parts: string[] = [];
  if (context.agentId !== undefined) {
    parts.push(`agent "${context.agentId}"`);
  }
  if (context.proposalId !== undefined) {
    parts.push(`proposal "${context.proposalId}"`);
  }
  return parts.length === 0 ? '' : ` for ${parts.join(' and ')}`;
}

export interface AgentAuditEntry {
  readonly action: AgentAuditAction;
  readonly actor: string;
  readonly payload: Record<string, unknown>;
  readonly id?: string;
  readonly createdAt?: string;
}

/**
 * Payload key fragments that may never reach `audit_log` (WFM-022, plan §12).
 * Only identifiers, hashes, counts, states and version numbers belong in a
 * workforce audit payload, so the check is deliberately a *substring* match on
 * the normalized key and fails closed: `raw_output`, `apiKey`, `promptText`
 * and `accessToken` are all rejected. Callers that need a token or prompt
 * metric must record it in the run/event telemetry tables, not here.
 */
const FORBIDDEN_AUDIT_PAYLOAD_KEY_FRAGMENTS: readonly string[] = [
  'prompt',
  'soulmarkdown',
  'harnessmarkdown',
  'markdown',
  'secret',
  'token',
  'password',
  'apikey',
  'credential',
  'rawoutput',
];

/** Deepest payload nesting accepted; also terminates a cyclic payload. */
const MAX_AUDIT_PAYLOAD_DEPTH = 8;

/**
 * Appends exactly one `audit_log` row for an agent-scoped workforce event.
 *
 * The row shape is fixed by migration 0001 — `(id, actor, action, project_id,
 * payload_json, created_at)` — and is never altered here. `project_id` is
 * always NULL because workforce events are agent-scoped, not project-scoped;
 * the agent identifier lives inside the payload (DEC-033).
 *
 * The caller MUST already hold a transaction: this function deliberately does
 * not open one, so the audit row commits or rolls back together with the state
 * change it describes.
 *
 * Returns the audit row id (a fresh ULID when the caller supplied none).
 */
export function appendAgentAuditEntry(
  database: DatabaseSync,
  entry: AgentAuditEntry,
  now: () => Date,
): string {
  const parsedAction = agentAuditActionSchema.safeParse(entry.action);
  if (!parsedAction.success) {
    throw new ApplicationError(
      'VALIDATION_FAILED',
      'The audit action is not a known agent workforce action.',
      { details: parsedAction.error.issues },
    );
  }

  assertAuditPayloadHygiene(entry.payload, 0);

  const id = entry.id ?? ulid();
  const createdAt = entry.createdAt ?? now().toISOString();
  database
    .prepare(
      `INSERT INTO audit_log (id, actor, action, project_id, payload_json, created_at)
       VALUES (?, ?, ?, NULL, ?, ?)`,
    )
    .run(id, entry.actor, parsedAction.data, JSON.stringify(entry.payload), createdAt);
  return id;
}

function assertAuditPayloadHygiene(value: unknown, depth: number): void {
  if (depth > MAX_AUDIT_PAYLOAD_DEPTH) {
    throw new ApplicationError(
      'VALIDATION_FAILED',
      'The audit payload is nested deeper than the audit hygiene check can inspect.',
    );
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      assertAuditPayloadHygiene(item, depth + 1);
    }
    return;
  }

  if (value === null || typeof value !== 'object') {
    return;
  }

  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    const forbidden = FORBIDDEN_AUDIT_PAYLOAD_KEY_FRAGMENTS.find((fragment) =>
      normalized.includes(fragment),
    );
    if (forbidden !== undefined) {
      throw new ApplicationError(
        'VALIDATION_FAILED',
        `An audit payload cannot carry the "${key}" field: secrets and raw bodies are never audited.`,
        { details: forbidden },
      );
    }
    assertAuditPayloadHygiene(nested, depth + 1);
  }
}

/**
 * Authoritative built-in check: the stored `origin` of the definition row, not
 * a hard-coded id list, so it cannot drift from the 0007 seed.
 */
export function isBuiltinAgentId(database: DatabaseSync, agentId: string): boolean {
  const row = database
    .prepare("SELECT 1 AS present FROM agent_definitions WHERE id = ? AND origin = 'builtin'")
    .get(agentId) as { present?: number } | undefined;
  return row !== undefined;
}
