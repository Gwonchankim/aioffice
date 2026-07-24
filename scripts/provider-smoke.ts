import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
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
  type GrantRequest,
  type PolicyProjection,
  type ProviderBinding,
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
export const CODEX_EXECUTABLE_ENV = 'ORION_CODEX_EXECUTABLE';
export const CLAUDE_EXECUTABLE_ENV = 'ORION_CLAUDE_EXECUTABLE';
export const LEDGER_DIR_ENV = 'ORION_PROVIDER_LEDGER_DIR';
export const PROVIDER_SMOKE_TIMEOUT_MS = SMOKE_GRANT_OPTIONS.timeoutMs;
export const CLAUDE_READ_ONLY_TOOLS = SMOKE_GRANT_OPTIONS.allowedTools;
export const CLAUDE_DISALLOWED_TOOLS = SMOKE_GRANT_OPTIONS.disallowedTools;
export const PROVIDER_SMOKE_MAX_BUDGET_USD = SMOKE_GRANT_OPTIONS.maxBudgetUsd;
/** Verified valid Claude alias; still bound per-authorization and operator-overridable. */
export const DEFAULT_CLAUDE_SMOKE_MODEL = 'sonnet';
export const PROVIDER_SMOKE_CLEANUP_MAX_RETRIES = 3;
export const PROVIDER_SMOKE_CLEANUP_RETRY_DELAY_MS = 100;

/** Official empty Claude MCP configuration (0 servers); replaces the bare `{}` which is not the
 * official shape and is rejected by the CLI's strict MCP validation. */
export const CLAUDE_EMPTY_MCP_CONFIG = JSON.stringify({ mcpServers: {} });

/** Bumped when the argv/schema/prompt smoke policy changes; bound into and re-checked against the
 * grant so any prior grant fails policy_binding_mismatch. v3: strict schema items + provider-neutral
 * prompt + official empty MCP config. */
export const ARGV_POLICY_VERSION = 3;
export const REPOSITORY_TEMPLATE_VERSION = 1;

export const EVIDENCE_SCHEMA_VERSION = 1 as const;

// Strict structured-output JSON Schema accepted by BOTH providers:
// - every array carries a real `items` schema; every object has `additionalProperties:false`
//   and lists ALL of its properties in `required` (OpenAI structured-outputs strict mode);
//   optional runResult fields are required+nullable (`type:['string','null']`).
// - NO `maxItems`/`minLength`/`format`: Anthropic structured outputs reject array constraints
//   other than `minItems` 0/1, so emptiness+success are enforced smoke-locally (smokeResultIsStrict),
//   not via the schema. The empty succeeded result still passes this schema AND runResultSchema.
export const providerSmokeResultSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'summary', 'findings', 'artifacts', 'changes', 'tests', 'risks', 'handoff'],
  properties: {
    status: { type: 'string', enum: ['succeeded'] },
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'text', 'evidence'],
        properties: {
          severity: { type: 'string', enum: ['info', 'low', 'medium', 'high', 'critical'] },
          text: { type: 'string' },
          evidence: { type: ['string', 'null'] },
        },
      },
    },
    artifacts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'path', 'title', 'description'],
        properties: {
          kind: { type: 'string' },
          path: { type: ['string', 'null'] },
          title: { type: 'string' },
          description: { type: ['string', 'null'] },
        },
      },
    },
    changes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['commitSha', 'files', 'description'],
        properties: {
          commitSha: { type: ['string', 'null'] },
          files: { type: 'array', items: { type: 'string' } },
          description: { type: 'string' },
        },
      },
    },
    tests: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['command', 'status', 'summary'],
        properties: {
          command: { type: 'string' },
          status: { type: 'string', enum: ['passed', 'failed', 'not_run'] },
          summary: { type: 'string' },
        },
      },
    },
    risks: { type: 'array', items: { type: 'string' } },
    handoff: { type: 'string' },
  },
} as const;

// Provider-NEUTRAL prompt (no provider-specific tool names): each provider enforces read-only
// access through its own argv (Codex `--sandbox read-only`; Claude `--allowedTools/--disallowedTools`).
const smokePrompt = [
  'Inspect this synthetic public repository in a strictly read-only way.',
  'Do not modify or create any file, do not run shell, bash, or git commands, do not access the network, do not run tests, and do not create artifacts.',
  'Return a strict JSON RunResult that exactly matches the provided schema:',
  'status must be "succeeded";',
  'summary must state the number of files and the detected programming languages;',
  'findings, artifacts, changes, tests, and risks must each be an empty array [];',
  'handoff must confirm that the read-only inspection completed.',
].join(' ');

/**
 * Authoritative smoke strict-result check: the model output must pass the Zod runResultSchema AND
 * report status `succeeded` AND leave all five arrays empty. This enforces the smoke's empty-result
 * contract locally (the JSON schema cannot, because Anthropic rejects `maxItems`).
 */
export function smokeResultIsStrict(candidate: unknown): boolean {
  const parsed = runResultSchema.safeParse(candidate);
  if (!parsed.success) return false;
  const result = parsed.data;
  return (
    result.status === 'succeeded' &&
    result.findings.length === 0 &&
    result.artifacts.length === 0 &&
    result.changes.length === 0 &&
    result.tests.length === 0 &&
    result.risks.length === 0
  );
}

export type SmokeProvider = 'openai' | 'anthropic';
export type CleanupStatus = 'complete' | 'incomplete' | 'not_reached';

export type SmokeReachedStage =
  | 'authorization_missing'
  | 'grant_missing'
  | 'grant_corrupt'
  | 'ledger_unsafe'
  | 'policy_binding_mismatch'
  | 'model_binding_conflict'
  | 'run_claim_denied'
  | 'authorization_exhausted'
  | 'preflight_unavailable'
  | 'executable_binding_mismatch'
  | 'security_halt'
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
  readonly reservedCount: number;
  readonly spawnAttemptCount: number;
  /** Cumulative real spawn-attempt count for this provider (= spawnAttemptCount). */
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
  readonly diagnostic?: ProviderDiagnosticCode;
}

export interface ProviderSmokeEnvelope {
  readonly schemaVersion: typeof EVIDENCE_SCHEMA_VERSION;
  readonly providers: readonly ProviderSmokeEvidence[];
  readonly cleanup: CleanupStatus;
}

export interface GrantEnvelope {
  readonly schemaVersion: typeof EVIDENCE_SCHEMA_VERSION;
  readonly mode: 'grant';
  readonly result: 'granted' | 'error';
  readonly authorizationIdHash?: string;
  readonly providers?: {
    readonly openai: { readonly model: string; readonly binding: ProviderBinding };
    readonly anthropic: { readonly model: string; readonly binding: ProviderBinding };
  };
  readonly policy?: PolicyProjection;
  readonly errorCode?: string;
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
  readonly executableFingerprint: string;
}

// ---------------------------------------------------------------------------
// Live policy projection (recomputed at grant AND run; compared field-by-field)
// ---------------------------------------------------------------------------
export function computeLivePolicy(): PolicyProjection {
  return {
    argvPolicyVersion: ARGV_POLICY_VERSION,
    schemaHash: sha256(JSON.stringify(providerSmokeResultSchema)),
    promptHash: sha256(smokePrompt),
    repositoryTemplateVersion: REPOSITORY_TEMPLATE_VERSION,
  };
}

function policyMatches(live: PolicyProjection, options: PolicyProjection): boolean {
  return (
    live.argvPolicyVersion === options.argvPolicyVersion &&
    live.schemaHash === options.schemaHash &&
    live.promptHash === options.promptHash &&
    live.repositoryTemplateVersion === options.repositoryTemplateVersion
  );
}

// ---------------------------------------------------------------------------
// Executable binding probe (resolve + content fingerprint + --version)
// ---------------------------------------------------------------------------
export interface ProbeResult {
  /** Trusted resolved path; used ONLY to launch. Never written to evidence. */
  readonly resolvedPath: string;
  readonly executableBasename: string;
  readonly executableFingerprint: string;
  readonly cliVersion: string;
}

export interface ProviderBindingProbe {
  probe(provider: SmokeProviderKey): ProbeResult;
}

function bindingFromProbe(
  provider: SmokeProviderKey,
  model: string,
  result: ProbeResult,
): ProviderBinding {
  return {
    provider,
    model,
    executableBasename: result.executableBasename,
    executableFingerprint: result.executableFingerprint,
    cliVersion: result.cliVersion,
  };
}

function bindingMatches(result: ProbeResult, binding: ProviderBinding): boolean {
  return (
    result.executableBasename === binding.executableBasename &&
    result.executableFingerprint === binding.executableFingerprint &&
    result.cliVersion === binding.cliVersion
  );
}

// ---------------------------------------------------------------------------
// Argv (SMG-008 execution-isolation flags — only installed-CLI-supported flags)
// ---------------------------------------------------------------------------
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
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '-',
  ];
}

export function claudeSmokeArgv(paths: ProviderSmokePaths, model: string): readonly string[] {
  // NOTE: `--max-turns` is NOT a supported flag in claude 2.1.156; `--print` is single-turn and
  // `--max-budget-usd` bounds cost. No automatic fallback is used.
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
    '--no-chrome',
    '--no-session-persistence',
    '--strict-mcp-config',
    '--mcp-config',
    CLAUDE_EMPTY_MCP_CONFIG,
    '--disable-slash-commands',
    '--max-budget-usd',
    String(PROVIDER_SMOKE_MAX_BUDGET_USD),
  ];
}

function argvFor(
  provider: SmokeProvider,
  paths: ProviderSmokePaths,
  model: string,
): readonly string[] {
  return provider === 'openai' ? codexSmokeArgv(paths, model) : claudeSmokeArgv(paths, model);
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
      exitClassification = classifyExit(
        exit,
        timedOut,
        summary.hasStrictResult && !summary.terminalFailure,
      );
      reachedStage = 'invocation_completed';
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    exitClassification = 'spawn_failed';
  }

  const ended = now();
  const strictResult = summary.hasStrictResult && !summary.terminalFailure;
  const diagnostic: ProviderDiagnosticCode | undefined =
    exitClassification === 'succeeded'
      ? undefined
      : (summary.frameDiagnostic ??
        classifyProviderDiagnostic(summary.stderrBuffer) ??
        'UNKNOWN_PROVIDER_FAILURE');
  return {
    provider: invocation.provider,
    reachedStage,
    reservedCount: 0,
    spawnAttemptCount: 0,
    invocationCount: 0,
    cliVersion: summary.cliVersion,
    executableFingerprint: invocation.executableFingerprint,
    modelReported: summary.modelReported,
    permissionMode: invocation.permissionMode,
    startedAt: started.toISOString(),
    endedAt: ended.toISOString(),
    durationMs: Math.max(0, ended.getTime() - started.getTime()),
    exitClassification,
    normalizedEventCounts: summary.normalizedEventCounts,
    sessionIdHash: summary.sessionIdHash,
    strictResult,
    ...(diagnostic === undefined ? {} : { diagnostic }),
    repositoryUnchanged: true,
    childProcessCount,
    reportedUsage: Object.keys(summary.usage).length === 0 ? null : summary.usage,
    reportedCost: summary.reportedCost,
    sanitizerFindingCount: summary.sanitizerFindingCount,
  };
}

// ---------------------------------------------------------------------------
// Sanitized failure diagnostics (CFG-004/005/006): map bounded stderr / terminal failure frames to
// a closed enum of generic codes. Raw stderr/stdout/message text is NEVER retained.
// ---------------------------------------------------------------------------
export type ProviderDiagnosticCode =
  | 'MODEL_UNAVAILABLE'
  | 'INVALID_OUTPUT_SCHEMA'
  | 'INVALID_ARGUMENT'
  | 'INVALID_MCP_CONFIG'
  | 'AUTHENTICATION_FAILED'
  | 'PERMISSION_DENIED'
  | 'RATE_LIMITED'
  | 'NETWORK_UNAVAILABLE'
  | 'PROVIDER_INTERNAL_ERROR'
  | 'UNKNOWN_PROVIDER_FAILURE';

export const DIAGNOSTIC_MAX_BYTES = 16384;

// Priority-ordered matchers; the FIRST matching rule (top to bottom) wins. Each `all` term must be
// present. Only the code is returned; the matched text is discarded.
const DIAGNOSTIC_RULES: ReadonlyArray<{ code: ProviderDiagnosticCode; any: readonly string[] }> = [
  {
    code: 'INVALID_MCP_CONFIG',
    any: ['mcpservers', 'mcp config', 'mcp-config', 'mcp server', 'invalid mcp', 'strict mcp'],
  },
  {
    code: 'INVALID_OUTPUT_SCHEMA',
    any: [
      'output schema',
      'output-schema',
      'json schema',
      'json-schema',
      'response_format',
      'structured output',
      'additionalproperties',
      'maxitems',
      'invalid schema',
      'schema is invalid',
      'schema must',
      'required property',
      'unsupported schema',
    ],
  },
  {
    code: 'INVALID_ARGUMENT',
    any: [
      'unknown option',
      'unknown flag',
      'unrecognized',
      'unexpected argument',
      'invalid argument',
      'invalid option',
      'invalid flag',
      'no such option',
    ],
  },
  {
    code: 'MODEL_UNAVAILABLE',
    any: [
      'unknown model',
      'no such model',
      'model not found',
      'model is not',
      'model unavailable',
      'model does not exist',
      'invalid model',
      'unsupported model',
      'model not supported',
      'model is deprecated',
      'no access to model',
    ],
  },
  {
    code: 'AUTHENTICATION_FAILED',
    any: [
      'unauthenticated',
      'unauthorized',
      'authentication',
      'not logged in',
      'invalid api key',
      'invalid token',
      'login required',
      '401',
    ],
  },
  {
    code: 'PERMISSION_DENIED',
    any: ['permission denied', 'forbidden', 'not allowed', 'access denied', '403'],
  },
  {
    code: 'RATE_LIMITED',
    any: ['rate limit', 'rate-limit', 'ratelimit', 'too many requests', 'quota', '429'],
  },
  {
    code: 'NETWORK_UNAVAILABLE',
    any: [
      'econnrefused',
      'etimedout',
      'enotfound',
      'network',
      'dns',
      'connection refused',
      'offline',
      'proxy',
      'tls handshake',
    ],
  },
  {
    code: 'PROVIDER_INTERNAL_ERROR',
    any: [
      'internal server error',
      'internal error',
      '500',
      '502',
      '503',
      '504',
      'panic',
      'segfault',
      'unexpected error',
    ],
  },
];

/** Classify bounded text into a generic diagnostic code. `undefined` when the text is empty. */
export function classifyProviderDiagnostic(text: string): ProviderDiagnosticCode | undefined {
  const bounded = text.slice(0, DIAGNOSTIC_MAX_BYTES).toLowerCase();
  if (bounded.trim().length === 0) return undefined;
  for (const rule of DIAGNOSTIC_RULES) {
    if (rule.any.some((needle) => bounded.includes(needle))) return rule.code;
  }
  return 'UNKNOWN_PROVIDER_FAILURE';
}

interface ProviderSummary {
  cliVersion: string | null;
  modelReported: string | null;
  normalizedEventCounts: Record<string, number>;
  sessionIdHash: string | null;
  hasStrictResult: boolean;
  terminalFailure: boolean;
  frameDiagnostic: ProviderDiagnosticCode | undefined;
  stderrBuffer: string; // transient bounded buffer; classified then discarded, never in evidence
  stderrBufferBytes: number;
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
    hasStrictResult: false,
    terminalFailure: false,
    frameDiagnostic: undefined,
    stderrBuffer: '',
    stderrBufferBytes: 0,
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
  for await (const chunk of stream) {
    const text = chunk.toString();
    summary.sanitizerFindingCount += sanitizerFindings(text);
    if (summary.stderrBufferBytes < DIAGNOSTIC_MAX_BYTES) {
      const bounded = text.slice(0, DIAGNOSTIC_MAX_BYTES - summary.stderrBufferBytes);
      summary.stderrBuffer += bounded;
      summary.stderrBufferBytes += bounded.length;
    }
  }
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
  if (isRecord(frame)) {
    captureCliVersion(frame, summary);
    captureFailureFrame(provider, frame, summary);
  }
  const normalized: NormalizedFrame =
    provider === 'openai' ? normalizeCodexFrame(frame) : normalizeClaudeFrame(frame);
  if (normalized.kind !== 'recognized') return;

  for (const item of normalized.items) recordNormalizedItem(item, summary);
  if (normalized.metadata !== undefined) captureMetadata(normalized.metadata, summary);
  if (normalized.result !== undefined && smokeResultIsStrict(normalized.result)) {
    summary.hasStrictResult = true;
    increment(summary, 'run.completed');
  }
}

// CFG-005/006: recognize Codex `error`/`turn.failed` and Claude error-result frames as terminal
// failures. Only a generic diagnostic code is retained; the raw message/code text is discarded.
function captureFailureFrame(
  provider: SmokeProvider,
  frame: Record<string, unknown>,
  summary: ProviderSummary,
): void {
  const type = typeof frame.type === 'string' ? frame.type : '';
  let failed = false;
  let text = '';
  if (provider === 'openai') {
    if (type === 'error') {
      failed = true;
      text = diagnosticText(frame.message);
    } else if (type === 'turn.failed') {
      failed = true;
      const error = recordOf(frame.error);
      text =
        diagnosticText(error?.message) ||
        diagnosticText(error?.code) ||
        diagnosticText(frame.message);
    }
  } else if (type === 'error') {
    failed = true;
    text = diagnosticText(frame.message);
  } else if (type === 'result') {
    const subtype = typeof frame.subtype === 'string' ? frame.subtype : '';
    if (frame.is_error === true || /error|fail/i.test(subtype)) {
      failed = true;
      const error = recordOf(frame.error);
      text = diagnosticText(error?.message) || diagnosticText(frame.result) || subtype;
    }
  }
  if (!failed) return;
  summary.terminalFailure = true;
  if (summary.frameDiagnostic === undefined) {
    summary.frameDiagnostic = classifyProviderDiagnostic(text) ?? 'UNKNOWN_PROVIDER_FAILURE';
  }
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function diagnosticText(value: unknown): string {
  return typeof value === 'string' ? value : '';
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

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function hashOpaque(value: string): string {
  return sha256(value);
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
// Evidence assembly (one shape on every path; never `[]`)
// ---------------------------------------------------------------------------
export interface ProviderCounts {
  readonly reservedCount: number;
  readonly spawnAttemptCount: number;
  readonly invocationCount: number;
}

export function pendingEvidence(
  provider: SmokeProvider,
  reachedStage: SmokeReachedStage,
  counts: ProviderCounts,
  errorCode?: string,
): ProviderSmokeEvidence {
  return {
    provider,
    reachedStage,
    reservedCount: counts.reservedCount,
    spawnAttemptCount: counts.spawnAttemptCount,
    invocationCount: counts.invocationCount,
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
  markSpawnAttempt(authorizationId: string, provider: SmokeProviderKey, ordinal: number): void;
  usage(
    authorizationId: string,
    provider: SmokeProviderKey,
  ): { granted: number; reserved: number; spawnAttempts: number };
  recordOutcome(
    authorizationId: string,
    reservation: Reservation,
    outcome: Readonly<Record<string, unknown>>,
  ): void;
}

export interface SmokeRepository {
  readonly paths: ProviderSmokePaths;
  isUnchangedSince(): boolean;
  environmentFor(provider: SmokeProvider): NodeJS.ProcessEnv;
}

export interface RunProviderSmokeDeps {
  readonly authorizationId: string | undefined;
  readonly ledger: SmokeLedger | (() => SmokeLedger);
  readonly processPort: SmokeProcessPort;
  readonly prepareRepository: () => Promise<SmokeRepository>;
  readonly probe: ProviderBindingProbe;
  readonly environment: NodeJS.ProcessEnv;
  readonly cleanup: () => Promise<CleanupStatus>;
  readonly livePolicy?: PolicyProjection;
  readonly now?: () => Date;
}

interface InMemoryMarks {
  reserved: boolean;
  spawnAttempted: boolean;
}

/** Orchestrate the fail-closed one-time smoke. Always returns the single envelope; never `[]`. */
export async function runProviderSmoke(deps: RunProviderSmokeDeps): Promise<ProviderSmokeEnvelope> {
  const marks: Record<SmokeProvider, InMemoryMarks> = {
    openai: { reserved: false, spawnAttempted: false },
    anthropic: { reserved: false, spawnAttempted: false },
  };
  let providers: readonly ProviderSmokeEvidence[];
  try {
    providers = await orchestrateProviders(deps, marks);
  } catch {
    providers = PROVIDER_ORDER.map((provider) =>
      pendingEvidence(
        provider,
        'preflight_unavailable',
        counts(undefined, marks[provider]),
        'PREFLIGHT_UNAVAILABLE',
      ),
    );
  }
  let cleanup: CleanupStatus;
  try {
    cleanup = await deps.cleanup();
  } catch {
    cleanup = 'incomplete';
  }
  return { schemaVersion: EVIDENCE_SCHEMA_VERSION, providers, cleanup };
}

async function orchestrateProviders(
  deps: RunProviderSmokeDeps,
  marks: Record<SmokeProvider, InMemoryMarks>,
): Promise<readonly ProviderSmokeEvidence[]> {
  const now = deps.now ?? (() => new Date());
  const livePolicy = deps.livePolicy ?? computeLivePolicy();
  const authorizationId = deps.authorizationId;
  if (authorizationId === undefined || authorizationId.length === 0) {
    return uniform('authorization_missing', undefined, marks);
  }

  let ledger: SmokeLedger;
  try {
    ledger = typeof deps.ledger === 'function' ? deps.ledger() : deps.ledger;
  } catch (error) {
    return uniform('ledger_unsafe', undefined, marks, ledgerErrorCode(error));
  }

  let grant: AuthorizationGrant | undefined;
  try {
    grant = ledger.readGrant(authorizationId);
  } catch (error) {
    return uniform(
      'grant_corrupt',
      boundLedger(ledger, authorizationId),
      marks,
      ledgerErrorCode(error),
    );
  }
  if (grant === undefined) return uniform('grant_missing', undefined, marks);

  if (!policyMatches(livePolicy, grant.options)) {
    return uniform(
      'policy_binding_mismatch',
      boundLedger(ledger, authorizationId),
      marks,
      'POLICY_BINDING_MISMATCH',
    );
  }
  if (detectModelConflict(deps.environment, grant)) {
    return uniform(
      'model_binding_conflict',
      boundLedger(ledger, authorizationId),
      marks,
      'MODEL_BINDING_CONFLICT',
    );
  }

  if (!ledger.claimRun(authorizationId)) {
    return uniform('run_claim_denied', boundLedger(ledger, authorizationId), marks);
  }

  const reservations = new Map<SmokeProvider, Reservation>();
  for (const provider of PROVIDER_ORDER) {
    const reservation = ledger.reserve(authorizationId, provider);
    if (reservation !== null) {
      reservations.set(provider, reservation);
      marks[provider].reserved = true;
    }
  }

  let repository: SmokeRepository;
  try {
    repository = await deps.prepareRepository();
  } catch {
    return uniform(
      'preflight_unavailable',
      boundLedger(ledger, authorizationId),
      marks,
      'PREFLIGHT_UNAVAILABLE',
    );
  }

  const evidence: ProviderSmokeEvidence[] = [];
  let halted = false;
  for (const provider of PROVIDER_ORDER) {
    const reservation = reservations.get(provider);
    const providerCounts = () =>
      counts(safeUsage(ledger, authorizationId, provider), marks[provider]);
    if (halted) {
      evidence.push(pendingEvidence(provider, 'security_halt', providerCounts(), 'SECURITY_HALT'));
      continue;
    }
    if (reservation === undefined) {
      evidence.push(pendingEvidence(provider, 'authorization_exhausted', providerCounts()));
      continue;
    }

    let probeResult: ProbeResult;
    try {
      probeResult = deps.probe.probe(provider);
    } catch {
      evidence.push(
        pendingEvidence(
          provider,
          'preflight_unavailable',
          providerCounts(),
          'EXECUTABLE_RESOLVE_FAILED',
        ),
      );
      continue;
    }
    if (!bindingMatches(probeResult, grant.providers[provider].binding)) {
      evidence.push(
        pendingEvidence(
          provider,
          'executable_binding_mismatch',
          providerCounts(),
          'EXECUTABLE_BINDING_MISMATCH',
        ),
      );
      continue;
    }

    try {
      ledger.markSpawnAttempt(authorizationId, provider, reservation.ordinal);
      marks[provider].spawnAttempted = true;
    } catch {
      evidence.push(
        pendingEvidence(provider, 'preflight_unavailable', providerCounts(), 'SPAWN_MARK_FAILED'),
      );
      continue;
    }

    const base = await invokeSmokeProvider(
      {
        provider,
        executable: probeResult.resolvedPath,
        argv: argvFor(provider, repository.paths, grant.providers[provider].model),
        cwd: repository.paths.repository,
        environment: repository.environmentFor(provider),
        permissionMode: PERMISSION_MODE[provider],
        executableFingerprint: grant.providers[provider].binding.executableFingerprint,
      },
      deps.processPort,
      now,
    );

    let unchanged: boolean;
    try {
      unchanged = repository.isUnchangedSince();
    } catch {
      unchanged = false; // fail closed on an unknown snapshot
    }
    const finalized = withRepositoryStatus({ ...base, ...providerCounts() }, unchanged);
    try {
      ledger.recordOutcome(authorizationId, reservation, sanitizedOutcome(finalized));
    } catch {
      // outcome metadata is advisory
    }
    evidence.push(finalized);
    if (!unchanged || finalized.exitClassification === 'repository_changed') halted = true;
  }
  return evidence;
}

function uniform(
  reachedStage: SmokeReachedStage,
  ledger: BoundLedger | undefined,
  marks: Record<SmokeProvider, InMemoryMarks>,
  errorCode?: string,
): readonly ProviderSmokeEvidence[] {
  return PROVIDER_ORDER.map((provider) =>
    pendingEvidence(provider, reachedStage, counts(ledger?.(provider), marks[provider]), errorCode),
  );
}

type BoundLedger = (provider: SmokeProvider) => { reserved: number; spawnAttempts: number };

function boundLedger(ledger: SmokeLedger, authorizationId: string): BoundLedger {
  return (provider) => safeUsage(ledger, authorizationId, provider);
}

function safeUsage(
  ledger: SmokeLedger,
  authorizationId: string,
  provider: SmokeProviderKey,
): { reserved: number; spawnAttempts: number } {
  try {
    const usage = ledger.usage(authorizationId, provider);
    return { reserved: usage.reserved, spawnAttempts: usage.spawnAttempts };
  } catch {
    return { reserved: 0, spawnAttempts: 0 };
  }
}

function counts(
  usage: { reserved: number; spawnAttempts: number } | undefined,
  mark: InMemoryMarks,
): ProviderCounts {
  const reservedCount = Math.max(usage?.reserved ?? 0, mark.reserved ? 1 : 0);
  const spawnAttemptCount = Math.max(usage?.spawnAttempts ?? 0, mark.spawnAttempted ? 1 : 0);
  return { reservedCount, spawnAttemptCount, invocationCount: spawnAttemptCount };
}

function detectModelConflict(environment: NodeJS.ProcessEnv, grant: AuthorizationGrant): boolean {
  const codex = environment[CODEX_MODEL_ENV];
  const claude = environment[CLAUDE_MODEL_ENV];
  if (codex !== undefined && codex.length > 0 && codex !== grant.providers.openai.model)
    return true;
  if (claude !== undefined && claude.length > 0 && claude !== grant.providers.anthropic.model)
    return true;
  return false;
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
    spawnAttemptCount: evidence.spawnAttemptCount,
    reservedCount: evidence.reservedCount,
    ...(evidence.diagnostic === undefined ? {} : { diagnostic: evidence.diagnostic }),
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

export function isSmokePass(envelope: ProviderSmokeEnvelope): boolean {
  return (
    envelope.cleanup === 'complete' &&
    envelope.providers.length > 0 &&
    envelope.providers.every(
      (item) =>
        item.reachedStage === 'invocation_completed' &&
        item.exitClassification === 'succeeded' &&
        item.strictResult &&
        item.repositoryUnchanged,
    )
  );
}

// ---------------------------------------------------------------------------
// Per-run resource tracker + cleanup
// ---------------------------------------------------------------------------
export type ProviderSmokeDirectoryRemover = typeof rm;

export class ResourceTracker {
  private readonly directories: string[] = [];
  public constructor(private readonly remove: ProviderSmokeDirectoryRemover = rm) {}
  public track(directory: string): void {
    if (directory.length > 0 && !this.directories.includes(directory))
      this.directories.push(directory);
  }
  public async cleanup(): Promise<CleanupStatus> {
    let complete = true;
    for (const directory of this.directories) {
      try {
        await this.remove(directory, {
          recursive: true,
          force: true,
          maxRetries: PROVIDER_SMOKE_CLEANUP_MAX_RETRIES,
          retryDelay: PROVIDER_SMOKE_CLEANUP_RETRY_DELAY_MS,
        });
      } catch {
        complete = false;
      }
    }
    return complete ? 'complete' : 'incomplete';
  }
}

export function resolveLedgerDirectory(environment: NodeJS.ProcessEnv): string {
  const override = environment[LEDGER_DIR_ENV];
  if (override !== undefined && override.length > 0) return override;
  const localAppData = environment.LOCALAPPDATA ?? join('C:\\Users\\Public', 'AppData', 'Local');
  return join(localAppData, 'Orion', 'provider-smoke-ledger');
}

// ---------------------------------------------------------------------------
// Grant issuance (0 provider/model calls; --version capability probe only)
// ---------------------------------------------------------------------------
export interface GrantIssuer {
  grant(request: GrantRequest): AuthorizationGrant;
}

export interface IssueGrantDeps {
  readonly environment: NodeJS.ProcessEnv;
  readonly ledger: GrantIssuer;
  readonly probe: ProviderBindingProbe;
  readonly policy?: PolicyProjection;
}

export function issueGrant(deps: IssueGrantDeps): AuthorizationGrant {
  const authorizationId = requiredEnvironment(deps.environment, AUTHORIZATION_ID_ENV);
  const codexModel = requiredEnvironment(deps.environment, CODEX_MODEL_ENV);
  const claudeModel = deps.environment[CLAUDE_MODEL_ENV] ?? DEFAULT_CLAUDE_SMOKE_MODEL;
  const codexBinding = bindingFromProbe('openai', codexModel, deps.probe.probe('openai'));
  const claudeBinding = bindingFromProbe('anthropic', claudeModel, deps.probe.probe('anthropic'));
  return deps.ledger.grant({
    authorizationId,
    providers: {
      openai: { model: codexModel, binding: codexBinding },
      anthropic: { model: claudeModel, binding: claudeBinding },
    },
    policy: deps.policy ?? computeLivePolicy(),
  });
}

export function grantEnvelope(grant: AuthorizationGrant, result: 'granted'): GrantEnvelope {
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    mode: 'grant',
    result,
    authorizationIdHash: sha256(grant.authorizationId),
    providers: {
      openai: { model: grant.providers.openai.model, binding: grant.providers.openai.binding },
      anthropic: {
        model: grant.providers.anthropic.model,
        binding: grant.providers.anthropic.binding,
      },
    },
    policy: {
      argvPolicyVersion: grant.options.argvPolicyVersion,
      schemaHash: grant.options.schemaHash,
      promptHash: grant.options.promptHash,
      repositoryTemplateVersion: grant.options.repositoryTemplateVersion,
    },
  };
}

function grantErrorEnvelope(errorCode: string): GrantEnvelope {
  return { schemaVersion: EVIDENCE_SCHEMA_VERSION, mode: 'grant', result: 'error', errorCode };
}

// ---------------------------------------------------------------------------
// Deferred (real) execution wiring — injectable seams
// ---------------------------------------------------------------------------
export interface HardenedRuntime {
  readonly NativeProviderProcessPort: new () => SmokeProcessPort;
  readonly buildProviderEnvironment: (
    environment: NodeJS.ProcessEnv,
    requestedNames: readonly string[],
  ) => NodeJS.ProcessEnv;
  readonly resolveTrustedProviderExecutable: (
    path: string,
    options: { readonly projectRoots: readonly string[] },
  ) => string;
}

export interface DeferredSmokeDependencies {
  readonly environment: NodeJS.ProcessEnv;
  readonly loadRuntime: () => Promise<HardenedRuntime>;
  readonly makeProbe: (
    runtime: HardenedRuntime,
    environment: NodeJS.ProcessEnv,
  ) => ProviderBindingProbe;
  readonly ledgerFactory: (environment: NodeJS.ProcessEnv) => SmokeLedger;
  readonly resourceTracker: ResourceTracker;
  readonly prepareRepository: (
    runtime: HardenedRuntime,
    environment: NodeJS.ProcessEnv,
    tracker: ResourceTracker,
  ) => Promise<SmokeRepository>;
  readonly now: () => Date;
}

export async function runDeferredProviderSmoke(
  overrides: Partial<DeferredSmokeDependencies> = {},
): Promise<ProviderSmokeEnvelope> {
  const deps = resolveDeferredDependencies(overrides);
  const tracker = deps.resourceTracker;
  let runtime: HardenedRuntime;
  try {
    runtime = await deps.loadRuntime();
  } catch {
    return {
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      providers: PROVIDER_ORDER.map((provider) =>
        pendingEvidence(provider, 'preflight_unavailable', zeroCounts(), 'RUNTIME_LOAD_FAILED'),
      ),
      cleanup: await safeTrackerCleanup(tracker),
    };
  }

  return runProviderSmoke({
    authorizationId: deps.environment[AUTHORIZATION_ID_ENV],
    environment: deps.environment,
    ledger: () => deps.ledgerFactory(deps.environment),
    probe: deps.makeProbe(runtime, deps.environment),
    processPort: new runtime.NativeProviderProcessPort(),
    now: deps.now,
    cleanup: () => tracker.cleanup(),
    prepareRepository: () => deps.prepareRepository(runtime, deps.environment, tracker),
  });
}

function resolveDeferredDependencies(
  overrides: Partial<DeferredSmokeDependencies>,
): DeferredSmokeDependencies {
  return {
    environment: overrides.environment ?? process.env,
    loadRuntime: overrides.loadRuntime ?? loadHardenedRuntime,
    makeProbe: overrides.makeProbe ?? makeRealBindingProbe,
    ledgerFactory:
      overrides.ledgerFactory ??
      ((environment) =>
        new ProviderAuthorizationLedger(resolveLedgerDirectory(environment), {
          forbiddenRoots: [workspaceRoot],
        })),
    resourceTracker: overrides.resourceTracker ?? new ResourceTracker(),
    prepareRepository: overrides.prepareRepository ?? prepareRealRepository,
    now: overrides.now ?? (() => new Date()),
  };
}

async function safeTrackerCleanup(tracker: ResourceTracker): Promise<CleanupStatus> {
  try {
    return await tracker.cleanup();
  } catch {
    return 'incomplete';
  }
}

function makeRealBindingProbe(
  runtime: HardenedRuntime,
  environment: NodeJS.ProcessEnv,
): ProviderBindingProbe {
  const executableEnv: Record<SmokeProviderKey, string> = {
    openai: CODEX_EXECUTABLE_ENV,
    anthropic: CLAUDE_EXECUTABLE_ENV,
  };
  return {
    probe(provider) {
      const resolvedPath = runtime.resolveTrustedProviderExecutable(
        requiredEnvironment(environment, executableEnv[provider]),
        { projectRoots: [workspaceRoot] },
      );
      const executableFingerprint = sha256Bytes(resolvedPath);
      const cliVersion = probeCliVersion(resolvedPath);
      return {
        resolvedPath,
        executableBasename: basename(resolvedPath),
        executableFingerprint,
        cliVersion,
      };
    },
  };
}

function sha256Bytes(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Local `--version` capability probe (no model prompt, no provider service call). */
function probeCliVersion(executable: string): string {
  const result = spawnSync(executable, ['--version'], {
    shell: false,
    windowsHide: true,
    encoding: 'utf8',
    timeout: 15_000,
  });
  const match = /\b(\d+(?:\.\d+){1,3})\b/.exec(`${result.stdout ?? ''}`);
  if (match?.[1] === undefined) throw new Error('The provider version probe failed.');
  return match[1];
}

async function prepareRealRepository(
  runtime: HardenedRuntime,
  environment: NodeJS.ProcessEnv,
  tracker: ResourceTracker,
): Promise<SmokeRepository> {
  const gitExecutable =
    environment.ORION_GIT_EXECUTABLE ??
    join(environment.ProgramFiles ?? 'C:\\Program Files', 'Git', 'cmd', 'git.exe');
  const runtimeDirectory = await mkdtemp(join(tmpdir(), 'orion-provider-smoke-runtime-'));
  tracker.track(runtimeDirectory);
  const repository = await createSyntheticPublicRepository(gitExecutable, tracker);
  const snapshotter = new GitReadRunner(gitExecutable, runtimeDirectory);
  const schemaPath = join(runtimeDirectory, 'result-schema.json');
  const schemaSerialized = JSON.stringify(providerSmokeResultSchema);
  await writeFile(schemaPath, schemaSerialized, { encoding: 'utf8', mode: 0o600 });
  const baseline = snapshotter.snapshot(repository, 'main');
  const childEnvironment = runtime.buildProviderEnvironment(environment, []);
  return {
    paths: { repository, schemaPath, schemaSerialized },
    isUnchangedSince: () => sameSnapshot(baseline, snapshotter.snapshot(repository, 'main')),
    environmentFor: () => childEnvironment,
  };
}

async function loadHardenedRuntime(): Promise<HardenedRuntime> {
  const providerDirectory = resolve(workspaceRoot, 'apps/server/dist/providers');
  const [processModule, executableModule] = await Promise.all([
    import(pathToFileURL(join(providerDirectory, 'provider-process.js')).href),
    import(pathToFileURL(join(providerDirectory, 'trusted-provider-executable.js')).href),
  ]);
  return {
    NativeProviderProcessPort:
      processModule.NativeProviderProcessPort as new () => SmokeProcessPort,
    buildProviderEnvironment:
      processModule.buildProviderEnvironment as HardenedRuntime['buildProviderEnvironment'],
    resolveTrustedProviderExecutable:
      executableModule.resolveTrustedProviderExecutable as HardenedRuntime['resolveTrustedProviderExecutable'],
  };
}

async function createSyntheticPublicRepository(
  gitExecutable: string,
  tracker: ResourceTracker,
): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), 'orion-provider-smoke-public-'));
  tracker.track(repository);
  if (isWithinWorkspace(repository)) {
    throw new Error('The synthetic smoke repository must be outside the workspace.');
  }
  await mkdir(join(repository, 'src'));
  await writeFile(join(repository, 'README.md'), '# Synthetic public provider smoke repository\n');
  await writeFile(join(repository, 'src', 'example.ts'), 'export const answer = 42;\n');
  await runGit(gitExecutable, repository, ['init', '--initial-branch', 'main']);
  await runGit(gitExecutable, repository, ['config', 'user.name', 'Orion Smoke']);
  await runGit(gitExecutable, repository, ['config', 'user.email', 'smoke@example.invalid']);
  await runGit(gitExecutable, repository, ['add', '--all']);
  await runGit(gitExecutable, repository, ['commit', '--message', 'Synthetic smoke baseline']);
  return repository;
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

function zeroCounts(): ProviderCounts {
  return { reservedCount: 0, spawnAttemptCount: 0, invocationCount: 0 };
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

// ---------------------------------------------------------------------------
// CLI dispatch (top-level sanitized catch; never `[]`, never a raw exception)
// ---------------------------------------------------------------------------
export interface SmokeCliDeps {
  readonly environment: NodeJS.ProcessEnv;
  readonly runGrant: () => AuthorizationGrant;
  readonly runSmoke: () => Promise<ProviderSmokeEnvelope>;
  readonly stdout: (line: string) => void;
  readonly setExitCode: (code: number) => void;
}

export async function runSmokeCli(argv: readonly string[], deps: SmokeCliDeps): Promise<void> {
  const mode = argv[0];
  try {
    if (mode === 'grant') {
      const grant = deps.runGrant();
      deps.stdout(`${JSON.stringify(grantEnvelope(grant, 'granted'))}\n`);
      deps.setExitCode(0);
      return;
    }
    if (!requiresRealProviderTestOptIn(deps.environment)) {
      deps.setExitCode(1);
      return;
    }
    const envelope = await deps.runSmoke();
    deps.stdout(`${JSON.stringify(envelope)}\n`);
    deps.setExitCode(isSmokePass(envelope) ? 0 : 1);
  } catch (error) {
    const errorCode = mode === 'grant' ? ledgerErrorCode(error) : 'PROVIDER_SMOKE_ERROR';
    const envelope: GrantEnvelope | ProviderSmokeEnvelope =
      mode === 'grant'
        ? grantErrorEnvelope(errorCode)
        : {
            schemaVersion: EVIDENCE_SCHEMA_VERSION,
            providers: PROVIDER_ORDER.map((provider) =>
              pendingEvidence(provider, 'preflight_unavailable', zeroCounts(), errorCode),
            ),
            cleanup: 'incomplete',
          };
    deps.stdout(`${JSON.stringify(envelope)}\n`);
    deps.setExitCode(1);
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let hardenedRuntime: HardenedRuntime | undefined;
  try {
    hardenedRuntime = await loadHardenedRuntime();
  } catch {
    hardenedRuntime = undefined;
  }
  await runSmokeCli(process.argv.slice(2), {
    environment: process.env,
    runGrant: () => {
      if (hardenedRuntime === undefined) throw new Error('The provider runtime is unavailable.');
      return issueGrant({
        environment: process.env,
        ledger: new ProviderAuthorizationLedger(resolveLedgerDirectory(process.env), {
          forbiddenRoots: [workspaceRoot],
        }),
        probe: makeRealBindingProbe(hardenedRuntime, process.env),
      });
    },
    runSmoke: () => runDeferredProviderSmoke(),
    stdout: (line) => process.stdout.write(line),
    setExitCode: (code) => {
      process.exitCode = code;
    },
  });
}
