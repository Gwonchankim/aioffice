import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ProviderAuthorizationLedger,
  ProviderLedgerError,
  SMOKE_GRANT_OPTIONS,
  type GrantRequest,
} from '../provider-authorization-ledger.js';

const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function ledgerRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'orion-ledger-'));
  cleanup.push(root);
  return root;
}

const request: GrantRequest = {
  authorizationId: 'AUTH-2026-07-24-001',
  codexModel: 'gpt-5.1-codex',
  claudeModel: 'sonnet',
};

let clock = 0;
const now = () => new Date(1_800_000_000_000 + clock++ * 1000);

describe('ProviderAuthorizationLedger', () => {
  it('issues an immutable grant that is idempotent for identical terms and conflicts otherwise', () => {
    const ledger = new ProviderAuthorizationLedger(ledgerRoot(), { now });
    const first = ledger.grant(request);
    expect(first.providers.openai.model).toBe('gpt-5.1-codex');
    expect(first.providers.anthropic.model).toBe('sonnet');
    expect(first.providers.openai.maxInvocations).toBe(1);
    expect(first.options).toEqual(SMOKE_GRANT_OPTIONS);

    const again = ledger.grant(request);
    expect(again.createdAt).toBe(first.createdAt); // idempotent: first createdAt retained

    expect(() => ledger.grant({ ...request, claudeModel: 'opus' })).toThrow(
      expect.objectContaining({ code: 'PROVIDER_GRANT_CONFLICT' }),
    );
  });

  it('rejects a missing/malformed authorization id and a malformed model', () => {
    const ledger = new ProviderAuthorizationLedger(ledgerRoot(), { now });
    expect(() => ledger.grant({ ...request, authorizationId: 'bad id' })).toThrow(
      expect.objectContaining({ code: 'PROVIDER_GRANT_INVALID' }),
    );
    expect(() => ledger.grant({ ...request, codexModel: 'has space' })).toThrow(
      expect.objectContaining({ code: 'PROVIDER_GRANT_INVALID' }),
    );
  });

  it('claims the run once and denies every rerun of the same authorization id', () => {
    const root = ledgerRoot();
    const ledger = new ProviderAuthorizationLedger(root, { now });
    ledger.grant(request);
    expect(ledger.claimRun(request.authorizationId)).toBe(true);
    expect(ledger.claimRun(request.authorizationId)).toBe(false);
    // A fresh ledger instance over the same durable directory still sees the claim.
    const reopened = new ProviderAuthorizationLedger(root, { now });
    expect(reopened.claimRun(request.authorizationId)).toBe(false);
  });

  it('reserves exactly one slot per provider and reports a real cumulative used count', () => {
    const ledger = new ProviderAuthorizationLedger(ledgerRoot(), { now });
    ledger.grant(request);

    const codex = ledger.reserve(request.authorizationId, 'openai');
    expect(codex).toEqual({ provider: 'openai', ordinal: 1 });
    // A crash before recordOutcome still leaves the marker: the slot is USED.
    expect(ledger.usage(request.authorizationId, 'openai')).toEqual({ granted: 1, used: 1 });
    // Re-reserving the same provider is exhausted (one-time).
    expect(ledger.reserve(request.authorizationId, 'openai')).toBeNull();

    const claude = ledger.reserve(request.authorizationId, 'anthropic');
    expect(claude).toEqual({ provider: 'anthropic', ordinal: 1 });
    expect(ledger.usage(request.authorizationId, 'anthropic')).toEqual({ granted: 1, used: 1 });

    ledger.recordOutcome(request.authorizationId, codex!, { reachedStage: 'invocation_completed' });
    // recordOutcome never releases the slot.
    expect(ledger.usage(request.authorizationId, 'openai').used).toBe(1);
  });

  it('returns null when reserving against an unknown authorization id and reports zero usage', () => {
    const ledger = new ProviderAuthorizationLedger(ledgerRoot(), { now });
    expect(ledger.reserve('AUTH-UNKNOWN', 'openai')).toBeNull();
    expect(ledger.usage('AUTH-UNKNOWN', 'openai')).toEqual({ granted: 0, used: 0 });
    expect(ledger.readGrant('AUTH-UNKNOWN')).toBeUndefined();
  });

  it('fails closed on a corrupt grant record', () => {
    const root = ledgerRoot();
    const ledger = new ProviderAuthorizationLedger(root, { now });
    ledger.grant(request);
    writeFileSync(join(root, request.authorizationId, 'grant.json'), '{ not valid json');
    expect(() => ledger.readGrant(request.authorizationId)).toThrow(
      expect.objectContaining({ code: 'PROVIDER_GRANT_CORRUPT' }),
    );
    expect(() => ledger.reserve(request.authorizationId, 'openai')).toThrow(
      expect.objectContaining({ code: 'PROVIDER_GRANT_CORRUPT' }),
    );
  });

  it('rejects unsafe ledger roots: relative, UNC, repo-tree, and forbidden-root containment', () => {
    expect(() => new ProviderAuthorizationLedger('relative\\path')).toThrow(
      expect.objectContaining({ code: 'PROVIDER_LEDGER_PATH_UNSAFE' }),
    );
    expect(() => new ProviderAuthorizationLedger('\\\\server\\share\\ledger')).toThrow(
      expect.objectContaining({ code: 'PROVIDER_LEDGER_PATH_UNSAFE' }),
    );
    expect(() => new ProviderAuthorizationLedger('C:\\repo\\.orion\\ledger')).toThrow(
      expect.objectContaining({ code: 'PROVIDER_LEDGER_PATH_UNSAFE' }),
    );

    const forbidden = ledgerRoot();
    expect(
      () =>
        new ProviderAuthorizationLedger(join(forbidden, 'inside', 'ledger'), {
          forbiddenRoots: [forbidden],
        }),
    ).toThrow(expect.objectContaining({ code: 'PROVIDER_LEDGER_PATH_UNSAFE' }));

    // A sibling directory outside every forbidden root is accepted.
    const safe = mkdtempSync(join(tmpdir(), 'orion-ledger-safe-'));
    cleanup.push(safe);
    expect(
      () => new ProviderAuthorizationLedger(join(safe, 'ledger'), { forbiddenRoots: [forbidden] }),
    ).not.toThrow();
    expect(existsSync(join(safe, 'ledger'))).toBe(true);
  });

  it('surfaces a typed error class for callers to sanitize', () => {
    try {
      new ProviderAuthorizationLedger('relative');
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderLedgerError);
      expect((error as ProviderLedgerError).code).toBe('PROVIDER_LEDGER_PATH_UNSAFE');
    }
  });
});
