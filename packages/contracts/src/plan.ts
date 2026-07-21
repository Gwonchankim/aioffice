import { z } from 'zod';

import {
  agentIdSchema,
  nfcStringSchema,
  normalizedUniqueStringArraySchema,
  positiveSafeIntegerSchema,
  ulidSchema,
  utcIso8601Schema,
} from './base.js';

export const stepStatusSchema = z.enum([
  'waiting',
  'ready',
  'running',
  'retry_wait',
  'waiting_approval',
  'succeeded',
  'failed',
  'skipped',
  'cancelled',
  'interrupted',
]);

export const executionModeSchema = z.enum([
  'read_only',
  'artifact_write',
  'worktree_write',
  'integration',
  'external_action',
]);

const boundedReferencesSchema = normalizedUniqueStringArraySchema(0, 100, 1, 512);
const boundedTextListSchema = normalizedUniqueStringArraySchema(0, 100, 1, 1000);

const orchestrationStepFields = {
  id: ulidSchema,
  title: nfcStringSchema(1, 200),
  agentId: agentIdSchema,
  dependsOn: z
    .array(ulidSchema)
    .max(100)
    .superRefine((values, context) => {
      if (new Set(values).size !== values.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Step dependencies must be unique.',
        });
      }
    }),
  executionMode: executionModeSchema,
  objective: nfcStringSchema(1, 4000),
  inputRefs: boundedReferencesSchema,
  expectedArtifacts: boundedTextListSchema,
  acceptanceCriteria: normalizedUniqueStringArraySchema(1, 50, 1, 1000),
  verificationCommands: boundedTextListSchema,
  maxAttempts: z.union([z.literal(1), z.literal(2), z.literal(3)]),
};

export const orchestrationStepSchema = z
  .object(orchestrationStepFields)
  .strict()
  .superRefine((step, context) => {
    if (step.dependsOn.includes(step.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A step cannot depend on itself.',
        path: ['dependsOn'],
      });
    }
  });

export const orchestrationPlanDocumentSchema = z
  .object({
    taskId: ulidSchema,
    summary: nfcStringSchema(1, 4000),
    assumptions: boundedTextListSchema,
    risks: boundedTextListSchema,
    steps: z.array(orchestrationStepSchema).min(1).max(100),
    finalSynthesisStepId: ulidSchema,
  })
  .strict()
  .superRefine((plan, context) => {
    if (!plan.steps.some((step) => step.id === plan.finalSynthesisStepId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'The final synthesis step must belong to the plan.',
        path: ['finalSynthesisStepId'],
      });
    }
  });

export const stepSchema = z
  .object({
    ...orchestrationStepFields,
    taskId: ulidSchema,
    planVersion: positiveSafeIntegerSchema,
    status: stepStatusSchema,
    createdAt: utcIso8601Schema,
    updatedAt: utcIso8601Schema,
    completedAt: utcIso8601Schema.nullable(),
  })
  .strict()
  .superRefine((step, context) => {
    const terminal = new Set(['succeeded', 'failed', 'skipped', 'cancelled']);
    if (terminal.has(step.status) && step.completedAt === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Terminal steps require a completion timestamp.',
        path: ['completedAt'],
      });
    }
    if (!terminal.has(step.status) && step.completedAt !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Nonterminal steps cannot have a completion timestamp.',
        path: ['completedAt'],
      });
    }
  });

export const storedPlanValidationSchema = z
  .object({
    valid: z.boolean(),
    issues: z.array(nfcStringSchema(1, 1000)).max(100),
  })
  .strict();

export const planSchema = z
  .object({
    taskId: ulidSchema,
    version: positiveSafeIntegerSchema,
    planJson: orchestrationPlanDocumentSchema,
    validationJson: storedPlanValidationSchema,
    createdAt: utcIso8601Schema,
  })
  .strict()
  .superRefine((plan, context) => {
    if (plan.planJson.taskId !== plan.taskId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Stored plan taskId must match its parent task.',
        path: ['planJson', 'taskId'],
      });
    }
  });

export type StepStatus = z.infer<typeof stepStatusSchema>;
export type ExecutionMode = z.infer<typeof executionModeSchema>;
export type OrchestrationStep = z.infer<typeof orchestrationStepSchema>;
export type OrchestrationPlanDocument = z.infer<typeof orchestrationPlanDocumentSchema>;
export type Step = z.infer<typeof stepSchema>;
export type Plan = z.infer<typeof planSchema>;
