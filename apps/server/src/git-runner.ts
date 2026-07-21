import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { ApplicationError } from './errors.js';

export interface GitStatus {
  readonly headSha: string;
  readonly branch: string;
  readonly dirty: boolean;
}

export interface RepositorySnapshot extends GitStatus {
  readonly indexHash: string;
  readonly filesHash: string;
}

export class GitReadRunner {
  private readonly executable: string;

  public constructor(
    executable: string,
    private readonly runtimeDirectory: string,
    private readonly baseEnvironment: NodeJS.ProcessEnv = process.env,
  ) {
    this.executable = resolveTrustedGitExecutable(executable);
  }

  public validate(root: string, branch: string): GitStatus {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/.test(branch) ||
      branch.includes('..') ||
      branch.startsWith('-')
    ) {
      throw new ApplicationError('VALIDATION_FAILED', 'The requested default branch is invalid.', {
        statusCode: 422,
      });
    }
    if (this.run(root, ['rev-parse', '--is-inside-work-tree']) !== 'true')
      throw invalidRepository();
    if (
      resolve(this.run(root, ['rev-parse', '--show-toplevel'])).toLowerCase() !==
      resolve(root).toLowerCase()
    )
      throw invalidRepository();
    this.run(root, ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`]);
    const headSha = this.run(root, ['rev-parse', 'HEAD']);
    const actualBranch = this.run(root, ['symbolic-ref', '--short', 'HEAD']);
    const dirty = this.run(root, ['status', '--porcelain=v1', '--untracked-files=all']).length > 0;
    if (actualBranch !== branch || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(headSha))
      throw invalidRepository();
    return { headSha, branch: actualBranch, dirty };
  }

  public snapshot(root: string, branch: string): RepositorySnapshot {
    const status = this.validate(root, branch);
    const index = join(root, '.git', 'index');
    if (!existsSync(index)) throw invalidRepository();
    return {
      ...status,
      indexHash: hash(readFileSync(index)),
      filesHash: snapshotTree(root),
    };
  }

  private run(root: string, command: readonly string[]): string {
    const args = [
      '--no-optional-locks',
      '-c',
      `core.hooksPath=${join(this.runtimeDirectory, 'git-empty-hooks')}`,
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.untrackedCache=false',
      '-c',
      'core.preloadIndex=false',
      '-c',
      'credential.helper=',
      ...command,
    ];
    const result = spawnSync(this.executable, args, {
      cwd: root,
      env: sanitizedEnvironment(this.baseEnvironment, this.runtimeDirectory),
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      timeout: 10_000,
    });
    if (result.status !== 0 || result.error !== undefined) throw invalidRepository();
    return result.stdout.trim();
  }
}
export function resolveTrustedGitExecutable(executable: string): string {
  if (!isAbsolute(executable)) {
    throw new ApplicationError(
      'DATABASE_CONFIGURATION_FAILED',
      'The configured Git executable must be an absolute trusted path.',
    );
  }
  try {
    const canonical = realpathSync.native(executable);
    if (!existsSync(canonical) || !lstatSync(canonical).isFile()) throw new Error('not a file');
    return canonical;
  } catch {
    throw new ApplicationError(
      'DATABASE_CONFIGURATION_FAILED',
      'The configured Git executable is not available.',
    );
  }
}

function sanitizedEnvironment(
  source: NodeJS.ProcessEnv,
  runtimeDirectory: string,
): NodeJS.ProcessEnv {
  const home = join(runtimeDirectory, 'git-home');
  return {
    PATH: source.PATH,
    SystemRoot: source.SystemRoot,
    SystemDrive: source.SystemDrive,
    ComSpec: source.ComSpec,
    TEMP: source.TEMP,
    TMP: source.TMP,
    HOME: home,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(runtimeDirectory, 'git-empty-config'),
    GIT_PAGER: 'cat',
  };
}

function snapshotTree(root: string): string {
  const entries: string[] = [];
  const visit = (directory: string): void => {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      if (item.name === '.git') continue;
      const path = join(directory, item.name);
      const relativePath = relative(root, path).replaceAll('\\', '/');
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw invalidRepository();
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) entries.push(`${relativePath}\0${hash(readFileSync(path))}`);
    }
  };
  visit(root);
  return hash(entries.sort().join('\n'));
}

function hash(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
function invalidRepository(): ApplicationError {
  return new ApplicationError(
    'VALIDATION_FAILED',
    'The repository must be a valid local Git worktree on its default branch.',
    { statusCode: 422 },
  );
}
