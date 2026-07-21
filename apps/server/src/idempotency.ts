import { createHash } from 'node:crypto';

import { ApplicationError } from './errors.js';
import { canonicalJson } from './project-policy.js';
import type { IdempotencyRepository } from './repositories/idempotency-repository.js';

export interface IdempotentResponse {
  readonly statusCode: number;
  readonly body: unknown;
}

export class IdempotencyService {
  public constructor(
    private readonly records: IdempotencyRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async execute(
    scopeHash: string,
    operation: string,
    key: string,
    validatedBody: unknown,
    handler: () => Promise<IdempotentResponse> | IdempotentResponse,
  ): Promise<IdempotentResponse> {
    const keyHash = sha256(key);
    const bodyHash = sha256(canonicalJson(validatedBody));
    const expiresAt = new Date(this.now().getTime() + 24 * 60 * 60 * 1000).toISOString();
    const reservation = this.records.reserve(scopeHash, operation, keyHash, bodyHash, expiresAt);
    if (reservation.kind === 'replay') {
      if (
        reservation.record.state !== 'completed' ||
        reservation.record.responseStatus === null ||
        reservation.record.responseBody === null
      ) {
        throw new ApplicationError(
          'IDEMPOTENCY_CONFLICT',
          'The same request is still in progress.',
          { statusCode: 409, retryable: true },
        );
      }
      return {
        statusCode: reservation.record.responseStatus,
        body: reservation.record.responseBody,
      };
    }
    try {
      const result = await handler();
      this.records.complete(scopeHash, operation, keyHash, result.statusCode, result.body);
      return result;
    } catch (error) {
      this.records.discard(scopeHash, operation, keyHash);
      throw error;
    }
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
