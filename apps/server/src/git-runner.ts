import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, win32 } from 'node:path';

import { ApplicationError } from './errors.js';

export interface GitStatus {
  readonly defaultBranch: string;
  readonly currentBranch: string | null;
  readonly headSha: string;
  readonly dirty: boolean;
}

export interface RepositorySnapshot extends GitStatus {
  readonly indexHash: string;
  readonly trackedHash: string;
  readonly untrackedHash: string;
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

  public validate(root: string, defaultBranch: string): GitStatus {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/.test(defaultBranch) ||
      defaultBranch.includes('..') ||
      defaultBranch.startsWith('-')
    ) {
      throw new ApplicationError('VALIDATION_FAILED', 'The requested default branch is invalid.', {
        statusCode: 422,
      });
    }

    const canonicalRoot = canonicalDirectory(root);
    if (this.run(canonicalRoot, ['rev-parse', '--is-inside-work-tree']) !== 'true')
      throw invalidRepository();
    if (
      !samePath(
        canonicalDirectory(this.run(canonicalRoot, ['rev-parse', '--show-toplevel'])),
        canonicalRoot,
      )
    )
      throw invalidRepository();

    this.run(canonicalRoot, ['rev-parse', '--verify', `refs/heads/${defaultBranch}^{commit}`]);
    const headSha = this.run(canonicalRoot, ['rev-parse', 'HEAD']);
    const currentBranch = this.currentBranch(canonicalRoot);
    const dirty =
      this.runBuffer(canonicalRoot, ['status', '--porcelain=v1', '--untracked-files=all', '-z'])
        .length > 0;

    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(headSha)) throw invalidRepository();
    return { defaultBranch, currentBranch, headSha, dirty };
  }

  public snapshot(root: string, defaultBranch: string): RepositorySnapshot {
    const canonicalRoot = canonicalDirectory(root);
    const status = this.validate(canonicalRoot, defaultBranch);
    const indexPath = this.resolveIndexPath(canonicalRoot);
    const trackedHash = snapshotGitPaths(
      canonicalRoot,
      this.runBuffer(canonicalRoot, ['ls-files', '--cached', '-z']),
    );
    const untrackedHash = snapshotUntrackedPaths(
      canonicalRoot,
      this.runBuffer(canonicalRoot, ['status', '--porcelain=v1', '--untracked-files=all', '-z']),
    );

    return {
      ...status,
      indexHash: hash(readFileSync(indexPath)),
      trackedHash,
      untrackedHash,
      filesHash: snapshotTree(canonicalRoot),
    };
  }

  private currentBranch(root: string): string | null {
    const result = this.execute(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (result.status === 1 && result.error === undefined) return null;
    if (result.status !== 0 || result.error !== undefined) throw invalidRepository();
    return decodeLine(result.stdout);
  }

  private resolveIndexPath(root: string): string {
    const administrativeDirectory = administrativeGitDirectory(root);
    const gitPath = this.run(root, ['rev-parse', '--git-path', 'index']);
    if (gitPath.length === 0 || gitPath.includes('\0') || /[\r\n]/.test(gitPath))
      throw invalidRepository();

    const candidate =
      isAbsolute(gitPath) || win32.isAbsolute(gitPath) ? gitPath : resolve(root, gitPath);
    const canonicalIndex = canonicalRegularFile(candidate);
    if (!isContained(canonicalIndex, administrativeDirectory)) throw invalidRepository();
    return canonicalIndex;
  }

  private run(root: string, command: readonly string[]): string {
    return decodeLine(this.runBuffer(root, command));
  }

  private runBuffer(root: string, command: readonly string[]): Buffer {
    const result = this.execute(root, command);
    if (result.status !== 0 || result.error !== undefined) throw invalidRepository();
    return result.stdout;
  }

  private execute(root: string, command: readonly string[]) {
    return spawnSync(
      this.executable,
      [
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
      ],
      {
        cwd: root,
        env: sanitizedEnvironment(this.baseEnvironment, this.runtimeDirectory),
        shell: false,
        windowsHide: true,
        timeout: 10_000,
      },
    );
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

function administrativeGitDirectory(root: string): string {
  const gitPath = join(root, '.git');
  try {
    const stats = lstatSync(gitPath);
    if (stats.isSymbolicLink()) throw invalidRepository();
    if (stats.isDirectory()) return canonicalDirectory(gitPath);
    if (!stats.isFile()) throw invalidRepository();

    const administrativeDirectory = parseGitdirPointer(gitPath, root, true);
    const backReference = join(administrativeDirectory, 'gitdir');
    const expectedPointer = canonicalRegularFile(gitPath);
    if (
      !samePath(parseGitdirBackReference(backReference, administrativeDirectory), expectedPointer)
    )
      throw invalidRepository();
    return administrativeDirectory;
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw invalidRepository();
  }
}

function parseGitdirPointer(pointerPath: string, relativeBase: string, directory: boolean): string {
  const stats = lstatSync(pointerPath);
  if (stats.isSymbolicLink() || !stats.isFile()) throw invalidRepository();

  const target = pointerFileValue(readFileSync(pointerPath, 'utf8'), true);
  const candidate =
    isAbsolute(target) || win32.isAbsolute(target) ? target : resolve(relativeBase, target);
  return directory ? canonicalDirectory(candidate) : canonicalRegularFile(candidate);
}

function parseGitdirBackReference(pointerPath: string, relativeBase: string): string {
  const stats = lstatSync(pointerPath);
  if (stats.isSymbolicLink() || !stats.isFile()) throw invalidRepository();

  const target = pointerFileValue(readFileSync(pointerPath, 'utf8'), false);
  const candidate =
    isAbsolute(target) || win32.isAbsolute(target) ? target : resolve(relativeBase, target);
  return canonicalRegularFile(candidate);
}

function pointerFileValue(raw: string, gitdirPrefix: boolean): string {
  const content = raw.endsWith('\r\n')
    ? raw.slice(0, -2)
    : raw.endsWith('\n')
      ? raw.slice(0, -1)
      : raw;
  const pattern = gitdirPrefix ? /^gitdir: ([^\0\r\n]+)$/ : /^([^\0\r\n]+)$/;
  const target = pattern.exec(content)?.[1];
  if (target === undefined) throw invalidRepository();
  return target;
}
function canonicalDirectory(path: string): string {
  try {
    const stats = lstatSync(path);
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw invalidRepository();
    return realpathSync.native(path);
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw invalidRepository();
  }
}

function canonicalRegularFile(path: string): string {
  try {
    const stats = lstatSync(path);
    if (stats.isSymbolicLink() || !stats.isFile()) throw invalidRepository();
    return realpathSync.native(path);
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw invalidRepository();
  }
}

function decodeLine(value: Buffer): string {
  const decoded = value.toString('utf8');
  if (decoded.endsWith('\r\n')) return decoded.slice(0, -2);
  if (decoded.endsWith('\n')) return decoded.slice(0, -1);
  return decoded;
}

function isContained(path: string, directory: string): boolean {
  const child = relative(directory, path);
  return (
    child.length > 0 &&
    child !== '..' &&
    !child.startsWith(`..${win32.sep}`) &&
    !child.startsWith('../') &&
    !isAbsolute(child) &&
    !win32.isAbsolute(child)
  );
}

function samePath(left: string, right: string): boolean {
  return resolve(left).toLowerCase() === resolve(right).toLowerCase();
}

function snapshotGitPaths(root: string, output: Buffer): string {
  return hash(
    nulDelimitedPaths(output)
      .map((path) => fileManifestEntry(root, path))
      .sort()
      .join('\n'),
  );
}

function snapshotUntrackedPaths(root: string, output: Buffer): string {
  const records = nulDelimitedPaths(output);
  const entries: string[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined || record.length < 4 || record.charAt(2) !== ' ')
      throw invalidRepository();

    const status = record.slice(0, 2);
    const path = record.slice(3);
    if (status === '??') entries.push(fileManifestEntry(root, path));

    if (status.includes('R') || status.includes('C')) {
      const originalPath = records[index + 1];
      if (originalPath === undefined) throw invalidRepository();
      repositoryFile(root, originalPath);
      index += 1;
    }
  }

  return hash(entries.sort().join('\n'));
}

function nulDelimitedPaths(output: Buffer): string[] {
  const value = output.toString('utf8');
  if (value.length === 0) return [];
  if (!value.endsWith('\0')) throw invalidRepository();
  return value.slice(0, -1).split('\0');
}

function fileManifestEntry(root: string, path: string): string {
  const file = repositoryFile(root, path);
  return `${path}\0${hash(readFileSync(file))}`;
}

function repositoryFile(root: string, path: string): string {
  if (
    path.length === 0 ||
    path.includes('\0') ||
    isAbsolute(path) ||
    win32.isAbsolute(path) ||
    path
      .split(/[\\/]/u)
      .some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  )
    throw invalidRepository();

  const candidate = resolve(root, path);
  if (!isContained(candidate, root)) throw invalidRepository();
  try {
    const stats = lstatSync(candidate);
    if (stats.isSymbolicLink() || !stats.isFile()) throw invalidRepository();
    return candidate;
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw invalidRepository();
  }
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
      else throw invalidRepository();
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
    'The repository must be a valid local Git worktree with the requested default branch.',
    { statusCode: 422 },
  );
}
