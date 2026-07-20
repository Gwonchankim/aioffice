import Fastify from 'fastify';
import type { AddressInfo, ListenOptions } from 'node:net';
import { describe, expect, it, vi } from 'vitest';

import { LOOPBACK_HOST, type ServerConfig } from '../src/config.js';
import { SequentialPortBinder } from '../src/port.js';
import { startServer } from '../src/main.js';
import type { RuntimeFileSystem } from '../src/runtime.js';
import type { StartupLogger } from '../src/logger.js';

function socketError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function testConfig(port: number): ServerConfig {
  return { assetRoot: 'unused', port, runtimeDirectory: 'unused' };
}

function testLogger(): StartupLogger {
  return { error: vi.fn(), info: vi.fn() } as unknown as StartupLogger;
}

function testRuntimeFileSystem(): RuntimeFileSystem {
  return { ensureDirectory: vi.fn(), writeMetadata: vi.fn() };
}

function loopbackAddress(port: number): AddressInfo {
  return { address: LOOPBACK_HOST, family: 'IPv4', port };
}

describe('loopback port binding', () => {
  it('PORT-001 binds 4317 without a retry and only uses the literal loopback host', async () => {
    const attempts: ListenOptions[] = [];
    const binder = new SequentialPortBinder();

    const port = await binder.bind(async (options) => {
      attempts.push(options);
    }, 4317);

    expect(port).toBe(4317);
    expect(attempts).toStrictEqual([{ host: LOOPBACK_HOST, port: 4317 }]);
  });

  it('PORT-002 retries only EADDRINUSE from 4317 to 4318', async () => {
    const attempts: ListenOptions[] = [];
    const binder = new SequentialPortBinder();

    const port = await binder.bind(async (options) => {
      attempts.push(options);
      if (options.port === 4317) {
        throw socketError('EADDRINUSE');
      }
    }, 4317);

    expect(port).toBe(4318);
    expect(attempts).toStrictEqual([
      { host: LOOPBACK_HOST, port: 4317 },
      { host: LOOPBACK_HOST, port: 4318 },
    ]);
  });

  it('PORT-003 fails immediately for EACCES with PORT_BIND_FAILED and exits 1', async () => {
    const app = Fastify();
    const listen = vi.spyOn(app, 'listen').mockRejectedValue(socketError('EACCES'));
    const exit = vi.fn();
    const logger = testLogger();

    const result = await startServer({
      appFactory: async () => app,
      config: testConfig(4317),
      exit,
      logger,
      runtimeFileSystem: testRuntimeFileSystem(),
    });

    expect(result).toBeUndefined();
    expect(listen).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(logger.error).toHaveBeenCalledWith(
      { code: 'PORT_BIND_FAILED' },
      'Server startup failed',
    );
    await app.close();
  });

  it('PORT-004 exhausts exactly 1,000 EADDRINUSE candidates and exits 1', async () => {
    const app = Fastify();
    const listen = vi.spyOn(app, 'listen').mockRejectedValue(socketError('EADDRINUSE'));
    const exit = vi.fn();
    const logger = testLogger();

    const result = await startServer({
      appFactory: async () => app,
      config: testConfig(4317),
      exit,
      logger,
      runtimeFileSystem: testRuntimeFileSystem(),
    });

    expect(result).toBeUndefined();
    expect(listen).toHaveBeenCalledTimes(1000);
    expect(listen.mock.calls[0]?.[0]).toStrictEqual({ host: LOOPBACK_HOST, port: 4317 });
    expect(listen.mock.calls[999]?.[0]).toStrictEqual({ host: LOOPBACK_HOST, port: 5316 });
    expect(exit).toHaveBeenCalledWith(1);
    expect(logger.error).toHaveBeenCalledWith({ code: 'PORT_EXHAUSTED' }, 'Server startup failed');
    await app.close();
  });

  it('PORT-005 attempts 65535 exactly once, never exceeds it, and exits 1', async () => {
    const app = Fastify();
    const listen = vi.spyOn(app, 'listen').mockRejectedValue(socketError('EADDRINUSE'));
    const exit = vi.fn();
    const logger = testLogger();

    const result = await startServer({
      appFactory: async () => app,
      config: testConfig(65535),
      exit,
      logger,
      runtimeFileSystem: testRuntimeFileSystem(),
    });

    expect(result).toBeUndefined();
    expect(listen).toHaveBeenCalledTimes(1);
    expect(listen).toHaveBeenCalledWith({ host: LOOPBACK_HOST, port: 65535 });
    expect(exit).toHaveBeenCalledWith(1);
    expect(logger.error).toHaveBeenCalledWith({ code: 'PORT_EXHAUSTED' }, 'Server startup failed');
    await app.close();
  });

  it('uses the actual listener address for metadata and the returned URL', async () => {
    const app = Fastify();
    const metadata: unknown[] = [];
    const runtimeFileSystem: RuntimeFileSystem = {
      ensureDirectory: vi.fn(),
      writeMetadata: async (value) => {
        metadata.push(value);
      },
    };

    const result = await startServer({
      addressReader: () => loopbackAddress(4567),
      appFactory: async () => app,
      config: testConfig(4317),
      logger: testLogger(),
      now: () => new Date('2026-07-20T12:00:00.000Z'),
      pid: () => 123,
      portBinder: { bind: async () => 4317 },
      runtimeFileSystem,
    });

    expect(result).toMatchObject({ host: LOOPBACK_HOST, port: 4567, url: 'http://127.0.0.1:4567' });
    expect(metadata).toStrictEqual([
      { pid: 123, host: LOOPBACK_HOST, port: 4567, startedAt: '2026-07-20T12:00:00.000Z' },
    ]);
    await app.close();
  });
});
