import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ApplicationError } from './errors.js';

export type SqliteDatabase = DatabaseSync;

export interface DatabaseHandle {
  readonly database: DatabaseSync;
  readonly path: string;
  readonly close: () => void;
}

const workspaceRoot = resolve(fileURLToPath(new URL('../../../', import.meta.url)));

export function createDatabase(databasePath: string): DatabaseHandle {
  const resolvedPath = resolve(databasePath);
  rejectRepositoryDatabasePath(resolvedPath);

  try {
    mkdirSync(dirname(resolvedPath), { recursive: true });
  } catch {
    throw new ApplicationError(
      'DATABASE_OPEN_FAILED',
      'The runtime database directory could not be created.',
    );
  }

  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(resolvedPath);
    database.exec(
      'PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL;',
    );
    const mode = database.prepare('PRAGMA journal_mode = WAL').get() as { journal_mode?: unknown };
    if (String(mode.journal_mode).toLowerCase() !== 'wal') {
      throw new Error('WAL was not enabled.');
    }
    const foreignKeys = database.prepare('PRAGMA foreign_keys').get() as { foreign_keys?: unknown };
    if (Number(foreignKeys.foreign_keys) !== 1) {
      throw new Error('Foreign keys were not enabled.');
    }
  } catch {
    database?.close();
    throw new ApplicationError(
      'DATABASE_CONFIGURATION_FAILED',
      'The local database could not be configured.',
    );
  }

  return { database, path: resolvedPath, close: () => database.close() };
}

export function rejectRepositoryDatabasePath(databasePath: string): void {
  const relation = relative(workspaceRoot, databasePath);
  if (
    relation === '' ||
    (!relation.startsWith(`..${sep}`) && relation !== '..' && !relation.startsWith('..'))
  ) {
    throw new ApplicationError(
      'DATABASE_OPEN_FAILED',
      'The runtime database path must be outside the repository.',
    );
  }
}

export function withImmediateTransaction<T>(database: DatabaseSync, work: () => T): T {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // No partial transaction is allowed to escape this helper.
    }
    throw error;
  }
}

export function sqliteErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  for (const code of [
    'INVALID_STATE_TRANSITION',
    'IMMUTABLE_PROFILE_SNAPSHOT',
    'EVENTS_APPEND_ONLY',
    'AUDIT_APPEND_ONLY',
    'PROJECT_UNREGISTERED',
    'SEED_CONFLICT',
  ]) {
    if (error.message.includes(code)) {
      return code;
    }
  }
  return undefined;
}
