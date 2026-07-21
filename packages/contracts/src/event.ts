import { z } from 'zod';

import { nonNegativeSafeIntegerSchema, ulidSchema, utcIso8601Schema } from './base.js';
import { providerSchema } from './agent-profile.js';

export const eventTypeSchema = z.enum([
  'task.status',
  'step.status',
  'run.started',
  'run.output.delta',
  'run.tool.started',
  'run.tool.completed',
  'run.usage',
  'run.retry',
  'run.model_fallback',
  'approval.requested',
  'artifact.created',
  'git.commit',
  'test.result',
  'run.completed',
  'run.failed',
  'run.cancelled',
  'registry.source_registered',
  'registry.source_updated',
  'registry.source_queried',
  'registry.excerpt_fetched',
  'registry.source_lifecycle_changed',
  'registry.source_request_created',
  'registry.source_request_resolved',
  'registry.source_request_cancelled',
  'registry.source_lookup_not_found',
]);

type EventJsonValue =
  string | number | boolean | null | EventJsonValue[] | { [key: string]: EventJsonValue };

const eventJsonValueSchema: z.ZodType<EventJsonValue> = z.lazy(() =>
  z.union([
    z.string().max(4096),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(eventJsonValueSchema).max(100),
    z.record(eventJsonValueSchema),
  ]),
);

const forbiddenPayloadKeys = new Set([
  'rawcontent',
  'rawexcerpt',
  'credential',
  'credentials',
  'token',
  'secret',
  'password',
  'authorization',
  'cookie',
  'prompt',
  'toollog',
  'stderr',
]);

function containsForbiddenPayloadKey(value: EventJsonValue): boolean {
  if (Array.isArray(value)) {
    return value.some(containsForbiddenPayloadKey);
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).some(
      ([key, nested]) =>
        forbiddenPayloadKeys.has(key.toLowerCase()) || containsForbiddenPayloadKey(nested),
    );
  }
  return false;
}

export const eventPayloadSchema = z.record(eventJsonValueSchema).superRefine((payload, context) => {
  if (containsForbiddenPayloadKey(payload)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Event payloads cannot contain raw or credential-bearing fields.',
    });
  }
});

export const eventSchema = z
  .object({
    id: ulidSchema,
    taskId: ulidSchema,
    stepId: ulidSchema.nullable(),
    runId: ulidSchema.nullable(),
    provider: providerSchema.or(z.literal('system')).nullable(),
    type: eventTypeSchema,
    timestamp: utcIso8601Schema,
    payload: eventPayloadSchema,
    taskSequence: nonNegativeSafeIntegerSchema.min(1),
    runSequence: nonNegativeSafeIntegerSchema.min(1).nullable(),
  })
  .strict()
  .superRefine((event, context) => {
    if (event.runId === null && event.runSequence !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Events without a run cannot have a run sequence.',
        path: ['runSequence'],
      });
    }
    if (event.runId !== null && event.runSequence === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Run events require a run sequence.',
        path: ['runSequence'],
      });
    }
  });

export type EventType = z.infer<typeof eventTypeSchema>;
export type EventPayload = z.infer<typeof eventPayloadSchema>;
export type Event = z.infer<typeof eventSchema>;
