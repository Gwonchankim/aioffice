import { describe, expect, it } from 'vitest';

import type {
  OrchestrationPlanDocument,
  OrchestrationStep,
  PermissionTemplate,
  Provider,
  ProviderModelState,
  ProviderPolicy,
} from '@orion/contracts';

import type { PlanValidatorAgent, PlanValidatorInput } from '../src/index.js';
import { decideReplanning, validatePlan } from '../src/index.js';

// Deterministic 26-character Crockford-base32 ULID literals (first char 0-7,
// remaining chars drawn from the Crockford alphabet: no I/L/O/U).
function ulid(tag: string): string {
  const cleaned = tag
    .toUpperCase()
    .replace(/[^0-9A-HJKMNP-TV-Z]/g, '0')
    .padEnd(25, '0')
    .slice(0, 25);
  return `0${cleaned}`;
}

const TASK_ID = ulid('TASK');

interface AgentFixtureDefinition {
  readonly permissionTemplate: PermissionTemplate;
  readonly provider: Provider;
  readonly model: string;
  readonly artifactWriteAllowed: boolean;
  readonly worktreeWriteAllowed: boolean;
  readonly localCommitAllowed: boolean;
  readonly enabled: boolean;
}

// Mirrors the 18 canonical M3 catalog profiles (0002/0006 seeds): roster,
// permission templates, providers, and models.
const AGENT_DEFINITIONS: Record<string, AgentFixtureDefinition> = {
  atlas: {
    permissionTemplate: 'advisor',
    provider: 'openai',
    model: 'gpt-5.6-sol',
    artifactWriteAllowed: true,
    worktreeWriteAllowed: false,
    localCommitAllowed: false,
    enabled: true,
  },
  nova: {
    permissionTemplate: 'advisor',
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    artifactWriteAllowed: true,
    worktreeWriteAllowed: false,
    localCommitAllowed: false,
    enabled: true,
  },
  miro: {
    permissionTemplate: 'advisor',
    provider: 'openai',
    model: 'gpt-5.6-terra',
    artifactWriteAllowed: true,
    worktreeWriteAllowed: false,
    localCommitAllowed: false,
    enabled: true,
  },
  aegis: {
    permissionTemplate: 'advisor',
    provider: 'openai',
    model: 'gpt-5.6-sol',
    artifactWriteAllowed: true,
    worktreeWriteAllowed: false,
    localCommitAllowed: false,
    enabled: true,
  },
  ledger: {
    permissionTemplate: 'advisor',
    provider: 'anthropic',
    model: 'claude-opus-4-8',
    artifactWriteAllowed: true,
    worktreeWriteAllowed: false,
    localCommitAllowed: false,
    enabled: true,
  },
  forge: {
    permissionTemplate: 'builder',
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    artifactWriteAllowed: true,
    worktreeWriteAllowed: true,
    localCommitAllowed: true,
    enabled: true,
  },
  luma: {
    permissionTemplate: 'builder',
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    artifactWriteAllowed: true,
    worktreeWriteAllowed: true,
    localCommitAllowed: true,
    enabled: true,
  },
  iris: {
    permissionTemplate: 'builder',
    provider: 'anthropic',
    model: 'claude-fable-5',
    artifactWriteAllowed: true,
    worktreeWriteAllowed: true,
    localCommitAllowed: true,
    enabled: true,
  },
  verify: {
    permissionTemplate: 'qa_writer',
    provider: 'openai',
    model: 'gpt-5.6-terra',
    artifactWriteAllowed: true,
    worktreeWriteAllowed: true,
    localCommitAllowed: true,
    enabled: true,
  },
  sentinel: {
    permissionTemplate: 'reviewer',
    provider: 'anthropic',
    model: 'claude-opus-4-8',
    artifactWriteAllowed: true,
    worktreeWriteAllowed: false,
    localCommitAllowed: false,
    enabled: true,
  },
  archon: {
    permissionTemplate: 'integrator',
    provider: 'openai',
    model: 'gpt-5.6-sol',
    artifactWriteAllowed: true,
    worktreeWriteAllowed: true,
    localCommitAllowed: true,
    enabled: true,
  },
  orion: {
    permissionTemplate: 'orchestrator',
    provider: 'openai',
    model: 'gpt-5.6-sol',
    artifactWriteAllowed: true,
    worktreeWriteAllowed: false,
    localCommitAllowed: false,
    enabled: true,
  },
  helios: {
    permissionTemplate: 'advisor',
    provider: 'anthropic',
    model: 'claude-opus-4-8',
    artifactWriteAllowed: true,
    worktreeWriteAllowed: false,
    localCommitAllowed: false,
    enabled: true,
  },
  regula: {
    permissionTemplate: 'advisor',
    provider: 'anthropic',
    model: 'claude-opus-4-8',
    artifactWriteAllowed: true,
    worktreeWriteAllowed: false,
    localCommitAllowed: false,
    enabled: true,
  },
  insight: {
    permissionTemplate: 'advisor',
    provider: 'openai',
    model: 'gpt-5.6-terra',
    artifactWriteAllowed: true,
    worktreeWriteAllowed: false,
    localCommitAllowed: false,
    enabled: true,
  },
  keystone: {
    permissionTemplate: 'builder',
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    artifactWriteAllowed: true,
    worktreeWriteAllowed: true,
    localCommitAllowed: true,
    enabled: true,
  },
  nexus: {
    permissionTemplate: 'orchestrator',
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    artifactWriteAllowed: true,
    worktreeWriteAllowed: false,
    localCommitAllowed: false,
    enabled: true,
  },
  arca: {
    permissionTemplate: 'knowledge-registry',
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    artifactWriteAllowed: false,
    worktreeWriteAllowed: false,
    localCommitAllowed: false,
    enabled: false,
  },
};

function makeAgent(id: string, overrides: Partial<PlanValidatorAgent> = {}): PlanValidatorAgent {
  const def = AGENT_DEFINITIONS[id];
  if (!def) {
    throw new Error(`Unknown fixture agent id "${id}".`);
  }
  return {
    id,
    version: 2,
    enabled: def.enabled,
    permissionTemplate: def.permissionTemplate,
    permissions: {
      artifactWriteAllowed: def.artifactWriteAllowed,
      worktreeWriteAllowed: def.worktreeWriteAllowed,
      localCommitAllowed: def.localCommitAllowed,
    },
    provider: def.provider,
    model: def.model,
    fallbackModels: id === 'iris' ? [{ provider: 'anthropic', model: 'claude-opus-4-8' }] : [],
    ...overrides,
  };
}

const ALL_AGENTS: readonly PlanValidatorAgent[] = Object.keys(AGENT_DEFINITIONS).map((id) =>
  makeAgent(id),
);

function allAvailableModelStates(): ProviderModelState[] {
  const seen = new Set<string>();
  const states: ProviderModelState[] = [];
  for (const def of Object.values(AGENT_DEFINITIONS)) {
    const key = `${def.provider}:${def.model}`;
    if (!seen.has(key)) {
      seen.add(key);
      states.push({ provider: def.provider, model: def.model, status: 'available' });
    }
  }
  states.push({ provider: 'anthropic', model: 'claude-opus-4-8', status: 'available' });
  return states;
}

const DEFAULT_PROVIDER_POLICY: ProviderPolicy = {
  openai: true,
  anthropic: true,
  allowFable: false,
};

function makeStep(
  overrides: Partial<OrchestrationStep> & Pick<OrchestrationStep, 'id' | 'agentId'>,
): OrchestrationStep {
  return {
    title: 'Step title',
    dependsOn: [],
    executionMode: 'read_only',
    objective: 'A sufficiently detailed step objective for validation purposes.',
    inputRefs: [],
    expectedArtifacts: [],
    acceptanceCriteria: ['Criterion satisfied'],
    verificationCommands: [],
    maxAttempts: 1,
    ...overrides,
  };
}

function makePlan(
  steps: OrchestrationStep[],
  finalSynthesisStepId: string,
): OrchestrationPlanDocument {
  return {
    taskId: TASK_ID,
    summary: 'Test plan summary text.',
    assumptions: [],
    risks: [],
    steps,
    finalSynthesisStepId,
  };
}

function baseInput(overrides: Partial<PlanValidatorInput> = {}): PlanValidatorInput {
  return {
    plan: makePlan([], ulid('FINAL')),
    taskLimits: { maxAgentRuns: 60, existingRunCount: 0 },
    taskTags: [],
    agents: ALL_AGENTS,
    modelStates: allAvailableModelStates(),
    project: { classification: 'internal', providerPolicy: DEFAULT_PROVIDER_POLICY },
    ...overrides,
  };
}

function issueCodes(result: ReturnType<typeof validatePlan>): string[] {
  return result.issues.map((issue) => issue.code);
}

describe('validatePlan', () => {
  it('PLN-001: a single advisor step plus an orion final synthesis step is valid', () => {
    const advisorId = ulid('ADV');
    const finalId = ulid('FIN1');
    const steps = [
      makeStep({ id: advisorId, agentId: 'atlas', executionMode: 'artifact_write' }),
      makeStep({ id: finalId, agentId: 'orion', dependsOn: [advisorId] }),
    ];
    const result = validatePlan(baseInput({ plan: makePlan(steps, finalId) }));
    expect(result).toEqual({ valid: true, issues: [] });
  });

  it('PLN-002: three parallel advisor steps converging into an orion final step is valid', () => {
    const a1 = ulid('A1');
    const a2 = ulid('A2');
    const a3 = ulid('A3');
    const finalId = ulid('FIN2');
    const steps = [
      makeStep({ id: a1, agentId: 'atlas', executionMode: 'artifact_write' }),
      makeStep({ id: a2, agentId: 'nova', executionMode: 'artifact_write' }),
      makeStep({ id: a3, agentId: 'miro', executionMode: 'artifact_write' }),
      makeStep({ id: finalId, agentId: 'orion', dependsOn: [a1, a2, a3] }),
    ];
    const result = validatePlan(baseInput({ plan: makePlan(steps, finalId) }));
    expect(result).toEqual({ valid: true, issues: [] });
  });

  it('PLN-003: nexus -> forge -> verify -> archon(integration) -> orion is a valid code workflow', () => {
    const nexusId = ulid('NEXUS');
    const forgeId = ulid('FORGE');
    const verifyId = ulid('VERIFY');
    const archonId = ulid('ARCHON');
    const finalId = ulid('FIN3');
    const steps = [
      makeStep({ id: nexusId, agentId: 'nexus', executionMode: 'read_only' }),
      makeStep({
        id: forgeId,
        agentId: 'forge',
        executionMode: 'worktree_write',
        dependsOn: [nexusId],
      }),
      makeStep({
        id: verifyId,
        agentId: 'verify',
        executionMode: 'artifact_write',
        dependsOn: [forgeId],
      }),
      makeStep({
        id: archonId,
        agentId: 'archon',
        executionMode: 'integration',
        dependsOn: [verifyId],
      }),
      makeStep({ id: finalId, agentId: 'orion', dependsOn: [archonId] }),
    ];
    const result = validatePlan(baseInput({ plan: makePlan(steps, finalId) }));
    expect(result).toEqual({ valid: true, issues: [] });
  });

  describe('CODE_WORKFLOW_INCOMPLETE', () => {
    function codeWorkflowSteps(omit: 'planning' | 'builder' | 'qa' | 'archon-integration' | null) {
      const nexusId = ulid('CWNEX');
      const forgeId = ulid('CWFRG');
      const verifyId = ulid('CWVFY');
      const archonId = ulid('CWARC');
      const finalId = ulid('CWFIN');
      const steps: OrchestrationStep[] = [];
      let previous: string[] = [];

      if (omit !== 'planning') {
        steps.push(makeStep({ id: nexusId, agentId: 'nexus', executionMode: 'read_only' }));
        previous = [nexusId];
      }
      if (omit !== 'builder') {
        steps.push(
          makeStep({
            id: forgeId,
            agentId: 'forge',
            executionMode: 'worktree_write',
            dependsOn: previous,
          }),
        );
        previous = [forgeId];
      }
      if (omit !== 'qa') {
        steps.push(
          makeStep({
            id: verifyId,
            agentId: 'verify',
            executionMode: 'artifact_write',
            dependsOn: previous,
          }),
        );
        previous = [verifyId];
      }
      if (omit !== 'archon-integration') {
        steps.push(
          makeStep({
            id: archonId,
            agentId: 'archon',
            executionMode: 'integration',
            dependsOn: previous,
          }),
        );
        previous = [archonId];
      }
      steps.push(makeStep({ id: finalId, agentId: 'orion', dependsOn: previous }));
      return { steps, finalId };
    }

    it('rejects when the code workflow is missing its builder step (triggered by the code tag)', () => {
      const { steps, finalId } = codeWorkflowSteps('builder');
      const result = validatePlan(
        baseInput({ plan: makePlan(steps, finalId), taskTags: ['code'] }),
      );
      expect(issueCodes(result)).toContain('CODE_WORKFLOW_INCOMPLETE');
    });

    it('passes when planning/builder/QA/archon-integration are all present', () => {
      const { steps, finalId } = codeWorkflowSteps(null);
      const result = validatePlan(
        baseInput({ plan: makePlan(steps, finalId), taskTags: ['code'] }),
      );
      expect(result).toEqual({ valid: true, issues: [] });
    });
  });

  describe('COATING_CROSS_REVIEW_MISSING', () => {
    it('rejects a coating-tagged plan missing the helios counterpart to aegis', () => {
      const aegisId = ulid('AEG');
      const finalId = ulid('COATFIN1');
      const steps = [
        makeStep({ id: aegisId, agentId: 'aegis', executionMode: 'artifact_write' }),
        makeStep({ id: finalId, agentId: 'orion', dependsOn: [aegisId] }),
      ];
      const result = validatePlan(
        baseInput({ plan: makePlan(steps, finalId), taskTags: ['coating'] }),
      );
      expect(issueCodes(result)).toContain('COATING_CROSS_REVIEW_MISSING');
    });

    it('passes a coating-tagged plan with both aegis and helios', () => {
      const aegisId = ulid('AEG2');
      const heliosId = ulid('HEL2');
      const finalId = ulid('COATFIN2');
      const steps = [
        makeStep({ id: aegisId, agentId: 'aegis', executionMode: 'artifact_write' }),
        makeStep({ id: heliosId, agentId: 'helios', executionMode: 'artifact_write' }),
        makeStep({ id: finalId, agentId: 'orion', dependsOn: [aegisId, heliosId] }),
      ];
      const result = validatePlan(
        baseInput({ plan: makePlan(steps, finalId), taskTags: ['coating'] }),
      );
      expect(result).toEqual({ valid: true, issues: [] });
    });
  });

  describe('REGULATORY_REVIEW_MISSING', () => {
    it('rejects a regulatory-tagged plan without a regula step', () => {
      const advId = ulid('REGADV');
      const finalId = ulid('REGFIN1');
      const steps = [
        makeStep({ id: advId, agentId: 'atlas', executionMode: 'artifact_write' }),
        makeStep({ id: finalId, agentId: 'orion', dependsOn: [advId] }),
      ];
      const result = validatePlan(
        baseInput({ plan: makePlan(steps, finalId), taskTags: ['regulatory'] }),
      );
      expect(issueCodes(result)).toContain('REGULATORY_REVIEW_MISSING');
    });

    it('passes a regulatory-tagged plan with a regula step', () => {
      const regulaId = ulid('REG2');
      const finalId = ulid('REGFIN2');
      const steps = [
        makeStep({ id: regulaId, agentId: 'regula', executionMode: 'artifact_write' }),
        makeStep({ id: finalId, agentId: 'orion', dependsOn: [regulaId] }),
      ];
      const result = validatePlan(
        baseInput({ plan: makePlan(steps, finalId), taskTags: ['regulatory'] }),
      );
      expect(result).toEqual({ valid: true, issues: [] });
    });
  });

  describe('FINANCIAL_REVIEW_MISSING', () => {
    it('rejects a financial-tagged plan without a ledger step', () => {
      const advId = ulid('FINADV');
      const finalId = ulid('FINFIN1');
      const steps = [
        makeStep({ id: advId, agentId: 'atlas', executionMode: 'artifact_write' }),
        makeStep({ id: finalId, agentId: 'orion', dependsOn: [advId] }),
      ];
      const result = validatePlan(
        baseInput({ plan: makePlan(steps, finalId), taskTags: ['financial'] }),
      );
      expect(issueCodes(result)).toContain('FINANCIAL_REVIEW_MISSING');
    });

    it('passes a financial-tagged plan with a ledger step', () => {
      const ledgerId = ulid('LDG2');
      const finalId = ulid('FINFIN2');
      const steps = [
        makeStep({ id: ledgerId, agentId: 'ledger', executionMode: 'artifact_write' }),
        makeStep({ id: finalId, agentId: 'orion', dependsOn: [ledgerId] }),
      ];
      const result = validatePlan(
        baseInput({ plan: makePlan(steps, finalId), taskTags: ['financial'] }),
      );
      expect(result).toEqual({ valid: true, issues: [] });
    });
  });

  it('PLN-INFRA: rejects an infrastructure-tagged plan missing sentinel alongside keystone', () => {
    const keystoneId = ulid('KEY1');
    const finalId = ulid('INFRAFIN1');
    const steps = [
      makeStep({ id: keystoneId, agentId: 'keystone', executionMode: 'worktree_write' }),
      makeStep({ id: finalId, agentId: 'orion', dependsOn: [keystoneId] }),
    ];
    const result = validatePlan(
      baseInput({ plan: makePlan(steps, finalId), taskTags: ['infrastructure'] }),
    );
    expect(issueCodes(result)).toContain('INFRASTRUCTURE_REVIEW_MISSING');
  });

  it('PLN-008a: FINAL_SYNTHESIS_MISSING when the final step is not assigned to orion', () => {
    const advId = ulid('FSMADV');
    const finalId = ulid('FSMFIN');
    const steps = [
      makeStep({ id: advId, agentId: 'atlas', executionMode: 'artifact_write' }),
      makeStep({
        id: finalId,
        agentId: 'nova',
        dependsOn: [advId],
        executionMode: 'artifact_write',
      }),
    ];
    const result = validatePlan(baseInput({ plan: makePlan(steps, finalId) }));
    expect(issueCodes(result)).toContain('FINAL_SYNTHESIS_MISSING');
  });

  it('PLN-008b: FINAL_SYNTHESIS_INCOMPLETE_DEPENDENCIES when the final step omits a step from its dependency closure', () => {
    const adv1 = ulid('FSIADV1');
    const adv2 = ulid('FSIADV2');
    const finalId = ulid('FSIFIN');
    const steps = [
      makeStep({ id: adv1, agentId: 'atlas', executionMode: 'artifact_write' }),
      makeStep({ id: adv2, agentId: 'nova', executionMode: 'artifact_write' }),
      makeStep({ id: finalId, agentId: 'orion', dependsOn: [adv1] }),
    ];
    const result = validatePlan(baseInput({ plan: makePlan(steps, finalId) }));
    expect(issueCodes(result)).toContain('FINAL_SYNTHESIS_INCOMPLETE_DEPENDENCIES');
  });

  it('PLN-009: EXCESSIVE_AGENT_SELECTION fires with 13 distinct agents in one plan', () => {
    const advisorIds = ['atlas', 'nova', 'miro', 'aegis', 'ledger', 'helios', 'regula', 'insight'];
    const steps: OrchestrationStep[] = advisorIds.map((agentId, index) =>
      makeStep({ id: ulid(`EX${index}`), agentId, executionMode: 'artifact_write' }),
    );
    const nexusId = ulid('EXNEXUS');
    const forgeId = ulid('EXFORGE');
    const verifyId = ulid('EXVERIFY');
    const archonId = ulid('EXARCHON');
    const finalId = ulid('EXFINAL');
    steps.push(makeStep({ id: nexusId, agentId: 'nexus', executionMode: 'read_only' }));
    steps.push(
      makeStep({
        id: forgeId,
        agentId: 'forge',
        executionMode: 'worktree_write',
        dependsOn: [nexusId],
      }),
    );
    steps.push(
      makeStep({
        id: verifyId,
        agentId: 'verify',
        executionMode: 'artifact_write',
        dependsOn: [forgeId],
      }),
    );
    steps.push(
      makeStep({
        id: archonId,
        agentId: 'archon',
        executionMode: 'integration',
        dependsOn: [verifyId],
      }),
    );
    steps.push(
      makeStep({
        id: finalId,
        agentId: 'orion',
        dependsOn: [...advisorIds.map((_, index) => ulid(`EX${index}`)), archonId],
      }),
    );
    // 8 advisors + nexus + forge + verify + archon + orion = 13 distinct agents.
    const result = validatePlan(baseInput({ plan: makePlan(steps, finalId) }));
    expect(issueCodes(result)).toContain('EXCESSIVE_AGENT_SELECTION');
  });

  it('PLN-011: DUPLICATE_STEP_ID fires when two steps reuse the same id', () => {
    const dupId = ulid('DUP');
    const finalId = ulid('DUPFIN');
    const steps = [
      makeStep({ id: dupId, agentId: 'atlas', executionMode: 'artifact_write' }),
      makeStep({ id: dupId, agentId: 'nova', executionMode: 'artifact_write' }),
      makeStep({ id: finalId, agentId: 'orion', dependsOn: [dupId] }),
    ];
    const result = validatePlan(baseInput({ plan: makePlan(steps, finalId) }));
    expect(issueCodes(result)).toContain('DUPLICATE_STEP_ID');
  });

  it('PLN-012: MISSING_DEPENDENCY fires when a step depends on a nonexistent step id', () => {
    const finalId = ulid('MDFIN');
    const steps = [makeStep({ id: finalId, agentId: 'orion', dependsOn: [ulid('GHOST')] })];
    const result = validatePlan(baseInput({ plan: makePlan(steps, finalId) }));
    expect(issueCodes(result)).toContain('MISSING_DEPENDENCY');
  });

  it('PLN-013: DAG_CYCLE fires for a two-step mutual dependency cycle', () => {
    const s1 = ulid('CYC1');
    const s2 = ulid('CYC2');
    const steps = [
      makeStep({ id: s1, agentId: 'atlas', executionMode: 'artifact_write', dependsOn: [s2] }),
      makeStep({ id: s2, agentId: 'orion', dependsOn: [s1] }),
    ];
    const result = validatePlan(baseInput({ plan: makePlan(steps, s2) }));
    expect(issueCodes(result)).toContain('DAG_CYCLE');
  });

  it('PLN-014: UNKNOWN_AGENT fires when a step references an unregistered agent id', () => {
    const finalId = ulid('UAFIN');
    const steps = [makeStep({ id: finalId, agentId: 'ghost-agent' })];
    const result = validatePlan(baseInput({ plan: makePlan(steps, finalId) }));
    expect(issueCodes(result)).toContain('UNKNOWN_AGENT');
  });

  it('PLN-015: EXECUTION_MODE_PERMISSION_MISMATCH fires for a worktree_write step on a non-writer agent', () => {
    const stepId = ulid('MISMATCH');
    const steps = [makeStep({ id: stepId, agentId: 'atlas', executionMode: 'worktree_write' })];
    const result = validatePlan(baseInput({ plan: makePlan(steps, stepId) }));
    expect(issueCodes(result)).toContain('EXECUTION_MODE_PERMISSION_MISMATCH');
  });

  it('PLN-016: CLASSIFICATION_TRANSFER_VIOLATION fires when the project classification is controlled', () => {
    const stepId = ulid('CTRL');
    const steps = [makeStep({ id: stepId, agentId: 'atlas', executionMode: 'artifact_write' })];
    const result = validatePlan(
      baseInput({
        plan: makePlan(steps, stepId),
        project: {
          classification: 'controlled',
          providerPolicy: { openai: false, anthropic: false, allowFable: false },
        },
      }),
    );
    expect(issueCodes(result)).toContain('CLASSIFICATION_TRANSFER_VIOLATION');
  });

  it('PLN-017: RUN_LIMIT_EXCEEDED fires when existing runs plus new steps exceed the task limit', () => {
    const stepId = ulid('LIMIT');
    const steps = [makeStep({ id: stepId, agentId: 'atlas', executionMode: 'artifact_write' })];
    const result = validatePlan(
      baseInput({
        plan: makePlan(steps, stepId),
        taskLimits: { maxAgentRuns: 60, existingRunCount: 60 },
      }),
    );
    expect(issueCodes(result)).toContain('RUN_LIMIT_EXCEEDED');
  });

  it('PLN-018: BUILDER_WITHOUT_QA fires when a worktree_write step has no downstream verify/sentinel step', () => {
    const forgeId = ulid('BWQFRG');
    const finalId = ulid('BWQFIN');
    const steps = [
      makeStep({ id: forgeId, agentId: 'forge', executionMode: 'worktree_write' }),
      makeStep({ id: finalId, agentId: 'orion', dependsOn: [forgeId] }),
    ];
    const result = validatePlan(baseInput({ plan: makePlan(steps, finalId) }));
    expect(issueCodes(result)).toContain('BUILDER_WITHOUT_QA');
  });

  it('PLN-020: accumulates every independent violation in a single pass instead of short-circuiting', () => {
    const dupId = ulid('ACCDUP');
    const forgeId = ulid('ACCFRG');
    const steps = [
      makeStep({ id: dupId, agentId: 'ghost-agent' }),
      makeStep({ id: dupId, agentId: 'atlas', executionMode: 'worktree_write' }),
      makeStep({ id: forgeId, agentId: 'forge', executionMode: 'worktree_write' }),
    ];
    const result = validatePlan(baseInput({ plan: makePlan(steps, dupId) }));
    const codes = issueCodes(result);
    expect(result.valid).toBe(false);
    expect(codes).toContain('DUPLICATE_STEP_ID');
    expect(codes).toContain('UNKNOWN_AGENT');
    expect(codes).toContain('EXECUTION_MODE_PERMISSION_MISMATCH');
    expect(codes).toContain('BUILDER_WITHOUT_QA');
    expect(codes).toContain('FINAL_SYNTHESIS_MISSING');
    expect(codes.length).toBeGreaterThan(3);
  });

  it('DISABLED_AGENT: fires for an arca step because arca is always seeded disabled', () => {
    const arcaId = ulid('ARCADIS');
    const steps = [makeStep({ id: arcaId, agentId: 'arca', executionMode: 'read_only' })];
    const result = validatePlan(baseInput({ plan: makePlan(steps, arcaId) }));
    expect(issueCodes(result)).toContain('DISABLED_AGENT');
    expect(issueCodes(result)).not.toContain('UNKNOWN_AGENT');
  });

  it('UNAVAILABLE_AGENT: fires when every model candidate is unavailable (not a policy block)', () => {
    const stepId = ulid('UNAVAIL');
    const steps = [makeStep({ id: stepId, agentId: 'atlas', executionMode: 'artifact_write' })];
    const modelStates: ProviderModelState[] = allAvailableModelStates().map((state) =>
      state.provider === 'openai' && state.model === 'gpt-5.6-sol'
        ? { ...state, status: 'unavailable' }
        : state,
    );
    const result = validatePlan(baseInput({ plan: makePlan(steps, stepId), modelStates }));
    expect(issueCodes(result)).toContain('UNAVAILABLE_AGENT');
    expect(issueCodes(result)).not.toContain('PROVIDER_POLICY_VIOLATION');
  });

  it('PROVIDER_POLICY_VIOLATION: fires when the only candidate is blocked purely by provider policy', () => {
    const stepId = ulid('POLICY');
    const steps = [makeStep({ id: stepId, agentId: 'atlas', executionMode: 'artifact_write' })];
    const result = validatePlan(
      baseInput({
        plan: makePlan(steps, stepId),
        project: {
          classification: 'internal',
          providerPolicy: { openai: false, anthropic: true, allowFable: false },
        },
      }),
    );
    expect(issueCodes(result)).toContain('PROVIDER_POLICY_VIOLATION');
    expect(issueCodes(result)).not.toContain('UNAVAILABLE_AGENT');
  });

  it('external_action step passes with an approval-request artifact and zero verification commands', () => {
    const stepId = ulid('EXTOK');
    const steps = [
      makeStep({
        id: stepId,
        agentId: 'atlas',
        executionMode: 'external_action',
        expectedArtifacts: ['approval-request'],
        verificationCommands: [],
      }),
    ];
    const result = validatePlan(baseInput({ plan: makePlan(steps, stepId) }));
    expect(issueCodes(result)).not.toContain('EXTERNAL_ACTION_WITHOUT_APPROVAL');
  });

  it('external_action step is rejected without an approval-request artifact', () => {
    const stepId = ulid('EXTBAD');
    const steps = [
      makeStep({
        id: stepId,
        agentId: 'atlas',
        executionMode: 'external_action',
        expectedArtifacts: [],
        verificationCommands: [],
      }),
    ];
    const result = validatePlan(baseInput({ plan: makePlan(steps, stepId) }));
    expect(issueCodes(result)).toContain('EXTERNAL_ACTION_WITHOUT_APPROVAL');
  });
});

describe('decideReplanning', () => {
  it('accepts a valid plan regardless of attempt number', () => {
    const decision = decideReplanning(1, { valid: true, issues: [] });
    expect(decision).toEqual({ action: 'accept' });
  });

  it('replans on attempt 1 when the plan is invalid, advancing to attempt 2', () => {
    const issues = [{ code: 'MISSING_DEPENDENCY' as const, path: null, message: 'gap' }];
    const decision = decideReplanning(1, { valid: false, issues });
    expect(decision).toEqual({ action: 'replan', nextAttempt: 2, issues });
  });

  it('replans on attempt 2 when the plan is invalid, advancing to attempt 3', () => {
    const issues = [{ code: 'DAG_CYCLE' as const, path: null, message: 'cycle' }];
    const decision = decideReplanning(2, { valid: false, issues });
    expect(decision).toEqual({ action: 'replan', nextAttempt: 3, issues });
  });

  it('fails the task when attempt 3 is still invalid (PLN-019: initial + 2 replans max)', () => {
    const issues = [{ code: 'RUN_LIMIT_EXCEEDED' as const, path: null, message: 'limit' }];
    const decision = decideReplanning(3, { valid: false, issues });
    expect(decision).toEqual({ action: 'fail', issues });
  });
});
