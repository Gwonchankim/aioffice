import { z } from 'zod';

import {
  agentIdSchema,
  dataClassificationSchema,
  nfcStringSchema,
  nonNegativeSafeIntegerSchema,
  normalizedUniqueStringArraySchema,
  positiveSafeIntegerSchema,
  sha256HexSchema,
  ulidSchema,
  utcIso8601Schema,
} from './base.js';
import { permissionTemplateSchema, providerSchema } from './agent-profile.js';
import { fallbackReasonCodeSchema } from './model-registry.js';
import { executionModeSchema } from './plan.js';
import { providerPolicySchema } from './project.js';

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

const agentIdListSchema = normalizedUniqueStringArraySchema(1, 18, 1, 32).superRefine(
  (values, context) => {
    for (const [index, value] of values.entries()) {
      if (!agentIdSchema.safeParse(value).success) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Expected a catalog agent ID.',
          path: [index],
        });
      }
    }
  },
);

export const plannerTaskRequestSchema = z
  .object({
    taskId: ulidSchema,
    title: nfcStringSchema(1, 200),
    objective: nfcStringSchema(1, 4000),
    successCriteria: normalizedUniqueStringArraySchema(1, 20, 1, 1000),
    tags: normalizedUniqueStringArraySchema(0, 16, 1, 32),
    maxDurationMinutes: positiveSafeIntegerSchema.max(120),
    maxAgentRuns: positiveSafeIntegerSchema.max(60),
    requestedAgentIds: agentIdListSchema.optional(),
  })
  .strict();

export const plannerAgentDescriptorSchema = z
  .object({
    id: agentIdSchema,
    version: positiveSafeIntegerSchema,
    name: nfcStringSchema(1, 40),
    displayName: nfcStringSchema(1, 100),
    description: nfcStringSchema(20, 500),
    enabled: z.boolean(),
    permissionTemplate: permissionTemplateSchema,
    provider: providerSchema,
    model: nfcStringSchema(1, 128),
    allowedExecutionModes: z
      .array(executionModeSchema)
      .min(1)
      .max(5)
      .superRefine((values, context) => {
        if (new Set(values).size !== values.length) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Allowed execution modes must be unique.',
          });
        }
      }),
    capabilities: normalizedUniqueStringArraySchema(1, 32, 1, 64),
    triggers: normalizedUniqueStringArraySchema(0, 32, 1, 100),
    exclusions: normalizedUniqueStringArraySchema(0, 32, 1, 200),
    requiredCollaborators: z
      .array(agentIdSchema)
      .max(8)
      .superRefine((values, context) => {
        if (new Set(values).size !== values.length) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Required collaborators must be unique.',
          });
        }
      }),
  })
  .strict();

export const plannerProjectPolicySchema = z
  .object({
    classification: dataClassificationSchema,
    providerPolicy: providerPolicySchema,
    allowedAgentIds: agentIdListSchema,
  })
  .strict();

export const plannerLimitsSchema = z
  .object({
    maxAgentRuns: positiveSafeIntegerSchema.max(60),
    existingRunCount: nonNegativeSafeIntegerSchema,
    remainingRuns: nonNegativeSafeIntegerSchema,
  })
  .strict()
  .superRefine((limits, context) => {
    const expected = Math.max(0, limits.maxAgentRuns - limits.existingRunCount);
    if (limits.remainingRuns !== expected) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Remaining runs must equal max(0, maxAgentRuns - existingRunCount) = ${expected}.`,
        path: ['remainingRuns'],
      });
    }
  });

export const plannerRequestSchema = z
  .object({
    attempt: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    task: plannerTaskRequestSchema,
    project: plannerProjectPolicySchema,
    agents: z.array(plannerAgentDescriptorSchema).min(1).max(18),
    limits: plannerLimitsSchema,
    previousIssues: z.array(planValidationIssueSchema).max(100),
  })
  .strict()
  .superRefine((request, context) => {
    const seen = new Set<string>();
    for (const [index, agent] of request.agents.entries()) {
      if (seen.has(agent.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Planner agent descriptors must be unique by ID.',
          path: ['agents', index, 'id'],
        });
      }
      seen.add(agent.id);
    }

    if (request.attempt === 1 && request.previousIssues.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'The first planning attempt cannot carry previous validation issues.',
        path: ['previousIssues'],
      });
    }
    if (request.attempt > 1 && request.previousIssues.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A replan attempt requires the previous validation issues it must fix.',
        path: ['previousIssues'],
      });
    }
  });

export type PlanningRunStatus = z.infer<typeof planningRunStatusSchema>;
export type PlanningRun = z.infer<typeof planningRunSchema>;
export type PlanValidationIssueCode = z.infer<typeof planValidationIssueCodeSchema>;
export type PlanValidationIssue = z.infer<typeof planValidationIssueSchema>;
export type PlannerTaskRequest = z.infer<typeof plannerTaskRequestSchema>;
export type PlannerAgentDescriptor = z.infer<typeof plannerAgentDescriptorSchema>;
export type PlannerProjectPolicy = z.infer<typeof plannerProjectPolicySchema>;
export type PlannerLimits = z.infer<typeof plannerLimitsSchema>;
export type PlannerRequest = z.infer<typeof plannerRequestSchema>;
