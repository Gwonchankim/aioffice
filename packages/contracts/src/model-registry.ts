import { z } from 'zod';

import { nfcStringSchema } from './base.js';
import { providerSchema } from './agent-profile.js';

export const modelStatusSchema = z.enum(['available', 'unavailable', 'incompatible']);

export const providerModelStateSchema = z
  .object({
    provider: providerSchema,
    model: nfcStringSchema(1, 128),
    status: modelStatusSchema,
  })
  .strict();

export const fallbackReasonCodeSchema = z.enum([
  'MODEL_UNAVAILABLE',
  'PROVIDER_OVERLOADED',
  'QUOTA_EXHAUSTED',
  'CAPABILITY_MISMATCH',
  'SAFEGUARD_REFUSAL',
  'CLASSIFICATION_POLICY_BLOCKED',
]);

export const modelSelectionSchema = z
  .object({
    provider: providerSchema,
    model: nfcStringSchema(1, 128),
    viaFallback: z.boolean(),
    fallbackReasonCode: fallbackReasonCodeSchema.nullable(),
    fromProvider: providerSchema.nullable(),
    fromModel: nfcStringSchema(1, 128).nullable(),
  })
  .strict()
  .superRefine((selection, context) => {
    const fields = [
      ['fallbackReasonCode', selection.fallbackReasonCode],
      ['fromProvider', selection.fromProvider],
      ['fromModel', selection.fromModel],
    ] as const;

    if (!selection.viaFallback) {
      for (const [path, value] of fields) {
        if (value !== null) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Non-fallback selections cannot carry fallback provenance fields.',
            path: [path],
          });
        }
      }
      return;
    }

    for (const [path, value] of fields) {
      if (value === null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Fallback selections require every fallback provenance field.',
          path: [path],
        });
      }
    }
  });

export type ModelStatus = z.infer<typeof modelStatusSchema>;
export type ProviderModelState = z.infer<typeof providerModelStateSchema>;
export type FallbackReasonCode = z.infer<typeof fallbackReasonCodeSchema>;
export type ModelSelection = z.infer<typeof modelSelectionSchema>;
