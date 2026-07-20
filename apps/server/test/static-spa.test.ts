import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import { createApplication } from '../src/app.js';
import type { ApplicationError } from '../src/errors.js';
import type { ResourceReader } from '../src/resources.js';

const temporaryDirectories: string[] = [];
const resources: ResourceReader = {
  read: async () => ({ memoryPercent: 50, freeDiskBytes: 1024 }),
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createAssetRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orion-server-spa-'));
  temporaryDirectories.push(root);
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'index.html'), '<!doctype html><h1>Orion Console</h1>');
  await writeFile(join(root, 'assets', 'app.js'), 'console.log("dashboard");');
  return root;
}

async function createTestApplication(assetRoot: string) {
  return createApplication({
    assetRoot,
    requestId: () => '01J0M0ABCDEF1234567890ABCD',
    resourceReader: resources,
    runtimeDirectory: tmpdir(),
  });
}

describe('production static SPA serving', () => {
  it('SPA-001 returns index.html for non-API HTML navigation', async () => {
    const app = await createTestApplication(await createAssetRoot());

    const response = await app.inject({
      headers: { accept: 'text/html,application/xhtml+xml' },
      method: 'GET',
      url: '/projects/current',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toBe('<!doctype html><h1>Orion Console</h1>');
    await app.close();
  });

  it('SPA-002 keeps API routes ahead of the SPA fallback', async () => {
    const app = await createTestApplication(await createAssetRoot());

    const health = await app.inject({
      headers: { accept: 'text/html' },
      method: 'GET',
      url: '/api/v1/health',
    });
    const missingApi = await app.inject({
      headers: { accept: 'text/html' },
      method: 'GET',
      url: '/api/v1/missing',
    });
    const apiRoot = await app.inject({
      headers: { accept: 'text/html' },
      method: 'GET',
      url: '/api',
    });

    expect(health.statusCode).toBe(200);
    expect(health.json().data.status).toBe('degraded');
    expect(missingApi.statusCode).toBe(404);
    expect(missingApi.json()).toStrictEqual({ error: { code: 'NOT_FOUND' } });
    expect(apiRoot.statusCode).toBe(404);
    await app.close();
  });

  it('SPA-003 fails explicitly when index.html is absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orion-server-spa-missing-'));
    temporaryDirectories.push(root);

    await expect(createTestApplication(root)).rejects.toMatchObject<ApplicationError>({
      code: 'STATIC_ASSET_ROOT_INVALID',
    });
  });

  it('SPA-004 serves exact built static assets instead of the SPA fallback', async () => {
    const app = await createTestApplication(await createAssetRoot());

    const response = await app.inject({ method: 'GET', url: '/assets/app.js' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/javascript');
    expect(response.body).toBe('console.log("dashboard");');
    await app.close();
  });

  it('returns 404 for missing non-navigation assets and path escapes', async () => {
    const app = await createTestApplication(await createAssetRoot());

    const missing = await app.inject({ method: 'GET', url: '/assets/missing.js' });
    const escape = await app.inject({ method: 'GET', url: '/%2e%2e/package.json' });

    expect(missing.statusCode).toBe(404);
    expect(escape.statusCode).toBe(404);
    await app.close();
  });
});
