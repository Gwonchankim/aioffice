import { statfs as nodeStatfs } from 'node:fs/promises';
import { freemem, totalmem } from 'node:os';

import type { ResourcesHealth } from '@orion/contracts';

import { ApplicationError } from './errors.js';

export interface ResourceReader {
  read(runtimeDirectory: string): Promise<ResourcesHealth>;
}

export interface SystemResourceDependencies {
  readonly freeMemory: () => number;
  readonly totalMemory: () => number;
  readonly statfs: (
    directory: string,
  ) => Promise<{ bavail: number | bigint; bsize: number | bigint }>;
}

const systemResourceDependencies: SystemResourceDependencies = {
  freeMemory: freemem,
  totalMemory: totalmem,
  async statfs(directory) {
    const details = await nodeStatfs(directory);
    return { bavail: details.bavail, bsize: details.bsize };
  },
};

export class SystemResourceReader implements ResourceReader {
  public constructor(
    private readonly dependencies: SystemResourceDependencies = systemResourceDependencies,
  ) {}

  public async read(runtimeDirectory: string): Promise<ResourcesHealth> {
    try {
      const totalMemory = this.dependencies.totalMemory();
      const freeMemory = this.dependencies.freeMemory();
      if (
        !Number.isFinite(totalMemory) ||
        !Number.isFinite(freeMemory) ||
        totalMemory <= 0 ||
        freeMemory < 0 ||
        freeMemory > totalMemory
      ) {
        throw new Error('Invalid memory measurement.');
      }

      const disk = await this.dependencies.statfs(runtimeDirectory);
      const availableBlocks = Number(disk.bavail);
      const blockSize = Number(disk.bsize);
      const freeDiskBytes = availableBlocks * blockSize;
      if (
        !Number.isSafeInteger(availableBlocks) ||
        !Number.isSafeInteger(blockSize) ||
        !Number.isSafeInteger(freeDiskBytes) ||
        freeDiskBytes < 0
      ) {
        throw new Error('Invalid disk measurement.');
      }

      const memoryPercent = ((totalMemory - freeMemory) / totalMemory) * 100;
      if (!Number.isFinite(memoryPercent) || memoryPercent < 0 || memoryPercent > 100) {
        throw new Error('Invalid memory percentage.');
      }

      return { memoryPercent, freeDiskBytes };
    } catch {
      throw new ApplicationError(
        'HEALTH_RESOURCE_MEASUREMENT_FAILED',
        'Required system resources could not be measured.',
      );
    }
  }
}
