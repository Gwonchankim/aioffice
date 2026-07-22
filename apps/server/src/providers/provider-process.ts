import { spawn, spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, win32 } from 'node:path';

import { ApplicationError } from '../errors.js';

export interface ProviderProcessExit {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface ProviderProcessHandle {
  readonly pid: number;
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
  readonly exited: Promise<ProviderProcessExit>;
  writeStdin(input: Uint8Array): Promise<void> | void;
  requestGracefulTermination(): void;
  terminateOwnedTree(): void;
  countOwnedDescendants(): Promise<number> | number;
}

export interface ProviderProcessSpawnRequest {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly shell: false;
}

export interface ProviderProcessPort {
  spawn(
    request: ProviderProcessSpawnRequest,
  ): Promise<ProviderProcessHandle> | ProviderProcessHandle;
}

export interface OutputSchemaFile {
  readonly path: string;
  readonly serialized: string;
  remove(): void;
}

export interface OutputSchemaStore {
  create(runId: string, sourcePath: string): OutputSchemaFile;
}

export class RuntimeOutputSchemaStore implements OutputSchemaStore {
  public constructor(private readonly runtimeDirectory: string) {}

  public create(runId: string, sourcePath: string): OutputSchemaFile {
    if (!isAbsolute(sourcePath) && !win32.isAbsolute(sourcePath)) {
      throw new ApplicationError(
        'OUTPUT_SCHEMA_INVALID',
        'The output schema path must be absolute.',
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(sourcePath, 'utf8')) as unknown;
    } catch {
      throw new ApplicationError(
        'OUTPUT_SCHEMA_INVALID',
        'The output schema must contain valid JSON.',
      );
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new ApplicationError(
        'OUTPUT_SCHEMA_INVALID',
        'The output schema must be a JSON object.',
      );
    }

    const runtimeRoot = canonicalDirectory(
      this.runtimeDirectory,
      'The runtime directory is invalid.',
    );
    const directory = join(runtimeRoot, 'schemas', runId);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const canonicalDirectoryPath = canonicalDirectory(
      directory,
      'The output schema directory is invalid.',
    );
    if (!isContained(canonicalDirectoryPath, runtimeRoot)) {
      throw new ApplicationError(
        'OUTPUT_SCHEMA_INVALID',
        'The output schema directory is outside runtime storage.',
      );
    }
    const path = join(canonicalDirectoryPath, 'result-schema.json');
    const serialized = JSON.stringify(parsed);
    writeFileSync(path, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return {
      path,
      serialized,
      remove: () => rmSync(canonicalDirectoryPath, { recursive: true, force: true }),
    };
  }
}

export class NativeProviderProcessPort implements ProviderProcessPort {
  public constructor(
    private readonly countDescendants: (
      rootPid: number,
    ) => Promise<number> | number = countWindowsOwnedDescendants,
  ) {}

  public spawn(request: ProviderProcessSpawnRequest): ProviderProcessHandle {
    if (request.shell !== false) {
      throw new ApplicationError(
        'PROVIDER_EXECUTION_FAILED',
        'Provider processes must not use a shell.',
      );
    }
    const child = spawn(request.executable, request.argv, {
      cwd: request.cwd,
      env: request.env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const exited = new Promise<ProviderProcessExit>((resolveExit) => {
      child.once('close', (exitCode, signal) => {
        resolveExit({ exitCode, signal });
      });
      child.once('error', () => resolveExit({ exitCode: null, signal: null }));
    });
    const pid = child.pid;
    if (
      pid === undefined ||
      child.stdout === null ||
      child.stderr === null ||
      child.stdin === null
    ) {
      throw new ApplicationError(
        'PROVIDER_UNAVAILABLE',
        'The provider process could not be started.',
        {
          retryable: true,
        },
      );
    }
    return {
      pid,
      stdout: child.stdout,
      stderr: child.stderr,
      exited,
      writeStdin: (input) =>
        new Promise<void>((resolveWrite, rejectWrite) => {
          child.stdin.write(input, (error) => {
            if (error === null || error === undefined) {
              child.stdin.end();
              resolveWrite();
            } else {
              rejectWrite(error);
            }
          });
        }),
      requestGracefulTermination: () => {
        child.kill('SIGTERM');
      },
      terminateOwnedTree: () => terminateWindowsTree(pid),
      countOwnedDescendants: () => this.countDescendants(pid),
    };
  }
}

export function buildProviderEnvironment(
  source: NodeJS.ProcessEnv,
  requestedNames: readonly string[],
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of OS_ENVIRONMENT_NAMES) {
    const value = source[name];
    if (value !== undefined) environment[name] = value;
  }
  for (const name of requestedNames) {
    if (!isPermittedProjectEnvironmentName(name)) {
      throw new ApplicationError(
        'VALIDATION_FAILED',
        'A requested provider environment name is not permitted.',
      );
    }
    const value = source[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

export function isPermittedProjectEnvironmentName(name: string): boolean {
  return (
    /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) &&
    !/(TOKEN|KEY|SECRET|PASSWORD|AUTHORIZATION|AUTH|COOKIE|CREDENTIAL|SESSION|CSRF|DATABASE|BOOTSTRAP)/i.test(
      name,
    )
  );
}

export function canonicalizeProviderCwd(
  cwd: string,
  projectRoot: string,
  executionMode:
    'read_only' | 'artifact_write' | 'worktree_write' | 'integration' | 'external_action',
  worktreeRoot?: string,
): string {
  if (!isAbsolute(cwd) && !win32.isAbsolute(cwd)) {
    throw new ApplicationError(
      'VALIDATION_FAILED',
      'The provider working directory must be absolute.',
    );
  }
  if (/^(?:\\\\|\\\\\?\\|\\\\\.\\)/.test(cwd) || /:[^\\/]+$/.test(cwd)) {
    throw new ApplicationError(
      'VALIDATION_FAILED',
      'The provider working directory is not permitted.',
    );
  }
  const canonicalCwd = canonicalDirectory(cwd, 'The provider working directory is invalid.');
  const containmentRoot =
    executionMode === 'read_only'
      ? canonicalDirectory(projectRoot, 'The registered project root is invalid.')
      : worktreeRoot === undefined
        ? undefined
        : canonicalDirectory(worktreeRoot, 'The provider worktree root is invalid.');
  if (containmentRoot === undefined || !isContained(canonicalCwd, containmentRoot)) {
    throw new ApplicationError(
      'VALIDATION_FAILED',
      'The provider working directory is outside its registered root.',
    );
  }
  return canonicalCwd;
}

export function validateProviderModel(model: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(model) || model.startsWith('-')) {
    throw new ApplicationError('VALIDATION_FAILED', 'The provider model identifier is invalid.');
  }
  return model;
}

const OS_ENVIRONMENT_NAMES = [
  'PATH',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'TEMP',
  'TMP',
  'SystemRoot',
  'SystemDrive',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'LANG',
  'LC_ALL',
] as const;

const WINDOWS_DESCENDANT_COUNT_QUERY =
  "$pending = [System.Collections.Generic.Queue[uint32]]::new(); $pending.Enqueue([uint32]$env:ORION_OWNED_ROOT_PID); $count = 0; while ($pending.Count -gt 0) { $parent = $pending.Dequeue(); Get-CimInstance -Query ('SELECT ProcessId FROM Win32_Process WHERE ParentProcessId = {0}' -f $parent) -ErrorAction Stop | ForEach-Object { $pending.Enqueue([uint32]$_.ProcessId); $count += 1 } }; [Console]::Out.Write($count)";

export function trustedWindowsPowerShellExecutable(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const systemRoot = environment.SystemRoot;
  if (
    systemRoot === undefined ||
    systemRoot.length === 0 ||
    (!isAbsolute(systemRoot) && !win32.isAbsolute(systemRoot))
  ) {
    throw new ApplicationError(
      'PROVIDER_EXECUTION_FAILED',
      'The operating system process query is unavailable.',
    );
  }
  try {
    const canonicalSystemRoot = realpathSync.native(systemRoot);
    const executable = realpathSync.native(
      join(canonicalSystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    );
    if (!isContained(executable, canonicalSystemRoot)) throw new Error('unsafe executable');
    return executable;
  } catch {
    throw new ApplicationError(
      'PROVIDER_EXECUTION_FAILED',
      'The operating system process query is unavailable.',
    );
  }
}

async function countWindowsOwnedDescendants(rootPid: number): Promise<number> {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0) {
    throw new ApplicationError(
      'PROVIDER_EXECUTION_FAILED',
      'The provider process tree could not be verified.',
    );
  }

  let query: ReturnType<typeof spawn>;
  try {
    query = spawn(
      trustedWindowsPowerShellExecutable(),
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        WINDOWS_DESCENDANT_COUNT_QUERY,
      ],
      {
        env: { ...process.env, ORION_OWNED_ROOT_PID: String(rootPid) },
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  } catch {
    throw new ApplicationError(
      'PROVIDER_EXECUTION_FAILED',
      'The provider process tree could not be verified.',
    );
  }
  const stdout = query.stdout;
  const stderr = query.stderr;
  if (stdout === null || stderr === null) {
    throw new ApplicationError(
      'PROVIDER_EXECUTION_FAILED',
      'The provider process tree could not be verified.',
    );
  }

  const output = await new Promise<string>((resolveOutput, rejectOutput) => {
    let retained = '';
    let retainedBytes = 0;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      query.kill('SIGTERM');
    }, 10_000);
    stdout.on('data', (chunk: Uint8Array) => {
      const remaining = 1024 - retainedBytes;
      if (remaining <= 0) return;
      const bounded = Buffer.from(chunk).subarray(0, remaining);
      retained += bounded.toString('utf8');
      retainedBytes += bounded.byteLength;
    });
    stderr.resume();
    query.once('error', () => {
      clearTimeout(timeout);
      rejectOutput(
        new ApplicationError(
          'PROVIDER_EXECUTION_FAILED',
          'The provider process tree could not be verified.',
        ),
      );
    });
    query.once('close', (exitCode) => {
      clearTimeout(timeout);
      if (timedOut || exitCode !== 0) {
        rejectOutput(
          new ApplicationError(
            'PROVIDER_EXECUTION_FAILED',
            'The provider process tree could not be verified.',
          ),
        );
        return;
      }
      resolveOutput(retained);
    });
  });

  if (!/^\d+$/.test(output.trim())) {
    throw new ApplicationError(
      'PROVIDER_EXECUTION_FAILED',
      'The provider process tree could not be verified.',
    );
  }
  const descendantCount = Number(output);
  if (!Number.isSafeInteger(descendantCount) || descendantCount < 0) {
    throw new ApplicationError(
      'PROVIDER_EXECUTION_FAILED',
      'The provider process tree could not be verified.',
    );
  }
  return descendantCount;
}
function terminateWindowsTree(pid: number): void {
  const systemRoot = process.env.SystemRoot;
  if (systemRoot === undefined || !Number.isSafeInteger(pid) || pid <= 0) return;
  const executable = join(systemRoot, 'System32', 'taskkill.exe');
  spawnSync(executable, ['/pid', String(pid), '/T', '/F'], {
    shell: false,
    windowsHide: true,
    stdio: 'ignore',
  });
}

function canonicalDirectory(path: string, message: string): string {
  try {
    const metadata = lstatSync(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('unsafe directory');
    return realpathSync.native(path);
  } catch {
    throw new ApplicationError('VALIDATION_FAILED', message);
  }
}

function isContained(candidate: string, root: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}
