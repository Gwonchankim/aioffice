import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';

import { ApplicationError } from './errors.js';
import { withImmediateTransaction } from './database.js';

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly sql: string;
}

export interface AppliedMigration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
}

const migrationNamePattern = /^(\d{4})_([a-z0-9_]+)\.sql$/;
const defaultMigrationDirectory = resolve(
  fileURLToPath(new URL('../../../migrations/', import.meta.url)),
);

export function loadMigrations(directory = defaultMigrationDirectory): readonly Migration[] {
  const migrations = readdirSync(directory)
    .map((fileName) => {
      const match = migrationNamePattern.exec(fileName);
      if (match === null) {
        if (fileName.endsWith('.sql')) {
          throw new ApplicationError(
            'MIGRATION_FAILED',
            'A migration filename is not forward-only.',
          );
        }
        return undefined;
      }
      const version = Number(match[1]);
      const sql = readFileSync(resolve(directory, fileName), 'utf8');
      return {
        version,
        name: fileName,
        checksum: createHash('sha256').update(sql).digest('hex'),
        sql,
      };
    })
    .filter((migration): migration is Migration => migration !== undefined)
    .sort((left, right) => left.version - right.version);

  const versions = new Set<number>();
  for (const migration of migrations) {
    if (versions.has(migration.version)) {
      throw new ApplicationError(
        'MIGRATION_FAILED',
        'Duplicate migration versions are not permitted.',
      );
    }
    versions.add(migration.version);
  }
  return migrations;
}

export function applyMigrations(database: DatabaseSync, migrations = loadMigrations()): void {
  try {
    database.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )`);

    const applied = new Map<number, AppliedMigration>();
    for (const row of database
      .prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version')
      .all() as unknown as AppliedMigration[]) {
      applied.set(row.version, row);
    }

    for (const migration of migrations) {
      const historical = applied.get(migration.version);
      if (historical !== undefined) {
        if (historical.name !== migration.name || historical.checksum !== migration.checksum) {
          throw new ApplicationError(
            'MIGRATION_FAILED',
            'An applied migration does not match its immutable checksum.',
          );
        }
        continue;
      }
      withImmediateTransaction(database, () => {
        database.exec(migration.sql);
        database
          .prepare(
            'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
          )
          .run(migration.version, migration.name, migration.checksum, new Date().toISOString());
      });
    }
  } catch (error) {
    if (error instanceof ApplicationError) {
      throw error;
    }
    throw new ApplicationError(
      'MIGRATION_FAILED',
      'The local database migration could not be applied.',
    );
  }
}

export function migrationDirectory(): string {
  return defaultMigrationDirectory;
}
