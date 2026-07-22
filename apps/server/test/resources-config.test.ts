import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ASSET_ROOT,
  DEFAULT_PORT,
  defaultTrustedGitExecutablePath,
  loadServerConfig,
} from '../src/config.js';
import { SystemResourceReader } from '../src/resources.js';
function thrownBy(operation: () => void): unknown {
  try {
    operation();
  } catch (error) {
    return error;
  }

  throw new Error('Expected the operation to throw.');
}
function writeNativePe(path: string): void {
  const descriptor = openSync(path, 'w');
  const header = Buffer.alloc(512);
  header[0] = 0x4d;
  header[1] = 0x5a;
  header.writeUInt32LE(0x80, 0x3c);
  header[0x80] = 0x50;
  header[0x81] = 0x45;
  writeFileSync(descriptor, header);
  closeSync(descriptor);
}

describe('server configuration and system resources', () => {
  it('uses only the permitted development overrides and rejects invalid ports', () => {
    expect(
      loadServerConfig({
        LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local',
        ORION_PORT: '4444',
        ORION_RUNTIME_DIR: 'C:\\runtime-test',
      }),
    ).toStrictEqual({
      assetRoot: DEFAULT_ASSET_ROOT,
      port: 4444,
      runtimeDirectory: 'C:\\runtime-test',
      gitExecutable: defaultTrustedGitExecutablePath(),
    });
    expect(
      thrownBy(() =>
        loadServerConfig({
          LOCALAPPDATA: 'C:\\runtime',
          ORION_GIT_EXECUTABLE: 'git',
        }),
      ),
    ).toMatchObject({ code: 'DATABASE_CONFIGURATION_FAILED' });
    expect(
      thrownBy(() => loadServerConfig({ LOCALAPPDATA: 'C:\\runtime', ORION_PORT: '0' })),
    ).toMatchObject({
      code: 'PORT_BIND_FAILED',
    });
    expect(thrownBy(() => loadServerConfig({}))).toMatchObject({
      code: 'RUNTIME_DIRECTORY_CREATE_FAILED',
    });
    expect(
      thrownBy(() => loadServerConfig({ LOCALAPPDATA: 'C:\\runtime', ORION_RUNTIME_DIR: '' })),
    ).toMatchObject({
      code: 'RUNTIME_DIRECTORY_CREATE_FAILED',
    });
    expect(loadServerConfig({ LOCALAPPDATA: 'C:\\runtime' }).port).toBe(DEFAULT_PORT);
  });

  it('accepts optional trusted provider executables and rejects untrusted or PATH inputs', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orion-provider-config-'));
    try {
      const executable = join(directory, 'provider.exe');
      writeNativePe(executable);
      const config = loadServerConfig({
        LOCALAPPDATA: 'C:\\runtime',
        ORION_CODEX_EXECUTABLE: executable,
        ORION_CLAUDE_EXECUTABLE: executable,
      });
      expect(config.codexExecutable).toContain('provider.exe');
      expect(config.claudeExecutable).toContain('provider.exe');
      expect(loadServerConfig({ LOCALAPPDATA: 'C:\\runtime' })).not.toHaveProperty(
        'codexExecutable',
      );
      expect(
        thrownBy(() =>
          loadServerConfig({ LOCALAPPDATA: 'C:\\runtime', ORION_CODEX_EXECUTABLE: 'codex' }),
        ),
      ).toMatchObject({ code: 'PROVIDER_EXECUTABLE_INVALID' });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('measures valid system resources and rejects invalid measurements', async () => {
    const reader = new SystemResourceReader({
      freeMemory: () => 25,
      totalMemory: () => 100,
      statfs: async () => ({ bavail: 10, bsize: 100 }),
    });

    await expect(reader.read('runtime')).resolves.toStrictEqual({
      memoryPercent: 75,
      freeDiskBytes: 1000,
    });

    const invalidReader = new SystemResourceReader({
      freeMemory: () => 101,
      totalMemory: () => 100,
      statfs: async () => ({ bavail: 10, bsize: 100 }),
    });
    await expect(invalidReader.read('runtime')).rejects.toMatchObject({
      code: 'HEALTH_RESOURCE_MEASUREMENT_FAILED',
    });
  });
});
