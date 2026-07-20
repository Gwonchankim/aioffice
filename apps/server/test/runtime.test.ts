import Fastify from 'fastify';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';

import { LOOPBACK_HOST, type ServerConfig } from '../src/config.js';
import { NodeRuntimeFileSystem, type RuntimeOperations } from '../src/runtime.js';
import { startServer } from '../src/main.js';
import type { StartupLogger } from '../src/logger.js';

function testConfig(): ServerConfig {
  return { assetRoot: 'unused', port: 4317, runtimeDirectory: 'runtime' };
}

function testLogger(): StartupLogger {
  return { error: vi.fn(), info: vi.fn() } as unknown as StartupLogger;
}

function loopbackAddress(): AddressInfo {
  return { address: LOOPBACK_HOST, family: 'IPv4', port: 4317 };
}

function baseOperations(overrides: Partial<RuntimeOperations> = {}): RuntimeOperations {
  return {
    mkdir: async () => undefined,
    stat: async () => ({ isDirectory: () => true }),
    writeFile: async () => undefined,
    rename: async () => undefined,
    unlink: async () => undefined,
    ...overrides,
  };
}

describe('runtime directory and metadata', () => {
  it('RUN-001 maps a directory creation failure to RUNTIME_DIRECTORY_CREATE_FAILED and exits 1', async () => {
    const runtimeFileSystem = new NodeRuntimeFileSystem(
      'runtime',
      baseOperations({ mkdir: async () => Promise.reject(new Error('disk unavailable')) }),
    );
    const app = Fastify();
    const exit = vi.fn();
    const logger = testLogger();

    const result = await startServer({
      appFactory: async () => app,
      config: testConfig(),
      exit,
      logger,
      runtimeFileSystem,
    });

    expect(result).toBeUndefined();
    expect(exit).toHaveBeenCalledWith(1);
    expect(logger.error).toHaveBeenCalledWith(
      { code: 'RUNTIME_DIRECTORY_CREATE_FAILED' },
      'Server startup failed',
    );
    await app.close();
  });

  it('RUN-002 maps EACCES and EPERM to RUNTIME_DIRECTORY_PERMISSION_DENIED and exits 1', async () => {
    for (const code of ['EACCES', 'EPERM']) {
      const runtimeFileSystem = new NodeRuntimeFileSystem(
        'runtime',
        baseOperations({
          mkdir: async () => Promise.reject(Object.assign(new Error(code), { code })),
        }),
      );
      const app = Fastify();
      const exit = vi.fn();
      const logger = testLogger();

      const result = await startServer({
        appFactory: async () => app,
        config: testConfig(),
        exit,
        logger,
        runtimeFileSystem,
      });

      expect(result).toBeUndefined();
      expect(exit).toHaveBeenCalledWith(1);
      expect(logger.error).toHaveBeenCalledWith(
        { code: 'RUNTIME_DIRECTORY_PERMISSION_DENIED' },
        'Server startup failed',
      );
      await app.close();
    }
  });

  it('RUN-003 cleans up its listener when atomic runtime metadata rename fails and exits 1', async () => {
    const writeFile = vi.fn(async () => undefined);
    const rename = vi.fn(async () => Promise.reject(new Error('rename failed')));
    const unlink = vi.fn(async () => undefined);
    const runtimeFileSystem = new NodeRuntimeFileSystem(
      'runtime',
      baseOperations({ writeFile, rename, unlink }),
      () => 'test-id',
    );
    const app = Fastify();
    const close = vi.spyOn(app, 'close');
    const exit = vi.fn();
    const logger = testLogger();

    const result = await startServer({
      addressReader: loopbackAddress,
      appFactory: async () => app,
      config: testConfig(),
      exit,
      logger,
      portBinder: { bind: async () => 4317 },
      runtimeFileSystem,
    });

    expect(result).toBeUndefined();
    expect(writeFile).toHaveBeenCalledOnce();
    expect(rename).toHaveBeenCalledOnce();
    expect(unlink).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(1);
    expect(logger.error).toHaveBeenCalledWith(
      { code: 'RUNTIME_METADATA_WRITE_FAILED' },
      'Server startup failed',
    );
  });

  it('writes only runtime metadata through a temporary file followed by rename', async () => {
    const writes: string[] = [];
    const renames: Array<[string, string]> = [];
    const runtimeFileSystem = new NodeRuntimeFileSystem(
      'runtime',
      baseOperations({
        writeFile: async (file, contents) => {
          writes.push(`${file}:${contents}`);
        },
        rename: async (source, destination) => {
          renames.push([source, destination]);
        },
      }),
      () => 'test-id',
    );

    await runtimeFileSystem.ensureDirectory();
    await runtimeFileSystem.writeMetadata({
      pid: 123,
      host: LOOPBACK_HOST,
      port: 4317,
      startedAt: '2026-07-20T12:00:00.000Z',
    });

    expect(writes).toStrictEqual([
      'runtime\\.runtime-test-id.tmp:{"pid":123,"host":"127.0.0.1","port":4317,"startedAt":"2026-07-20T12:00:00.000Z"}',
    ]);
    expect(renames).toStrictEqual([['runtime\\.runtime-test-id.tmp', 'runtime\\runtime.json']]);
  });
});
