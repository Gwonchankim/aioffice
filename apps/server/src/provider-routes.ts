import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ulid } from 'ulid';
import { providerRefreshInputSchema } from '@orion/contracts';

import type { IdempotencyService } from './idempotency.js';
import type { ProviderHealthService } from './provider-health-service.js';
import {
  type RequestSecurityOptions,
  idempotencyKey,
  requireMutationSession,
} from './request-security.js';
import { parseSessionCookie } from './session.js';

export interface ProviderRouteDependencies {
  readonly security: RequestSecurityOptions;
  readonly health: ProviderHealthService;
  readonly idempotency: IdempotencyService;
  readonly now?: () => Date;
  readonly requestId?: () => string;
}

export function registerProviderRoutes(
  app: FastifyInstance,
  dependencies: ProviderRouteDependencies,
): void {
  const now = dependencies.now ?? (() => new Date());
  const requestId = dependencies.requestId ?? ulid;
  const meta = () => ({ requestId: requestId(), timestamp: now().toISOString() });
  const requireReadSession = (request: FastifyRequest) =>
    dependencies.security.sessions.require(parseSessionCookie(request.headers.cookie));

  app.get('/api/v1/providers', async (request) => {
    requireReadSession(request);
    return { data: dependencies.health.list(), meta: meta() };
  });

  app.post('/api/v1/providers/refresh', async (request, reply) => {
    const session = requireMutationSession(request, dependencies.security);
    const body = providerRefreshInputSchema.parse(request.body);
    const result = await dependencies.idempotency.execute(
      session.scopeHash,
      'providers.refresh',
      idempotencyKey(request),
      body,
      async () => ({
        statusCode: 200,
        body: { data: await dependencies.health.refresh(), meta: meta() },
      }),
    );
    return reply.code(result.statusCode).send(result.body);
  });
}
