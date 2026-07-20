import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLogger, type StartupLogger } from '@orion/server';

import {
  openBrowser,
  reportBrowserOpenFailure,
  validateAbsoluteUrl,
  type AbsoluteUrl,
} from './browser.js';
import type { BrowserOpener } from './start.js';

const LOOPBACK_HOST = '127.0.0.1';
const VITE_PORT = 5173;
const POLL_INTERVAL_MILLISECONDS = 50;
const DEFAULT_READINESS_TIMEOUT_MILLISECONDS = 10_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MILLISECONDS = 10_000;

export interface RuntimeMetadata {
  readonly host: string;
  readonly pid: number;
  readonly port: number;
  readonly startedAt: string;
}

export interface OwnedChildProcess {
  readonly pid: number;
  kill(signal: NodeJS.Signals): boolean;
  once(event: 'error' | 'exit', listener: () => void): void;
}

export interface ChildSpawnOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly shell: false;
  readonly stdio: 'inherit';
}

export type ChildSpawner = (
  executable: string,
  arguments_: readonly string[],
  options: ChildSpawnOptions,
) => OwnedChildProcess;

export interface Clock {
  now(): number;
  sleep(milliseconds: number): Promise<void>;
}

export interface SignalSource {
  once(signal: 'SIGINT', listener: () => void): void;
  removeListener(signal: 'SIGINT', listener: () => void): void;
}

export type RuntimeReadinessReader = (expectedPid: number) => Promise<RuntimeMetadata | undefined>;
export type ViteReadinessReader = (url: AbsoluteUrl) => Promise<boolean>;

export interface DevelopmentCoordinatorDependencies {
  readonly apiEntry?: string;
  readonly apiReadinessTimeoutMilliseconds?: number;
  readonly browserOpener?: BrowserOpener;
  readonly clock?: Clock;
  readonly environment?: NodeJS.ProcessEnv;
  readonly logger?: StartupLogger;
  readonly output?: (value: string) => void;
  readonly runtimeReadinessReader?: RuntimeReadinessReader;
  readonly shutdownTimeoutMilliseconds?: number;
  readonly signalSource?: SignalSource;
  readonly spawn?: ChildSpawner;
  readonly viteEntry?: string;
  readonly viteReadinessReader?: ViteReadinessReader;
  readonly viteReadinessTimeoutMilliseconds?: number;
  readonly workingDirectory?: string;
}

interface ChildState {
  readonly child: OwnedChildProcess;
  readonly name: 'API' | 'Vite';
  exited: boolean;
}

type TerminalEvent =
  { readonly kind: 'child_failure'; readonly name: 'API' | 'Vite' } | { readonly kind: 'signal' };

export async function runDevelopmentCoordinator(
  dependencies: DevelopmentCoordinatorDependencies = {},
): Promise<number> {
  const environment = dependencies.environment ?? process.env;
  const workingDirectory = resolve(dependencies.workingDirectory ?? defaultWorkingDirectory());
  const logger = dependencies.logger ?? createLogger();
  const output = dependencies.output ?? console.log;
  const clock = dependencies.clock ?? systemClock;
  const spawnChild = dependencies.spawn ?? spawnOwnedChild;
  const signalSource = dependencies.signalSource ?? process;
  const apiReadinessReader =
    dependencies.runtimeReadinessReader ??
    createRuntimeReadinessReader(runtimeDirectory(environment));
  const viteReadinessReader = dependencies.viteReadinessReader ?? readViteHttpReadiness;
  const apiReadinessTimeout =
    dependencies.apiReadinessTimeoutMilliseconds ?? DEFAULT_READINESS_TIMEOUT_MILLISECONDS;
  const viteReadinessTimeout =
    dependencies.viteReadinessTimeoutMilliseconds ?? DEFAULT_READINESS_TIMEOUT_MILLISECONDS;
  const shutdownTimeout =
    dependencies.shutdownTimeoutMilliseconds ?? DEFAULT_SHUTDOWN_TIMEOUT_MILLISECONDS;
  const states: ChildState[] = [];
  let terminalEvent: TerminalEvent | undefined;
  let resolveTerminal: (event: TerminalEvent) => void = () => undefined;
  const terminal = new Promise<TerminalEvent>((resolve) => {
    resolveTerminal = resolve;
  });
  const settle = (event: TerminalEvent): void => {
    if (terminalEvent === undefined) {
      terminalEvent = event;
      resolveTerminal(event);
    }
  };
  const onSigint = (): void => {
    settle({ kind: 'signal' });
  };

  signalSource.once('SIGINT', onSigint);

  try {
    const api = registerChild(
      spawnChild(process.execPath, [resolve(dependencies.apiEntry ?? apiEntry(workingDirectory))], {
        cwd: workingDirectory,
        env: { ...environment, ORION_BROWSER_DISABLED: '1' },
        shell: false,
        stdio: 'inherit',
      }),
      'API',
      states,
      settle,
    );

    const apiReady = await waitForRuntimeReadiness(
      apiReadinessReader,
      api.child.pid,
      clock,
      apiReadinessTimeout,
      () => terminalEvent !== undefined,
    );
    if (!apiReady || terminalEvent !== undefined) {
      logger.error({ code: 'API_READINESS_FAILED' }, 'API readiness failed');
      await stopOwnedChildren(states, clock, shutdownTimeout, logger);
      return 1;
    }

    const viteUrl = validateAbsoluteUrl(`http://${LOOPBACK_HOST}:${VITE_PORT}`);
    registerChild(
      spawnChild(
        process.execPath,
        [
          resolve(dependencies.viteEntry ?? viteEntry(workingDirectory)),
          '--host',
          LOOPBACK_HOST,
          '--port',
          String(VITE_PORT),
          '--strictPort',
        ],
        {
          cwd: join(workingDirectory, 'apps', 'web'),
          env: { ...environment, ORION_API_ORIGIN: `http://${LOOPBACK_HOST}:${apiReady.port}` },
          shell: false,
          stdio: 'inherit',
        },
      ),
      'Vite',
      states,
      settle,
    );

    const viteReady = await waitForViteReadiness(
      viteReadinessReader,
      viteUrl,
      clock,
      viteReadinessTimeout,
      () => terminalEvent !== undefined,
    );
    if (!viteReady || terminalEvent !== undefined) {
      logger.error({ code: 'VITE_READINESS_FAILED' }, 'Vite readiness failed');
      await stopOwnedChildren(states, clock, shutdownTimeout, logger);
      return 1;
    }

    try {
      (dependencies.browserOpener ?? defaultBrowserOpener(logger, output))(viteUrl);
    } catch {
      reportBrowserOpenFailure(viteUrl, logger, output);
    }

    const event = await terminal;
    if (event.kind === 'signal') {
      await stopOwnedChildren(states, clock, shutdownTimeout, logger);
      return 0;
    }

    logger.error({ code: `${event.name.toUpperCase()}_CHILD_EXITED` }, 'Owned child exited early');
    await stopOwnedChildren(states, clock, shutdownTimeout, logger);
    return 1;
  } catch {
    logger.error({ code: 'COORDINATOR_STARTUP_FAILED' }, 'Development coordinator failed');
    await stopOwnedChildren(states, clock, shutdownTimeout, logger);
    return 1;
  } finally {
    signalSource.removeListener('SIGINT', onSigint);
  }
}

function registerChild(
  child: OwnedChildProcess,
  name: ChildState['name'],
  states: ChildState[],
  settle: (event: TerminalEvent) => void,
): ChildState {
  const state: ChildState = { child, name, exited: false };
  states.push(state);
  child.once('exit', () => {
    state.exited = true;
    settle({ kind: 'child_failure', name });
  });
  child.once('error', () => {
    settle({ kind: 'child_failure', name });
  });
  return state;
}

async function waitForRuntimeReadiness(
  reader: RuntimeReadinessReader,
  expectedPid: number,
  clock: Clock,
  timeoutMilliseconds: number,
  hasTerminalEvent: () => boolean,
): Promise<RuntimeMetadata | undefined> {
  const deadline = clock.now() + timeoutMilliseconds;
  while (!hasTerminalEvent() && clock.now() <= deadline) {
    const metadata = await reader(expectedPid);
    if (isCurrentApiReadiness(metadata, expectedPid)) {
      return metadata;
    }
    await clock.sleep(Math.min(POLL_INTERVAL_MILLISECONDS, Math.max(0, deadline - clock.now())));
  }
  return undefined;
}

async function waitForViteReadiness(
  reader: ViteReadinessReader,
  url: AbsoluteUrl,
  clock: Clock,
  timeoutMilliseconds: number,
  hasTerminalEvent: () => boolean,
): Promise<boolean> {
  const deadline = clock.now() + timeoutMilliseconds;
  while (!hasTerminalEvent() && clock.now() <= deadline) {
    if (await reader(url)) {
      return true;
    }
    await clock.sleep(Math.min(POLL_INTERVAL_MILLISECONDS, Math.max(0, deadline - clock.now())));
  }
  return false;
}

async function stopOwnedChildren(
  states: readonly ChildState[],
  clock: Clock,
  timeoutMilliseconds: number,
  logger: StartupLogger,
): Promise<void> {
  const running = states.filter((state) => !state.exited);
  const exitPromises = running.map((state) => childExit(state.child));
  for (const state of running) {
    try {
      state.child.kill('SIGINT');
    } catch {
      logger.warn(
        { code: 'CHILD_STOP_FAILED', pid: state.child.pid },
        'Owned child did not accept SIGINT',
      );
    }
  }
  await Promise.race([Promise.all(exitPromises), clock.sleep(timeoutMilliseconds)]);
  for (const state of running.filter((candidate) => !candidate.exited)) {
    logger.warn(
      { code: 'CHILD_STOP_TIMEOUT', pid: state.child.pid },
      'Owned child did not exit in time',
    );
  }
}

function childExit(child: OwnedChildProcess): Promise<void> {
  return new Promise((resolve) => {
    child.once('exit', resolve);
  });
}

function isCurrentApiReadiness(
  metadata: RuntimeMetadata | undefined,
  expectedPid: number,
): metadata is RuntimeMetadata {
  return (
    metadata !== undefined &&
    metadata.pid === expectedPid &&
    metadata.host === LOOPBACK_HOST &&
    Number.isSafeInteger(metadata.port) &&
    metadata.port >= 1 &&
    metadata.port <= 65535
  );
}

export function createRuntimeReadinessReader(directory: string): RuntimeReadinessReader {
  const path = join(directory, 'runtime.json');
  return async () => {
    try {
      const contents = await readFile(path, 'utf8');
      const parsed: unknown = JSON.parse(contents);
      return isRuntimeMetadata(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  };
}

function isRuntimeMetadata(value: unknown): value is RuntimeMetadata {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<RuntimeMetadata>;
  return (
    typeof candidate.host === 'string' &&
    typeof candidate.pid === 'number' &&
    typeof candidate.port === 'number' &&
    typeof candidate.startedAt === 'string'
  );
}

async function readViteHttpReadiness(url: AbsoluteUrl): Promise<boolean> {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(POLL_INTERVAL_MILLISECONDS) })).ok;
  } catch {
    return false;
  }
}

function runtimeDirectory(environment: NodeJS.ProcessEnv): string {
  if (environment.ORION_RUNTIME_DIR !== undefined) {
    return resolve(environment.ORION_RUNTIME_DIR);
  }
  return join(environment.LOCALAPPDATA ?? '', 'OrionConsole');
}

function apiEntry(workingDirectory: string): string {
  return resolve(workingDirectory, 'apps', 'server', 'dist', 'main.js');
}

function viteEntry(workingDirectory: string): string {
  return resolve(workingDirectory, 'apps', 'web', 'node_modules', 'vite', 'bin', 'vite.js');
}

function defaultWorkingDirectory(): string {
  const directory = dirname(fileURLToPath(import.meta.url));
  return basename(directory) === 'dist' ? resolve(directory, '..', '..') : resolve(directory, '..');
}

function spawnOwnedChild(
  executable: string,
  arguments_: readonly string[],
  options: ChildSpawnOptions,
): OwnedChildProcess {
  const child = spawn(executable, arguments_, options);
  if (child.pid === undefined) {
    throw new Error('Child process did not provide a PID.');
  }
  return {
    pid: child.pid,
    kill(signal) {
      return child.kill(signal);
    },
    once(event, listener) {
      child.once(event, listener);
    },
  };
}

function defaultBrowserOpener(
  logger: StartupLogger,
  output: (value: string) => void,
): BrowserOpener {
  return (actualUrl) => {
    openBrowser(actualUrl, { logger, output });
  };
}

const systemClock: Clock = {
  now() {
    return Date.now();
  },
  sleep(milliseconds) {
    return new Promise((resolve) => {
      setTimeout(resolve, milliseconds);
    });
  },
};

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runDevelopmentCoordinator().then((exitCode) => {
    if (exitCode !== 0) {
      process.exitCode = exitCode;
    }
  });
}
