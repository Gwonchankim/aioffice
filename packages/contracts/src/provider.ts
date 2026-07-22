import { z } from 'zod';

import { agentProfileSkeletonSchema, providerSchema } from './agent-profile.js';
import {
  absolutePathSchema,
  nfcStringSchema,
  nonNegativeSafeIntegerSchema,
  normalizedUniqueStringArraySchema,
  positiveSafeIntegerSchema,
  ulidSchema,
  utcIso8601Schema,
} from './base.js';
import { allowedCommandsSchema } from './project.js';

const boundedTextSchema = (minimum: number, maximum: number) => nfcStringSchema(minimum, maximum);

const environmentVariableNameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/, 'Expected an environment variable name.')
  .refine(
    (value) => !/(?:TOKEN|KEY|SECRET|PASSWORD|AUTHORIZATION|COOKIE|CREDENTIAL)/i.test(value),
    'Secret-shaped environment variable names are not allowed.',
  );

const sanitizedTextSchema = boundedTextSchema(1, 4096).refine(
  (value) => !/(?:\bBearer\s+|\bsk-[A-Za-z0-9_-]{8,}|-----BEGIN)/i.test(value),
  'Expected sanitized text without credential-shaped values.',
);

const providerEventIdentitySchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/, 'Expected an opaque provider event identity.');

const sessionIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/, 'Expected an opaque persisted session ID.');

export const providerExecutionModeSchema = z.enum([
  'read_only',
  'artifact_write',
  'worktree_write',
  'integration',
  'external_action',
]);

export const agentRunRequestSchema = z
  .object({
    runId: ulidSchema,
    taskId: ulidSchema,
    stepId: ulidSchema,
    agentProfileSnapshot: agentProfileSkeletonSchema,
    provider: providerSchema,
    model: boundedTextSchema(1, 128),
    prompt: boundedTextSchema(1, 100_000),
    cwd: absolutePathSchema,
    executionMode: providerExecutionModeSchema,
    outputSchemaPath: absolutePathSchema,
    allowedTools: normalizedUniqueStringArraySchema(0, 64, 1, 128),
    allowedCommands: allowedCommandsSchema,
    timeoutAt: utcIso8601Schema,
    environmentVariableNames: z
      .array(environmentVariableNameSchema)
      .max(64)
      .superRefine((values, context) => {
        const seen = new Set<string>();
        for (const [index, value] of values.entries()) {
          if (seen.has(value)) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              message: 'Environment variable names must be unique.',
              path: [index],
            });
          }
          seen.add(value);
        }
      }),
  })
  .strict();

export const resumeRunRequestSchema = agentRunRequestSchema
  .extend({ sessionId: sessionIdSchema })
  .strict();

export const runResultStatusSchema = z.enum(['succeeded', 'failed', 'needs_attention']);
export const findingSeveritySchema = z.enum(['info', 'low', 'medium', 'high', 'critical']);

export const runResultSchema = z
  .object({
    status: runResultStatusSchema,
    summary: boundedTextSchema(1, 20_000),
    findings: z
      .array(
        z
          .object({
            severity: findingSeveritySchema,
            text: boundedTextSchema(1, 8_000),
            evidence: boundedTextSchema(1, 8_000).optional(),
          })
          .strict(),
      )
      .max(500),
    artifacts: z
      .array(
        z
          .object({
            kind: boundedTextSchema(1, 128),
            path: boundedTextSchema(1, 2_048).optional(),
            title: boundedTextSchema(1, 256),
            description: boundedTextSchema(1, 4_096).optional(),
          })
          .strict(),
      )
      .max(500),
    changes: z
      .array(
        z
          .object({
            commitSha: z
              .string()
              .regex(/^[a-f0-9]{40}$/, 'Expected a lowercase Git SHA.')
              .optional(),
            files: normalizedUniqueStringArraySchema(0, 2_000, 1, 2_048),
            description: boundedTextSchema(1, 8_000),
          })
          .strict(),
      )
      .max(500),
    tests: z
      .array(
        z
          .object({
            command: boundedTextSchema(1, 1_024),
            status: z.enum(['passed', 'failed', 'not_run']),
            summary: boundedTextSchema(1, 8_000),
          })
          .strict(),
      )
      .max(500),
    risks: normalizedUniqueStringArraySchema(0, 500, 1, 4_096),
    handoff: boundedTextSchema(1, 20_000),
  })
  .strict();

export const providerHealthStatusSchema = z.enum([
  'ready',
  'not_installed',
  'unsupported',
  'unauthenticated',
  'untested',
  'policy_review_required',
  'error',
]);

export const providerHealthSchema = z
  .object({
    provider: providerSchema,
    installed: z.boolean(),
    cliVersion: boundedTextSchema(1, 128).nullable(),
    authenticated: z.boolean(),
    status: providerHealthStatusSchema,
    supportedModels: normalizedUniqueStringArraySchema(0, 128, 1, 128),
    lastCheckedAt: utcIso8601Schema,
    sanitizedError: sanitizedTextSchema.nullable(),
  })
  .strict()
  .superRefine((health, context) => {
    if (!health.installed) {
      if (health.cliVersion !== null || health.authenticated || health.supportedModels.length > 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'An uninstalled provider cannot expose version, authentication, or models.',
        });
      }
      if (health.status !== 'not_installed') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'An uninstalled provider must have not_installed status.',
          path: ['status'],
        });
      }
    }
    if (health.status === 'ready') {
      if (!health.installed || !health.authenticated || health.cliVersion === null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'A ready provider must be installed, authenticated, and versioned.',
        });
      }
      if (health.supportedModels.length === 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'A ready provider must expose at least one supported model.',
          path: ['supportedModels'],
        });
      }
    }
    if (health.status === 'unauthenticated' && health.authenticated) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'An unauthenticated provider cannot be authenticated.',
        path: ['authenticated'],
      });
    }
  });

export const providerCapabilityNameSchema = z.enum([
  'jsonl',
  'stream_json',
  'output_schema',
  'resume',
  'sandbox',
  'permission_mode',
]);

export const providerCapabilitySchema = z
  .object({
    name: providerCapabilityNameSchema,
    supported: z.boolean(),
  })
  .strict();

export const providerInspectionSchema = z
  .object({
    provider: providerSchema,
    health: providerHealthSchema,
    capabilities: z.array(providerCapabilitySchema).max(16),
  })
  .strict()
  .superRefine((inspection, context) => {
    if (inspection.provider !== inspection.health.provider) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Inspection and health providers must match.',
        path: ['health', 'provider'],
      });
    }
    const capabilities = new Set<string>();
    for (const [index, capability] of inspection.capabilities.entries()) {
      if (capabilities.has(capability.name)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Capabilities must be unique.',
          path: ['capabilities', index, 'name'],
        });
      }
      capabilities.add(capability.name);
    }
  });

export const providerDiagnosticsSchema = z
  .object({
    invalidFrameCount: nonNegativeSafeIntegerSchema,
    consecutiveInvalidFrameCount: nonNegativeSafeIntegerSchema.max(5),
    unknownEventCount: nonNegativeSafeIntegerSchema,
    stderrBytes: nonNegativeSafeIntegerSchema,
    stderrOmittedBytes: nonNegativeSafeIntegerSchema,
    sanitizedMessage: sanitizedTextSchema.optional(),
  })
  .strict()
  .superRefine((diagnostics, context) => {
    if (diagnostics.consecutiveInvalidFrameCount > diagnostics.invalidFrameCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Consecutive invalid frames cannot exceed all invalid frames.',
        path: ['consecutiveInvalidFrameCount'],
      });
    }
    if (diagnostics.stderrOmittedBytes > diagnostics.stderrBytes) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Omitted stderr bytes cannot exceed observed stderr bytes.',
        path: ['stderrOmittedBytes'],
      });
    }
  });

export const providerRunEventTypeSchema = z.enum([
  'run.started',
  'run.output.delta',
  'run.tool.started',
  'run.tool.completed',
  'run.usage',
  'run.retry',
  'run.completed',
  'run.failed',
  'run.cancelled',
]);

export const providerProcessErrorCodeSchema = z.enum([
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_AUTH_REQUIRED',
  'PROVIDER_UNSUPPORTED',
  'PROVIDER_POLICY_REVIEW_REQUIRED',
  'PROVIDER_THROTTLED',
  'MODEL_UNAVAILABLE',
  'ADAPTER_PROTOCOL_ERROR',
  'OUTPUT_SCHEMA_INVALID',
  'PROCESS_CRASHED',
  'RUN_TIMED_OUT',
  'PROVIDER_EXECUTION_FAILED',
]);

const runEventDiagnosticsSchema = providerDiagnosticsSchema.optional();
const runEventEnvelopeFields = {
  schemaVersion: z.literal(1),
  id: ulidSchema,
  sequence: positiveSafeIntegerSchema,
  taskId: ulidSchema,
  stepId: ulidSchema,
  runId: ulidSchema,
  provider: providerSchema,
  timestamp: utcIso8601Schema,
  diagnostics: runEventDiagnosticsSchema,
};

const adapterEventEnvelopeFields = {
  providerEventId: providerEventIdentitySchema.optional(),
  diagnostics: providerDiagnosticsSchema,
};

const runStartedPayloadSchema = z
  .object({
    attempt: positiveSafeIntegerSchema.max(3),
    provider: providerSchema,
    model: boundedTextSchema(1, 128),
    profileVersion: positiveSafeIntegerSchema,
    sessionId: sessionIdSchema.optional(),
  })
  .strict();

const outputDeltaPayloadSchema = z
  .object({
    channel: z.enum(['summary', 'raw']),
    text: boundedTextSchema(1, 16_384),
  })
  .strict();

const toolStartedPayloadSchema = z
  .object({
    toolName: boundedTextSchema(1, 128),
    sanitizedInput: sanitizedTextSchema,
    externalMutation: z.boolean(),
  })
  .strict();

const toolCompletedPayloadSchema = z
  .object({
    toolName: boundedTextSchema(1, 128),
    status: z.enum(['succeeded', 'failed', 'cancelled']),
    durationMs: nonNegativeSafeIntegerSchema,
    sanitizedOutput: sanitizedTextSchema.optional(),
  })
  .strict();

const usagePayloadSchema = z
  .object({
    inputTokens: nonNegativeSafeIntegerSchema.optional(),
    outputTokens: nonNegativeSafeIntegerSchema.optional(),
    cacheTokens: nonNegativeSafeIntegerSchema.optional(),
    durationMs: nonNegativeSafeIntegerSchema.optional(),
    reportedCost: z.number().finite().nonnegative().optional(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/, 'Expected an ISO 4217 currency code.')
      .optional(),
  })
  .strict()
  .superRefine((usage, context) => {
    if (
      usage.inputTokens === undefined &&
      usage.outputTokens === undefined &&
      usage.cacheTokens === undefined &&
      usage.durationMs === undefined &&
      usage.reportedCost === undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Usage must include at least one reported value.',
      });
    }
    if ((usage.reportedCost === undefined) !== (usage.currency === undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Reported cost and currency must be supplied together.',
      });
    }
  });

const retryPayloadSchema = z
  .object({
    attempt: positiveSafeIntegerSchema.max(3),
    delayMs: nonNegativeSafeIntegerSchema,
    reasonCode: providerProcessErrorCodeSchema,
  })
  .strict();

const completedPayloadSchema = z
  .object({
    status: z.literal('succeeded'),
    resultArtifactId: ulidSchema,
    durationMs: nonNegativeSafeIntegerSchema,
  })
  .strict();

const failedPayloadSchema = z
  .object({
    errorCode: providerProcessErrorCodeSchema,
    retryable: z.boolean(),
    sanitizedMessage: sanitizedTextSchema,
    diagnosticArtifactId: ulidSchema.optional(),
  })
  .strict();

const cancelledPayloadSchema = z
  .object({
    requestedBy: z.enum(['user', 'system']),
    reason: sanitizedTextSchema,
  })
  .strict();

const createRunEventSchema = <
  EventType extends z.infer<typeof providerRunEventTypeSchema>,
  PayloadSchema extends z.ZodTypeAny,
>(
  type: EventType,
  payload: PayloadSchema,
) =>
  z
    .object({
      ...runEventEnvelopeFields,
      type: z.literal(type),
      payload,
    })
    .strict();

const createAdapterEventSchema = <
  EventType extends z.infer<typeof providerRunEventTypeSchema>,
  PayloadSchema extends z.ZodTypeAny,
>(
  type: EventType,
  payload: PayloadSchema,
) =>
  z
    .object({
      ...adapterEventEnvelopeFields,
      type: z.literal(type),
      payload,
    })
    .strict();

export const runEventSchema = z.discriminatedUnion('type', [
  createRunEventSchema('run.started', runStartedPayloadSchema),
  createRunEventSchema('run.output.delta', outputDeltaPayloadSchema),
  createRunEventSchema('run.tool.started', toolStartedPayloadSchema),
  createRunEventSchema('run.tool.completed', toolCompletedPayloadSchema),
  createRunEventSchema('run.usage', usagePayloadSchema),
  createRunEventSchema('run.retry', retryPayloadSchema),
  createRunEventSchema('run.completed', completedPayloadSchema),
  createRunEventSchema('run.failed', failedPayloadSchema),
  createRunEventSchema('run.cancelled', cancelledPayloadSchema),
]);

export const normalizedAdapterEventSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('event'),
      event: z.discriminatedUnion('type', [
        createAdapterEventSchema('run.started', runStartedPayloadSchema),
        createAdapterEventSchema('run.output.delta', outputDeltaPayloadSchema),
        createAdapterEventSchema('run.tool.started', toolStartedPayloadSchema),
        createAdapterEventSchema('run.tool.completed', toolCompletedPayloadSchema),
        createAdapterEventSchema('run.usage', usagePayloadSchema),
        createAdapterEventSchema('run.retry', retryPayloadSchema),
        createAdapterEventSchema('run.completed', completedPayloadSchema),
        createAdapterEventSchema('run.failed', failedPayloadSchema),
        createAdapterEventSchema('run.cancelled', cancelledPayloadSchema),
      ]),
    })
    .strict(),
  z
    .object({
      kind: z.literal('session'),
      sessionId: sessionIdSchema,
      diagnostics: providerDiagnosticsSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('result'),
      result: runResultSchema,
      diagnostics: providerDiagnosticsSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('diagnostic'),
      diagnostics: providerDiagnosticsSchema,
    })
    .strict(),
]);

export const runtimeHandleSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/, 'Expected an opaque runtime handle.');

export const adapterCancelRequestSchema = z.object({ runtimeHandle: runtimeHandleSchema }).strict();

export interface AgentRuntimeAdapter {
  inspect(): Promise<ProviderHealth>;
  start(request: AgentRunRequest): AsyncIterable<NormalizedAdapterEvent>;
  resume(request: ResumeRunRequest): AsyncIterable<NormalizedAdapterEvent>;
  cancel(runtimeHandle: string): Promise<void>;
}

export type ProviderExecutionMode = z.infer<typeof providerExecutionModeSchema>;
export type AgentRunRequest = z.infer<typeof agentRunRequestSchema>;
export type ResumeRunRequest = z.infer<typeof resumeRunRequestSchema>;
export type RunResult = z.infer<typeof runResultSchema>;
export type ProviderHealthStatus = z.infer<typeof providerHealthStatusSchema>;
export type ProviderHealth = z.infer<typeof providerHealthSchema>;
export type ProviderCapabilityName = z.infer<typeof providerCapabilityNameSchema>;
export type ProviderCapability = z.infer<typeof providerCapabilitySchema>;
export type ProviderInspection = z.infer<typeof providerInspectionSchema>;
export type ProviderDiagnostics = z.infer<typeof providerDiagnosticsSchema>;
export type ProviderRunEventType = z.infer<typeof providerRunEventTypeSchema>;
export type ProviderProcessErrorCode = z.infer<typeof providerProcessErrorCodeSchema>;
export type RunEvent = z.infer<typeof runEventSchema>;
export type NormalizedAdapterEvent = z.infer<typeof normalizedAdapterEventSchema>;
export type AdapterCancelRequest = z.infer<typeof adapterCancelRequestSchema>;
