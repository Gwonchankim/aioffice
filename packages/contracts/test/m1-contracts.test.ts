import { describe, expect, it } from 'vitest';

import {
  agentProfileSkeletonSchema,
  approvalSchema,
  archiveApprovalCommandSchema,
  dataClassificationSchema,
  errorEnvelopeSchema,
  eventSchema,
  fableConfirmationInputSchema,
  planSchema,
  projectRegistrationInputSchema,
  projectRouteRegistry,
  projectSchema,
  projectUpdateInputSchema,
  registerSourceInputSchema,
  runSchema,
  sourceCardSchema,
  sourceRequestSchema,
  stepSchema,
  successEnvelopeSchema,
  taskSchema,
  ulidSchema,
  utcIso8601Schema,
} from '../src/index.js';

const ids = {
  project: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  task: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
  step: '01ARZ3NDEKTSV4RRFFQ69G5FAX',
  run: '01ARZ3NDEKTSV4RRFFQ69G5FAY',
  event: '01ARZ3NDEKTSV4RRFFQ69G5FAZ',
  approval: '01ARZ3NDEKTSV4RRFFQ69G5FB0',
  source: '01ARZ3NDEKTSV4RRFFQ69G5FB1',
  request: '01ARZ3NDEKTSV4RRFFQ69G5FB2',
  confirmation: '01ARZ3NDEKTSV4RRFFQ69G5FB3',
} as const;

const timestamp = '2026-07-21T09:00:00.000Z';
const laterTimestamp = '2026-07-21T09:05:00.000Z';
const projectKey = 'orion_contract_fixture';

function clone<Value>(value: Value): Value {
  return structuredClone(value);
}

function validProfile() {
  return {
    id: 'atlas',
    version: 1,
    name: 'Atlas',
    displayName: 'Atlas Advisor',
    description: 'Synthetic advisor profile used only for contract validation.',
    provider: 'openai',
    model: 'gpt-synthetic',
    fallbackModels: [{ provider: 'anthropic', model: 'claude-synthetic' }],
    reasoningEffort: 'high',
    permissionTemplate: 'advisor',
    permissions: {
      networkReadAllowed: false,
      projectReadAllowed: true,
      artifactWriteAllowed: true,
      worktreeWriteAllowed: false,
      localCommitAllowed: false,
      externalActionsAllowed: false,
    },
    capabilities: ['contract-validation'],
    enabled: false,
    executionMode: 'skeleton',
  };
}

function validProject() {
  return {
    id: ids.project,
    projectKey,
    name: 'Orion Contract Fixture',
    repositoryPath: 'C:\\Synthetic\\orion-contract-fixture',
    defaultBranch: 'main',
    classification: 'internal',
    providerPolicy: { openai: true, anthropic: false, allowFable: false },
    allowedAgentIds: ['atlas', 'verify'],
    allowedCommands: {
      read: [
        ['git', 'status'],
        ['git', 'diff'],
      ],
      verify: [
        ['pnpm', 'test'],
        ['pnpm', 'build'],
      ],
      localWrite: [
        ['git', 'add'],
        ['git', 'commit'],
      ],
    },
    createdAt: timestamp,
    updatedAt: laterTimestamp,
    unregisteredAt: null,
  };
}

function validTask() {
  return {
    id: ids.task,
    projectId: ids.project,
    title: 'Synthetic contract task',
    objective: 'Validate shared contract persistence shapes without executing a provider.',
    successCriteria: ['accept canonical payloads', 'reject forbidden fields'],
    inputArtifactIds: [],
    maxDurationMinutes: 120,
    maxAgentRuns: 60,
    requestedAgentIds: ['atlas'],
    status: 'draft',
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: null,
  };
}

function validOrchestrationStep() {
  return {
    id: ids.step,
    title: 'Validate contracts',
    agentId: 'atlas',
    dependsOn: [],
    executionMode: 'read_only',
    objective: 'Parse synthetic metadata without performing an external action.',
    inputRefs: ['fixture:source-card'],
    expectedArtifacts: ['validation-report'],
    acceptanceCriteria: ['all schema checks pass'],
    verificationCommands: ['pnpm test'],
    maxAttempts: 1,
  };
}

function validPlan() {
  return {
    taskId: ids.task,
    version: 1,
    planJson: {
      taskId: ids.task,
      summary: 'Synthetic one-step contract plan.',
      assumptions: [],
      risks: [],
      steps: [validOrchestrationStep()],
      finalSynthesisStepId: ids.step,
    },
    validationJson: { valid: true, issues: [] },
    createdAt: timestamp,
  };
}

function validStep() {
  return {
    ...validOrchestrationStep(),
    taskId: ids.task,
    planVersion: 1,
    status: 'waiting',
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: null,
  };
}

function validRun() {
  return {
    id: ids.run,
    stepId: ids.step,
    attempt: 1,
    provider: 'openai',
    model: 'gpt-synthetic',
    agentProfileSnapshot: validProfile(),
    status: 'running',
    sessionId: null,
    createdAt: timestamp,
    startedAt: timestamp,
    completedAt: null,
  };
}

function validEvent() {
  return {
    id: ids.event,
    taskId: ids.task,
    stepId: ids.step,
    runId: ids.run,
    provider: 'openai',
    type: 'run.started',
    timestamp,
    payload: { attempt: 1, model: 'gpt-synthetic' },
    taskSequence: 1,
    runSequence: 1,
  };
}

function validApproval() {
  return {
    id: ids.approval,
    action: 'source_card.archive',
    sourceId: ids.source,
    projectKey,
    metadataVersion: 1,
    actionHash: `sha256:${'a'.repeat(64)}`,
    status: 'approved',
    expiresAt: laterTimestamp,
    consumedAt: null,
  };
}

function validSourceCard() {
  return {
    sourceId: ids.source,
    title: '합성 계약 검증 자료',
    summary: '승인된 최소 합성 요약입니다.',
    tags: ['synthetic', '계약'],
    projectId: projectKey,
    connectorType: 'local-folder',
    locator: 'C:\\Synthetic\\orion-contract-fixture\\metadata.md',
    owner: 'synthetic-team',
    classification: 'internal',
    allowedRoles: ['advisor', 'knowledge-registry'],
    version: 'v1',
    checksumAlgorithm: 'sha256',
    checksum: 'a'.repeat(64),
    recordedAt: timestamp,
    lastVerifiedAt: laterTimestamp,
    status: 'active',
    supersedesSourceId: null,
    metadataVersion: 1,
  };
}

function validSourceRequest() {
  return {
    requestId: ids.request,
    projectId: projectKey,
    requestedMaterial: '합성 검증용 metadata',
    criteria: '최소 metadata만 필요합니다.',
    acceptableFormats: ['markdown', 'json'],
    expectedLocations: ['C:\\Synthetic\\orion-contract-fixture'],
    purpose: 'contract-validation',
    requesterRole: 'knowledge-registry',
    requestedAt: timestamp,
    resolvedBySourceId: null,
    resolvedAt: null,
    status: 'open',
    metadataVersion: 1,
  };
}

describe('M1 shared contracts', () => {
  it('M1-CON-001 accepts canonical core, project, Arca, and archive payloads', () => {
    expect(projectSchema.parse(validProject()).projectKey).toBe(projectKey);
    expect(agentProfileSkeletonSchema.parse(validProfile()).executionMode).toBe('skeleton');
    expect(taskSchema.parse(validTask()).status).toBe('draft');
    expect(planSchema.parse(validPlan()).planJson.steps).toHaveLength(1);
    expect(stepSchema.parse(validStep()).status).toBe('waiting');
    expect(runSchema.parse(validRun()).agentProfileSnapshot.id).toBe('atlas');
    expect(eventSchema.parse(validEvent()).runSequence).toBe(1);
    expect(approvalSchema.parse(validApproval()).status).toBe('approved');
    expect(sourceCardSchema.parse(validSourceCard()).status).toBe('active');
    expect(sourceRequestSchema.parse(validSourceRequest()).status).toBe('open');
    expect(
      archiveApprovalCommandSchema.parse({
        sourceId: ids.source,
        projectId: projectKey,
        expectedMetadataVersion: 1,
        action: 'source_card.archive',
        actionHash: `sha256:${'a'.repeat(64)}`,
        approvalId: ids.approval,
      }).projectId,
    ).toBe(projectKey);
  });

  it('M1-CON-002 rejects unknown fields on every persisted contract shape', () => {
    const cases: readonly [unknown, { safeParse: (input: unknown) => { success: boolean } }][] = [
      [validProject(), projectSchema],
      [validProfile(), agentProfileSkeletonSchema],
      [validTask(), taskSchema],
      [validPlan(), planSchema],
      [validStep(), stepSchema],
      [validRun(), runSchema],
      [validEvent(), eventSchema],
      [validApproval(), approvalSchema],
      [validSourceCard(), sourceCardSchema],
      [validSourceRequest(), sourceRequestSchema],
    ];

    for (const [payload, schema] of cases) {
      expect(schema.safeParse({ ...(payload as object), unexpected: true }).success).toBe(false);
    }
  });

  it('M1-CON-003 validates ULIDs and canonicalizes only valid UTC Z instants', () => {
    expect(ulidSchema.safeParse('not-a-ulid').success).toBe(false);
    expect(ulidSchema.safeParse('01ARZ3NDEKTSV4RRFFQ69G5FAI').success).toBe(false);
    expect(utcIso8601Schema.parse('2026-07-21T09:00:00.1Z')).toBe('2026-07-21T09:00:00.100Z');

    for (const invalidTimestamp of [
      '2026-07-21T09:00:00+09:00',
      '2026-07-21T09:00:00',
      '2026-02-30T09:00:00.000Z',
      '2026-07-21',
    ]) {
      expect(utcIso8601Schema.safeParse(invalidTimestamp).success).toBe(false);
    }
  });

  it('M1-CON-004 has exactly four classifications and rejects restricted without conversion', () => {
    for (const classification of ['public', 'internal', 'confidential', 'controlled']) {
      expect(dataClassificationSchema.parse(classification)).toBe(classification);
    }
    expect(dataClassificationSchema.safeParse('restricted').success).toBe(false);
    expect(dataClassificationSchema.safeParse('private').success).toBe(false);
  });

  it('M1-CON-005 rejects invalid project keys, policy violations, immutable fields, and shell commands', () => {
    for (const invalidProjectKey of ['A-project', 'a', 'project key', 'project/with/slash']) {
      expect(
        projectSchema.safeParse({ ...validProject(), projectKey: invalidProjectKey }).success,
      ).toBe(false);
    }
    expect(
      projectSchema.safeParse({
        ...validProject(),
        classification: 'controlled',
        providerPolicy: { openai: true, anthropic: false, allowFable: false },
      }).success,
    ).toBe(false);
    expect(
      projectSchema.safeParse({
        ...validProject(),
        classification: 'confidential',
        providerPolicy: { openai: false, anthropic: false, allowFable: false },
      }).success,
    ).toBe(false);
    expect(projectUpdateInputSchema.safeParse({ projectKey }).success).toBe(false);
    expect(
      projectUpdateInputSchema.safeParse({ repositoryPath: 'C:\\Synthetic\\other' }).success,
    ).toBe(false);
    expect(
      projectSchema.safeParse({
        ...validProject(),
        allowedCommands: { ...validProject().allowedCommands, read: [['git', 'status;']] },
      }).success,
    ).toBe(false);
  });

  it('M1-CON-006 requires a Fable confirmation and keeps its two scopes disjoint', () => {
    const registration = {
      projectKey,
      name: 'Orion Contract Fixture',
      repositoryPath: 'C:\\Synthetic\\orion-contract-fixture',
      defaultBranch: 'main',
      classification: 'internal',
      providerPolicy: { openai: true, anthropic: false, allowFable: true },
      allowedAgentIds: ['atlas'],
      allowedCommands: validProject().allowedCommands,
      fableWarningConfirmationId: ids.confirmation,
    };
    expect(projectRegistrationInputSchema.safeParse(registration).success).toBe(true);
    const withoutConfirmation = { ...registration };
    delete withoutConfirmation.fableWarningConfirmationId;
    expect(projectRegistrationInputSchema.safeParse(withoutConfirmation).success).toBe(false);
    expect(
      fableConfirmationInputSchema.safeParse({
        scope: 'project-create',
        projectKey,
        proposedProviderPolicy: registration.providerPolicy,
        warningStatementVersion: 'v1',
      }).success,
    ).toBe(true);
    expect(
      fableConfirmationInputSchema.safeParse({
        scope: 'project-update',
        projectId: ids.project,
        proposedProviderPolicy: registration.providerPolicy,
        warningStatementVersion: 'v1',
      }).success,
    ).toBe(true);
  });

  it('M1-CON-007 enforces Fable confirmation input and strict source registration fields', () => {
    const registration = {
      projectKey,
      name: 'Orion Contract Fixture',
      repositoryPath: 'C:\\Synthetic\\orion-contract-fixture',
      defaultBranch: 'main',
      classification: 'internal',
      providerPolicy: { openai: true, anthropic: false, allowFable: true },
      allowedAgentIds: ['atlas'],
      allowedCommands: validProject().allowedCommands,
    };
    expect(projectRegistrationInputSchema.safeParse(registration).success).toBe(false);
    expect(
      fableConfirmationInputSchema.safeParse({
        scope: 'project-create',
        projectKey,
        projectId: ids.project,
        proposedProviderPolicy: { openai: true, anthropic: false, allowFable: true },
        warningStatementVersion: 'v1',
      }).success,
    ).toBe(false);

    const card = validSourceCard();
    const registerInput = {
      title: card.title,
      summary: card.summary,
      tags: card.tags,
      projectId: card.projectId,
      connectorType: card.connectorType,
      locator: card.locator,
      owner: card.owner,
      classification: card.classification,
      allowedRoles: card.allowedRoles,
      version: card.version,
      checksumAlgorithm: card.checksumAlgorithm,
      checksum: card.checksum,
    };
    expect(registerSourceInputSchema.parse(registerInput).supersedesSourceId).toBeNull();
    expect(
      registerSourceInputSchema.safeParse({ ...registerInput, sourceId: ids.source }).success,
    ).toBe(false);
    expect(
      registerSourceInputSchema.safeParse({ ...registerInput, rawContent: 'forbidden' }).success,
    ).toBe(false);
    expect(
      registerSourceInputSchema.safeParse({ ...registerInput, classification: 'restricted' })
        .success,
    ).toBe(false);
  });

  it('M1-CON-008 rejects malformed lifecycle state, missing required fields, and normalized duplicates', () => {
    expect(sourceCardSchema.safeParse({ ...validSourceCard(), status: 'deleted' }).success).toBe(
      false,
    );
    expect(
      sourceRequestSchema.safeParse({ ...validSourceRequest(), status: 'pending' }).success,
    ).toBe(false);
    expect(
      sourceCardSchema.safeParse({ ...validSourceCard(), tags: ['é', 'e\u0301'] }).success,
    ).toBe(false);
    expect(
      sourceRequestSchema.safeParse({
        ...validSourceRequest(),
        acceptableFormats: ['json', 'json'],
      }).success,
    ).toBe(false);

    const sourceWithoutId = clone(validSourceCard());
    delete (sourceWithoutId as { sourceId?: string }).sourceId;
    expect(sourceCardSchema.safeParse(sourceWithoutId).success).toBe(false);
    expect(taskSchema.safeParse({ ...validTask(), completedAt: timestamp }).success).toBe(false);
    expect(
      planSchema.safeParse({
        ...validPlan(),
        planJson: { ...validPlan().planJson, taskId: ids.project },
      }).success,
    ).toBe(false);
    expect(eventSchema.safeParse({ ...validEvent(), runSequence: null }).success).toBe(false);
  });

  it('M1-CON-009 validates Arca resolution, immutable snapshots, approvals, and route response envelopes', () => {
    const resolvedRequest = {
      ...validSourceRequest(),
      status: 'resolved',
      resolvedBySourceId: ids.source,
      resolvedAt: laterTimestamp,
    };
    expect(sourceRequestSchema.safeParse(resolvedRequest).success).toBe(true);
    expect(
      sourceRequestSchema.safeParse({ ...resolvedRequest, resolvedAt: '2026-07-21T08:00:00.000Z' })
        .success,
    ).toBe(false);
    expect(
      sourceCardSchema.safeParse({ ...validSourceCard(), supersedesSourceId: ids.source }).success,
    ).toBe(false);
    expect(
      approvalSchema.safeParse({ ...validApproval(), status: 'rejected', consumedAt: timestamp })
        .success,
    ).toBe(false);
    expect(
      eventSchema.safeParse({ ...validEvent(), payload: { rawExcerpt: 'forbidden' } }).success,
    ).toBe(false);

    const successSchema = successEnvelopeSchema(projectSchema);
    const success = successSchema.parse({
      data: validProject(),
      meta: { requestId: ids.event, timestamp: '2026-07-21T09:00:00Z' },
    });
    expect(success.meta.timestamp).toBe(timestamp);
    expect(successSchema.safeParse({ ...success, trace: true }).success).toBe(false);
    expect(
      errorEnvelopeSchema.safeParse({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Invalid input',
          retryable: false,
          unexpected: true,
        },
        meta: { requestId: ids.event, timestamp },
      }).success,
    ).toBe(false);
    const projectStatusResponse = {
      data: {
        project: validProject(),
        git: {
          defaultBranch: 'main',
          currentBranch: null,
          headSha: 'a'.repeat(40),
          dirty: false,
        },
      },
      meta: { requestId: ids.event, timestamp },
    };
    expect(
      projectRouteRegistry.createProject.responses[201].safeParse(projectStatusResponse).success,
    ).toBe(true);
    expect(
      projectRouteRegistry.createProject.responses[201].safeParse({
        ...projectStatusResponse,
        data: {
          ...projectStatusResponse.data,
          git: { ...projectStatusResponse.data.git, branch: 'main' },
        },
      }).success,
    ).toBe(false);
  });
});
