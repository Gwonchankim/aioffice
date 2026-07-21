import { z } from 'zod';

import { ulidSchema, utcIso8601Schema } from './base.js';

export const responseMetaSchema = z
  .object({
    requestId: ulidSchema,
    timestamp: utcIso8601Schema,
  })
  .strict();

export const applicationErrorCodeSchema = z.enum([
  'BAD_REQUEST',
  'SESSION_REQUIRED',
  'ORIGIN_REJECTED',
  'HOST_REJECTED',
  'CSRF_REJECTED',
  'NOT_FOUND',
  'PERMISSION_DENIED',
  'VALIDATION_FAILED',
  'PLAN_VALIDATION_FAILED',
  'INVALID_STATE_TRANSITION',
  'IDEMPOTENCY_CONFLICT',
  'PROJECT_CONFLICT',
  'PROJECT_POLICY_CONFLICT',
  'REPOSITORY_MUTATED_DURING_REGISTRATION',
  'TASK_EXECUTION_CONFLICT',
  'WORKTREE_CONFLICT',
  'APPROVAL_REQUIRED',
  'TASK_LIMIT_REACHED',
  'PROVIDER_UNAVAILABLE',
  'RESOURCE_EXHAUSTED',
  'DATABASE_OPEN_FAILED',
  'DATABASE_CONFIGURATION_FAILED',
  'MIGRATION_FAILED',
  'DATABASE_UNAVAILABLE',
  'CONTROLLED_EXECUTION_BLOCKED',
  'INTERNAL_ERROR',
]);

export const errorEnvelopeSchema = z
  .object({
    error: z
      .object({
        code: applicationErrorCodeSchema,
        message: z.string().min(1).max(1024),
        details: z.unknown().optional(),
        retryable: z.boolean(),
      })
      .strict(),
    meta: responseMetaSchema,
  })
  .strict();

export const successEnvelopeSchema = <DataSchema extends z.ZodTypeAny>(data: DataSchema) =>
  z
    .object({
      data,
      meta: responseMetaSchema,
    })
    .strict();

export type ResponseMeta = z.infer<typeof responseMetaSchema>;
export type ApplicationErrorCode = z.infer<typeof applicationErrorCodeSchema>;
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;
export type SuccessEnvelope<Data> = {
  data: Data;
  meta: ResponseMeta;
};
