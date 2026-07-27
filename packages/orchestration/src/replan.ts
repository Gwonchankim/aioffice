import type { PlanValidationIssue } from '@orion/contracts';

import type { PlanValidationResult } from './plan-validator.js';

export type PlanningAttempt = 1 | 2 | 3;

export type ReplanDecision =
  | { readonly action: 'accept' }
  | {
      readonly action: 'replan';
      readonly nextAttempt: PlanningAttempt;
      readonly issues: PlanValidationIssue[];
    }
  | { readonly action: 'fail'; readonly issues: PlanValidationIssue[] };

/**
 * PLN-019: at most 2 replanning attempts follow the initial plan (3 total
 * planning_runs per task: attempt 1, 2, 3). A valid plan is always accepted;
 * an invalid plan on attempt < 3 triggers another replan; attempt 3 failing
 * validation fails the task outright.
 */
export function decideReplanning(
  attempt: PlanningAttempt,
  validation: PlanValidationResult,
): ReplanDecision {
  if (validation.valid) {
    return { action: 'accept' };
  }
  if (attempt < 3) {
    return {
      action: 'replan',
      nextAttempt: (attempt + 1) as PlanningAttempt,
      issues: validation.issues,
    };
  }
  return { action: 'fail', issues: validation.issues };
}
