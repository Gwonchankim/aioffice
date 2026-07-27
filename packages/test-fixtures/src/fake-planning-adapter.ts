import type {
  DataClassification,
  OrchestrationPlanDocument,
  OrchestrationStep,
  PermissionTemplate,
  PlannerAgentDescriptor,
  PlannerRequest,
  PlanValidationIssue,
  PlanValidationIssueCode,
  Provider,
  ProviderPolicy,
} from '@orion/contracts';

/** Fixed Crockford-base32 ULID literals; nothing here is generated at runtime. */
export const fakePlanningTaskId = '01FAKETASK0000000000000000';
const ADVISOR_A_STEP_ID = '01FAKEADVA0000000000000000';
const ADVISOR_B_STEP_ID = '01FAKEADVB0000000000000000';
const FINAL_STEP_ID = '01FAKEENDS0000000000000000';
const DUPLICATE_STEP_ID = '01FAKEDPST0000000000000000';
const GHOST_STEP_ID = '01FAKEGHST0000000000000000';
const CYCLE_A_STEP_ID = '01FAKECYCA0000000000000000';
const CYCLE_B_STEP_ID = '01FAKECYCB0000000000000000';
const DISABLED_STEP_ID = '01FAKEDSBD0000000000000000';
const BUILDER_STEP_ID = '01FAKEFRGE0000000000000000';
const QA_STEP_ID = '01FAKEVRFY0000000000000000';

export type FakePlanningScenario =
  | 'valid'
  | 'schemaInvalid'
  | 'malformedJson'
  | 'emptyOutput'
  | 'notAnObject'
  | 'duplicateStepId'
  | 'missingDependency'
  | 'dagCycle'
  | 'disabledAgent'
  | 'finalSynthesisIncomplete'
  | 'builderWithoutQa'
  | 'codeWorkflowIncomplete'
  | 'runLimitExceeded';

export interface FakePlanningTaskLimits {
  readonly maxAgentRuns: number;
  readonly existingRunCount: number;
}

export interface FakePlanningAgentPermissions {
  readonly artifactWriteAllowed: boolean;
  readonly worktreeWriteAllowed: boolean;
  readonly localCommitAllowed: boolean;
}

export interface FakePlanningFallbackModel {
  readonly provider: Provider;
  readonly model: string;
}

/** Structurally compatible with the orchestration package's `PlanValidatorAgent`. */
export interface FakePlanningRosterAgent {
  readonly id: string;
  readonly version: number;
  readonly enabled: boolean;
  readonly permissionTemplate: PermissionTemplate;
  readonly permissions: FakePlanningAgentPermissions;
  readonly provider: Provider;
  readonly model: string;
  readonly fallbackModels: readonly FakePlanningFallbackModel[];
}

interface RosterDefinition {
  readonly permissionTemplate: PermissionTemplate;
  readonly provider: Provider;
  readonly model: string;
  readonly enabled: boolean;
  readonly artifactWriteAllowed: boolean;
  readonly worktreeWriteAllowed: boolean;
  readonly localCommitAllowed: boolean;
  readonly capabilities: readonly string[];
  readonly requiredCollaborators: readonly string[];
  readonly description: string;
}

const ROSTER_DEFINITIONS: readonly (readonly [string, RosterDefinition])[] = [
  [
    'atlas',
    {
      permissionTemplate: 'advisor',
      provider: 'openai',
      model: 'gpt-5.6-sol',
      enabled: true,
      artifactWriteAllowed: true,
      worktreeWriteAllowed: false,
      localCommitAllowed: false,
      capabilities: ['strategy', 'analysis'],
      requiredCollaborators: [],
      description: 'Strategy advisor that analyses objectives and proposes an approach.',
    },
  ],
  [
    'nova',
    {
      permissionTemplate: 'advisor',
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      enabled: true,
      artifactWriteAllowed: true,
      worktreeWriteAllowed: false,
      localCommitAllowed: false,
      capabilities: ['research', 'synthesis'],
      requiredCollaborators: [],
      description: 'Research advisor that gathers background material and synthesises findings.',
    },
  ],
  [
    'forge',
    {
      permissionTemplate: 'builder',
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      enabled: true,
      artifactWriteAllowed: true,
      worktreeWriteAllowed: true,
      localCommitAllowed: true,
      capabilities: ['implementation', 'refactoring'],
      requiredCollaborators: ['verify'],
      description: 'Builder that implements changes inside an isolated worktree and commits them.',
    },
  ],
  [
    'verify',
    {
      permissionTemplate: 'qa_writer',
      provider: 'openai',
      model: 'gpt-5.6-terra',
      enabled: true,
      artifactWriteAllowed: true,
      worktreeWriteAllowed: true,
      localCommitAllowed: true,
      capabilities: ['testing', 'verification'],
      requiredCollaborators: [],
      description: 'Quality agent that writes and runs tests against a builder worktree.',
    },
  ],
  [
    'archon',
    {
      permissionTemplate: 'integrator',
      provider: 'openai',
      model: 'gpt-5.6-sol',
      enabled: true,
      artifactWriteAllowed: true,
      worktreeWriteAllowed: true,
      localCommitAllowed: true,
      capabilities: ['integration', 'conflict-resolution'],
      requiredCollaborators: [],
      description: 'Integrator that merges verified worktree output back into the task branch.',
    },
  ],
  [
    'nexus',
    {
      permissionTemplate: 'orchestrator',
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      enabled: true,
      artifactWriteAllowed: true,
      worktreeWriteAllowed: false,
      localCommitAllowed: false,
      capabilities: ['decomposition', 'sequencing'],
      requiredCollaborators: [],
      description: 'Planning agent that decomposes engineering work into ordered work packages.',
    },
  ],
  [
    'orion',
    {
      permissionTemplate: 'orchestrator',
      provider: 'openai',
      model: 'gpt-5.6-sol',
      enabled: true,
      artifactWriteAllowed: true,
      worktreeWriteAllowed: false,
      localCommitAllowed: false,
      capabilities: ['orchestration', 'synthesis'],
      requiredCollaborators: [],
      description: 'Orchestrator that plans the task and writes the final synthesis of results.',
    },
  ],
  [
    'arca',
    {
      permissionTemplate: 'knowledge-registry',
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      enabled: false,
      artifactWriteAllowed: false,
      worktreeWriteAllowed: false,
      localCommitAllowed: false,
      capabilities: ['registry-search'],
      requiredCollaborators: [],
      description: 'Knowledge registry agent that stays disabled until the registry milestone.',
    },
  ],
];

function allowedExecutionModes(
  definition: RosterDefinition,
): PlannerAgentDescriptor['allowedExecutionModes'] {
  const modes: PlannerAgentDescriptor['allowedExecutionModes'] = ['read_only'];
  if (definition.artifactWriteAllowed) {
    modes.push('artifact_write');
  }
  if (definition.worktreeWriteAllowed && definition.localCommitAllowed) {
    modes.push('worktree_write');
  }
  if (definition.permissionTemplate === 'integrator') {
    modes.push('integration');
  }
  return modes;
}

/** Validator-side roster: feed straight into `validatePlan`'s `agents` input. */
export const fakePlanningRoster: readonly FakePlanningRosterAgent[] = ROSTER_DEFINITIONS.map(
  ([id, definition]) => ({
    id,
    version: 2,
    enabled: definition.enabled,
    permissionTemplate: definition.permissionTemplate,
    permissions: {
      artifactWriteAllowed: definition.artifactWriteAllowed,
      worktreeWriteAllowed: definition.worktreeWriteAllowed,
      localCommitAllowed: definition.localCommitAllowed,
    },
    provider: definition.provider,
    model: definition.model,
    fallbackModels: [],
  }),
);

/** Planner-side roster: the descriptors handed to the planner in a `PlannerRequest`. */
export const fakePlannerAgentDescriptors: readonly PlannerAgentDescriptor[] =
  ROSTER_DEFINITIONS.map(([id, definition]) => ({
    id,
    version: 2,
    name: id,
    displayName: `${id.slice(0, 1).toUpperCase()}${id.slice(1)}`,
    description: definition.description,
    enabled: definition.enabled,
    permissionTemplate: definition.permissionTemplate,
    provider: definition.provider,
    model: definition.model,
    allowedExecutionModes: allowedExecutionModes(definition),
    capabilities: [...definition.capabilities],
    triggers: [],
    exclusions: [],
    requiredCollaborators: [...definition.requiredCollaborators],
  }));

export const fakePlanningClassification: DataClassification = 'internal';

export const fakePlanningProviderPolicy: ProviderPolicy = {
  openai: true,
  anthropic: true,
  allowFable: false,
};

export const fakePlanningTaskLimits: FakePlanningTaskLimits = {
  maxAgentRuns: 60,
  existingRunCount: 0,
};

const TIGHT_TASK_LIMITS: FakePlanningTaskLimits = { maxAgentRuns: 4, existingRunCount: 2 };

function makeStep(
  overrides: Partial<OrchestrationStep> & Pick<OrchestrationStep, 'id' | 'agentId'>,
): OrchestrationStep {
  return {
    title: 'Fixture step',
    dependsOn: [],
    executionMode: 'read_only',
    objective: 'A deterministic fixture step objective used by the fake planning adapter.',
    inputRefs: [],
    expectedArtifacts: [],
    acceptanceCriteria: ['Fixture acceptance criterion'],
    verificationCommands: [],
    maxAttempts: 1,
    ...overrides,
  };
}

/** Canonical plan-document builder shared by every scenario. */
export function makeFakePlanDocument(
  steps: readonly OrchestrationStep[],
  finalSynthesisStepId: string,
): OrchestrationPlanDocument {
  return {
    taskId: fakePlanningTaskId,
    summary: 'Deterministic fixture plan produced by the fake planning adapter.',
    assumptions: [],
    risks: [],
    steps: [...steps],
    finalSynthesisStepId,
  };
}

const advisorStep = makeStep({
  id: ADVISOR_A_STEP_ID,
  agentId: 'atlas',
  executionMode: 'artifact_write',
});

const secondAdvisorStep = makeStep({
  id: ADVISOR_B_STEP_ID,
  agentId: 'nova',
  executionMode: 'artifact_write',
});

/** The one plan that parses strictly AND passes `validatePlan` against `fakePlanningRoster`. */
export const fakeValidPlanDocument = makeFakePlanDocument(
  [advisorStep, makeStep({ id: FINAL_STEP_ID, agentId: 'orion', dependsOn: [ADVISOR_A_STEP_ID] })],
  FINAL_STEP_ID,
);

const duplicateStepIdPlan = makeFakePlanDocument(
  [
    makeStep({ id: DUPLICATE_STEP_ID, agentId: 'atlas', executionMode: 'artifact_write' }),
    makeStep({ id: DUPLICATE_STEP_ID, agentId: 'nova', executionMode: 'artifact_write' }),
    makeStep({ id: FINAL_STEP_ID, agentId: 'orion', dependsOn: [DUPLICATE_STEP_ID] }),
  ],
  FINAL_STEP_ID,
);

const missingDependencyPlan = makeFakePlanDocument(
  [makeStep({ id: FINAL_STEP_ID, agentId: 'orion', dependsOn: [GHOST_STEP_ID] })],
  FINAL_STEP_ID,
);

const dagCyclePlan = makeFakePlanDocument(
  [
    makeStep({
      id: CYCLE_A_STEP_ID,
      agentId: 'atlas',
      executionMode: 'artifact_write',
      dependsOn: [CYCLE_B_STEP_ID],
    }),
    makeStep({ id: CYCLE_B_STEP_ID, agentId: 'orion', dependsOn: [CYCLE_A_STEP_ID] }),
  ],
  CYCLE_B_STEP_ID,
);

const disabledAgentPlan = makeFakePlanDocument(
  [
    makeStep({ id: DISABLED_STEP_ID, agentId: 'arca' }),
    makeStep({ id: FINAL_STEP_ID, agentId: 'orion', dependsOn: [DISABLED_STEP_ID] }),
  ],
  FINAL_STEP_ID,
);

const finalSynthesisIncompletePlan = makeFakePlanDocument(
  [
    advisorStep,
    secondAdvisorStep,
    makeStep({ id: FINAL_STEP_ID, agentId: 'orion', dependsOn: [ADVISOR_A_STEP_ID] }),
  ],
  FINAL_STEP_ID,
);

// This plan raises BUILDER_WITHOUT_QA *and* CODE_WORKFLOW_INCOMPLETE: the lone
// worktree_write step triggers the code-workflow check too, and the plan has no
// nexus/archon planning step and no archon integration step. Assertions on this
// fixture must therefore check that the issue list CONTAINS the expected code.
const builderWithoutQaPlan = makeFakePlanDocument(
  [
    makeStep({ id: BUILDER_STEP_ID, agentId: 'forge', executionMode: 'worktree_write' }),
    makeStep({ id: FINAL_STEP_ID, agentId: 'orion', dependsOn: [BUILDER_STEP_ID] }),
  ],
  FINAL_STEP_ID,
);

// Isolates CODE_WORKFLOW_INCOMPLETE: forge's worktree_write step does have a
// downstream verify QA step, so BUILDER_WITHOUT_QA does not fire, but the plan
// still lacks a nexus/archon planning step and an archon integration step.
const codeWorkflowIncompletePlan = makeFakePlanDocument(
  [
    makeStep({ id: BUILDER_STEP_ID, agentId: 'forge', executionMode: 'worktree_write' }),
    makeStep({
      id: QA_STEP_ID,
      agentId: 'verify',
      executionMode: 'artifact_write',
      dependsOn: [BUILDER_STEP_ID],
    }),
    makeStep({ id: FINAL_STEP_ID, agentId: 'orion', dependsOn: [QA_STEP_ID] }),
  ],
  FINAL_STEP_ID,
);

const runLimitExceededPlan = makeFakePlanDocument(
  [
    advisorStep,
    secondAdvisorStep,
    makeStep({
      id: FINAL_STEP_ID,
      agentId: 'orion',
      dependsOn: [ADVISOR_A_STEP_ID, ADVISOR_B_STEP_ID],
    }),
  ],
  FINAL_STEP_ID,
);

const schemaInvalidRaw = JSON.stringify({ ...fakeValidPlanDocument, unexpectedField: 'rejected' });

export interface FakePlanningScenarioFixture {
  readonly scenario: FakePlanningScenario;
  /** Exactly what the fake planner "returns"; strings stay unparsed on purpose. */
  readonly raw: unknown;
  /** The limits `validatePlan` must be given for this scenario's expectation to hold. */
  readonly taskLimits: FakePlanningTaskLimits;
  /** `null` when the scenario is rejected before it ever reaches the validator. */
  readonly expectedIssueCode: PlanValidationIssueCode | null;
}

const SCENARIO_FIXTURES: readonly FakePlanningScenarioFixture[] = [
  {
    scenario: 'valid',
    raw: JSON.stringify(fakeValidPlanDocument),
    taskLimits: fakePlanningTaskLimits,
    expectedIssueCode: null,
  },
  {
    scenario: 'schemaInvalid',
    raw: schemaInvalidRaw,
    taskLimits: fakePlanningTaskLimits,
    expectedIssueCode: null,
  },
  {
    scenario: 'malformedJson',
    raw: '{"taskId": "01FAKETASK0000000000000000", "steps": [',
    taskLimits: fakePlanningTaskLimits,
    expectedIssueCode: null,
  },
  {
    scenario: 'emptyOutput',
    raw: '',
    taskLimits: fakePlanningTaskLimits,
    expectedIssueCode: null,
  },
  {
    scenario: 'notAnObject',
    raw: '[]',
    taskLimits: fakePlanningTaskLimits,
    expectedIssueCode: null,
  },
  {
    scenario: 'duplicateStepId',
    raw: JSON.stringify(duplicateStepIdPlan),
    taskLimits: fakePlanningTaskLimits,
    expectedIssueCode: 'DUPLICATE_STEP_ID',
  },
  {
    scenario: 'missingDependency',
    raw: JSON.stringify(missingDependencyPlan),
    taskLimits: fakePlanningTaskLimits,
    expectedIssueCode: 'MISSING_DEPENDENCY',
  },
  {
    scenario: 'dagCycle',
    raw: JSON.stringify(dagCyclePlan),
    taskLimits: fakePlanningTaskLimits,
    expectedIssueCode: 'DAG_CYCLE',
  },
  {
    scenario: 'disabledAgent',
    raw: JSON.stringify(disabledAgentPlan),
    taskLimits: fakePlanningTaskLimits,
    expectedIssueCode: 'DISABLED_AGENT',
  },
  {
    scenario: 'finalSynthesisIncomplete',
    raw: JSON.stringify(finalSynthesisIncompletePlan),
    taskLimits: fakePlanningTaskLimits,
    expectedIssueCode: 'FINAL_SYNTHESIS_INCOMPLETE_DEPENDENCIES',
  },
  {
    scenario: 'builderWithoutQa',
    raw: JSON.stringify(builderWithoutQaPlan),
    taskLimits: fakePlanningTaskLimits,
    expectedIssueCode: 'BUILDER_WITHOUT_QA',
  },
  {
    scenario: 'codeWorkflowIncomplete',
    raw: JSON.stringify(codeWorkflowIncompletePlan),
    taskLimits: fakePlanningTaskLimits,
    expectedIssueCode: 'CODE_WORKFLOW_INCOMPLETE',
  },
  {
    scenario: 'runLimitExceeded',
    raw: JSON.stringify(runLimitExceededPlan),
    taskLimits: TIGHT_TASK_LIMITS,
    expectedIssueCode: 'RUN_LIMIT_EXCEEDED',
  },
];

export const fakePlanningScenarioFixtures = SCENARIO_FIXTURES;

export function fakePlanningScenarioFixture(
  scenario: FakePlanningScenario,
): FakePlanningScenarioFixture {
  const fixture = SCENARIO_FIXTURES.find((entry) => entry.scenario === scenario);
  if (!fixture) {
    throw new Error(`Unknown fake planning scenario "${scenario}".`);
  }
  return fixture;
}

export interface FakePlanningResponse {
  readonly attempt: number;
  readonly scenario: FakePlanningScenario;
  readonly raw: unknown;
}

export interface FakePlanningAdapter {
  plan(request: PlannerRequest): FakePlanningResponse;
}

/** A single scenario reused for every attempt, or one scenario per attempt. */
export type FakePlanningScript = FakePlanningScenario | readonly FakePlanningScenario[];

/**
 * Synthetic, in-memory planning adapter. No process spawning, no network, and no
 * provider call: it replays fixed fixture output keyed by `request.attempt`, so a
 * replan sequence such as `['dagCycle', 'schemaInvalid', 'valid']` is reproducible.
 *
 * The adapter never echoes the request back into the plan; every scenario carries
 * `fakePlanningTaskId`, so callers must build requests with that task id.
 */
export function createFakePlanningAdapter(script: FakePlanningScript): FakePlanningAdapter {
  const scenarios = typeof script === 'string' ? null : [...script];
  if (scenarios !== null && scenarios.length === 0) {
    throw new Error('A fake planning script requires at least one scenario.');
  }

  return {
    plan(request: PlannerRequest): FakePlanningResponse {
      const scenario =
        scenarios === null ? script : (scenarios[request.attempt - 1] ?? scenarios.at(-1));
      if (typeof scenario !== 'string') {
        throw new Error(`No fake planning scenario for attempt ${request.attempt}.`);
      }
      return {
        attempt: request.attempt,
        scenario,
        raw: fakePlanningScenarioFixture(scenario).raw,
      };
    },
  };
}

export interface FakePlannerRequestOverrides {
  readonly attempt?: 1 | 2 | 3;
  readonly previousIssues?: readonly PlanValidationIssue[];
  readonly taskLimits?: FakePlanningTaskLimits;
  readonly tags?: readonly string[];
}

/** Builds a `PlannerRequest` that matches the canonical fixture roster and task id. */
export function createFakePlannerRequest(
  overrides: FakePlannerRequestOverrides = {},
): PlannerRequest {
  const attempt = overrides.attempt ?? 1;
  const limits = overrides.taskLimits ?? fakePlanningTaskLimits;
  return {
    attempt,
    task: {
      taskId: fakePlanningTaskId,
      title: 'Fixture planning task',
      objective: 'Produce a deterministic fixture plan for the orchestration test suite.',
      successCriteria: ['The plan passes the deterministic server validator.'],
      tags: [...(overrides.tags ?? [])],
      maxDurationMinutes: 60,
      maxAgentRuns: limits.maxAgentRuns,
    },
    project: {
      classification: fakePlanningClassification,
      providerPolicy: fakePlanningProviderPolicy,
      allowedAgentIds: fakePlannerAgentDescriptors.map((agent) => agent.id),
    },
    agents: [...fakePlannerAgentDescriptors],
    limits: {
      maxAgentRuns: limits.maxAgentRuns,
      existingRunCount: limits.existingRunCount,
      remainingRuns: Math.max(0, limits.maxAgentRuns - limits.existingRunCount),
    },
    previousIssues: [...(overrides.previousIssues ?? [])],
  };
}
