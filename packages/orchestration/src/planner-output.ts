import { orchestrationPlanDocumentSchema, type OrchestrationPlanDocument } from '@orion/contracts';

export type PlannerOutputRejectionCode =
  'MALFORMED_JSON' | 'SCHEMA_INVALID' | 'NOT_AN_OBJECT' | 'EMPTY_OUTPUT';

export interface PlannerOutputAccepted {
  readonly ok: true;
  readonly plan: OrchestrationPlanDocument;
}

export interface PlannerOutputRejected {
  readonly ok: false;
  readonly code: PlannerOutputRejectionCode;
  readonly issues: readonly string[];
}

export type PlannerOutputParseResult = PlannerOutputAccepted | PlannerOutputRejected;

const MAX_ISSUES = 100;
const MAX_ISSUE_LENGTH = 1000;

function reject(
  code: PlannerOutputRejectionCode,
  issues: readonly string[],
): PlannerOutputRejected {
  return {
    code,
    ok: false,
    issues: issues.slice(0, MAX_ISSUES).map((entry) => entry.slice(0, MAX_ISSUE_LENGTH)),
  };
}

/**
 * Parses raw planner output into an `OrchestrationPlanDocument`.
 *
 * Planner output is UNTRUSTED (prompt §8.5): this function never strips markdown
 * fences, never extracts JSON out of surrounding prose, never repairs malformed
 * JSON, and never coerces field types. Anything that does not already satisfy the
 * strict schema is rejected, so a partially valid plan can never be accepted.
 */
export function parsePlannerOutput(raw: unknown): PlannerOutputParseResult {
  if (raw === undefined) {
    return reject('EMPTY_OUTPUT', ['Planner produced no output.']);
  }

  let value: unknown = raw;
  if (typeof raw === 'string') {
    if (raw.trim().length === 0) {
      return reject('EMPTY_OUTPUT', ['Planner produced empty output.']);
    }
    try {
      value = JSON.parse(raw);
    } catch {
      return reject('MALFORMED_JSON', ['Planner output is not valid JSON.']);
    }
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return reject('NOT_AN_OBJECT', ['Planner output is not a JSON object.']);
  }

  const parsed = orchestrationPlanDocumentSchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`,
    );
    return reject('SCHEMA_INVALID', issues);
  }

  return { ok: true, plan: parsed.data };
}
