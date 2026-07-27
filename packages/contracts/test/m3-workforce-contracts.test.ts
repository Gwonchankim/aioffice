import { describe, expect, it } from 'vitest';

import {
  agentAuditActionSchema,
  agentDefinitionSchema,
  agentEmploymentSchema,
  agentIdSchema,
  agentProfileVersionSchema,
  allowedEmploymentTransitions,
  employmentActionFor,
  employmentRequestSchema,
  employmentStateSchema,
  harnessDocumentSchema,
  hireProposalDecisionSchema,
  hireProposalSchema,
  isAllowedEmploymentTransition,
  requestableAgentOriginSchema,
  runtimeSelectionSchema,
  type EmploymentState,
} from '../src/index.js';

const iso = '2026-07-27T00:00:00.000Z';
const sha = 'a'.repeat(64);

function employment(overrides: Record<string, unknown> = {}) {
  return {
    agentId: 'atlas',
    state: 'active',
    activeVersion: 2,
    lastActiveVersion: 2,
    activatedAt: iso,
    deactivatedAt: null,
    actor: 'local-user',
    reason: null,
    revision: 1,
    updatedAt: iso,
    ...overrides,
  };
}

function runtimeSelection(overrides: Record<string, unknown> = {}) {
  return {
    selectionMode: 'default',
    selectionSource: 'catalog',
    provider: 'openai',
    model: 'gpt-5.6-sol',
    reasoningEffort: 'high',
    fallbackModels: [{ provider: 'anthropic', model: 'claude-opus-4-8' }],
    ...overrides,
  };
}

function proposal(overrides: Record<string, unknown> = {}) {
  return {
    // Crockford base32 excludes I, L, O and U.
    id: '01FAKEPRP00000000000000000',
    requestedBy: 'local-user',
    authoredBy: 'orion',
    proposedAgentId: 'zeta',
    proposalSha256: sha,
    status: 'pending_approval',
    createdAt: iso,
    expiresAt: '2026-07-27T00:30:00.000Z',
    decidedAt: null,
    decidedBy: null,
    activatedVersion: null,
    ...overrides,
  };
}

describe('WFM agent id contract', () => {
  it('follows Agent Profile Format §4 (2-32 characters) and keeps every built-in id valid', () => {
    for (const id of ['atlas', 'nova', 'arca', 'orion', 'ab', 'a'.repeat(32)]) {
      expect(agentIdSchema.safeParse(id).success).toBe(true);
    }
    // Narrowed from `{0,31}`: a single character no longer satisfies the document.
    expect(agentIdSchema.safeParse('a').success).toBe(false);
    expect(agentIdSchema.safeParse('a'.repeat(33)).success).toBe(false);
    expect(agentIdSchema.safeParse('Atlas').success).toBe(false);
    expect(agentIdSchema.safeParse('1atlas').success).toBe(false);
  });
});

describe('WFM agent definition contract', () => {
  it('accepts a seeded built-in definition and rejects unknown fields', () => {
    const definition = {
      id: 'atlas',
      name: 'Atlas',
      origin: 'builtin',
      createdBy: 'migration-0007',
      createdAt: iso,
    };
    expect(agentDefinitionSchema.parse(definition)).toMatchObject({ origin: 'builtin' });
    expect(agentDefinitionSchema.safeParse({ ...definition, extra: 1 }).success).toBe(false);
  });

  it('never lets a request path claim the builtin origin', () => {
    expect(requestableAgentOriginSchema.safeParse('builtin').success).toBe(false);
    for (const origin of ['user_created', 'manager_proposed', 'imported']) {
      expect(requestableAgentOriginSchema.safeParse(origin).success).toBe(true);
    }
  });
});

describe('WFM employment lifecycle contract', () => {
  it('permits exactly 7 of the 16 ordered state pairs and no self transition', () => {
    const states = employmentStateSchema.options as readonly EmploymentState[];
    expect(states).toHaveLength(4);

    const pairs = states.flatMap((from) => states.map((to) => ({ from, to })));
    expect(pairs).toHaveLength(16);

    const allowed = pairs.filter((pair) => isAllowedEmploymentTransition(pair.from, pair.to));
    expect(allowed).toHaveLength(7);
    expect(allowedEmploymentTransitions).toHaveLength(7);

    const rejected = pairs.filter((pair) => !isAllowedEmploymentTransition(pair.from, pair.to));
    expect(rejected).toHaveLength(9);
    for (const state of states) {
      expect(isAllowedEmploymentTransition(state, state)).toBe(false);
    }

    expect(employmentActionFor('draft', 'active')).toBe('hire');
    expect(employmentActionFor('suspended', 'active')).toBe('resume');
    expect(employmentActionFor('retired', 'active')).toBe('rehire');
    expect(employmentActionFor('active', 'draft')).toBeUndefined();
  });

  it('binds the active version to the active state in both directions', () => {
    expect(agentEmploymentSchema.parse(employment())).toMatchObject({ state: 'active' });

    expect(
      agentEmploymentSchema.safeParse(employment({ state: 'active', activeVersion: null })).success,
    ).toBe(false);
    expect(
      agentEmploymentSchema.safeParse(
        employment({ state: 'retired', activeVersion: 2, deactivatedAt: iso }),
      ).success,
    ).toBe(false);
    expect(
      agentEmploymentSchema.parse(
        employment({
          state: 'draft',
          activeVersion: null,
          lastActiveVersion: null,
          activatedAt: null,
        }),
      ),
    ).toMatchObject({ state: 'draft', activeVersion: null });
  });
});

describe('WFM employment request contract', () => {
  it('requires an explicit version for hire and forbids one elsewhere', () => {
    expect(
      employmentRequestSchema.parse({ action: 'hire', version: 2, expectedRevision: 1 }),
    ).toMatchObject({ action: 'hire', version: 2 });

    // The server never auto-selects the newest version.
    expect(employmentRequestSchema.safeParse({ action: 'hire', expectedRevision: 1 }).success).toBe(
      false,
    );

    expect(employmentRequestSchema.parse({ action: 'rehire', expectedRevision: 3 })).toMatchObject({
      action: 'rehire',
    });
    expect(
      employmentRequestSchema.parse({ action: 'rehire', version: 5, expectedRevision: 3 }),
    ).toMatchObject({ version: 5 });

    for (const action of ['dismiss', 'suspend', 'resume']) {
      expect(employmentRequestSchema.parse({ action, expectedRevision: 2 })).toMatchObject({
        action,
      });
      expect(
        employmentRequestSchema.safeParse({ action, version: 2, expectedRevision: 2 }).success,
      ).toBe(false);
    }
  });

  it('always requires the CAS revision and rejects unknown fields', () => {
    expect(employmentRequestSchema.safeParse({ action: 'suspend' }).success).toBe(false);
    expect(
      employmentRequestSchema.safeParse({
        action: 'suspend',
        expectedRevision: 1,
        origin: 'builtin',
      }).success,
    ).toBe(false);
  });
});

describe('WFM runtime selection contract', () => {
  it('keeps default selections attributed to the catalog and overrides to a decider', () => {
    expect(runtimeSelectionSchema.parse(runtimeSelection())).toMatchObject({
      selectionMode: 'default',
    });
    expect(
      runtimeSelectionSchema.safeParse(runtimeSelection({ selectionSource: 'user' })).success,
    ).toBe(false);
    expect(
      runtimeSelectionSchema.parse(
        runtimeSelection({ selectionMode: 'override', selectionSource: 'user' }),
      ),
    ).toMatchObject({ selectionMode: 'override', selectionSource: 'user' });
    expect(
      runtimeSelectionSchema.safeParse(runtimeSelection({ selectionMode: 'override' })).success,
    ).toBe(false);
  });

  it('rejects a fallback chain that duplicates the primary or itself', () => {
    expect(
      runtimeSelectionSchema.safeParse(
        runtimeSelection({ fallbackModels: [{ provider: 'openai', model: 'gpt-5.6-sol' }] }),
      ).success,
    ).toBe(false);
    expect(
      runtimeSelectionSchema.safeParse(
        runtimeSelection({
          fallbackModels: [
            { provider: 'anthropic', model: 'claude-opus-4-8' },
            { provider: 'anthropic', model: 'claude-opus-4-8' },
          ],
        }),
      ).success,
    ).toBe(false);
  });

  it('carries no permission field at all', () => {
    expect(
      runtimeSelectionSchema.safeParse({
        ...runtimeSelection(),
        permissions: { worktreeWriteAllowed: true },
      }).success,
    ).toBe(false);
  });
});

describe('WFM profile version and harness contracts', () => {
  it('stores custom versions only and keeps the harness hash optional', () => {
    const version = {
      agentId: 'zeta',
      version: 1,
      configSha256: sha,
      soulSha256: sha,
      harnessSha256: null,
      runtimeSelection: runtimeSelection({ selectionMode: 'override', selectionSource: 'user' }),
      origin: 'user_created',
      createdBy: 'local-user',
      createdAt: iso,
    };
    expect(agentProfileVersionSchema.parse(version)).toMatchObject({ harnessSha256: null });
    expect(agentProfileVersionSchema.parse({ ...version, harnessSha256: sha })).toMatchObject({
      harnessSha256: sha,
    });
    // The custom version space can never claim a built-in origin.
    expect(agentProfileVersionSchema.safeParse({ ...version, origin: 'builtin' }).success).toBe(
      false,
    );
  });

  it('records where a run-time harness body came from', () => {
    expect(
      harnessDocumentSchema.parse({
        markdown: '# 작업 절차\n검증 체크리스트를 따른다.',
        sha256: sha,
        source: 'template-default',
      }),
    ).toMatchObject({ source: 'template-default' });
    expect(
      harnessDocumentSchema.safeParse({ markdown: 'x', sha256: sha, source: 'profile' }).success,
    ).toBe(false);
    expect(
      harnessDocumentSchema.safeParse({
        markdown: '# 작업 절차\n검증 체크리스트를 따른다.',
        sha256: sha,
        source: 'catalog',
      }).success,
    ).toBe(false);
  });
});

describe('WFM hire proposal contract', () => {
  it('keeps a pending proposal undecided and an activation version exclusive to activation', () => {
    expect(hireProposalSchema.parse(proposal())).toMatchObject({ status: 'pending_approval' });
    expect(hireProposalSchema.safeParse(proposal({ decidedAt: iso })).success).toBe(false);
    expect(
      hireProposalSchema.safeParse(
        proposal({
          status: 'approved',
          decidedAt: iso,
          decidedBy: 'local-user',
          activatedVersion: 1,
        }),
      ).success,
    ).toBe(false);
    expect(
      hireProposalSchema.parse(
        proposal({
          status: 'activated',
          decidedAt: iso,
          decidedBy: 'local-user',
          activatedVersion: 1,
        }),
      ),
    ).toMatchObject({ status: 'activated', activatedVersion: 1 });
  });

  it('binds a decision to the exact proposal hash', () => {
    expect(
      hireProposalDecisionSchema.parse({ decision: 'approve', proposalSha256: sha }),
    ).toMatchObject({ decision: 'approve' });
    expect(hireProposalDecisionSchema.safeParse({ decision: 'approve' }).success).toBe(false);
    expect(
      hireProposalDecisionSchema.safeParse({ decision: 'activate', proposalSha256: sha }).success,
    ).toBe(false);
  });
});

describe('WFM audit action contract', () => {
  it('namespaces every workforce audit action under agent.*', () => {
    const actions = agentAuditActionSchema.options;
    expect(actions).toHaveLength(11);
    for (const action of actions) {
      expect(action.startsWith('agent.')).toBe(true);
    }
    expect(agentAuditActionSchema.safeParse('agent.deleted').success).toBe(false);
  });
});
