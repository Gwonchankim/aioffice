import { z } from 'zod';

import { nonNegativeSafeIntegerSchema } from './base.js';

export const schedulerLimitsSchema = z
  .object({
    globalHardCap: z.literal(8),
    providerSoftCap: z.literal(4),
    providerBorrowMax: z.literal(6),
    writeIntegrationHardCap: z.literal(4),
    taskIntegrationCap: z.literal(1),
    taskDeadlineMinutes: z.literal(120),
    taskRunHardLimit: z.literal(60),
    stepAttemptMax: z.literal(3),
    transientRetryMax: z.literal(2),
    transientBackoffMs: z.tuple([z.literal(30000), z.literal(120000)]),
    stalledAfterMs: z.literal(120000),
  })
  .strict();

export const defaultSchedulerLimits: z.infer<typeof schedulerLimitsSchema> = {
  globalHardCap: 8,
  providerSoftCap: 4,
  providerBorrowMax: 6,
  writeIntegrationHardCap: 4,
  taskIntegrationCap: 1,
  taskDeadlineMinutes: 120,
  taskRunHardLimit: 60,
  stepAttemptMax: 3,
  transientRetryMax: 2,
  transientBackoffMs: [30000, 120000],
  stalledAfterMs: 120000,
};

export const resourceSnapshotSchema = z
  .object({
    memoryUsedPercent: z.number().finite().min(0).max(100),
    freeMemoryBytes: nonNegativeSafeIntegerSchema,
    freeDiskBytes: nonNegativeSafeIntegerSchema,
  })
  .strict();

export const stepPriorityTierSchema = z.enum([
  'approval_release',
  'integration',
  'verification',
  'builder',
  'advisor',
]);

export type SchedulerLimits = z.infer<typeof schedulerLimitsSchema>;
export type ResourceSnapshot = z.infer<typeof resourceSnapshotSchema>;
export type StepPriorityTier = z.infer<typeof stepPriorityTierSchema>;
