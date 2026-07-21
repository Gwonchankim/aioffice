import type { FastifyRequest } from 'fastify';

import { ApplicationError } from './errors.js';
import type { Session, SessionManager } from './session.js';
import { constantTimeEqual, parseSessionCookie } from './session.js';

export interface RequestSecurityOptions {
  readonly origin: string;
  readonly host: string;
  readonly sessions: SessionManager;
}

export function assertHost(request: FastifyRequest, options: RequestSecurityOptions): void {
  if (request.headers.host !== options.host) {
    throw new ApplicationError('HOST_REJECTED', 'The request host is not loopback.', {
      statusCode: 403,
    });
  }
}

export function assertOrigin(request: FastifyRequest, options: RequestSecurityOptions): void {
  if (request.headers.origin !== options.origin) {
    throw new ApplicationError('ORIGIN_REJECTED', 'The request origin is not allowed.', {
      statusCode: 403,
    });
  }
}

export function requireMutationSession(
  request: FastifyRequest,
  options: RequestSecurityOptions,
): Session {
  assertOrigin(request, options);
  const session = options.sessions.require(parseSessionCookie(request.headers.cookie));
  const csrf = request.headers['x-csrf-token'];
  if (typeof csrf !== 'string' || !constantTimeEqual(session.csrfToken, csrf)) {
    throw new ApplicationError('CSRF_REJECTED', 'The CSRF token is invalid.', { statusCode: 403 });
  }
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || key.length < 1 || key.length > 256) {
    throw new ApplicationError('IDEMPOTENCY_REQUIRED', 'An Idempotency-Key header is required.', {
      statusCode: 400,
    });
  }
  return session;
}

export function idempotencyKey(request: FastifyRequest): string {
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string')
    throw new ApplicationError('IDEMPOTENCY_REQUIRED', 'An Idempotency-Key header is required.', {
      statusCode: 400,
    });
  return key;
}
