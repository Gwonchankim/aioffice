import { describe, expect, it } from 'vitest';

import {
  agentProfileFullSchema,
  agentProfileSchema,
  arcaInvocationResultSchema,
  arcaInvocationSchema,
  arcaScopeDenialSchema,
  exportManifestSchema,
  fallbackReasonCodeSchema,
  modelSelectionSchema,
  planningRunSchema,
  planValidationIssueSchema,
  resourceSnapshotSchema,
  schedulerLimitsSchema,
  defaultSchedulerLimits,
} from '../src/index.js';

const timestamp = '2026-07-21T09:00:00.000Z';
const laterTimestamp = '2026-07-21T09:05:00.000Z';
const hex64 = 'a'.repeat(64);
const soulMarkdown = '합성 SOUL 본문입니다. '.repeat(3);

function validRouting(overrides: Record<string, unknown> = {}) {
  return {
    capabilities: ['contract-validation'],
    triggers: ['contract review'],
    exclusions: [],
    requiredCollaborators: ['verify'],
    recommendedCollaborators: [],
    ...overrides,
  };
}

function validContracts() {
  return {
    outputSchema: 'artifact-report-v1',
    requiredArtifactKinds: ['report'],
    stopConditions: ['acceptance-met'],
  };
}

function validFullProfile(overrides: Record<string, unknown> = {}) {
  return {
    id: 'forge',
    version: 1,
    name: 'Forge',
    displayName: 'Forge Builder',
    description: 'Synthetic builder profile used only for M3 contract validation tests.',
    provider: 'openai',
    model: 'gpt-synthetic',
    fallbackModels: [{ provider: 'anthropic', model: 'claude-synthetic' }],
    reasoningEffort: 'high',
    permissionTemplate: 'builder',
    permissions: {
      networkReadAllowed: false,
      projectReadAllowed: true,
      artifactWriteAllowed: true,
      worktreeWriteAllowed: true,
      localCommitAllowed: true,
      externalActionsAllowed: false,
    },
    capabilities: ['contract-validation'],
    routing: validRouting(),
    contracts: validContracts(),
    soulMarkdown,
    soulSha256: hex64,
    enabled: true,
    executionMode: 'full',
    ...overrides,
  };
}

describe('M3 shared contracts', () => {
  it('M3-CON-001 accepts a canonical full profile with a builder+QA collaborator', () => {
    const parsed = agentProfileFullSchema.parse(validFullProfile());
    expect(parsed.routing.requiredCollaborators).toContain('verify');
  });

  it('M3-CON-002 accepts full profiles through the profile union', () => {
    expect(agentProfileSchema.safeParse(validFullProfile()).success).toBe(true);
  });

  it('M3-CON-003 rejects unknown fields on the full profile', () => {
    expect(
      agentProfileFullSchema.safeParse({ ...validFullProfile(), unexpected: true }).success,
    ).toBe(false);
  });

  it('M3-CON-004 rejects builder profiles missing a QA collaborator', () => {
    expect(
      agentProfileFullSchema.safeParse(
        validFullProfile({ routing: validRouting({ requiredCollaborators: [] }) }),
      ).success,
    ).toBe(false);
  });

  it('M3-CON-005 rejects orion/nexus profiles that allow worktree writes', () => {
    expect(
      agentProfileFullSchema.safeParse(
        validFullProfile({
          id: 'orion',
          permissionTemplate: 'orchestrator',
          routing: validRouting({ requiredCollaborators: [] }),
          permissions: {
            networkReadAllowed: false,
            projectReadAllowed: true,
            artifactWriteAllowed: true,
            worktreeWriteAllowed: true,
            localCommitAllowed: false,
            externalActionsAllowed: false,
          },
        }),
      ).success,
    ).toBe(false);
  });

  it('M3-CON-006 rejects sentinel profiles that are not reviewer templated', () => {
    expect(
      agentProfileFullSchema.safeParse(
        validFullProfile({
          id: 'sentinel',
          permissionTemplate: 'advisor',
          routing: validRouting({ requiredCollaborators: [] }),
        }),
      ).success,
    ).toBe(false);
  });

  it('M3-CON-007 rejects arca full profiles with enabled true', () => {
    const registryPermissions = {
      networkReadAllowed: false,
      projectReadAllowed: true,
      artifactWriteAllowed: false,
      worktreeWriteAllowed: false,
      localCommitAllowed: false,
      externalActionsAllowed: false,
      registryProjectMetadataReadAllowed: true,
      registrySearchAllowed: true,
      sourceCardRegisterAllowed: true,
      sourceCardUpdateAllowed: true,
      purposeBoundExcerptReadAllowed: true,
      sourceRequestCreateAllowed: true,
      sourceRequestResolveAllowed: true,
      auditWriteAllowed: true,
      connectorReadAllowed: true,
      sourceCardArchiveWithApprovalAllowed: true,
      sourceRepositoryWriteAllowed: false,
      sourceFileDeleteMoveRenameAllowed: false,
      permissionChangeAllowed: false,
      classificationDowngradeAllowed: false,
      externalShareAllowed: false,
      archiveDeleteWithoutApprovalAllowed: false,
      sourceCardDeleteAllowed: false,
      arbitraryNetworkEndpointAllowed: false,
      registryOperationScopes: ['registry-search'],
    };
    expect(
      agentProfileFullSchema.safeParse(
        validFullProfile({
          id: 'arca',
          permissionTemplate: 'knowledge-registry',
          routing: validRouting({ requiredCollaborators: [] }),
          permissions: registryPermissions,
          enabled: true,
        }),
      ).success,
    ).toBe(false);
    expect(
      agentProfileFullSchema.safeParse(
        validFullProfile({
          id: 'arca',
          permissionTemplate: 'knowledge-registry',
          routing: validRouting({ requiredCollaborators: [] }),
          permissions: registryPermissions,
          enabled: false,
        }),
      ).success,
    ).toBe(true);
  });

  it('M3-CON-008 rejects arca-only registry permission fields missing their scopes', () => {
    expect(
      agentProfileFullSchema.safeParse(
        validFullProfile({
          id: 'arca',
          permissionTemplate: 'knowledge-registry',
          routing: validRouting({ requiredCollaborators: [] }),
          enabled: false,
          permissions: {
            networkReadAllowed: false,
            projectReadAllowed: true,
            artifactWriteAllowed: false,
            worktreeWriteAllowed: false,
            localCommitAllowed: false,
            externalActionsAllowed: false,
          },
        }),
      ).success,
    ).toBe(false);
  });

  it('M3-CON-009 rejects duplicate and self-referential fallback models', () => {
    expect(
      agentProfileFullSchema.safeParse(
        validFullProfile({
          fallbackModels: [{ provider: 'openai', model: 'gpt-synthetic' }],
        }),
      ).success,
    ).toBe(false);
    expect(
      agentProfileFullSchema.safeParse(
        validFullProfile({
          fallbackModels: [
            { provider: 'anthropic', model: 'claude-synthetic' },
            { provider: 'anthropic', model: 'claude-synthetic' },
          ],
        }),
      ).success,
    ).toBe(false);
  });

  it('M3-CON-010 rejects routing collaborators that self-reference or duplicate', () => {
    expect(
      agentProfileFullSchema.safeParse(
        validFullProfile({
          routing: validRouting({ requiredCollaborators: ['forge'] }),
        }),
      ).success,
    ).toBe(false);
    expect(
      agentProfileFullSchema.safeParse(
        validFullProfile({
          routing: validRouting({ requiredCollaborators: ['verify', 'verify'] }),
        }),
      ).success,
    ).toBe(false);
  });

  it('M3-CON-011 validates modelSelection fallback provenance consistency', () => {
    expect(
      modelSelectionSchema.safeParse({
        provider: 'openai',
        model: 'gpt-synthetic',
        viaFallback: false,
        fallbackReasonCode: null,
        fromProvider: null,
        fromModel: null,
      }).success,
    ).toBe(true);
    expect(
      modelSelectionSchema.safeParse({
        provider: 'anthropic',
        model: 'claude-synthetic',
        viaFallback: true,
        fallbackReasonCode: 'MODEL_UNAVAILABLE',
        fromProvider: 'openai',
        fromModel: 'gpt-synthetic',
      }).success,
    ).toBe(true);
    expect(
      modelSelectionSchema.safeParse({
        provider: 'openai',
        model: 'gpt-synthetic',
        viaFallback: false,
        fallbackReasonCode: 'MODEL_UNAVAILABLE',
        fromProvider: null,
        fromModel: null,
      }).success,
    ).toBe(false);
    expect(
      modelSelectionSchema.safeParse({
        provider: 'anthropic',
        model: 'claude-synthetic',
        viaFallback: true,
        fallbackReasonCode: null,
        fromProvider: 'openai',
        fromModel: 'gpt-synthetic',
      }).success,
    ).toBe(false);
  });

  it('M3-CON-012 has exactly six fallback reason codes', () => {
    expect(fallbackReasonCodeSchema.options).toHaveLength(6);
    expect(fallbackReasonCodeSchema.safeParse('UNKNOWN_REASON').success).toBe(false);
  });

  it('M3-CON-013 validates planningRun running/completedAt consistency', () => {
    expect(
      planningRunSchema.safeParse({
        id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        taskId: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
        attempt: 1,
        provider: 'openai',
        model: 'gpt-synthetic',
        profileSnapshotSha256: hex64,
        status: 'running',
        fallbackReason: null,
        createdAt: timestamp,
        completedAt: null,
      }).success,
    ).toBe(true);
    expect(
      planningRunSchema.safeParse({
        id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        taskId: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
        attempt: 1,
        provider: 'openai',
        model: 'gpt-synthetic',
        profileSnapshotSha256: hex64,
        status: 'running',
        fallbackReason: null,
        createdAt: timestamp,
        completedAt: laterTimestamp,
      }).success,
    ).toBe(false);
    expect(
      planningRunSchema.safeParse({
        id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        taskId: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
        attempt: 1,
        provider: 'openai',
        model: 'gpt-synthetic',
        profileSnapshotSha256: hex64,
        status: 'succeeded',
        fallbackReason: null,
        createdAt: timestamp,
        completedAt: null,
      }).success,
    ).toBe(false);
  });

  it('M3-CON-014 rejects invalid plan validation issue codes', () => {
    expect(
      planValidationIssueSchema.safeParse({
        code: 'DAG_CYCLE',
        path: 'steps[0].dependsOn',
        message: 'A cycle was detected among plan steps.',
      }).success,
    ).toBe(true);
    expect(
      planValidationIssueSchema.safeParse({
        code: 'NOT_A_REAL_CODE',
        path: null,
        message: 'irrelevant',
      }).success,
    ).toBe(false);
  });

  it('M3-CON-015 rejects export manifests with duplicate (id, version) entries', () => {
    const entry = {
      id: 'forge',
      version: 1,
      profilePath: 'profiles/forge.yaml',
      soulPath: 'souls/forge.md',
      configSha256: hex64,
      soulSha256: hex64,
    };
    expect(
      exportManifestSchema.safeParse({
        schemaVersion: 1,
        exportedAt: timestamp,
        includeHistory: false,
        entries: [entry],
      }).success,
    ).toBe(true);
    expect(
      exportManifestSchema.safeParse({
        schemaVersion: 1,
        exportedAt: timestamp,
        includeHistory: false,
        entries: [entry, entry],
      }).success,
    ).toBe(false);
  });

  it('M3-CON-016 enforces arca invocation discriminated union shapes', () => {
    expect(
      arcaInvocationSchema.safeParse({
        projectKey: 'orion_contract_fixture',
        requester: {
          requesterId: 'forge',
          requesterRole: 'builder',
          purpose: 'contract-validation',
        },
        request: { kind: 'query', query: 'metadata schema' },
      }).success,
    ).toBe(true);
    expect(
      arcaInvocationSchema.safeParse({
        projectKey: 'orion_contract_fixture',
        requester: {
          requesterId: 'forge',
          requesterRole: 'builder',
          purpose: 'contract-validation',
        },
        request: { kind: 'source', sourceId: '01ARZ3NDEKTSV4RRFFQ69G5FAV', range: null },
      }).success,
    ).toBe(true);
    expect(
      arcaInvocationSchema.safeParse({
        projectKey: 'orion_contract_fixture',
        requester: {
          requesterId: 'forge',
          requesterRole: 'builder',
          purpose: 'contract-validation',
        },
        request: { kind: 'bogus' },
      }).success,
    ).toBe(false);
  });

  it('M3-CON-017 enforces non-disclosure of protected fields when Arca result is missing', () => {
    expect(
      arcaInvocationResultSchema.safeParse({
        status: 'missing',
        sourceId: null,
        title: null,
        version: null,
        locator: null,
        owner: null,
        classification: null,
        confidence: null,
        nextAction: 'Request source registration.',
      }).success,
    ).toBe(true);
    expect(
      arcaInvocationResultSchema.safeParse({
        status: 'missing',
        sourceId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        title: 'Leaked title',
        version: null,
        locator: null,
        owner: null,
        classification: null,
        confidence: null,
        nextAction: null,
      }).success,
    ).toBe(false);
    expect(
      arcaInvocationResultSchema.safeParse({
        status: 'found',
        sourceId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        title: 'Design doc',
        version: 'v1',
        locator: 'C:\\Synthetic\\design.md',
        owner: 'forge',
        classification: 'internal',
        confidence: 0.9,
        nextAction: null,
      }).success,
    ).toBe(true);
  });

  it('M3-CON-018 validates the arca registry-scope denial shape strictly', () => {
    expect(
      arcaScopeDenialSchema.safeParse({
        code: 'PERMISSION_DENIED',
        stage: 'registry-scope',
        sourceIndependent: true,
      }).success,
    ).toBe(true);
    expect(
      arcaScopeDenialSchema.safeParse({
        code: 'PERMISSION_DENIED',
        stage: 'registry-scope',
        sourceIndependent: false,
      }).success,
    ).toBe(false);
  });

  it('M3-CON-019 rejects resource snapshots with negative or out-of-range values', () => {
    expect(
      resourceSnapshotSchema.safeParse({
        memoryUsedPercent: 42.5,
        freeMemoryBytes: 1024,
        freeDiskBytes: 2048,
      }).success,
    ).toBe(true);
    expect(
      resourceSnapshotSchema.safeParse({
        memoryUsedPercent: -1,
        freeMemoryBytes: 1024,
        freeDiskBytes: 2048,
      }).success,
    ).toBe(false);
    expect(
      resourceSnapshotSchema.safeParse({
        memoryUsedPercent: 42.5,
        freeMemoryBytes: -1,
        freeDiskBytes: 2048,
      }).success,
    ).toBe(false);
    expect(
      resourceSnapshotSchema.safeParse({
        memoryUsedPercent: 101,
        freeMemoryBytes: 1024,
        freeDiskBytes: 2048,
      }).success,
    ).toBe(false);
  });

  it('M3-CON-020 fixes the scheduler limits to their approved literal defaults', () => {
    expect(schedulerLimitsSchema.parse(defaultSchedulerLimits)).toEqual(defaultSchedulerLimits);
    expect(
      schedulerLimitsSchema.safeParse({ ...defaultSchedulerLimits, globalHardCap: 9 }).success,
    ).toBe(false);
    expect(
      schedulerLimitsSchema.safeParse({
        ...defaultSchedulerLimits,
        transientBackoffMs: [1000, 2000],
      }).success,
    ).toBe(false);
  });

  it('M3-CON-021 rejects full profiles with an out-of-range description length', () => {
    expect(
      agentProfileFullSchema.safeParse(validFullProfile({ description: 'too short' })).success,
    ).toBe(false);
  });
});
