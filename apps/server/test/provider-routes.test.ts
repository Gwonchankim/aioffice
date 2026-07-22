import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentRuntimeAdapter, ProviderHealth } from '@orion/contracts';

import { createApplication, createProductionProviderAdapters } from '../src/app.js';
import { createDatabase } from '../src/database.js';
import { applyMigrations } from '../src/migrations.js';
import { ProviderHealthService } from '../src/provider-health-service.js';
import { ClaudeAdapter } from '../src/providers/claude-adapter.js';
import { CodexAdapter } from '../src/providers/codex-adapter.js';

const cleanup: string[] = [];
const handles: Array<{ close(): void }> = [];
afterEach(async () => {
  handles.splice(0).forEach((handle) => handle.close());
  cleanup.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});

function adapter(health: ProviderHealth, calls: { value: number }): AgentRuntimeAdapter {
  return {
    async inspect() {
      calls.value += 1;
      return { ...health, accountEmail: 'must-not-cross-the-boundary' } as ProviderHealth;
    },
    async *start() {},
    async *resume() {},
    async cancel() {},
  };
}

function health(provider: 'openai' | 'anthropic'): ProviderHealth {
  return {
    provider,
    installed: true,
    cliVersion: 'synthetic-1',
    authenticated: true,
    status: 'ready',
    supportedModels: ['synthetic-model'],
    lastCheckedAt: '2026-07-22T00:00:00.000Z',
    sanitizedError: null,
  };
}

describe('provider routes', () => {
  it('PRV-005 composes configured production provider adapters without invoking a provider CLI', () => {
    const adapters = createProductionProviderAdapters('C:\\Synthetic\\runtime', {
      codexExecutable: 'C:\\Synthetic\\trusted\\codex.exe',
      claudeExecutable: 'C:\\Synthetic\\trusted\\claude.exe',
    });

    expect(adapters.get('openai')).toBeInstanceOf(CodexAdapter);
    expect(adapters.get('anthropic')).toBeInstanceOf(ClaudeAdapter);
  });
  it('PRV-API-001 refreshes sanitized health with session, Origin, CSRF, and idempotency only', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orion-provider-routes-'));
    cleanup.push(directory);
    const assets = join(directory, 'assets');
    writeFileSync(join(directory, 'placeholder'), 'x');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(assets);
    writeFileSync(join(assets, 'index.html'), '<!doctype html>');
    const handle = createDatabase(join(directory, 'orion.db'));
    handles.push(handle);
    applyMigrations(handle.database);
    const openaiCalls = { value: 0 };
    const anthropicCalls = { value: 0 };
    const app = await createApplication({
      assetRoot: assets,
      runtimeDirectory: directory,
      database: handle.database,
      loopbackPort: 4317,
      bootstrapToken: 'bootstrap',
      providerAdapters: new Map([
        ['openai', adapter(health('openai'), openaiCalls)],
        ['anthropic', adapter(health('anthropic'), anthropicCalls)],
      ]),
      now: () => new Date('2026-07-22T00:00:00.000Z'),
    });
    const base = { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317' };
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/providers', headers: base })).statusCode,
    ).toBe(401);
    const boot = await app.inject({
      method: 'POST',
      url: '/api/v1/session/bootstrap',
      headers: { ...base, 'x-orion-bootstrap-token': 'bootstrap' },
    });
    const headers = {
      ...base,
      cookie: boot.headers['set-cookie'] as string,
      'x-csrf-token': boot.json().data.csrfToken as string,
      'idempotency-key': 'provider-refresh-1',
    };
    const refreshed = await app.inject({
      method: 'POST',
      url: '/api/v1/providers/refresh',
      headers,
      payload: {},
    });
    expect(refreshed.statusCode).toBe(200);
    expect([openaiCalls.value, anthropicCalls.value]).toEqual([1, 1]);
    const providers = refreshed.json().data.providers as Array<Record<string, unknown>>;
    expect(Object.keys(providers[0] ?? {}).sort()).toEqual([
      'authenticated',
      'cliVersion',
      'installed',
      'lastCheckedAt',
      'provider',
      'sanitizedError',
      'status',
      'supportedModels',
    ]);
    expect(
      (
        await app.inject({ method: 'POST', url: '/api/v1/providers/refresh', headers, payload: {} })
      ).json().data.providers,
    ).toEqual(refreshed.json().data.providers);
    expect([openaiCalls.value, anthropicCalls.value]).toEqual([1, 1]);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/providers/refresh',
          headers: {
            ...headers,
            origin: 'http://localhost:4317',
            'idempotency-key': 'provider-refresh-2',
          },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    await app.close();
  });
  it('PRV-API-002 retains only the strict public health fields when inspection fails or no adapter is configured', async () => {
    const service = new ProviderHealthService(
      new Map([
        [
          'openai',
          {
            async inspect() {
              throw new Error('synthetic internal inspection detail');
            },
            async *start() {},
            async *resume() {},
            async cancel() {},
          } satisfies AgentRuntimeAdapter,
        ],
      ]),
      () => new Date('2026-07-22T00:00:00.000Z'),
    );
    expect(service.list().providers.map((value) => value.status)).toEqual([
      'not_installed',
      'not_installed',
    ]);
    const refreshed = await service.refresh();
    expect(refreshed.providers).toEqual([
      expect.objectContaining({
        provider: 'openai',
        status: 'error',
        sanitizedError: 'Provider inspection could not be completed.',
      }),
      expect.objectContaining({ provider: 'anthropic', status: 'not_installed' }),
    ]);
  });
});
