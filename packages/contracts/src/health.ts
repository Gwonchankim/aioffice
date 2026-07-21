import { z } from 'zod';

import {
  nonNegativeIntegerSchema,
  nonNegativeSafeIntegerSchema,
  utcIso8601Schema,
} from './base.js';
import { responseMetaSchema, successEnvelopeSchema } from './envelope.js';

export const overallHealthStatusSchema = z.enum(['healthy', 'degraded', 'unhealthy']);
export const databaseHealthStatusSchema = z.enum(['ok', 'not_initialized', 'error']);
export const schedulerHealthStatusSchema = z.enum(['ok', 'not_initialized', 'error']);
export const retentionHealthStatusSchema = z.enum(['ok', 'not_initialized', 'error']);

export const healthMetaSchema = responseMetaSchema;

export const schedulerHealthSchema = z
  .object({
    status: schedulerHealthStatusSchema,
    active: nonNegativeIntegerSchema,
    capacity: nonNegativeIntegerSchema,
    queued: nonNegativeIntegerSchema,
  })
  .strict();

export const resourcesHealthSchema = z
  .object({
    memoryPercent: z.number().finite().min(0).max(100),
    freeDiskBytes: nonNegativeSafeIntegerSchema,
  })
  .strict();

export const retentionHealthSchema = z
  .object({
    lastRunAt: utcIso8601Schema.nullable(),
    status: retentionHealthStatusSchema,
  })
  .strict();

export const healthDataSchema = z
  .object({
    status: overallHealthStatusSchema,
    database: databaseHealthStatusSchema,
    scheduler: schedulerHealthSchema,
    resources: resourcesHealthSchema,
    retention: retentionHealthSchema,
  })
  .strict();

export const healthSuccessSchema = successEnvelopeSchema(healthDataSchema);

export type OverallHealthStatus = z.infer<typeof overallHealthStatusSchema>;
export type DatabaseHealthStatus = z.infer<typeof databaseHealthStatusSchema>;
export type SchedulerHealthStatus = z.infer<typeof schedulerHealthStatusSchema>;
export type RetentionHealthStatus = z.infer<typeof retentionHealthStatusSchema>;
export type HealthMeta = z.infer<typeof healthMetaSchema>;
export type SchedulerHealth = z.infer<typeof schedulerHealthSchema>;
export type ResourcesHealth = z.infer<typeof resourcesHealthSchema>;
export type RetentionHealth = z.infer<typeof retentionHealthSchema>;
export type HealthData = z.infer<typeof healthDataSchema>;
export type HealthSuccess = z.infer<typeof healthSuccessSchema>;
