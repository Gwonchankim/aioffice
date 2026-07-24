import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { runResultSchema } from '@orion/contracts';
import {
  GitReadRunner,
  normalizeClaudeFrame,
  normalizeCodexFrame,
  type NormalizedFrame,
  type NormalizedItem,
  type NormalizedMetadata,
} from '@orion/server';

import {
  ProviderAuthorizationLedger,
  ProviderLedgerError,
  SMOKE_GRANT_OPTIONS,
  type AuthorizationGrant,
  type Reservation,
  type SmokeProviderKey,
} from './provider-authorization-ledger.js';

const scriptDirectory = resolve(fileURLToPath(new URL('.', import.meta.url)));
const workspaceRoot = resolve(
  scriptDirectory,
  basename(scriptDirectory) === 'dist' ? '../..' : '..',
);

export const REAL_PROVIDER_TESTS_ENV = 'ORION_REAL_PROVIDER_TESTS';
export const AUTHORIZATION_ID_ENV = 'ORION_PROVIDER_AUTHORIZATION_ID';
export const CODEX_MODEL_ENV = 'ORION_CODEX_SMOKE_MODEL';
export const CLAUDE_MODEL_ENV = 'ORION_CLAUDE_SMOKE_MODEL';
export const LEDGER_DIR_ENV = 'ORION_PROVIDER_LEDGER_DIR';
export const PROVIDER_SMOKE_TIMEOUT_MS = SMOKE_GRANT_OPTIONS.timeoutMs;
export const CLAUDE_READ_ONLY_TOOLS = SMOKE_GRANT_OPTIONS.allowedTools;
export const CLAUDE_DISALLOWED_TOOLS = SMOKE_GRANT_OPTIONS.disallowedTools;
export const PROVIDER_SMOKE_MAX_BUDGET_USD = SMOKE_GRANT_OPTIONS.maxBudgetUsd;
/** Verified valid Claude alias; still bound per-authorization and operator-overridable. */
export const DEFAULT_CLAUDE_SMOKE_MODEL = 'sonnet';
export const PROVIDER_SMOKE_CLEANUP_MAX_RETRIES = 3;
export const PROVIDER_SMOKE_CLEANUP_RETRY_DELAY_MS = 100;

export const EVIDENCE_SCHEMA_VERSION = 1 as const;

export const providerSmokeResultSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'summary', 'findings', 'artifacts', 'changes', 'tests', 'risks', 'handoff'],
  properties: {
    status: { type: 'string', enum: ['succeeded', 'failed', 'needs_attention'] },
    summary: { type: 'string', minLength: 1 },
    findings: { type: 'array' },
    artifacts: { type: 'array' },
    changes: { type: 'array' },
    tests: { type: 'array' },
    risks: { type: 'array' },
    handoff: { type: 'string', minLength: 1 },
  },
} as const;

export type SmokeProvider = 'openai' | 'anthropic';

export type SmokeReachedStage =
  | 'authorization_missing'
  | 'grant_missing'
  | 'grant_corrupt'
  | 'ledger_unsafe'
  | 'run_claim_denied'
  | 'authorization_exhausted'
  | 'preflight_unavailable'
  | 'invocation_reserved'
  | 'invocation_spawned'
  | 'invocation_completed';

export type ExitClassification =
  | 'succeeded'
  | 'nonzero_exit'
  | 'signal'
  | 'timed_out'
  | 'spawn_failed'
  | 'result_schema_invalid'
  | 'repository_changed';

type Usage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheTokens?: number;
  durationMs?: number;
};

export interface ProviderSmokePaths {
  readonly repository: string;
  readonly schemaPath: string;
  readonly schemaSerialized: string;
}

export interface ProviderSmokeEvidence {
  readonly provider: SmokeProvider;
  readonly reachedStage: SmokeReachedStage;
  readonly invocationCount: number;
  readonly cliVersion: string | null;
  readonly executableFingerprint: string | null;
  readonly modelReported: string | null;
  readonly permissionMode: 'read-only' | 'dontAsk-read-only-tools' | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly durationMs: number | null;
  readonly exitClassification: ExitClassification | null;
  readonly normalizedEventCounts: Readonly<Record<string, number>>;
  readonly sessionIdHash: string | null;
  readonly strictResult: boolean;
  readonly repositoryUnchanged: boolean;
  readonly childProcessCount: number;
  readonly reportedUsage: Usage | null;
  readonly reportedCost: number | null;
  readonly sanitizerFindingCount: number;
  readonly errorCode?: string;
}

export interface ProviderSmokeEnvelope {
  readonly schemaVersion: typeof EVIDENCE_SCHEMA_VERSION;
  readonly providers: readonly ProviderSmokeEvidence[];
}

export interface SmokeProcess {
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
  readonly exited: Promise<{ readonly exitCode: number | null; readonly signal: string | null }>;
  writeStdin(input: Uint8Array): Promise<void> | void;
  terminateOwnedTree(): void;
  countOwnedDescendants(): Promise<number> | number;
}

export interface SmokeProcessPort {
  spawn(request: {
    readonly executable: string;
    readonly argv: readonly string[];
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly shell: false;
  }): Promise<SmokeProcess> | SmokeProcess;
}

export interface SmokeInvocation {
  readonly provider: SmokeProvider;
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly permissionMode: 'read-only' | 'dontAsk-read-only-tools';
  readonly invocationCount: number;
}

const smokePrompt = [
  'Inspect only this synthetic public repository without writing files or using network tools.',
  'Return a strict RunResult that states the file count and detected languages.',
].join(' ');

export function codexSmokeArgv(paths: ProviderSmokePaths, model: string): readonly string[] {
  return [
    'exec',
    '--json',
    '--sandbox',
    'read-only',
    '--cd',
    paths.repository,
    '--output-schema',
    paths.schemaPath,
    '--model',
    model,
    '-',
  ];
}

export function claudeSmokeArgv(paths: ProviderSmokePaths, model: string): readonly string[] {
  return [
    '--print',
    '--output-format',
    'stream-json',
    '--verbose',
    '--json-schema',
    paths.schemaSerialized,
    '--model',
    model,
    '--effort',
    'low',
    '--permission-mode',
    'dontAsk',
    '--allowedTools',
    CLAUDE_READ_ONLY_TOOLS,
    '--disallowedTools',
    CLAUDE_DISALLOWED_TOOLS,
    '--max-budget-usd',
    String(PROVIDER_SMOKE_MAX_BUDGET_USD),
  ];
}

export function requiresRealProviderTestOptIn(environment: NodeJS.ProcessEnv): boolean {
  return environment[REAL_PROVIDER_TESTS_ENV] === '1';
}

// ---------------------------------------------------------------------------
// Invocation + shared-normalizer inspection
// ---------------------------------------------------------------------------
export async function invokeSmokeProvider(
  invocation: SmokeInvocation,
  processPort: SmokeProcessPort,
  now: () => Date = () => new Date(),
): Promise<ProviderSmokeEvidence> {
  const started = now();
  const summary = createSummary();
  let timedOut = false;
  let childProcessCount = 0;
  let reachedStage: SmokeReachedStage = 'invocation_reserved';
  let exitClassification: ExitClassification = 'spawn_failed';

  try {
    const child = await processPort.spawn({
      executable: invocation.executable,
      argv: invocation.argv,
      cwd: invocation.cwd,
      env: invocation.environment,
      shell: false,
    });
    childProcessCount = 1;
    reachedStage = 'invocation_spawned';
    const timeout = setTimeout(() => {
      timedOut = true;
      child.terminateOwnedTree();
    }, PROVIDER_SMOKE_TIMEOUT_MS);
    try {
      await child.writeStdin(Buffer.from(smokePrompt, 'utf8'));
      const [exit] = await Promise.all([
        child.exited,
        consumeProviderStream(invocation.provider, child.stdout, summary),
        consumeSanitizerStream(child.stderr, summary),
      ]);
      childProcessCount += await child.countOwnedDescendants();
      exitClassification = classifyExit(exit, timedOut, summary.strictResult);
      reachedStage = 'invocation_completed';
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    exitClassification = 'spawn_failed';
  }

  const ended = now();
  return {
    provider: invocation.provider,
    reachedStage,
    invocationCount: invocation.invocationCount,
    cliVersion: summary.cliVersion,
    executableFingerprint: hashOpaque(basename(invocation.executable).toLowerCase()),
    modelReported: summary.modelReported,
    permissionMode: invocation.permissionMode,
    startedAt: started.toISOString(),
    endedAt: ended.toISOString(),
    durationMs: Math.max(0, ended.getTime() - started.getTime()),
    exitClassification,
    normalizedEventCounts: summary.normalizedEventCounts,
    sessionIdHash: summary.sessionIdHash,
    strictResult: summary.strictResult,
    repositoryUnchanged: true,
    childProcessCount,
    reportedUsage: Object.keys(summary.usage).length === 0 ? null : summary.usage,
    reportedCost: summary.reportedCost,
    sanitizerFindingCount: summary.sanitizerFindingCount,
  };
}

interface ProviderSummary {
  cliVersion: string | null;
  modelReported: string | null;
  normalizedEventCounts: Record<string, number>;
  sessionIdHash: string | null;
  strictResult: boolean;
  usage: Usage;
  reportedCost: number | null;
  sanitizerFindingCount: number;
}

function createSummary(): ProviderSummary {
  return {
    cliVersion: null,
    modelReported: null,
    normalizedEventCounts: {},
    sessionIdHash: null,
    strictResult: false,
    usage: {},
    reportedCost: null,
    sanitizerFindingCount: 0,
  };
}

async function consumeProviderStream(
  provider: SmokeProvider,
  stream: AsyncIterable<Uint8Array>,
  summary: ProviderSummary,
): Promise<void> {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  for await (const chunk of stream) {
    pending += decoder.write(chunk);
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? '';
    for (const line of lines) inspectProviderFrame(provider, line, summary);
  }
  pending += decoder.end();
  if (pending.length > 0) inspectProviderFrame(provider, pending, summary);
}

async function consumeSanitizerStream(
  stream: AsyncIterable<Uint8Array>,
  summary: ProviderSummary,
): Promise<void> {
  for await (const chunk of stream)
    summary.sanitizerFindingCount += sanitizerFindings(chunk.toString());
}

function inspectProviderFrame(
  provider: SmokeProvider,
  line: string,
  summary: ProviderSummary,
): void {
  summary.sanitizerFindingCount += sanitizerFindings(line);
  let frame: unknown;
  try {
    frame = JSON.parse(line) as unknown;
  } catch {
    return;
  }
  if (isRecord(frame)) captureCliVersion(frame, summary);
  const normalized: NormalizedFrame =
    provider === 'openai' ? normalizeCodexFrame(frame) : normalizeClaudeFrame(frame);
  if (normalized.kind !== 'recognized') return;

  for (const item of normalized.items) recordNormalizedItem(item, summary);
  if (normalized.metadata !== undefined) captureMetadata(normalized.metadata, summary);
  if (normalized.result !== undefined && runResultSchema.safeParse(normalized.result).success) {
    summary.strictResult = true;
    increment(summary, 'run.completed');
  }
}

function recordNormalizedItem(item: NormalizedItem, summary: ProviderSummary): void {
  switch (item.kind) {
    case 'session':
      increment(summary, 'run.started');
      if (isSafeOpaqueIdentifier(item.sessionId))
        summary.sessionIdHash = hashOpaque(item.sessionId);
      return;
    case 'output':
      increment(summary, 'run.output.delta');
      return;
    case 'tool.started':
      increment(summary, 'run.tool.started');
      return;
    case 'tool.completed':
      increment(summary, 'run.tool.completed');
      return;
    case 'usage':
      increment(summary, 'run.usage');
      captureUsage(item.usage, summary);
      return;
    case 'retry':
      increment(summary, 'run.retry');
      return;
  }
}

function increment(summary: ProviderSummary, key: string): void {
  summary.normalizedEventCounts[key] = (summary.normalizedEventCounts[key] ?? 0) + 1;
}

function captureUsage(usage: NormalizedMetadata['usage'], summary: ProviderSummary): void {
  if (usage === undefined) return;
  for (const key of ['inputTokens', 'outputTokens', 'cacheTokens', 'durationMs'] as const) {
    const value = usage[key];
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
      summary.usage[key] = value;
  }
  if (typeof usage.reportedCost === 'number' && usage.reportedCost >= 0)
    summary.reportedCost = usage.reportedCost;
}

function captureMetadata(metadata: NormalizedMetadata, summary: ProviderSummary): void {
  if (summary.modelReported === null && metadata.model !== undefined)
    summary.modelReported = metadata.model;
  if (metadata.usage !== undefined) captureUsage(metadata.usage, summary);
  if (
    summary.reportedCost === null &&
    typeof metadata.costUsd === 'number' &&
    metadata.costUsd >= 0
  )
    summary.reportedCost = metadata.costUsd;
}

function captureCliVersion(frame: Record<string, unknown>, summary: ProviderSummary): void {
  if (summary.cliVersion !== null) return;
  const candidate = frame.version ?? frame.claude_code_version ?? frame.cli_version;
  if (isSemanticVersion(candidate)) summary.cliVersion = candidate;
}

function classifyExit(
  exit: { readonly exitCode: number | null; readonly signal: string | null },
  timedOut: boolean,
  strictResult: boolean,
): ExitClassification {
  if (timedOut) return 'timed_out';
  if (exit.signal !== null) return 'signal';
  if (exit.exitCode !== 0) return 'nonzero_exit';
  return strictResult ? 'succeeded' : 'result_schema_invalid';
}

function sanitizerFindings(value: string): number {
  return [
    /\bBearer\s+[A-Za-z0-9._-]{8,}/i,
    /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}/i,
    /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----/,
  ].reduce((count, expression) => count + (expression.test(value) ? 1 : 0), 0);
}

function hashOpaque(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeOpaqueIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value);
}

function isSemanticVersion(value: unknown): value is string {
  return typeof value === 'string' && /^v?\d+(?:\.\d+){1,3}(?:[-+][A-Za-z0-9.-]+)?$/.test(value);
}

// ---------------------------------------------------------------------------
// Envelope assembly (one shape on every path; never `[]`)
// ---------------------------------------------------------------------------
export function pendingEvidence(
  provider: SmokeProvider,
  reachedStage: SmokeReachedStage,
  invocationCount: number,
  errorCode?: string,
): ProviderSmokeEvidence {
  return {
    provider,
    reachedStage,
    invocationCount,
    cliVersion: null,
    executableFingerprint: null,
    modelReported: null,
    permissionMode: null,
    startedAt: null,
    endedAt: null,
    durationMs: null,
    exitClassification: null,
    normalizedEventCounts: {},
    sessionIdHash: null,
    strictResult: false,
    repositoryUnchanged: true,
    childProcessCount: 0,
    reportedUsage: null,
    reportedCost: null,
    sanitizerFindingCount: 0,
    ...(errorCode === undefined ? {} : { errorCode }),
  };
}

const PROVIDER_ORDER: readonly SmokeProvider[] = ['openai', 'anthropic'];
const PERMISSION_MODE: Record<SmokeProvider, 'read-only' | 'dontAsk-read-only-tools'> = {
  openai: 'read-only',
  anthropic: 'dontAsk-read-only-tools',
};

export interface SmokeLedger {
  readGrant(authorizationId: string): AuthorizationGrant | undefined;
  claimRun(authorizationId: string): boolean;
  reserve(authorizationId: string, provider: SmokeProviderKey): Reservation | null;
  usage(authorizationId: string, provider: SmokeProviderKey): { granted: number; used: number };
  recordOutcome(
    authorizationId: string,
    reservation: Reservation,
    outcome: Readonly<Record<string, unknown>>,
  ): void;
}

export interface SmokeSpawnTarget {
  readonly provider: SmokeProvider;
  readonly executable: string;
  readonly argv: readonly string[];
}

export interface SmokeRepository {
  readonly paths: ProviderSmokePaths;
  isUnchangedSince(): boolean;
  environmentFor(provider: SmokeProvider): NodeJS.ProcessEnv;
  executableFor(provider: SmokeProvider): string;
}

export interface RunProviderSmokeDeps {
  readonly authorizationId: string | undefined;
  readonly ledger: SmokeLedger | (() => SmokeLedger);
  readonly processPort: SmokeProcessPort;
  readonly prepareRepository: () => Promise<SmokeRepository>;
  readonly models: { readonly openai: string; readonly anthropic: string };
  readonly now?: () => Date;
}

/** Orchestrate the fail-closed one-time smoke. Always returns the single envelope; never `[]`. */
export async function runProviderSmoke(deps: RunProviderSmokeDeps): Promise<ProviderSmokeEnvelope> {
  const now = deps.now ?? (() => new Date());
  const authorizationId = deps.authorizationId;
  if (authorizationId === undefined || authorizationId.length === 0) {
    return envelope('authorization_missing', 0);
  }

  let ledger: SmokeLedger;
  try {
    ledger = typeof deps.ledger === 'function' ? deps.ledger() : deps.ledger;
  } catch (error) {
    return envelope('ledger_unsafe', 0, ledgerErrorCode(error));
  }

  let grant: AuthorizationGrant | undefined;
  try {
    grant = ledger.readGrant(authorizationId);
  } catch (error) {
    return usageEnvelope(ledger, authorizationId, 'grant_corrupt', ledgerErrorCode(error));
  }
  if (grant === undefined) return envelope('grant_missing', 0);

  if (!ledger.claimRun(authorizationId)) {
    return usageEnvelope(ledger, authorizationId, 'run_claim_denied');
  }

  // Reserve BOTH slots before spawning EITHER provider (reserve-all-before-first-spawn).
  const reservations = new Map<SmokeProvider, Reservation>();
  const exhausted = new Set<SmokeProvider>();
  for (const provider of PROVIDER_ORDER) {
    const reservation = ledger.reserve(authorizationId, provider);
    if (reservation === null) exhausted.add(provider);
    else reservations.set(provider, reservation);
  }

  const repository = await deps.prepareRepository();
  const evidence: ProviderSmokeEvidence[] = [];
  for (const provider of PROVIDER_ORDER) {
    const usage = ledger.usage(authorizationId, provider).used;
    const reservation = reservations.get(provider);
    if (reservation === undefined) {
      evidence.push(pendingEvidence(provider, 'authorization_exhausted', usage));
      continue;
    }
    const result = await invokeSmokeProvider(
      {
        provider,
        executable: repository.executableFor(provider),
        argv:
          provider === 'openai'
            ? codexSmokeArgv(repository.paths, deps.models.openai)
            : claudeSmokeArgv(repository.paths, deps.models.anthropic),
        cwd: repository.paths.repository,
        environment: repository.environmentFor(provider),
        permissionMode: PERMISSION_MODE[provider],
        invocationCount: usage,
      },
      deps.processPort,
      now,
    );
    const finalized = withRepositoryStatus(result, repository.isUnchangedSince());
    ledger.recordOutcome(authorizationId, reservation, sanitizedOutcome(finalized));
    evidence.push(finalized);
  }

  void exhausted;
  return { schemaVersion: EVIDENCE_SCHEMA_VERSION, providers: evidence };
}

function envelope(
  reachedStage: SmokeReachedStage,
  invocationCount: number,
  errorCode?: string,
): ProviderSmokeEnvelope {
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    providers: PROVIDER_ORDER.map((provider) =>
      pendingEvidence(provider, reachedStage, invocationCount, errorCode),
    ),
  };
}

function usageEnvelope(
  ledger: SmokeLedger,
  authorizationId: string,
  reachedStage: SmokeReachedStage,
  errorCode?: string,
): ProviderSmokeEnvelope {
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    providers: PROVIDER_ORDER.map((provider) =>
      pendingEvidence(
        provider,
        reachedStage,
        safeUsed(ledger, authorizationId, provider),
        errorCode,
      ),
    ),
  };
}

function safeUsed(
  ledger: SmokeLedger,
  authorizationId: string,
  provider: SmokeProviderKey,
): number {
  try {
    return ledger.usage(authorizationId, provider).used;
  } catch {
    return 0;
  }
}

function ledgerErrorCode(error: unknown): string {
  return error instanceof ProviderLedgerError ? error.code : 'PROVIDER_LEDGER_ERROR';
}

function sanitizedOutcome(evidence: ProviderSmokeEvidence): Readonly<Record<string, unknown>> {
  return {
    reachedStage: evidence.reachedStage,
    exitClassification: evidence.exitClassification,
    strictResult: evidence.strictResult,
    repositoryUnchanged: evidence.repositoryUnchanged,
    invocationCount: evidence.invocationCount,
  };
}

export function withRepositoryStatus(
  evidence: ProviderSmokeEvidence,
  repositoryUnchanged: boolean,
): ProviderSmokeEvidence {
  return {
    ...evidence,
    repositoryUnchanged,
    exitClassification:
      repositoryUnchanged || evidence.exitClassification !== 'succeeded'
        ? evidence.exitClassification
        : 'repository_changed',
  };
}

export function isSmokePass(envelopeValue: ProviderSmokeEnvelope): boolean {
  return (
    envelopeValue.providers.length > 0 &&
    envelopeValue.providers.every(
      (item) =>
        item.reachedStage === 'invocation_completed' &&
        item.exitClassification === 'succeeded' &&
        item.strictResult &&
        item.repositoryUnchanged,
    )
  );
}

// ---------------------------------------------------------------------------
// Cleanup + real (deferred) execution wiring
// ---------------------------------------------------------------------------
export type ProviderSmokeDirectoryRemover = typeof rm;

export async function runProviderSmokeWithBestEffortCleanup<T>(
  operation: () => Promise<T>,
  cleanupPaths: () => readonly (string | undefined)[],
  removeDirectory: ProviderSmokeDirectoryRemover = rm,
): Promise<T> {
  let result!: T;
  try {
    result = await operation();
  } finally {
    const directories = cleanupPaths().filter((path): path is string => path !== undefined);
    await Promise.all(
      directories.map((directory) => removeProviderSmokeDirectory(directory, removeDirectory)),
    );
  }
  return result;
}

async function removeProviderSmokeDirectory(
  directory: string,
  removeDirectory: ProviderSmokeDirectoryRemover,
): Promise<void> {
  try {
    await removeDirectory(directory, {
      recursive: true,
      force: true,
      maxRetries: PROVIDER_SMOKE_CLEANUP_MAX_RETRIES,
      retryDelay: PROVIDER_SMOKE_CLEANUP_RETRY_DELAY_MS,
    });
  } catch {
    // Temporary smoke directories are intentionally best-effort cleanup.
  }
}

export function resolveLedgerDirectory(environment: NodeJS.ProcessEnv): string {
  const override = environment[LEDGER_DIR_ENV];
  if (override !== undefined && override.length > 0) return override;
  const localAppData = environment.LOCALAPPDATA ?? join('C:\\Users\\Public', 'AppData', 'Local');
  return join(localAppData, 'Orion', 'provider-smoke-ledger');
}

export interface GrantIssuer {
  grant(request: {
    readonly authorizationId: string;
    readonly codexModel: string;
    readonly claudeModel: string;
  }): AuthorizationGrant;
}

export function issueGrant(
  environment: NodeJS.ProcessEnv,
  ledgerFactory: () => GrantIssuer = () =>
    new ProviderAuthorizationLedger(resolveLedgerDirectory(environment), {
      forbiddenRoots: [workspaceRoot],
    }),
): AuthorizationGrant {
  const authorizationId = requiredEnvironment(environment, AUTHORIZATION_ID_ENV);
  const codexModel = requiredEnvironment(environment, CODEX_MODEL_ENV);
  const claudeModel = environment[CLAUDE_MODEL_ENV] ?? DEFAULT_CLAUDE_SMOKE_MODEL;
  return ledgerFactory().grant({ authorizationId, codexModel, claudeModel });
}

export async function runDeferredProviderSmoke(): Promise<ProviderSmokeEnvelope> {
  const environment = process.env;
  const authorizationId = environment[AUTHORIZATION_ID_ENV];
  const grantModels = () => {
    const codexModel = requiredEnvironment(environment, CODEX_MODEL_ENV);
    const claudeModel = environment[CLAUDE_MODEL_ENV] ?? DEFAULT_CLAUDE_SMOKE_MODEL;
    return { openai: codexModel, anthropic: claudeModel };
  };
  const runtime = await loadHardenedRuntime();
  const gitExecutable =
    environment.ORION_GIT_EXECUTABLE ??
    join(environment.ProgramFiles ?? 'C:\\Program Files', 'Git', 'cmd', 'git.exe');

  return runProviderSmoke({
    authorizationId,
    ledger: () =>
      new ProviderAuthorizationLedger(resolveLedgerDirectory(environment), {
        forbiddenRoots: [workspaceRoot],
      }),
    models: grantModels(),
    processPort: new runtime.NativeProviderProcessPort() as SmokeProcessPort,
    prepareRepository: async () => {
      const codexExecutable = runtime.resolveTrustedProviderExecutable(
        requiredEnvironment(environment, 'ORION_CODEX_EXECUTABLE'),
        { projectRoots: [workspaceRoot] },
      );
      const claudeExecutable = runtime.resolveTrustedProviderExecutable(
        requiredEnvironment(environment, 'ORION_CLAUDE_EXECUTABLE'),
        { projectRoots: [workspaceRoot] },
      );
      const runtimeDirectory = await mkdtemp(join(tmpdir(), 'orion-provider-smoke-runtime-'));
      const snapshotter = new GitReadRunner(gitExecutable, runtimeDirectory);
      const repository = await createSyntheticPublicRepository(gitExecutable);
      const schemaPath = join(runtimeDirectory, 'result-schema.json');
      const schemaSerialized = JSON.stringify(providerSmokeResultSchema);
      await writeFile(schemaPath, schemaSerialized, { encoding: 'utf8', mode: 0o600 });
      const baseline = snapshotter.snapshot(repository, 'main');
      const childEnvironment = runtime.buildProviderEnvironment(environment, []);
      const executables: Record<SmokeProvider, string> = {
        openai: codexExecutable,
        anthropic: claudeExecutable,
      };
      return {
        paths: { repository, schemaPath, schemaSerialized },
        isUnchangedSince: () => sameSnapshot(baseline, snapshotter.snapshot(repository, 'main')),
        environmentFor: () => childEnvironment,
        executableFor: (provider) => executables[provider],
      };
    },
  });
}

async function loadHardenedRuntime(): Promise<{
  readonly NativeProviderProcessPort: new () => SmokeProcessPort;
  readonly buildProviderEnvironment: (
    environment: NodeJS.ProcessEnv,
    requestedNames: readonly string[],
  ) => NodeJS.ProcessEnv;
  readonly resolveTrustedProviderExecutable: (
    path: string,
    options: { readonly projectRoots: readonly string[] },
  ) => string;
}> {
  const providerDirectory = resolve(workspaceRoot, 'apps/server/dist/providers');
  const [processModule, executableModule] = await Promise.all([
    import(pathToFileURL(join(providerDirectory, 'provider-process.js')).href),
    import(pathToFileURL(join(providerDirectory, 'trusted-provider-executable.js')).href),
  ]);
  return {
    NativeProviderProcessPort:
      processModule.NativeProviderProcessPort as new () => SmokeProcessPort,
    buildProviderEnvironment: processModule.buildProviderEnvironment as (
      environment: NodeJS.ProcessEnv,
      requestedNames: readonly string[],
    ) => NodeJS.ProcessEnv,
    resolveTrustedProviderExecutable: executableModule.resolveTrustedProviderExecutable as (
      path: string,
      options: { readonly projectRoots: readonly string[] },
    ) => string,
  };
}

async function createSyntheticPublicRepository(gitExecutable: string): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), 'orion-provider-smoke-public-'));
  if (isWithinWorkspace(repository)) {
    await rm(repository, { recursive: true, force: true });
    throw new Error('The synthetic smoke repository must be outside the workspace.');
  }
  try {
    await mkdir(join(repository, 'src'));
    await writeFile(
      join(repository, 'README.md'),
      '# Synthetic public provider smoke repository\n',
    );
    await writeFile(join(repository, 'src', 'example.ts'), 'export const answer = 42;\n');
    await runGit(gitExecutable, repository, ['init', '--initial-branch', 'main']);
    await runGit(gitExecutable, repository, ['config', 'user.name', 'Orion Smoke']);
    await runGit(gitExecutable, repository, ['config', 'user.email', 'smoke@example.invalid']);
    await runGit(gitExecutable, repository, ['add', '--all']);
    await runGit(gitExecutable, repository, ['commit', '--message', 'Synthetic smoke baseline']);
    return repository;
  } catch {
    await rm(repository, { recursive: true, force: true });
    throw new Error('The synthetic smoke repository could not be prepared.');
  }
}

function runGit(executable: string, cwd: string, argv: readonly string[]): Promise<void> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, argv, {
      cwd,
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.once('error', () => rejectRun(new Error('The synthetic repository command failed.')));
    child.once('close', (code) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error('The synthetic repository command failed.'));
    });
  });
}

function isWithinWorkspace(candidate: string): boolean {
  const relativePath = relative(workspaceRoot, candidate);
  return (
    relativePath === '' ||
    (!relativePath.startsWith('..') &&
      !relativePath.startsWith('/') &&
      !relativePath.startsWith('\\'))
  );
}

function requiredEnvironment(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (value === undefined || value.length === 0)
    throw new Error('A required provider smoke environment value is missing.');
  return value;
}

export function sameSnapshot(
  left: ReturnType<GitReadRunner['snapshot']>,
  right: ReturnType<GitReadRunner['snapshot']>,
): boolean {
  return (
    left.defaultBranch === right.defaultBranch &&
    left.currentBranch === right.currentBranch &&
    left.headSha === right.headSha &&
    left.dirty === right.dirty &&
    left.indexHash === right.indexHash &&
    left.trackedHash === right.trackedHash &&
    left.untrackedHash === right.untrackedHash &&
    left.filesHash === right.filesHash
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  if (mode === 'grant') {
    const grant = issueGrant(process.env);
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: EVIDENCE_SCHEMA_VERSION,
        grantedAuthorizationId: grant.authorizationId,
        providers: grant.providers,
      })}\n`,
    );
    process.exitCode = 0;
  } else if (!requiresRealProviderTestOptIn(process.env)) {
    process.exitCode = 1;
  } else {
    const result = await runDeferredProviderSmoke();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = isSmokePass(result) ? 0 : 1;
  }
}
