import { z } from 'zod';

import { agentProfileSkeletonSchema, providerSchema } from './agent-profile.js';
import {
  nfcStringSchema,
  positiveSafeIntegerSchema,
  ulidSchema,
  utcIso8601Schema,
} from './base.js';

export const runStatusSchema = z.enum([
  'starting',
  'running',
  'stalled',
  'succeeded',
  'failed',
  'timed_out',
  'cancelled',
  'interrupted',
]);

export const runSchema = z
  .object({
    id: ulidSchema,
    stepId: ulidSchema,
    attempt: positiveSafeIntegerSchema.max(3),
    provider: providerSchema,
    model: nfcStringSchema(1, 128),
    agentProfileSnapshot: agentProfileSkeletonSchema,
    status: runStatusSchema,
    sessionId: nfcStringSchema(1, 256).nullable(),
    createdAt: utcIso8601Schema,
    startedAt: utcIso8601Schema.nullable(),
    completedAt: utcIso8601Schema.nullable(),
  })
  .strict()
  .superRefine((run, context) => {
    const terminal = new Set(['succeeded', 'failed', 'timed_out', 'cancelled', 'interrupted']);
    if (terminal.has(run.status) && run.completedAt === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Terminal runs require a completion timestamp.',
        path: ['completedAt'],
      });
    }
    if (!terminal.has(run.status) && run.completedAt !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Nonterminal runs cannot have a completion timestamp.',
        path: ['completedAt'],
      });
    }
    if (run.startedAt !== null && run.startedAt < run.createdAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Run start time cannot precede creation.',
        path: ['startedAt'],
      });
    }
    if (run.startedAt !== null && run.completedAt !== null && run.completedAt < run.startedAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Run completion cannot precede start.',
        path: ['completedAt'],
      });
    }
  });

export type RunStatus = z.infer<typeof runStatusSchema>;
export type Run = z.infer<typeof runSchema>;
