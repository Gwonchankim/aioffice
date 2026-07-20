import { z } from 'zod';

const utcIso8601Schema = z.string().datetime({ offset: false });
const nonNegativeIntegerSchema = z.number().finite().int().nonnegative();

export const overallHealthStatusSchema = z.enum(['healthy', 'degraded', 'unhealthy']);
export const databaseHealthStatusSchema = z.enum(['ok', 'not_initialized', 'error']);
export const schedulerHealthStatusSchema = z.enum(['ok', 'not_initialized', 'error']);
export const retentionHealthStatusSchema = z.enum(['ok', 'not_initialized', 'error']);

export const healthMetaSchema = z
  .object({
    requestId: z.string().regex(/^[0-7][0-9A-HJKMNPQRSTVWXYZ]{25}$/),
    timestamp: utcIso8601Schema,
  })
  .strict();

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
    freeDiskBytes: z.number().finite().int().safe().nonnegative(),
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

export const successEnvelopeSchema = <DataSchema extends z.ZodTypeAny>(data: DataSchema) =>
  z
    .object({
      data,
      meta: healthMetaSchema,
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
