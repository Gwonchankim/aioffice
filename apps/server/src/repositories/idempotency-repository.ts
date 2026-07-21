import type { DatabaseSync } from 'node:sqlite';

import { ApplicationError } from '../errors.js';
import { withImmediateTransaction } from '../database.js';

export interface IdempotencyRecord {
  readonly scopeHash: string;
  readonly operation: string;
  readonly keyHash: string;
  readonly bodyHash: string;
  readonly state: 'in_progress' | 'completed';
  readonly responseStatus: number | null;
  readonly responseBody: unknown | null;
  readonly expiresAt: string;
}

export class IdempotencyRepository {
  public constructor(
    private readonly database: DatabaseSync,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public reserve(
    scopeHash: string,
    operation: string,
    keyHash: string,
    bodyHash: string,
    expiresAt: string,
  ):
    | { readonly kind: 'reserved' }
    | { readonly kind: 'replay'; readonly record: IdempotencyRecord } {
    return withImmediateTransaction(this.database, () => {
      this.database
        .prepare('DELETE FROM idempotency_records WHERE expires_at <= ?')
        .run(this.now().toISOString());
      const existing = this.find(scopeHash, operation, keyHash);
      if (existing !== undefined) {
        if (existing.bodyHash !== bodyHash) {
          throw new ApplicationError(
            'IDEMPOTENCY_CONFLICT',
            'The idempotency key was previously used with a different request.',
            { statusCode: 409 },
          );
        }
        return { kind: 'replay', record: existing };
      }
      this.database
        .prepare(
          `INSERT INTO idempotency_records (scope_hash, operation, key_hash, body_hash, state, response_status, response_body_json, created_at, completed_at, expires_at)
        VALUES (?, ?, ?, ?, 'in_progress', NULL, NULL, ?, NULL, ?)`,
        )
        .run(scopeHash, operation, keyHash, bodyHash, this.now().toISOString(), expiresAt);
      return { kind: 'reserved' };
    });
  }

  public complete(
    scopeHash: string,
    operation: string,
    keyHash: string,
    status: number,
    body: unknown,
  ): void {
    const json = JSON.stringify(body);
    JSON.parse(json) as unknown;
    const result = this.database
      .prepare(
        `UPDATE idempotency_records SET state = 'completed', response_status = ?, response_body_json = ?, completed_at = ?
      WHERE scope_hash = ? AND operation = ? AND key_hash = ? AND state = 'in_progress'`,
      )
      .run(status, json, this.now().toISOString(), scopeHash, operation, keyHash);
    if (result.changes !== 1) {
      throw new ApplicationError(
        'IDEMPOTENCY_CONFLICT',
        'The idempotency reservation was not available.',
        { statusCode: 409 },
      );
    }
  }

  public discard(scopeHash: string, operation: string, keyHash: string): void {
    this.database
      .prepare(
        `DELETE FROM idempotency_records WHERE scope_hash = ? AND operation = ? AND key_hash = ? AND state = 'in_progress'`,
      )
      .run(scopeHash, operation, keyHash);
  }

  public find(
    scopeHash: string,
    operation: string,
    keyHash: string,
  ): IdempotencyRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT scope_hash, operation, key_hash, body_hash, state, response_status, response_body_json, expires_at
      FROM idempotency_records WHERE scope_hash = ? AND operation = ? AND key_hash = ?`,
      )
      .get(scopeHash, operation, keyHash) as IdempotencyRow | undefined;
    return row === undefined ? undefined : rowToRecord(row);
  }
}

type IdempotencyRow = {
  readonly scope_hash: string;
  readonly operation: string;
  readonly key_hash: string;
  readonly body_hash: string;
  readonly state: 'in_progress' | 'completed';
  readonly response_status: number | null;
  readonly response_body_json: string | null;
  readonly expires_at: string;
};
function rowToRecord(row: IdempotencyRow): IdempotencyRecord {
  return {
    scopeHash: row.scope_hash,
    operation: row.operation,
    keyHash: row.key_hash,
    bodyHash: row.body_hash,
    state: row.state,
    responseStatus: row.response_status,
    responseBody: row.response_body_json === null ? null : JSON.parse(row.response_body_json),
    expiresAt: row.expires_at,
  };
}
