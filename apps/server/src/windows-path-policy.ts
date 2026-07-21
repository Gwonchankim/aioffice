import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { win32 } from 'node:path';

import { ApplicationError } from './errors.js';

export function canonicalProjectPath(input: string): string {
  if (
    input.length === 0 ||
    input.includes('\0') ||
    isDeviceOrUnc(input) ||
    !win32.isAbsolute(input) ||
    !/^[A-Za-z]:[\\/]/.test(input)
  ) {
    throw invalidPath();
  }
  const pieces = input.replaceAll('/', '\\').split('\\');
  if (pieces.slice(1).some((part) => part === '.' || part === '..' || part.includes(':'))) {
    throw invalidPath();
  }
  const lexical = win32.normalize(input);
  if (!existsSync(lexical)) throw invalidPath();
  let component = `${lexical.slice(0, 2)}\\`;
  const rest = lexical.slice(3).split('\\').filter(Boolean);
  for (const segment of rest) {
    component = win32.join(component, segment);
    try {
      const stats = lstatSync(component);
      if (stats.isSymbolicLink()) throw invalidPath();
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw invalidPath();
    }
  }
  try {
    const real = realpathSync.native(lexical);
    const normalizedReal = normalizeWindowsPath(real);
    if (!lstatSync(real).isDirectory()) throw invalidPath();
    return normalizedReal;
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw invalidPath();
  }
}

function isDeviceOrUnc(value: string): boolean {
  return (
    value.startsWith('\\\\') ||
    value.startsWith('//') ||
    value.startsWith('\\?\\') ||
    value.startsWith('\\.\\') ||
    /^[A-Za-z]:[^\\/]/.test(value) ||
    value.includes(':', 2)
  );
}

function normalizeWindowsPath(value: string): string {
  const normalized = win32
    .normalize(value)
    .replaceAll('/', '\\')
    .replace(/^\\\\\?\\/, '');
  return normalized.replace(/\\+$/, '').toLowerCase();
}

function invalidPath(): ApplicationError {
  return new ApplicationError(
    'VALIDATION_FAILED',
    'The repository path must be an existing canonical local directory.',
    { statusCode: 422 },
  );
}
