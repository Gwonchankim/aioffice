import { z } from 'zod';

import { dataClassificationSchema, nfcStringSchema, projectKeySchema, ulidSchema } from './base.js';

export const arcaRequesterSchema = z
  .object({
    requesterId: nfcStringSchema(1, 128),
    requesterRole: nfcStringSchema(1, 128),
    purpose: nfcStringSchema(1, 500),
  })
  .strict();

export const arcaInvocationSchema = z
  .object({
    projectKey: projectKeySchema,
    requester: arcaRequesterSchema,
    request: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('query'),
          query: nfcStringSchema(1, 500),
        })
        .strict(),
      z
        .object({
          kind: z.literal('source'),
          sourceId: ulidSchema,
          range: nfcStringSchema(1, 200).nullable(),
        })
        .strict(),
    ]),
  })
  .strict();

export const arcaInvocationResultSchema = z
  .object({
    status: z.enum(['found', 'missing', 'stale']),
    sourceId: ulidSchema.nullable(),
    title: nfcStringSchema(1, 500).nullable(),
    version: nfcStringSchema(1, 128).nullable(),
    locator: nfcStringSchema(1, 2048).nullable(),
    owner: nfcStringSchema(1, 128).nullable(),
    classification: dataClassificationSchema.nullable(),
    confidence: z.number().min(0).max(1).nullable(),
    nextAction: nfcStringSchema(1, 500).nullable(),
  })
  .strict()
  .superRefine((result, context) => {
    if (result.status !== 'missing') {
      return;
    }
    const protectedFields = [
      ['sourceId', result.sourceId],
      ['title', result.title],
      ['version', result.version],
      ['locator', result.locator],
      ['owner', result.owner],
      ['classification', result.classification],
      ['confidence', result.confidence],
    ] as const;
    for (const [path, value] of protectedFields) {
      if (value !== null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Missing results cannot disclose protected fields.',
          path: [path],
        });
      }
    }
  });

export const arcaScopeDenialSchema = z
  .object({
    code: z.literal('PERMISSION_DENIED'),
    stage: z.literal('registry-scope'),
    sourceIndependent: z.literal(true),
  })
  .strict();

export type ArcaRequester = z.infer<typeof arcaRequesterSchema>;
export type ArcaInvocation = z.infer<typeof arcaInvocationSchema>;
export type ArcaInvocationResult = z.infer<typeof arcaInvocationResultSchema>;
export type ArcaScopeDenial = z.infer<typeof arcaScopeDenialSchema>;
