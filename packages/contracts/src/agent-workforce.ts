import { z } from 'zod';

import {
  agentIdSchema,
  nfcStringSchema,
  positiveSafeIntegerSchema,
  sha256HexSchema,
  ulidSchema,
  utcIso8601Schema,
} from './base.js';
import { fallbackModelSchema, providerSchema, reasoningEffortSchema } from './agent-profile.js';

/**
 * Agent Workforce contracts (plan-delta-003 rev6, DEC-030..037).
 *
 * Three concepts are kept strictly apart:
 * - `AgentDefinition`  — immutable identity of an agent (never rewritten).
 * - `AgentProfileVersion` — immutable content of one version.
 * - `AgentEmployment` — the mutable lifecycle state, the sole runtime authority
 *   for "may this agent be planned/spawned".
 */

export const agentOriginSchema = z.enum([
  'builtin',
  'user_created',
  'manager_proposed',
  'imported',
]);

/** Origins a request path may produce; `builtin` is reserved for the 0007 seed (DEC-031). */
export const requestableAgentOriginSchema = z.enum([
  'user_created',
  'manager_proposed',
  'imported',
]);

export const agentDefinitionSchema = z
  .object({
    id: agentIdSchema,
    name: nfcStringSchema(1, 40),
    origin: agentOriginSchema,
    createdBy: nfcStringSchema(1, 64),
    createdAt: utcIso8601Schema,
  })
  .strict();

export const employmentStateSchema = z.enum(['draft', 'active', 'suspended', 'retired']);

export const employmentActionSchema = z.enum(['hire', 'dismiss', 'rehire', 'suspend', 'resume']);

/** The 7 permitted transitions of §3; every other ordered pair is rejected. */
export const allowedEmploymentTransitions: readonly {
  readonly from: EmploymentState;
  readonly to: EmploymentState;
  readonly action: EmploymentAction;
}[] = [
  { from: 'draft', to: 'active', action: 'hire' },
  { from: 'active', to: 'suspended', action: 'suspend' },
  { from: 'suspended', to: 'active', action: 'resume' },
  { from: 'active', to: 'retired', action: 'dismiss' },
  { from: 'suspended', to: 'retired', action: 'dismiss' },
  { from: 'retired', to: 'active', action: 'rehire' },
  { from: 'draft', to: 'retired', action: 'dismiss' },
];

/** True only for the 7 transitions above (self-transitions are never allowed). */
export function isAllowedEmploymentTransition(from: EmploymentState, to: EmploymentState): boolean {
  return allowedEmploymentTransitions.some(
    (transition) => transition.from === from && transition.to === to,
  );
}

/** The action that performs `from -> to`, or `undefined` when the pair is rejected. */
export function employmentActionFor(
  from: EmploymentState,
  to: EmploymentState,
): EmploymentAction | undefined {
  return allowedEmploymentTransitions.find(
    (transition) => transition.from === from && transition.to === to,
  )?.action;
}

export const agentEmploymentSchema = z
  .object({
    agentId: agentIdSchema,
    state: employmentStateSchema,
    activeVersion: positiveSafeIntegerSchema.nullable(),
    lastActiveVersion: positiveSafeIntegerSchema.nullable(),
    activatedAt: utcIso8601Schema.nullable(),
    deactivatedAt: utcIso8601Schema.nullable(),
    actor: nfcStringSchema(1, 64),
    reason: nfcStringSchema(1, 200).nullable(),
    revision: positiveSafeIntegerSchema,
    updatedAt: utcIso8601Schema,
  })
  .strict()
  .superRefine((employment, context) => {
    if (employment.state === 'active' && employment.activeVersion === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'An active employment requires an active version.',
        path: ['activeVersion'],
      });
    }
    if (employment.state !== 'active' && employment.activeVersion !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Only an active employment carries an active version.',
        path: ['activeVersion'],
      });
    }
  });

/**
 * Employment mutation request. `hire` must name the version to activate: the
 * server never auto-selects the newest version (DEC-032, plan §2.3).
 */
export const employmentRequestSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('hire'),
      version: positiveSafeIntegerSchema,
      expectedRevision: positiveSafeIntegerSchema,
      reason: nfcStringSchema(1, 200).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('rehire'),
      version: positiveSafeIntegerSchema.optional(),
      expectedRevision: positiveSafeIntegerSchema,
      reason: nfcStringSchema(1, 200).optional(),
    })
    .strict(),
  z
    .object({
      action: z.enum(['dismiss', 'suspend', 'resume']),
      expectedRevision: positiveSafeIntegerSchema,
      reason: nfcStringSchema(1, 200).optional(),
    })
    .strict(),
]);

export const selectionModeSchema = z.enum(['default', 'override']);
export const selectionSourceSchema = z.enum(['catalog', 'user', 'manager']);

/**
 * Provider/model/effort selection of one profile version. Permissions are NOT
 * part of this object: an override can never widen a permission ceiling.
 */
export const runtimeSelectionSchema = z
  .object({
    selectionMode: selectionModeSchema,
    selectionSource: selectionSourceSchema,
    provider: providerSchema,
    model: nfcStringSchema(1, 128),
    reasoningEffort: reasoningEffortSchema,
    fallbackModels: z.array(fallbackModelSchema).max(3),
  })
  .strict()
  .superRefine((selection, context) => {
    if (selection.selectionMode === 'default' && selection.selectionSource !== 'catalog') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A default selection can only come from the catalog.',
        path: ['selectionSource'],
      });
    }
    if (selection.selectionMode === 'override' && selection.selectionSource === 'catalog') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'An override selection must be attributed to the user or the manager agent.',
        path: ['selectionSource'],
      });
    }
    const seen = new Set<string>();
    for (const [index, fallback] of selection.fallbackModels.entries()) {
      const key = `${fallback.provider}:${fallback.model}`;
      if (fallback.provider === selection.provider && fallback.model === selection.model) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'A fallback model cannot duplicate the primary model.',
          path: ['fallbackModels', index],
        });
      }
      if (seen.has(key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Fallback models must be unique.',
          path: ['fallbackModels', index],
        });
      }
      seen.add(key);
    }
  });

/** Where the HARNESS body used by a run came from (plan §6). */
export const harnessSourceSchema = z.enum(['profile', 'template-default']);

export const harnessDocumentSchema = z
  .object({
    markdown: nfcStringSchema(20, 200000),
    sha256: sha256HexSchema,
    source: harnessSourceSchema,
  })
  .strict();

/**
 * A custom agent's profile version. Built-in versions keep living in
 * `agent_profiles` (DEC-031): this contract covers the custom id space only.
 */
export const agentProfileVersionSchema = z
  .object({
    agentId: agentIdSchema,
    version: positiveSafeIntegerSchema,
    configSha256: sha256HexSchema,
    soulSha256: sha256HexSchema,
    harnessSha256: sha256HexSchema.nullable(),
    runtimeSelection: runtimeSelectionSchema,
    origin: requestableAgentOriginSchema,
    createdBy: nfcStringSchema(1, 64),
    createdAt: utcIso8601Schema,
  })
  .strict();

export const hireProposalStatusSchema = z.enum([
  'pending_approval',
  'approved',
  'rejected',
  'expired',
  'activated',
  'invalidated',
]);

/**
 * A proposal authored by the top-level manager agent (Orion). It can never
 * activate anything by itself: activation requires an explicit user decision
 * that re-states `proposalSha256` (Security §8.3, DEC-030).
 */
/**
 * Per-status field expectations. `null` means "must be null", `'set'` means
 * "must not be null"; every status is listed, so an unhandled status is a
 * compile error rather than a silently permitted combination.
 *
 * Expiry is an automatic transition, not a user decision: `expired` records
 * when expiry was settled in `decidedAt` and leaves `decidedBy` null. The
 * expiry instant itself is already carried by `expiresAt`.
 */
const hireProposalStatusInvariants: Record<
  HireProposalStatus,
  {
    readonly decidedAt: 'set' | null;
    readonly decidedBy: 'set' | null;
    readonly activatedVersion: 'set' | null;
  }
> = {
  pending_approval: { decidedAt: null, decidedBy: null, activatedVersion: null },
  approved: { decidedAt: 'set', decidedBy: 'set', activatedVersion: null },
  rejected: { decidedAt: 'set', decidedBy: 'set', activatedVersion: null },
  invalidated: { decidedAt: 'set', decidedBy: 'set', activatedVersion: null },
  expired: { decidedAt: 'set', decidedBy: null, activatedVersion: null },
  activated: { decidedAt: 'set', decidedBy: 'set', activatedVersion: 'set' },
};

export const hireProposalSchema = z
  .object({
    id: ulidSchema,
    requestedBy: nfcStringSchema(1, 64),
    authoredBy: agentIdSchema,
    proposedAgentId: agentIdSchema,
    proposalSha256: sha256HexSchema,
    status: hireProposalStatusSchema,
    createdAt: utcIso8601Schema,
    expiresAt: utcIso8601Schema,
    decidedAt: utcIso8601Schema.nullable(),
    decidedBy: nfcStringSchema(1, 64).nullable(),
    activatedAgentId: agentIdSchema.nullable(),
    activatedVersion: positiveSafeIntegerSchema.nullable(),
  })
  .strict()
  .superRefine((proposal, context) => {
    const expected = hireProposalStatusInvariants[proposal.status];
    const actual = {
      decidedAt: proposal.decidedAt,
      decidedBy: proposal.decidedBy,
      activatedVersion: proposal.activatedVersion,
    };

    for (const field of ['decidedAt', 'decidedBy', 'activatedVersion'] as const) {
      const requirement = expected[field];
      const value = actual[field];
      if (requirement === null && value !== null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `A "${proposal.status}" proposal cannot carry ${field}.`,
          path: [field],
        });
      }
      if (requirement === 'set' && value === null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `A "${proposal.status}" proposal requires ${field}.`,
          path: [field],
        });
      }
    }

    // The activated agent and the activated version are recorded together.
    if ((proposal.activatedAgentId === null) !== (proposal.activatedVersion === null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'An activation records both the activated agent and its version.',
        path: ['activatedAgentId'],
      });
    }
  });

/** The decision a user makes on a proposal; the hash binds it to exact content. */
export const hireProposalDecisionSchema = z
  .object({
    decision: z.enum(['approve', 'reject']),
    proposalSha256: sha256HexSchema,
    reason: nfcStringSchema(1, 200).optional(),
  })
  .strict();

/**
 * `audit_log.action` values for workforce events. The row shape is fixed by
 * migration 0001 (`id, actor, action, project_id, payload_json, created_at`);
 * agent identifiers live inside the payload (DEC-033).
 */
export const agentAuditActionSchema = z.enum([
  'agent.created',
  'agent.version_added',
  'agent.hired',
  'agent.suspended',
  'agent.resumed',
  'agent.dismissed',
  'agent.rehired',
  'agent.proposal_created',
  'agent.proposal_approved',
  'agent.proposal_rejected',
  'agent.proposal_expired',
]);

export type AgentOrigin = z.infer<typeof agentOriginSchema>;
export type RequestableAgentOrigin = z.infer<typeof requestableAgentOriginSchema>;
export type AgentDefinition = z.infer<typeof agentDefinitionSchema>;
export type EmploymentState = z.infer<typeof employmentStateSchema>;
export type EmploymentAction = z.infer<typeof employmentActionSchema>;
export type AgentEmployment = z.infer<typeof agentEmploymentSchema>;
export type EmploymentRequest = z.infer<typeof employmentRequestSchema>;
export type SelectionMode = z.infer<typeof selectionModeSchema>;
export type SelectionSource = z.infer<typeof selectionSourceSchema>;
export type RuntimeSelection = z.infer<typeof runtimeSelectionSchema>;
export type HarnessSource = z.infer<typeof harnessSourceSchema>;
export type HarnessDocument = z.infer<typeof harnessDocumentSchema>;
export type AgentProfileVersion = z.infer<typeof agentProfileVersionSchema>;
export type HireProposalStatus = z.infer<typeof hireProposalStatusSchema>;
export type HireProposal = z.infer<typeof hireProposalSchema>;
export type HireProposalDecision = z.infer<typeof hireProposalDecisionSchema>;
export type AgentAuditAction = z.infer<typeof agentAuditActionSchema>;
