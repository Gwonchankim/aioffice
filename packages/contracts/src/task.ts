import { z } from 'zod';

import {
  nfcStringSchema,
  normalizedUniqueStringArraySchema,
  positiveSafeIntegerSchema,
  ulidSchema,
  utcIso8601Schema,
} from './base.js';

export const taskStatusSchema = z.enum([
  'draft',
  'planning',
  'queued',
  'running',
  'waiting_approval',
  'succeeded',
  'failed',
  'cancelled',
  'limit_reached',
]);

const taskTitleSchema = nfcStringSchema(1, 200);
const taskObjectiveSchema = nfcStringSchema(1, 4000);
const successCriteriaSchema = normalizedUniqueStringArraySchema(1, 20, 1, 1000);
const inputArtifactIdsSchema = z
  .array(ulidSchema)
  .max(100)
  .superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Input artifact IDs must be unique.',
      });
    }
  });
const requestedAgentIdsSchema = normalizedUniqueStringArraySchema(1, 18, 1, 32);

export const taskInputSchema = z
  .object({
    projectId: ulidSchema,
    title: taskTitleSchema,
    objective: taskObjectiveSchema,
    successCriteria: successCriteriaSchema,
    inputArtifactIds: inputArtifactIdsSchema,
    maxDurationMinutes: positiveSafeIntegerSchema.max(120),
    maxAgentRuns: positiveSafeIntegerSchema.max(60),
    requestedAgentIds: requestedAgentIdsSchema.optional(),
  })
  .strict();

export const taskSchema = z
  .object({
    id: ulidSchema,
    ...taskInputSchema.shape,
    status: taskStatusSchema,
    createdAt: utcIso8601Schema,
    updatedAt: utcIso8601Schema,
    completedAt: utcIso8601Schema.nullable(),
  })
  .strict()
  .superRefine((task, context) => {
    const terminal = new Set(['succeeded', 'failed', 'cancelled', 'limit_reached']);
    if (terminal.has(task.status) && task.completedAt === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Terminal tasks require a completion timestamp.',
        path: ['completedAt'],
      });
    }
    if (!terminal.has(task.status) && task.completedAt !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Nonterminal tasks cannot have a completion timestamp.',
        path: ['completedAt'],
      });
    }
  });

export type TaskStatus = z.infer<typeof taskStatusSchema>;
export type TaskInput = z.infer<typeof taskInputSchema>;
export type Task = z.infer<typeof taskSchema>;
