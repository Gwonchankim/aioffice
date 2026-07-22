import { z } from 'zod';

import { errorEnvelopeSchema, successEnvelopeSchema } from './envelope.js';
import { providerHealthSchema } from './provider.js';

export const providerHealthCollectionSchema = z
  .object({
    providers: z.array(providerHealthSchema).min(1).max(2),
  })
  .strict()
  .superRefine((collection, context) => {
    const providers = new Set<string>();
    for (const [index, health] of collection.providers.entries()) {
      if (providers.has(health.provider)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Provider health entries must be unique by provider.',
          path: ['providers', index, 'provider'],
        });
      }
      providers.add(health.provider);
    }
  });

export const providerRefreshInputSchema = z.object({}).strict();

export const providerHealthCollectionSuccessSchema = successEnvelopeSchema(
  providerHealthCollectionSchema,
);

export const providerRouteRegistry = {
  listProviders: {
    method: 'GET',
    path: '/api/v1/providers',
    responses: {
      200: providerHealthCollectionSuccessSchema,
      401: errorEnvelopeSchema,
    },
  },
  refreshProviders: {
    method: 'POST',
    path: '/api/v1/providers/refresh',
    body: providerRefreshInputSchema,
    responses: {
      200: providerHealthCollectionSuccessSchema,
      400: errorEnvelopeSchema,
      401: errorEnvelopeSchema,
      403: errorEnvelopeSchema,
      409: errorEnvelopeSchema,
      422: errorEnvelopeSchema,
    },
  },
} as const;

export type ProviderHealthCollection = z.infer<typeof providerHealthCollectionSchema>;
export type ProviderRefreshInput = z.infer<typeof providerRefreshInputSchema>;
export type ProviderRouteRegistry = typeof providerRouteRegistry;
