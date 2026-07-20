import { mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { ApplicationError, getErrorCode } from './errors.js';

export interface RuntimeMetadata {
  readonly pid: number;
  readonly host: string;
  readonly port: number;
  readonly startedAt: string;
}

export interface RuntimeFileSystem {
  ensureDirectory(): Promise<void>;
  writeMetadata(metadata: RuntimeMetadata): Promise<void>;
}

export interface RuntimeOperations {
  mkdir(directory: string): Promise<void>;
  stat(directory: string): Promise<{ isDirectory(): boolean }>;
  writeFile(file: string, contents: string): Promise<void>;
  rename(source: string, destination: string): Promise<void>;
  unlink(file: string): Promise<void>;
}

const nodeRuntimeOperations: RuntimeOperations = {
  async mkdir(directory) {
    await mkdir(directory, { recursive: true });
  },
  stat,
  async writeFile(file, contents) {
    await writeFile(file, contents, 'utf8');
  },
  rename,
  unlink,
};

export class NodeRuntimeFileSystem implements RuntimeFileSystem {
  public constructor(
    private readonly directory: string,
    private readonly operations: RuntimeOperations = nodeRuntimeOperations,
    private readonly temporaryName: () => string = randomUUID,
  ) {}

  public async ensureDirectory(): Promise<void> {
    try {
      await this.operations.mkdir(this.directory);
      const details = await this.operations.stat(this.directory);
      if (!details.isDirectory()) {
        throw new ApplicationError(
          'RUNTIME_DIRECTORY_CREATE_FAILED',
          'The runtime path is not a directory.',
        );
      }
    } catch (error) {
      if (error instanceof ApplicationError) {
        throw error;
      }

      if (isPermissionError(error)) {
        throw new ApplicationError(
          'RUNTIME_DIRECTORY_PERMISSION_DENIED',
          'The runtime directory is not accessible.',
        );
      }

      throw new ApplicationError(
        'RUNTIME_DIRECTORY_CREATE_FAILED',
        'The runtime directory could not be created.',
      );
    }
  }

  public async writeMetadata(metadata: RuntimeMetadata): Promise<void> {
    const destination = join(this.directory, 'runtime.json');
    const temporary = join(this.directory, `.runtime-${this.temporaryName()}.tmp`);
    const contents = JSON.stringify({
      pid: metadata.pid,
      host: metadata.host,
      port: metadata.port,
      startedAt: metadata.startedAt,
    });

    try {
      await this.operations.writeFile(temporary, contents);
      await this.operations.rename(temporary, destination);
    } catch {
      await this.removeTemporaryFile(temporary);
      throw new ApplicationError(
        'RUNTIME_METADATA_WRITE_FAILED',
        'The runtime metadata could not be written.',
      );
    }
  }

  private async removeTemporaryFile(temporary: string): Promise<void> {
    try {
      await this.operations.unlink(temporary);
    } catch {
      // The primary metadata failure remains the actionable error.
    }
  }
}

function isPermissionError(error: unknown): boolean {
  const code = getErrorCode(error);
  return code === 'EACCES' || code === 'EPERM';
}
