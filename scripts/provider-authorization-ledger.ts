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
// Layout (crash/concurrency-safe on Windows, no global lock, no counter rewrite):
//   <ledgerRoot>/<authId>/grant.json                       immutable grant terms (wx once)
//   <ledgerRoot>/<authId>/run.claim                        one-shot run gate (wx once)
//   <ledgerRoot>/<authId>/slots/<provider>-<n>.slot        per-invocation reservation (wx)
//   <ledgerRoot>/<authId>/slots/<provider>-<n>.spawn       spawn attempt, written BEFORE spawn (wx)
//   <ledgerRoot>/<authId>/slots/<provider>-<n>.outcome.json sanitized outcome (best effort)
//
// A `.slot` reserves; a `.spawn` records that a real process launch was ATTEMPTED. Both are created
// with an exclusive `wx` open, so a crash leaves them in place: reserved slots and spawn attempts
// are durable and never decrease. `usage()` reports both counts from fresh directory reads. Re-running
// the same authorization id finds `run.claim` present and performs zero spawns.

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

export interface ProviderBinding {
  readonly provider: SmokeProviderKey;
  readonly cliVersion: string;
  readonly executableBasename: string;
  readonly executableFingerprint: string;
  readonly model: string;
}

export interface ProviderGrantTerms {
  readonly model: string;
  readonly maxInvocations: number;
  readonly binding: ProviderBinding;
}

export interface PolicyProjection {
  readonly argvPolicyVersion: number;
  readonly schemaHash: string;
  readonly promptHash: string;
  readonly repositoryTemplateVersion: number;
}

export interface GrantOptions extends PolicyProjection {
  readonly codexSandbox: 'read-only';
  readonly claudePermissionMode: 'dontAsk';
  readonly effort: 'low';
  readonly allowedTools: string;
  readonly disallowedTools: string;
  readonly timeoutMs: number;
  readonly maxBudgetUsd: number;
}

export interface AuthorizationGrant {
  readonly schemaVersion: 2;
  readonly authorizationId: string;
  readonly createdAt: string;
  readonly providers: {
    readonly openai: ProviderGrantTerms;
    readonly anthropic: ProviderGrantTerms;
  };
  readonly options: GrantOptions;
}

export interface ProviderGrantInput {
  readonly model: string;
  readonly binding: ProviderBinding;
}

export interface GrantRequest {
  readonly authorizationId: string;
  readonly providers: {
    readonly openai: ProviderGrantInput;
    readonly anthropic: ProviderGrantInput;
  };
  readonly policy: PolicyProjection;
}

export interface Reservation {
  readonly provider: SmokeProviderKey;
  readonly ordinal: number;
}

export interface ProviderUsage {
  readonly granted: number;
  readonly reserved: number;
  readonly spawnAttempts: number;
}

/** Fixed (non-policy) execution options; exact values are enforced on every grant read. */
export const SMOKE_GRANT_OPTIONS = {
  codexSandbox: 'read-only',
  claudePermissionMode: 'dontAsk',
  effort: 'low',
  allowedTools: 'Read,Glob,Grep',
  disallowedTools: 'Bash,Edit,Write,WebFetch,WebSearch',
  timeoutMs: 5 * 60 * 1000,
  maxBudgetUsd: 0.5,
} as const;

export const GRANT_SCHEMA_VERSION = 2 as const;
export const SMOKE_MAX_INVOCATIONS = 1;

const AUTHORIZATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MODEL_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const CLI_VERSION = /^\d+(?:\.\d+){1,3}$/;
const EXECUTABLE_BASENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ISO8601_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const FORBIDDEN_SEGMENTS = new Set(['.git', '.orion', '.gjc', 'node_modules']);

const ROOT_KEYS = ['authorizationId', 'createdAt', 'options', 'providers', 'schemaVersion'];
const TERMS_KEYS = ['binding', 'maxInvocations', 'model'];
const BINDING_KEYS = [
  'cliVersion',
  'executableBasename',
  'executableFingerprint',
  'model',
  'provider',
];
const OPTIONS_KEYS = [
  'allowedTools',
  'argvPolicyVersion',
  'claudePermissionMode',
  'codexSandbox',
  'disallowedTools',
  'effort',
  'maxBudgetUsd',
  'promptHash',
  'repositoryTemplateVersion',
  'schemaHash',
  'timeoutMs',
];

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
    assertSafeLedgerRoot(this.root, options.forbiddenRoots ?? []);
  }

  public grant(request: GrantRequest): AuthorizationGrant {
    const authorizationId = validateAuthorizationId(request.authorizationId);
    const providers = {
      openai: buildTerms('openai', request.providers?.openai),
      anthropic: buildTerms('anthropic', request.providers?.anthropic),
    };
    const options = buildOptions(request.policy);
    const authDir = join(this.root, authorizationId);
    mkdirSync(join(authDir, 'slots'), { recursive: true, mode: 0o700 });
    const grantFile = join(authDir, 'grant.json');
    const grant: AuthorizationGrant = {
      schemaVersion: GRANT_SCHEMA_VERSION,
      authorizationId,
      createdAt: this.now().toISOString(),
      providers,
      options,
    };

    if (existsSync(grantFile)) return this.reconcileExistingGrant(grantFile, grant);
    try {
      writeFileSync(grantFile, JSON.stringify(grant), {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
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

  /**
   * Record — ATOMICALLY, immediately before a real `processPort.spawn()` — that a provider launch
   * was attempted. The `wx` marker survives a crash, so the spawn-attempt count never decreases.
   */
  public markSpawnAttempt(
    authorizationId: string,
    provider: SmokeProviderKey,
    ordinal: number,
  ): void {
    const id = validateAuthorizationId(authorizationId);
    const spawnFile = join(this.root, id, 'slots', `${provider}-${ordinal}.spawn`);
    try {
      writeFileSync(spawnFile, JSON.stringify({ attemptedAt: this.now().toISOString() }), {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
    } catch (error) {
      if (!isExists(error)) throw error;
    }
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

  /** Fresh cumulative usage: reserved = live `.slot` count, spawnAttempts = live `.spawn` count. */
  public usage(authorizationId: string, provider: SmokeProviderKey): ProviderUsage {
    let granted = 0;
    try {
      granted = this.readGrant(authorizationId)?.providers[provider].maxInvocations ?? 0;
    } catch {
      granted = 0;
    }
    const slotsDir = join(this.root, authorizationId, 'slots');
    let reserved = 0;
    let spawnAttempts = 0;
    let entries: readonly string[] = [];
    try {
      entries = readdirSync(slotsDir);
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.startsWith(`${provider}-`)) continue;
      if (entry.endsWith('.slot')) reserved += 1;
      else if (entry.endsWith('.spawn')) spawnAttempts += 1;
    }
    return { granted, reserved, spawnAttempts };
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

// ---------------------------------------------------------------------------
// grant construction (validates operator/probe input)
// ---------------------------------------------------------------------------
function buildTerms(
  provider: SmokeProviderKey,
  input: ProviderGrantInput | undefined,
): ProviderGrantTerms {
  if (input === null || typeof input !== 'object')
    throw grantInvalid('A provider grant input is missing.');
  const model = validateModel(input.model);
  const binding = validateBinding(provider, input.binding, model);
  return { model, maxInvocations: SMOKE_MAX_INVOCATIONS, binding };
}

function validateBinding(
  provider: SmokeProviderKey,
  binding: ProviderBinding | undefined,
  model: string,
): ProviderBinding {
  if (binding === null || typeof binding !== 'object')
    throw grantInvalid('A provider binding is missing.');
  if (binding.provider !== provider) throw grantInvalid('The binding provider does not match.');
  if (binding.model !== model)
    throw grantInvalid('The binding model does not match the grant model.');
  if (typeof binding.cliVersion !== 'string' || !CLI_VERSION.test(binding.cliVersion))
    throw grantInvalid('The binding CLI version is malformed.');
  if (
    typeof binding.executableBasename !== 'string' ||
    !EXECUTABLE_BASENAME.test(binding.executableBasename)
  )
    throw grantInvalid('The binding executable basename is malformed.');
  if (
    typeof binding.executableFingerprint !== 'string' ||
    !HEX64.test(binding.executableFingerprint)
  )
    throw grantInvalid('The binding executable fingerprint is malformed.');
  return {
    provider,
    cliVersion: binding.cliVersion,
    executableBasename: binding.executableBasename,
    executableFingerprint: binding.executableFingerprint,
    model,
  };
}

function buildOptions(policy: PolicyProjection | undefined): GrantOptions {
  if (policy === null || typeof policy !== 'object')
    throw grantInvalid('The grant policy is missing.');
  return { ...SMOKE_GRANT_OPTIONS, ...validatePolicy(policy) };
}

function validatePolicy(policy: PolicyProjection): PolicyProjection {
  if (!Number.isSafeInteger(policy.argvPolicyVersion) || policy.argvPolicyVersion < 1)
    throw grantInvalid('The argv policy version is invalid.');
  if (
    !Number.isSafeInteger(policy.repositoryTemplateVersion) ||
    policy.repositoryTemplateVersion < 1
  )
    throw grantInvalid('The repository template version is invalid.');
  if (typeof policy.schemaHash !== 'string' || !HEX64.test(policy.schemaHash))
    throw grantInvalid('The schema hash is malformed.');
  if (typeof policy.promptHash !== 'string' || !HEX64.test(policy.promptHash))
    throw grantInvalid('The prompt hash is malformed.');
  return {
    argvPolicyVersion: policy.argvPolicyVersion,
    repositoryTemplateVersion: policy.repositoryTemplateVersion,
    schemaHash: policy.schemaHash,
    promptHash: policy.promptHash,
  };
}

// ---------------------------------------------------------------------------
// ledger path containment
// ---------------------------------------------------------------------------
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
  const segments = normalized
    .slice(3)
    .split('\\')
    .filter((segment) => segment.length > 0);
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
      return remainder.length === 0
        ? canonicalAncestor
        : [canonicalAncestor, ...remainder].join('\\');
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
    normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}\\`)
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

// ---------------------------------------------------------------------------
// strict grant parsing (recursive exact key sets + formats)
// ---------------------------------------------------------------------------
function validateAuthorizationId(value: string): string {
  if (typeof value !== 'string' || !AUTHORIZATION_ID.test(value)) {
    throw grantInvalid('The authorization id is missing or malformed.');
  }
  return value;
}

function validateModel(value: string): string {
  if (typeof value !== 'string' || !MODEL_IDENTIFIER.test(value)) {
    throw grantInvalid('A provider model must be an operator-selected identifier.');
  }
  return value;
}

function parseGrant(contents: string, authorizationId: string): AuthorizationGrant {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch {
    throw grantCorrupt('The grant record is not valid JSON.');
  }
  if (!isStrictGrant(parsed) || parsed.authorizationId !== authorizationId) {
    throw grantCorrupt('The grant record is malformed.');
  }
  return parsed;
}

function isStrictGrant(value: unknown): value is AuthorizationGrant {
  if (!isExactObject(value, ROOT_KEYS)) return false;
  const grant = value as Record<string, unknown>;
  if (grant.schemaVersion !== GRANT_SCHEMA_VERSION) return false;
  if (typeof grant.authorizationId !== 'string' || !AUTHORIZATION_ID.test(grant.authorizationId))
    return false;
  if (typeof grant.createdAt !== 'string' || !isIsoUtc(grant.createdAt)) return false;
  if (!isExactObject(grant.providers, ['anthropic', 'openai'])) return false;
  const providers = grant.providers as Record<string, unknown>;
  if (!isStrictTerms(providers.openai, 'openai')) return false;
  if (!isStrictTerms(providers.anthropic, 'anthropic')) return false;
  return isStrictOptions(grant.options);
}

function isStrictTerms(value: unknown, provider: SmokeProviderKey): boolean {
  if (!isExactObject(value, TERMS_KEYS)) return false;
  const terms = value as Record<string, unknown>;
  if (typeof terms.model !== 'string' || !MODEL_IDENTIFIER.test(terms.model)) return false;
  if (terms.maxInvocations !== SMOKE_MAX_INVOCATIONS) return false;
  return isStrictBinding(terms.binding, provider, terms.model);
}

function isStrictBinding(value: unknown, provider: SmokeProviderKey, model: string): boolean {
  if (!isExactObject(value, BINDING_KEYS)) return false;
  const binding = value as Record<string, unknown>;
  return (
    binding.provider === provider &&
    binding.model === model &&
    typeof binding.cliVersion === 'string' &&
    CLI_VERSION.test(binding.cliVersion) &&
    typeof binding.executableBasename === 'string' &&
    EXECUTABLE_BASENAME.test(binding.executableBasename) &&
    typeof binding.executableFingerprint === 'string' &&
    HEX64.test(binding.executableFingerprint)
  );
}

function isStrictOptions(value: unknown): boolean {
  if (!isExactObject(value, OPTIONS_KEYS)) return false;
  const options = value as Record<string, unknown>;
  return (
    options.codexSandbox === SMOKE_GRANT_OPTIONS.codexSandbox &&
    options.claudePermissionMode === SMOKE_GRANT_OPTIONS.claudePermissionMode &&
    options.effort === SMOKE_GRANT_OPTIONS.effort &&
    options.allowedTools === SMOKE_GRANT_OPTIONS.allowedTools &&
    options.disallowedTools === SMOKE_GRANT_OPTIONS.disallowedTools &&
    options.timeoutMs === SMOKE_GRANT_OPTIONS.timeoutMs &&
    options.maxBudgetUsd === SMOKE_GRANT_OPTIONS.maxBudgetUsd &&
    Number.isSafeInteger(options.argvPolicyVersion) &&
    (options.argvPolicyVersion as number) >= 1 &&
    Number.isSafeInteger(options.repositoryTemplateVersion) &&
    (options.repositoryTemplateVersion as number) >= 1 &&
    typeof options.schemaHash === 'string' &&
    HEX64.test(options.schemaHash) &&
    typeof options.promptHash === 'string' &&
    HEX64.test(options.promptHash)
  );
}

function isExactObject(value: unknown, keys: readonly string[]): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value as Record<string, unknown>).sort();
  if (actual.length !== keys.length) return false;
  return keys.every((key, index) => actual[index] === key);
}

function isIsoUtc(value: string): boolean {
  return ISO8601_UTC.test(value) && !Number.isNaN(Date.parse(value));
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
  return (
    typeof error === 'object' && error !== null && (error as { code?: string }).code === 'EEXIST'
  );
}

function grantInvalid(message: string): ProviderLedgerError {
  return new ProviderLedgerError('PROVIDER_GRANT_INVALID', message);
}

function grantCorrupt(message: string): ProviderLedgerError {
  return new ProviderLedgerError('PROVIDER_GRANT_CORRUPT', message);
}

function pathUnsafe(message: string): ProviderLedgerError {
  return new ProviderLedgerError('PROVIDER_LEDGER_PATH_UNSAFE', message);
}
