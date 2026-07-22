import { closeSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, relative, win32 } from 'node:path';

import { ApplicationError } from '../errors.js';

const DISALLOWED_EXECUTABLE_NAMES = new Set([
  'node.exe',
  'node',
  'npm.exe',
  'npm',
  'npx.exe',
  'npx',
  'pnpm.exe',
  'pnpm',
  'powershell.exe',
  'powershell',
  'pwsh.exe',
  'pwsh',
  'cmd.exe',
  'cmd',
]);

export interface TrustedProviderExecutableOptions {
  readonly projectRoots?: readonly string[];
}

/** Resolves only an administrator-configured native PE executable; it never searches PATH. */
export function resolveTrustedProviderExecutable(
  configuredPath: string,
  options: TrustedProviderExecutableOptions = {},
): string {
  if (
    (!isAbsolute(configuredPath) && !win32.isAbsolute(configuredPath)) ||
    configuredPath.includes('\0')
  ) {
    throw invalidExecutable();
  }
  if (!configuredPath.toLowerCase().endsWith('.exe')) throw invalidExecutable();

  let canonicalPath: string;
  try {
    const sourceStats = lstatSync(configuredPath);
    if (!sourceStats.isFile() || sourceStats.isSymbolicLink()) throw new Error('unsafe executable');
    canonicalPath = realpathSync.native(configuredPath);
    const canonicalStats = lstatSync(canonicalPath);
    if (!canonicalStats.isFile() || canonicalStats.isSymbolicLink() || !isNativePe(canonicalPath)) {
      throw new Error('unsafe executable');
    }
  } catch {
    throw invalidExecutable();
  }

  const name = basename(canonicalPath).toLowerCase();
  if (
    DISALLOWED_EXECUTABLE_NAMES.has(name) ||
    isWithinProjectRoot(canonicalPath, options.projectRoots ?? [])
  ) {
    throw invalidExecutable();
  }
  return canonicalPath;
}

function isNativePe(path: string): boolean {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, 'r');
    const header = Buffer.alloc(4096);
    const bytesRead = readSync(descriptor, header, 0, header.length, 0);
    if (bytesRead < 64 || header[0] !== 0x4d || header[1] !== 0x5a) return false;
    const peOffset = header.readUInt32LE(0x3c);
    return (
      peOffset >= 64 &&
      peOffset + 4 <= bytesRead &&
      header[peOffset] === 0x50 &&
      header[peOffset + 1] === 0x45 &&
      header[peOffset + 2] === 0 &&
      header[peOffset + 3] === 0
    );
  } catch {
    return false;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function isWithinProjectRoot(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => {
    try {
      const relativePath = relative(realpathSync.native(root), path);
      return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
    } catch {
      return false;
    }
  });
}

function invalidExecutable(): ApplicationError {
  return new ApplicationError(
    'PROVIDER_EXECUTABLE_INVALID',
    'The configured provider executable must be a trusted absolute native executable.',
  );
}
