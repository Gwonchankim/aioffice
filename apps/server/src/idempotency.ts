import { createHash } from 'node:crypto';

import { ApplicationError } from './errors.js';
import { canonicalJson } from './project-policy.js';
import type {
  IdempotencyRecord,
  IdempotencyRepository,
} from './repositories/idempotency-repository.js';

export interface IdempotentResponse {
  readonly statusCode: number;
  readonly body: unknown;
}

export class IdempotencyService {
  public constructor(
    private readonly records: IdempotencyRepository,
    private readonly now: () => Date = () => new Date(),
    private readonly waitTimeoutMilliseconds = 1_000,
    private readonly pollIntervalMilliseconds = 10,
  ) {}

  public async execute(
    scopeHash: string,
    operation: string,
    key: string,
    validatedBody: unknown,
    handler: () => Promise<IdempotentResponse> | IdempotentResponse,
  ): Promise<IdempotentResponse> {
    const reservation = this.reserve(scopeHash, operation, key, validatedBody);
    if (reservation.kind === 'replay')
      return this.waitForReplay(reservation.record, scopeHash, operation, reservation.keyHash);
    try {
      const result = await handler();
      this.records.complete(
        scopeHash,
        operation,
        reservation.keyHash,
        result.statusCode,
        result.body,
      );
      return result;
    } catch (error) {
      this.records.discard(scopeHash, operation, reservation.keyHash);
      throw error;
    }
  }

  public async executeAtomic(
    scopeHash: string,
    operation: string,
    key: string,
    validatedBody: unknown,
    handler: () => IdempotentResponse,
  ): Promise<IdempotentResponse> {
    const reservation = this.reserve(scopeHash, operation, key, validatedBody);
    if (reservation.kind === 'replay')
      return this.waitForReplay(reservation.record, scopeHash, operation, reservation.keyHash);
    try {
      return this.records.completeWithMutation(scopeHash, operation, reservation.keyHash, handler);
    } catch (error) {
      this.records.discard(scopeHash, operation, reservation.keyHash);
      throw error;
    }
  }

  private reserve(
    scopeHash: string,
    operation: string,
    key: string,
    validatedBody: unknown,
  ):
    | { readonly kind: 'reserved'; readonly keyHash: string }
    | { readonly kind: 'replay'; readonly record: IdempotencyRecord; readonly keyHash: string } {
    const keyHash = sha256(key);
    const bodyHash = sha256(canonicalJson(validatedBody));
    const expiresAt = new Date(this.now().getTime() + 24 * 60 * 60 * 1000).toISOString();
    const reservation = this.records.reserve(scopeHash, operation, keyHash, bodyHash, expiresAt);
    return reservation.kind === 'reserved'
      ? { kind: 'reserved', keyHash }
      : { ...reservation, keyHash };
  }

  private async waitForReplay(
    record: IdempotencyRecord,
    scopeHash: string,
    operation: string,
    keyHash: string,
  ): Promise<IdempotentResponse> {
    let current = record;
    const deadline = Date.now() + this.waitTimeoutMilliseconds;
    while (true) {
      if (
        current.state === 'completed' &&
        current.responseStatus !== null &&
        current.responseBody !== null
      ) {
        return { statusCode: current.responseStatus, body: current.responseBody };
      }
      if (Date.now() >= deadline) {
        throw new ApplicationError(
          'IDEMPOTENCY_CONFLICT',
          'The same request is still in progress.',
          { statusCode: 409, retryable: true },
        );
      }
      await delay(this.pollIntervalMilliseconds);
      const persisted = this.records.find(scopeHash, operation, keyHash);
      if (persisted === undefined) {
        throw new ApplicationError(
          'IDEMPOTENCY_CONFLICT',
          'The idempotency reservation was not completed.',
          { statusCode: 409, retryable: true },
        );
      }
      current = persisted;
    }
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
