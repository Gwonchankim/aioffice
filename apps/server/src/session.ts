import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { ApplicationError } from './errors.js';

export interface Session {
  readonly id: string;
  readonly scopeHash: string;
  readonly csrfToken: string;
  readonly expiresAt: number;
}

export class SessionManager {
  private bootstrapToken: string;
  private readonly sessions = new Map<string, Session>();

  public constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly lifetimeMs = 60 * 60 * 1000,
    bootstrapToken?: string,
  ) {
    this.bootstrapToken = bootstrapToken ?? randomToken(32);
  }

  public takeBootstrapToken(): string {
    return this.bootstrapToken;
  }

  public bootstrap(token: string): { readonly cookie: string; readonly session: Session } {
    if (this.bootstrapToken.length === 0 || !constantTimeEqual(this.bootstrapToken, token)) {
      throw new ApplicationError('SESSION_REQUIRED', 'The bootstrap token is invalid.', {
        statusCode: 401,
      });
    }
    this.bootstrapToken = '';
    const cookie = randomToken(32);
    const session: Session = {
      id: cookie,
      scopeHash: sha256(cookie),
      csrfToken: randomToken(32),
      expiresAt: this.now().getTime() + this.lifetimeMs,
    };
    this.sessions.set(cookie, session);
    return { cookie, session };
  }

  public require(cookie: string | undefined): Session {
    if (cookie === undefined)
      throw new ApplicationError('SESSION_REQUIRED', 'A local session is required.', {
        statusCode: 401,
      });
    const session = this.sessions.get(cookie);
    if (session === undefined || session.expiresAt <= this.now().getTime()) {
      this.sessions.delete(cookie);
      throw new ApplicationError('SESSION_REQUIRED', 'A local session is required.', {
        statusCode: 401,
      });
    }
    return session;
  }
}

export function parseSessionCookie(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  return header
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('orion_session='))
    ?.slice('orion_session='.length);
}

export function secureSessionCookie(value: string, maxAgeSeconds = 3600): string {
  return `orion_session=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

export function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function randomToken(bytes: number): string {
  return randomBytes(bytes).toString('base64url');
}
function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
