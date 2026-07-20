import { describe, expect, it } from 'vitest';

import { DEFAULT_ASSET_ROOT, DEFAULT_PORT, loadServerConfig } from '../src/config.js';
import { SystemResourceReader } from '../src/resources.js';
function thrownBy(operation: () => void): unknown {
  try {
    operation();
  } catch (error) {
    return error;
  }

  throw new Error('Expected the operation to throw.');
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
    });
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
