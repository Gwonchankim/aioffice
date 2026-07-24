import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ProviderAuthorizationLedger,
  ProviderLedgerError,
  SMOKE_GRANT_OPTIONS,
  type AuthorizationGrant,
  type GrantRequest,
  type ProviderBinding,
  type SmokeProviderKey,
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

const FINGERPRINT = 'a'.repeat(64);
function binding(provider: SmokeProviderKey, model: string): ProviderBinding {
  return {
    provider,
    model,
    executableBasename: provider === 'openai' ? 'codex.exe' : 'claude.exe',
    executableFingerprint: FINGERPRINT,
    cliVersion: provider === 'openai' ? '0.145.0' : '2.1.156',
  };
}

const request: GrantRequest = {
  authorizationId: 'AUTH-2026-07-24-001',
  providers: {
    openai: { model: 'gpt-5.1-codex', binding: binding('openai', 'gpt-5.1-codex') },
    anthropic: { model: 'sonnet', binding: binding('anthropic', 'sonnet') },
  },
  policy: {
    argvPolicyVersion: 2,
    schemaHash: 'b'.repeat(64),
    promptHash: 'c'.repeat(64),
    repositoryTemplateVersion: 1,
  },
};

let clock = 0;
const now = () => new Date(1_800_000_000_000 + clock++ * 1000);

function grantFilePath(root: string, authId: string): string {
  return join(root, authId, 'grant.json');
}

describe('ProviderAuthorizationLedger (v2)', () => {
  it('issues an immutable v2 grant with bindings + policy that is idempotent and conflict-safe', () => {
    const ledger = new ProviderAuthorizationLedger(ledgerRoot(), { now });
    const grant = ledger.grant(request);
    expect(grant.schemaVersion).toBe(2);
    expect(grant.providers.openai).toMatchObject({ model: 'gpt-5.1-codex', maxInvocations: 1 });
    expect(grant.providers.openai.binding).toMatchObject({
      provider: 'openai',
      executableBasename: 'codex.exe',
      executableFingerprint: FINGERPRINT,
      cliVersion: '0.145.0',
    });
    expect(grant.options).toMatchObject({
      ...SMOKE_GRANT_OPTIONS,
      argvPolicyVersion: 2,
      schemaHash: 'b'.repeat(64),
      promptHash: 'c'.repeat(64),
      repositoryTemplateVersion: 1,
    });

    const again = ledger.grant(request);
    expect(again.createdAt).toBe(grant.createdAt); // idempotent

    expect(() =>
      ledger.grant({
        ...request,
        providers: {
          ...request.providers,
          anthropic: { model: 'opus', binding: binding('anthropic', 'opus') },
        },
      }),
    ).toThrow(expect.objectContaining({ code: 'PROVIDER_GRANT_CONFLICT' }));
  });

  it('rejects malformed grant inputs (id, model, binding provider/model/fingerprint)', () => {
    const ledger = new ProviderAuthorizationLedger(ledgerRoot(), { now });
    expect(() => ledger.grant({ ...request, authorizationId: 'bad id' })).toThrow(
      expect.objectContaining({ code: 'PROVIDER_GRANT_INVALID' }),
    );
    const bad = (mutation: Partial<ProviderBinding>): GrantRequest => ({
      ...request,
      providers: {
        ...request.providers,
        openai: {
          model: 'gpt-5.1-codex',
          binding: { ...binding('openai', 'gpt-5.1-codex'), ...mutation },
        },
      },
    });
    expect(() => ledger.grant(bad({ executableFingerprint: 'short' }))).toThrow(
      expect.objectContaining({ code: 'PROVIDER_GRANT_INVALID' }),
    );
    expect(() => ledger.grant(bad({ executableBasename: 'C:\\path\\codex.exe' }))).toThrow(
      expect.objectContaining({ code: 'PROVIDER_GRANT_INVALID' }),
    );
    expect(() => ledger.grant(bad({ cliVersion: 'not-a-version' }))).toThrow(
      expect.objectContaining({ code: 'PROVIDER_GRANT_INVALID' }),
    );
    expect(() => ledger.grant(bad({ provider: 'anthropic' as SmokeProviderKey }))).toThrow(
      expect.objectContaining({ code: 'PROVIDER_GRANT_INVALID' }),
    );
  });

  it('claims the run once and denies every rerun of the same authorization id', () => {
    const root = ledgerRoot();
    const ledger = new ProviderAuthorizationLedger(root, { now });
    ledger.grant(request);
    expect(ledger.claimRun(request.authorizationId)).toBe(true);
    expect(ledger.claimRun(request.authorizationId)).toBe(false);
    expect(new ProviderAuthorizationLedger(root, { now }).claimRun(request.authorizationId)).toBe(
      false,
    );
  });

  it('distinguishes reserved slots from durable spawn attempts in usage', () => {
    const ledger = new ProviderAuthorizationLedger(ledgerRoot(), { now });
    ledger.grant(request);

    const codex = ledger.reserve(request.authorizationId, 'openai');
    expect(codex).toEqual({ provider: 'openai', ordinal: 1 });
    // Crash after reserve, before spawn: reserved=1 but spawnAttempts still 0.
    expect(ledger.usage(request.authorizationId, 'openai')).toEqual({
      granted: 1,
      reserved: 1,
      spawnAttempts: 0,
    });
    // Re-reserving the same provider is exhausted (one-time).
    expect(ledger.reserve(request.authorizationId, 'openai')).toBeNull();

    // A spawn-attempt marker (written before the real spawn) survives a crash.
    ledger.markSpawnAttempt(request.authorizationId, 'openai', codex!.ordinal);
    expect(ledger.usage(request.authorizationId, 'openai')).toEqual({
      granted: 1,
      reserved: 1,
      spawnAttempts: 1,
    });
    // markSpawnAttempt is idempotent.
    ledger.markSpawnAttempt(request.authorizationId, 'openai', codex!.ordinal);
    expect(ledger.usage(request.authorizationId, 'openai').spawnAttempts).toBe(1);

    ledger.recordOutcome(request.authorizationId, codex!, { reachedStage: 'invocation_completed' });
    expect(ledger.usage(request.authorizationId, 'openai')).toEqual({
      granted: 1,
      reserved: 1,
      spawnAttempts: 1,
    });
    expect(ledger.usage(request.authorizationId, 'anthropic')).toEqual({
      granted: 1,
      reserved: 0,
      spawnAttempts: 0,
    });
  });

  it('returns null / zero usage for an unknown authorization id', () => {
    const ledger = new ProviderAuthorizationLedger(ledgerRoot(), { now });
    expect(ledger.reserve('AUTH-UNKNOWN', 'openai')).toBeNull();
    expect(ledger.usage('AUTH-UNKNOWN', 'openai')).toEqual({
      granted: 0,
      reserved: 0,
      spawnAttempts: 0,
    });
    expect(ledger.readGrant('AUTH-UNKNOWN')).toBeUndefined();
  });

  it('fails closed on every v2 grant tamper class (unknown keys, options, versions, counts)', () => {
    const root = ledgerRoot();
    const ledger = new ProviderAuthorizationLedger(root, { now });
    ledger.grant(request);
    const grantFile = grantFilePath(root, request.authorizationId);
    const base = JSON.parse(readFileSync(grantFile, 'utf8')) as AuthorizationGrant;

    const tamper = (mutate: (grant: Record<string, unknown>) => void): void => {
      const clone = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
      mutate(clone);
      writeFileSync(grantFile, JSON.stringify(clone));
      expect(() => ledger.readGrant(request.authorizationId)).toThrow(
        expect.objectContaining({ code: 'PROVIDER_GRANT_CORRUPT' }),
      );
    };

    tamper((g) => (g.injected = true)); // root unknown key
    tamper((g) => ((g.options as Record<string, unknown>).injected = true)); // nested unknown key
    tamper((g) => (g.schemaVersion = 1)); // wrong schema version
    tamper(
      (g) => ((g.providers as { openai: { maxInvocations: number } }).openai.maxInvocations = 2),
    );
    tamper((g) => ((g.options as { timeoutMs: number }).timeoutMs = 299999)); // in-range but not exact
    tamper((g) => ((g.options as { maxBudgetUsd: number }).maxBudgetUsd = 0.25)); // in-range but not exact
    tamper((g) => ((g.options as { codexSandbox: string }).codexSandbox = 'workspace-write'));
    tamper((g) => ((g.options as { schemaHash: string }).schemaHash = 'nope'));
    tamper(
      (g) =>
        ((
          g.providers as { openai: { binding: { executableFingerprint: string } } }
        ).openai.binding.executableFingerprint = 'z'.repeat(64)),
    ); // non-hex fingerprint
    tamper(
      (g) =>
        ((g.providers as { openai: { binding: { model: string } } }).openai.binding.model =
          'mismatch'),
    ); // binding/model mismatch
    tamper((g) => delete (g.providers as { anthropic?: unknown }).anthropic); // missing provider

    // restore a valid grant and confirm it reads.
    writeFileSync(grantFile, JSON.stringify(base));
    expect(ledger.readGrant(request.authorizationId)?.schemaVersion).toBe(2);
  });

  it('rejects unsafe ledger roots and accepts a safe sibling', () => {
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
    const safe = mkdtempSync(join(tmpdir(), 'orion-ledger-safe-'));
    cleanup.push(safe);
    expect(
      () => new ProviderAuthorizationLedger(join(safe, 'ledger'), { forbiddenRoots: [forbidden] }),
    ).not.toThrow();
    expect(existsSync(join(safe, 'ledger'))).toBe(true);
  });

  it('surfaces a typed error class', () => {
    try {
      new ProviderAuthorizationLedger('relative');
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderLedgerError);
      expect((error as ProviderLedgerError).code).toBe('PROVIDER_LEDGER_PATH_UNSAFE');
    }
  });
});
