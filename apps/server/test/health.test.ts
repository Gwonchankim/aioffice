import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import { healthSuccessSchema } from '@orion/contracts';

import { createApplication } from '../src/app.js';
import { ApplicationError } from '../src/errors.js';
import type { ResourceReader } from '../src/resources.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function assetRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'orion-server-health-'));
  temporaryDirectories.push(directory);
  await writeFile(join(directory, 'index.html'), '<!doctype html><title>Orion</title>');
  return directory;
}

describe('health route', () => {
  it('HC-006 returns the exact M0 degraded envelope with fresh measured resources', async () => {
    const resources: ResourceReader = {
      read: async () => ({ memoryPercent: 12.5, freeDiskBytes: 987654321 }),
    };
    const app = await createApplication({
      assetRoot: await assetRoot(),
      now: () => new Date('2026-07-20T12:00:00.000Z'),
      requestId: () => '01J0M0ABCDEF1234567890ABCD',
      resourceReader: resources,
      runtimeDirectory: tmpdir(),
    });

    const response = await app.inject({ method: 'GET', url: '/api/v1/health' });
    const payload = response.json();

    expect(response.statusCode).toBe(200);
    expect(healthSuccessSchema.parse(payload)).toStrictEqual({
      data: {
        status: 'degraded',
        database: 'not_initialized',
        scheduler: { status: 'not_initialized', active: 0, capacity: 0, queued: 0 },
        resources: { memoryPercent: 12.5, freeDiskBytes: 987654321 },
        retention: { lastRunAt: null, status: 'not_initialized' },
      },
      meta: {
        requestId: '01J0M0ABCDEF1234567890ABCD',
        timestamp: '2026-07-20T12:00:00.000Z',
      },
    });
    await app.close();
  });

  it('treats a resource measurement failure as an unhealthy service error without fabricated values', async () => {
    const resources: ResourceReader = {
      read: async () => {
        throw new ApplicationError(
          'HEALTH_RESOURCE_MEASUREMENT_FAILED',
          'Required system resources could not be measured.',
        );
      },
    };
    const app = await createApplication({
      assetRoot: await assetRoot(),
      resourceReader: resources,
      runtimeDirectory: tmpdir(),
    });

    const response = await app.inject({ method: 'GET', url: '/api/v1/health' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toStrictEqual({
      error: { code: 'HEALTH_RESOURCE_MEASUREMENT_FAILED' },
    });
    await app.close();
  });
});
