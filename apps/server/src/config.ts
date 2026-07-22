import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

import { ApplicationError } from './errors.js';
import { resolveTrustedGitExecutable } from './git-runner.js';
import { resolveTrustedProviderExecutable } from './providers/trusted-provider-executable.js';

export const LOOPBACK_HOST = '127.0.0.1' as const;
export const DEFAULT_PORT = 4317;
export const MAX_PORT_ATTEMPTS = 1000;

const workspaceRoot = fileURLToPath(new URL('../../../', import.meta.url));

export const DEFAULT_ASSET_ROOT = resolve(workspaceRoot, 'apps', 'web', 'dist');

export interface ServerConfig {
  readonly assetRoot: string;
  readonly port: number;
  readonly runtimeDirectory: string;
  readonly gitExecutable?: string;
  readonly codexExecutable?: string;
  readonly claudeExecutable?: string;
}

export function loadServerConfig(environment: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    assetRoot: DEFAULT_ASSET_ROOT,
    port: parsePort(environment.ORION_PORT),
    runtimeDirectory: resolveRuntimeDirectory(environment),
    gitExecutable: resolveTrustedGitExecutable(
      environment.ORION_GIT_EXECUTABLE ?? defaultTrustedGitExecutablePath(environment),
    ),
    ...(environment.ORION_CODEX_EXECUTABLE === undefined
      ? {}
      : {
          codexExecutable: resolveTrustedProviderExecutable(environment.ORION_CODEX_EXECUTABLE, {
            projectRoots: [workspaceRoot],
          }),
        }),
    ...(environment.ORION_CLAUDE_EXECUTABLE === undefined
      ? {}
      : {
          claudeExecutable: resolveTrustedProviderExecutable(environment.ORION_CLAUDE_EXECUTABLE, {
            projectRoots: [workspaceRoot],
          }),
        }),
  };
}

export function defaultTrustedGitExecutablePath(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return join(environment.ProgramFiles ?? 'C:\\Program Files', 'Git', 'cmd', 'git.exe');
}

function parsePort(value: string | undefined): number {
  if (value === undefined) {
    return DEFAULT_PORT;
  }

  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new ApplicationError('PORT_BIND_FAILED', 'ORION_PORT must be a valid TCP port.');
  }

  return port;
}

function resolveRuntimeDirectory(environment: NodeJS.ProcessEnv): string {
  if (environment.ORION_RUNTIME_DIR !== undefined) {
    if (environment.ORION_RUNTIME_DIR.length === 0) {
      throw new ApplicationError(
        'RUNTIME_DIRECTORY_CREATE_FAILED',
        'ORION_RUNTIME_DIR must not be empty.',
      );
    }

    return resolve(environment.ORION_RUNTIME_DIR);
  }

  if (environment.LOCALAPPDATA === undefined || environment.LOCALAPPDATA.length === 0) {
    throw new ApplicationError(
      'RUNTIME_DIRECTORY_CREATE_FAILED',
      'LOCALAPPDATA is required to determine the runtime directory.',
    );
  }

  return join(environment.LOCALAPPDATA, 'OrionConsole');
}
