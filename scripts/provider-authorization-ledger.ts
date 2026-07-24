import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

// A durable, fail-closed one-time authorization ledger for the deferred real provider smoke.
//
// Design (crash/concurrency-safe on Windows, no global lock, no counter rewrite):
//   <ledgerRoot>/<authId>/grant.json                    immutable grant terms (wx once)
//   <ledgerRoot>/<authId>/run.claim                     one-shot run gate (wx once)
//   <ledgerRoot>/<authId>/slots/<provider>-<n>.slot     per-invocation reservation marker (wx)
//   <ledgerRoot>/<authId>/slots/<provider>-<n>.outcome.json  sanitized outcome (best effort)
//
// A slot/claim marker is created with an exclusive `wx` open BEFORE any provider spawn, so a crash
// or ambiguous outcome leaves the marker in place and the slot stays USED. The cumulative used
// count is a fresh count of `.slot` markers — never a constant. Re-running the same authorization
// id finds `run.claim` already present and performs zero spawns.

export type SmokeProviderKey = 'openai' | 'anthropic';

export type LedgerErrorCode =
  | 'PROVIDER_LEDGER_PATH_UNSAFE'
  | 'PROVIDER_GRANT_CONFLICT'
  | 'PROVIDER_GRANT_CORRUPT'
  | 'PROVIDER_GRANT_INVALID';

export class ProviderLedgerError extends Error {
  public constructor(
    public readonly code: LedgerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderLedgerError';
  }
}

export interface ProviderGrantTerms {
  readonly model: string;
  readonly maxInvocations: number;
}

export interface GrantOptions {
  readonly codexSandbox: 'read-only';
  readonly claudePermissionMode: 'dontAsk';
  readonly effort: 'low';
  readonly allowedTools: string;
  readonly disallowedTools: string;
  readonly timeoutMs: number;
  readonly maxBudgetUsd: number;
}

export interface AuthorizationGrant {
  readonly schemaVersion: 1;
  readonly authorizationId: string;
  readonly createdAt: string;
  readonly providers: {
    readonly openai: ProviderGrantTerms;
    readonly anthropic: ProviderGrantTerms;
  };
  readonly options: GrantOptions;
}

export interface GrantRequest {
  readonly authorizationId: string;
  readonly codexModel: string;
  readonly claudeModel: string;
}

export interface Reservation {
  readonly provider: SmokeProviderKey;
  readonly ordinal: number;
}

export interface ProviderUsage {
  readonly granted: number;
  readonly used: number;
}

export const SMOKE_GRANT_OPTIONS: GrantOptions = {
  codexSandbox: 'read-only',
  claudePermissionMode: 'dontAsk',
  effort: 'low',
  allowedTools: 'Read,Glob,Grep',
  disallowedTools: 'Bash,Edit,Write,WebFetch,WebSearch',
  timeoutMs: 5 * 60 * 1000,
  maxBudgetUsd: 0.5,
};

export const SMOKE_MAX_INVOCATIONS = 1;

const AUTHORIZATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MODEL_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const FORBIDDEN_SEGMENTS = new Set(['.git', '.orion', '.gjc', 'node_modules']);

export class ProviderAuthorizationLedger {
  private readonly root: string;
  private readonly now: () => Date;

  public constructor(
    ledgerRoot: string,
    options: { readonly forbiddenRoots?: readonly string[]; readonly now?: () => Date } = {},
  ) {
    this.root = assertSafeLedgerRoot(ledgerRoot, options.forbiddenRoots ?? []);
    this.now = options.now ?? (() => new Date());
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    // Revalidate after creation: the freshly created directory must still resolve to a
    // contained, non-reparse location.
    assertSafeLedgerRoot(this.root, options.forbiddenRoots ?? []);
  }

  public grant(request: GrantRequest): AuthorizationGrant {
    const authorizationId = validateAuthorizationId(request.authorizationId);
    const codexModel = validateModel(request.codexModel);
    const claudeModel = validateModel(request.claudeModel);
    const authDir = join(this.root, authorizationId);
    mkdirSync(join(authDir, 'slots'), { recursive: true, mode: 0o700 });
    const grantFile = join(authDir, 'grant.json');
    const grant: AuthorizationGrant = {
      schemaVersion: 1,
      authorizationId,
      createdAt: this.now().toISOString(),
      providers: {
        openai: { model: codexModel, maxInvocations: SMOKE_MAX_INVOCATIONS },
        anthropic: { model: claudeModel, maxInvocations: SMOKE_MAX_INVOCATIONS },
      },
      options: SMOKE_GRANT_OPTIONS,
    };

    if (existsSync(grantFile)) return this.reconcileExistingGrant(grantFile, grant);
    try {
      writeFileSync(grantFile, JSON.stringify(grant), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      return grant;
    } catch (error) {
      if (isExists(error)) return this.reconcileExistingGrant(grantFile, grant);
      throw error;
    }
  }

  public readGrant(authorizationId: string): AuthorizationGrant | undefined {
    const id = validateAuthorizationId(authorizationId);
    const grantFile = join(this.root, id, 'grant.json');
    if (!existsSync(grantFile)) return undefined;
    return parseGrant(readFileSync(grantFile, 'utf8'), id);
  }

  /** Atomically claim the one-shot run gate. Returns false when already claimed (rerun/crash). */
  public claimRun(authorizationId: string): boolean {
    const id = validateAuthorizationId(authorizationId);
    const claimFile = join(this.root, id, 'run.claim');
    try {
      writeFileSync(claimFile, JSON.stringify({ claimedAt: this.now().toISOString() }), {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      return true;
    } catch (error) {
      if (isExists(error)) return false;
      throw error;
    }
  }

  /** Reserve the next free invocation slot for a provider BEFORE spawning. `null` when exhausted. */
  public reserve(authorizationId: string, provider: SmokeProviderKey): Reservation | null {
    const grant = this.readGrant(authorizationId);
    if (grant === undefined) return null;
    const max = grant.providers[provider].maxInvocations;
    const slotsDir = join(this.root, authorizationId, 'slots');
    mkdirSync(slotsDir, { recursive: true, mode: 0o700 });
    for (let ordinal = 1; ordinal <= max; ordinal += 1) {
      const slotFile = join(slotsDir, `${provider}-${ordinal}.slot`);
      try {
        writeFileSync(slotFile, JSON.stringify({ reservedAt: this.now().toISOString() }), {
          encoding: 'utf8',
          mode: 0o600,
          flag: 'wx',
        });
        return { provider, ordinal };
      } catch (error) {
        if (isExists(error)) continue;
        throw error;
      }
    }
    return null;
  }

  /** Record sanitized outcome metadata for a reserved slot. Best effort; never releases a slot. */
  public recordOutcome(
    authorizationId: string,
    reservation: Reservation,
    outcome: Readonly<Record<string, unknown>>,
  ): void {
    try {
      const id = validateAuthorizationId(authorizationId);
      const outcomeFile = join(
        this.root,
        id,
        'slots',
        `${reservation.provider}-${reservation.ordinal}.outcome.json`,
      );
      writeFileSync(outcomeFile, JSON.stringify(outcome), { encoding: 'utf8', mode: 0o600 });
    } catch {
      // Outcome metadata is advisory; a write failure must never resurrect a reserved slot.
    }
  }

  /** Fresh cumulative usage for a provider: `used` = live `.slot` marker count. */
  public usage(authorizationId: string, provider: SmokeProviderKey): ProviderUsage {
    let granted = 0;
    try {
      granted = this.readGrant(authorizationId)?.providers[provider].maxInvocations ?? 0;
    } catch {
      granted = 0;
    }
    const slotsDir = join(this.root, authorizationId, 'slots');
    let used = 0;
    try {
      for (const entry of readdirSync(slotsDir)) {
        if (/^.+\.slot$/.test(entry) && entry.startsWith(`${provider}-`)) used += 1;
      }
    } catch {
      used = 0;
    }
    return { granted, used };
  }

  private reconcileExistingGrant(
    grantFile: string,
    desired: AuthorizationGrant,
  ): AuthorizationGrant {
    const existing = parseGrant(readFileSync(grantFile, 'utf8'), desired.authorizationId);
    if (grantProjection(existing) !== grantProjection(desired)) {
      throw new ProviderLedgerError(
        'PROVIDER_GRANT_CONFLICT',
        'A conflicting grant already exists for this authorization id.',
      );
    }
    return existing;
  }
}

export function assertSafeLedgerRoot(dir: string, forbiddenRoots: readonly string[]): string {
  if (typeof dir !== 'string' || dir.length === 0) {
    throw pathUnsafe('The ledger directory must be a non-empty path.');
  }
  const normalized = dir.replace(/\//g, '\\');
  if (/^\\\\/.test(normalized)) {
    throw pathUnsafe('UNC and device ledger paths are not permitted.');
  }
  if (!/^[A-Za-z]:\\/.test(normalized)) {
    throw pathUnsafe('The ledger directory must be a local drive-letter absolute path.');
  }
  const segments = normalized.slice(3).split('\\').filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment.includes(':'))) {
    throw pathUnsafe('Alternate data stream ledger paths are not permitted.');
  }
  if (segments.some((segment) => FORBIDDEN_SEGMENTS.has(segment.toLowerCase()))) {
    throw pathUnsafe('The ledger directory must not sit inside repository or local-state trees.');
  }
  const canonical = canonicalizeExistingAncestor(normalized);
  for (const root of forbiddenRoots) {
    if (isContainedCaseInsensitive(canonical, root)) {
      throw pathUnsafe('The ledger directory must be outside every repository and worktree.');
    }
  }
  return normalized;
}

function canonicalizeExistingAncestor(path: string): string {
  const parts = path.split('\\');
  for (let end = parts.length; end >= 1; end -= 1) {
    const candidate = parts.slice(0, end).join('\\');
    if (candidate.length === 0) continue;
    if (!existsSync(candidate)) continue;
    let stat;
    try {
      stat = lstatSync(candidate);
    } catch {
      throw pathUnsafe('The ledger directory could not be verified.');
    }
    if (stat.isSymbolicLink()) {
      throw pathUnsafe('Symbolic-link or reparse ledger ancestors are not permitted.');
    }
    try {
      const canonicalAncestor = realpathSync.native(candidate);
      const remainder = parts.slice(end);
      return remainder.length === 0 ? canonicalAncestor : [canonicalAncestor, ...remainder].join('\\');
    } catch {
      throw pathUnsafe('The ledger directory could not be canonicalized.');
    }
  }
  return path;
}

function isContainedCaseInsensitive(candidate: string, root: string): boolean {
  if (typeof root !== 'string' || root.length === 0) return false;
  const normalizedCandidate = canonicalizeForCompare(candidate);
  const normalizedRoot = canonicalizeForCompare(root);
  return (
    normalizedCandidate === normalizedRoot ||
    normalizedCandidate.startsWith(`${normalizedRoot}\\`)
  );
}

function canonicalizeForCompare(value: string): string {
  let resolved = value.replace(/\//g, '\\');
  try {
    resolved = realpathSync.native(resolved);
  } catch {
    // Non-existent comparison targets are compared lexically.
  }
  return resolved.replace(/\\+$/, '').toLowerCase();
}

function validateAuthorizationId(value: string): string {
  if (typeof value !== 'string' || !AUTHORIZATION_ID.test(value)) {
    throw new ProviderLedgerError(
      'PROVIDER_GRANT_INVALID',
      'The authorization id is missing or malformed.',
    );
  }
  return value;
}

function validateModel(value: string): string {
  if (typeof value !== 'string' || !MODEL_IDENTIFIER.test(value)) {
    throw new ProviderLedgerError(
      'PROVIDER_GRANT_INVALID',
      'A provider model must be an operator-selected identifier.',
    );
  }
  return value;
}

function parseGrant(contents: string, authorizationId: string): AuthorizationGrant {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch {
    throw new ProviderLedgerError('PROVIDER_GRANT_CORRUPT', 'The grant record is not valid JSON.');
  }
  if (!isGrant(parsed) || parsed.authorizationId !== authorizationId) {
    throw new ProviderLedgerError('PROVIDER_GRANT_CORRUPT', 'The grant record is malformed.');
  }
  return parsed;
}

function isGrant(value: unknown): value is AuthorizationGrant {
  if (typeof value !== 'object' || value === null) return false;
  const grant = value as Record<string, unknown>;
  if (grant.schemaVersion !== 1 || typeof grant.authorizationId !== 'string') return false;
  const providers = grant.providers as Record<string, unknown> | undefined;
  if (providers === undefined) return false;
  return isTerms(providers.openai) && isTerms(providers.anthropic) && typeof grant.options === 'object';
}

function isTerms(value: unknown): value is ProviderGrantTerms {
  if (typeof value !== 'object' || value === null) return false;
  const terms = value as Record<string, unknown>;
  return (
    typeof terms.model === 'string' &&
    typeof terms.maxInvocations === 'number' &&
    Number.isSafeInteger(terms.maxInvocations) &&
    terms.maxInvocations >= 1
  );
}

function grantProjection(grant: AuthorizationGrant): string {
  return stableStringify({
    schemaVersion: grant.schemaVersion,
    authorizationId: grant.authorizationId,
    providers: grant.providers,
    options: grant.options,
  });
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function isExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'EEXIST';
}

function pathUnsafe(message: string): ProviderLedgerError {
  return new ProviderLedgerError('PROVIDER_LEDGER_PATH_UNSAFE', message);
}
