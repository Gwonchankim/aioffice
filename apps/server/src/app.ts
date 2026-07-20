import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';

import { getErrorCode } from './errors.js';
import { registerHealthRoute } from './health.js';
import type { ResourceReader } from './resources.js';
import { SystemResourceReader } from './resources.js';
import { registerStaticSpa } from './static-spa.js';

export interface CreateApplicationOptions {
  readonly assetRoot: string;
  readonly runtimeDirectory: string;
  readonly logger?: FastifyBaseLogger;
  readonly resourceReader?: ResourceReader;
  readonly now?: () => Date;
  readonly requestId?: () => string;
}

export async function createApplication(
  options: CreateApplicationOptions,
): Promise<FastifyInstance> {
  const app =
    options.logger === undefined
      ? Fastify({ logger: false })
      : Fastify({ loggerInstance: options.logger });

  app.setErrorHandler((error, request, reply) => {
    const code = getErrorCode(error) ?? 'INTERNAL_SERVER_ERROR';
    request.log.error({ code }, 'Request failed');
    const statusCode = code === 'HEALTH_RESOURCE_MEASUREMENT_FAILED' ? 503 : 500;
    return reply.code(statusCode).send({ error: { code } });
  });

  const healthRouteOptions = {
    resourceReader: options.resourceReader ?? new SystemResourceReader(),
    runtimeDirectory: options.runtimeDirectory,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
  };
  registerHealthRoute(app, healthRouteOptions);
  await registerStaticSpa(app, { assetRoot: options.assetRoot });

  return app;
}
