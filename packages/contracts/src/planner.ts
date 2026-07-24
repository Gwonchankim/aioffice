import { z } from 'zod';

import { nfcStringSchema, sha256HexSchema, ulidSchema, utcIso8601Schema } from './base.js';
import { providerSchema } from './agent-profile.js';
import { fallbackReasonCodeSchema } from './model-registry.js';

export const planningRunStatusSchema = z.enum(['running', 'succeeded', 'failed']);

export const planningRunSchema = z
  .object({
    id: ulidSchema,
    taskId: ulidSchema,
    attempt: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    provider: providerSchema,
    model: nfcStringSchema(1, 128),
    profileSnapshotSha256: sha256HexSchema,
    status: planningRunStatusSchema,
    fallbackReason: fallbackReasonCodeSchema.nullable(),
    createdAt: utcIso8601Schema,
    completedAt: utcIso8601Schema.nullable(),
  })
  .strict()
  .superRefine((run, context) => {
    if (run.status === 'running' && run.completedAt !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Running planning runs cannot have a completion timestamp.',
        path: ['completedAt'],
      });
    }
    if (run.status !== 'running' && run.completedAt === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Completed planning runs require a completion timestamp.',
        path: ['completedAt'],
      });
    }
  });

export const planValidationIssueCodeSchema = z.enum([
  'DUPLICATE_STEP_ID',
  'MISSING_DEPENDENCY',
  'DAG_CYCLE',
  'UNKNOWN_AGENT',
  'DISABLED_AGENT',
  'UNAVAILABLE_AGENT',
  'EXECUTION_MODE_PERMISSION_MISMATCH',
  'PROVIDER_POLICY_VIOLATION',
  'CLASSIFICATION_TRANSFER_VIOLATION',
  'RUN_LIMIT_EXCEEDED',
  'FINAL_SYNTHESIS_MISSING',
  'FINAL_SYNTHESIS_INCOMPLETE_DEPENDENCIES',
  'BUILDER_WITHOUT_QA',
  'EXTERNAL_ACTION_WITHOUT_APPROVAL',
  'CODE_WORKFLOW_INCOMPLETE',
  'COATING_CROSS_REVIEW_MISSING',
  'REGULATORY_REVIEW_MISSING',
  'FINANCIAL_REVIEW_MISSING',
  'INFRASTRUCTURE_REVIEW_MISSING',
  'EXCESSIVE_AGENT_SELECTION',
]);

export const planValidationIssueSchema = z
  .object({
    code: planValidationIssueCodeSchema,
    path: nfcStringSchema(1, 256).nullable(),
    message: nfcStringSchema(1, 1000),
  })
  .strict();

export type PlanningRunStatus = z.infer<typeof planningRunStatusSchema>;
export type PlanningRun = z.infer<typeof planningRunSchema>;
export type PlanValidationIssueCode = z.infer<typeof planValidationIssueCodeSchema>;
export type PlanValidationIssue = z.infer<typeof planValidationIssueSchema>;
