import { describe, expect, it } from 'vitest';

import type { OrchestrationPlanDocument } from '@orion/contracts';

import { createFakeProviderRegistry } from '../../test-fixtures/src/fake-provider-registry.js';
import {
  createFakePlannerRequest,
  createFakePlanningAdapter,
  fakePlanningRoster,
  fakePlanningClassification,
  fakePlanningProviderPolicy,
  fakePlanningScenarioFixtures,
  fakePlanningScenarioFixture,
  fakeValidPlanDocument,
  type FakePlanningTaskLimits,
} from '../../test-fixtures/src/fake-planning-adapter.js';

import type { PlanValidatorInput } from '../src/index.js';
import { decideReplanning, parsePlannerOutput, validatePlan } from '../src/index.js';

const modelStates = createFakeProviderRegistry().modelStates;

function validatorInput(
  plan: OrchestrationPlanDocument,
  taskLimits: FakePlanningTaskLimits,
): PlanValidatorInput {
  return {
    plan,
    taskLimits,
    taskTags: [],
    agents: fakePlanningRoster,
    modelStates,
    project: {
      classification: fakePlanningClassification,
      providerPolicy: fakePlanningProviderPolicy,
    },
  };
}

describe('parsePlannerOutput', () => {
  it('accepts a well-formed plan supplied as raw model text', () => {
    const result = parsePlannerOutput(JSON.stringify(fakeValidPlanDocument));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan).toEqual(fakeValidPlanDocument);
    }
  });

  it('accepts an already-parsed plan object', () => {
    const result = parsePlannerOutput(fakeValidPlanDocument);
    expect(result).toEqual({ ok: true, plan: fakeValidPlanDocument });
  });

  it('rejects malformed JSON with MALFORMED_JSON', () => {
    const result = parsePlannerOutput(fakePlanningScenarioFixture('malformedJson').raw);
    expect(result).toMatchObject({ ok: false, code: 'MALFORMED_JSON' });
  });

  it('rejects empty output with EMPTY_OUTPUT', () => {
    expect(parsePlannerOutput('')).toMatchObject({ ok: false, code: 'EMPTY_OUTPUT' });
    expect(parsePlannerOutput('   \n  ')).toMatchObject({ ok: false, code: 'EMPTY_OUTPUT' });
    expect(parsePlannerOutput(undefined)).toMatchObject({ ok: false, code: 'EMPTY_OUTPUT' });
  });

  it('rejects arrays, scalars, and null with NOT_AN_OBJECT', () => {
    expect(parsePlannerOutput('[]')).toMatchObject({ ok: false, code: 'NOT_AN_OBJECT' });
    expect(parsePlannerOutput('42')).toMatchObject({ ok: false, code: 'NOT_AN_OBJECT' });
    expect(parsePlannerOutput('null')).toMatchObject({ ok: false, code: 'NOT_AN_OBJECT' });
    expect(parsePlannerOutput(null)).toMatchObject({ ok: false, code: 'NOT_AN_OBJECT' });
  });

  it('rejects an unknown extra field with SCHEMA_INVALID and reports the zod issues', () => {
    const result = parsePlannerOutput(fakePlanningScenarioFixture('schemaInvalid').raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('SCHEMA_INVALID');
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.issues.join('\n')).toContain('unexpectedField');
    }
  });

  it('does not strip markdown fences around otherwise valid JSON', () => {
    const fenced = ['```json', JSON.stringify(fakeValidPlanDocument), '```'].join('\n');
    expect(parsePlannerOutput(fenced)).toMatchObject({ ok: false, code: 'MALFORMED_JSON' });
  });

  it('does not extract JSON embedded in prose', () => {
    const prose = `Here is the plan: ${JSON.stringify(fakeValidPlanDocument)} — let me know.`;
    expect(parsePlannerOutput(prose)).toMatchObject({ ok: false, code: 'MALFORMED_JSON' });
  });

  it('does not coerce or repair a partially valid plan', () => {
    const partial = { ...fakeValidPlanDocument, steps: [] };
    const result = parsePlannerOutput(partial);
    expect(result.ok).toBe(false);
  });

  it('bounds the reported issue list to 100 entries of at most 1000 characters', () => {
    const noisy = {
      ...fakeValidPlanDocument,
      steps: Array.from({ length: 120 }, () => ({})),
    };
    const result = parsePlannerOutput(noisy);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.length).toBeLessThanOrEqual(100);
      for (const entry of result.issues) {
        expect(entry.length).toBeLessThanOrEqual(1000);
      }
    }
  });
});

describe('fake planning adapter to validator seam', () => {
  it('the valid scenario parses strictly and passes validatePlan', () => {
    const fixture = fakePlanningScenarioFixture('valid');
    const parsed = parsePlannerOutput(fixture.raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(validatePlan(validatorInput(parsed.plan, fixture.taskLimits))).toEqual({
      valid: true,
      issues: [],
    });
  });

  for (const fixture of fakePlanningScenarioFixtures) {
    if (fixture.expectedIssueCode === null) {
      continue;
    }
    it(`the ${fixture.scenario} scenario parses cleanly and yields ${fixture.expectedIssueCode}`, () => {
      const parsed = parsePlannerOutput(fixture.raw);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) {
        return;
      }
      const result = validatePlan(validatorInput(parsed.plan, fixture.taskLimits));
      expect(result.valid).toBe(false);
      expect(result.issues.map((issue) => issue.code)).toContain(fixture.expectedIssueCode);
    });
  }

  it('the builderWithoutQa scenario also trips the code-workflow rule', () => {
    const fixture = fakePlanningScenarioFixture('builderWithoutQa');
    const parsed = parsePlannerOutput(fixture.raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    const codes = validatePlan(validatorInput(parsed.plan, fixture.taskLimits)).issues.map(
      (issue) => issue.code,
    );
    expect(codes).toContain('BUILDER_WITHOUT_QA');
    expect(codes).toContain('CODE_WORKFLOW_INCOMPLETE');
  });

  it('the codeWorkflowIncomplete scenario isolates the code-workflow rule from QA coverage', () => {
    const fixture = fakePlanningScenarioFixture('codeWorkflowIncomplete');
    const parsed = parsePlannerOutput(fixture.raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    const codes = validatePlan(validatorInput(parsed.plan, fixture.taskLimits)).issues.map(
      (issue) => issue.code,
    );
    expect(codes).toContain('CODE_WORKFLOW_INCOMPLETE');
    expect(codes).not.toContain('BUILDER_WITHOUT_QA');
  });

  it('drives a replan sequence: cycle, schema failure, then an accepted plan', () => {
    const adapter = createFakePlanningAdapter(['dagCycle', 'schemaInvalid', 'valid']);

    const first = adapter.plan(createFakePlannerRequest({ attempt: 1 }));
    const firstParsed = parsePlannerOutput(first.raw);
    expect(firstParsed.ok).toBe(true);
    if (!firstParsed.ok) {
      return;
    }
    const firstValidation = validatePlan(
      validatorInput(firstParsed.plan, fakePlanningScenarioFixture('dagCycle').taskLimits),
    );
    expect(decideReplanning(1, firstValidation)).toMatchObject({
      action: 'replan',
      nextAttempt: 2,
    });

    const second = adapter.plan(
      createFakePlannerRequest({ attempt: 2, previousIssues: firstValidation.issues }),
    );
    expect(parsePlannerOutput(second.raw)).toMatchObject({ ok: false, code: 'SCHEMA_INVALID' });

    const third = adapter.plan(
      createFakePlannerRequest({ attempt: 3, previousIssues: firstValidation.issues }),
    );
    const thirdParsed = parsePlannerOutput(third.raw);
    expect(thirdParsed.ok).toBe(true);
    if (!thirdParsed.ok) {
      return;
    }
    const thirdValidation = validatePlan(
      validatorInput(thirdParsed.plan, fakePlanningScenarioFixture('valid').taskLimits),
    );
    expect(decideReplanning(3, thirdValidation)).toEqual({ action: 'accept' });
  });

  it('replays a single scenario for every attempt', () => {
    const adapter = createFakePlanningAdapter('valid');
    for (const attempt of [1, 2, 3] as const) {
      const previousIssues =
        attempt === 1 ? [] : [{ code: 'DAG_CYCLE' as const, path: null, message: 'cycle' }];
      const response = adapter.plan(createFakePlannerRequest({ attempt, previousIssues }));
      expect(response).toEqual({
        attempt,
        scenario: 'valid',
        raw: fakePlanningScenarioFixture('valid').raw,
      });
    }
  });

  it('rejects an empty script', () => {
    expect(() => createFakePlanningAdapter([])).toThrow(/at least one scenario/);
  });
});
