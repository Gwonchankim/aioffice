import type { FastifyInstance } from 'fastify';
import { ulid } from 'ulid';

import {
  canonicalM0DegradedHealth,
  healthSuccessSchema,
  type HealthSuccess,
} from '@orion/contracts';

import type { ResourceReader } from './resources.js';

export interface HealthRouteOptions {
  readonly resourceReader: ResourceReader;
  readonly runtimeDirectory: string;
  readonly now?: () => Date;
  readonly requestId?: () => string;
}

export function registerHealthRoute(app: FastifyInstance, options: HealthRouteOptions): void {
  const now = options.now ?? (() => new Date());
  const requestId = options.requestId ?? ulid;

  app.get('/api/v1/health', async (): Promise<HealthSuccess> => {
    const resources = await options.resourceReader.read(options.runtimeDirectory);

    return healthSuccessSchema.parse({
      data: {
        ...canonicalM0DegradedHealth.data,
        resources,
      },
      meta: {
        requestId: requestId(),
        timestamp: now().toISOString(),
      },
    });
  });
}
