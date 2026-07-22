import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { runResultSchema } from '@orion/contracts';
import { GitReadRunner } from '@orion/server';

const scriptDirectory = resolve(fileURLToPath(new URL('.', import.meta.url)));
const workspaceRoot = resolve(
  scriptDirectory,
  basename(scriptDirectory) === 'dist' ? '../..' : '..',
);

export const REAL_PROVIDER_TESTS_ENV = 'ORION_REAL_PROVIDER_TESTS';
export const PROVIDER_SMOKE_TIMEOUT_MS = 5 * 60 * 1000;
export const PROVIDER_SMOKE_MAX_INVOCATIONS = 1;
export const CODEX_SMOKE_MODEL = 'gpt-5.6-sol';
export const CLAUDE_SMOKE_MODEL = 'sonnet';
export const CLAUDE_READ_ONLY_TOOLS = 'Read,Glob,Grep';
export const CLAUDE_DISALLOWED_TOOLS = 'Bash,Edit,Write,WebFetch,WebSearch';
export const PROVIDER_SMOKE_CLEANUP_MAX_RETRIES = 3;
export const PROVIDER_SMOKE_CLEANUP_RETRY_DELAY_MS = 100;

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

export interface ProviderSmokePaths {
  readonly repository: string;
  readonly schema: string;
}

export interface ProviderSmokeModels {
  readonly codex: string;
  readonly claude: string;
}
export type ProviderSmokeDirectoryRemover = typeof rm;

export function codexSmokeArgv(paths: ProviderSmokePaths, model: string): readonly string[] {
  return [
    'exec',
    '--json',
    '--sandbox',
    'read-only',
    '--cd',
    paths.repository,
    '--output-schema',
    paths.schema,
    '--model',
    model,
    '-',
  ];
}

/** Available for recovery inspection only; the P4 smoke never resumes or retries. */
export function codexResumeArgv(
  paths: ProviderSmokePaths,
  model: string,
  sessionId: string,
): readonly string[] {
  return [
    'exec',
    '--json',
    '--model',
    model,
    '--sandbox',
    'read-only',
    '--cd',
    paths.repository,
    '--output-schema',
    paths.schema,
    'resume',
    sessionId,
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
    paths.schema,
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
    '0.50',
  ];
}

export function providerSmokeModels(): ProviderSmokeModels {
  return { codex: CODEX_SMOKE_MODEL, claude: CLAUDE_SMOKE_MODEL };
}

export function requiresRealProviderTestOptIn(environment: NodeJS.ProcessEnv): boolean {
  return environment[REAL_PROVIDER_TESTS_ENV] === '1';
}

export type SmokeProvider = 'openai' | 'anthropic';

type Usage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheTokens?: number;
  durationMs?: number;
};

export interface ProviderSmokeEvidence {
  readonly provider: SmokeProvider;
  readonly cliVersion: string | null;
  readonly executableFingerprint: string;
  readonly invocationCount: number;
  readonly modelReported: string | null;
  readonly permissionMode: 'read-only' | 'dontAsk-read-only-tools';
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
  readonly exitClassification:
    | 'succeeded'
    | 'nonzero_exit'
    | 'signal'
    | 'timed_out'
    | 'spawn_failed'
    | 'result_schema_invalid'
    | 'repository_changed';
  readonly normalizedEventCounts: Readonly<Record<string, number>>;
  readonly sessionIdHash: string | null;
  readonly strictResult: boolean;
  readonly repositoryUnchanged: boolean;
  readonly childProcessCount: number;
  readonly reportedUsage: Usage | null;
  readonly reportedCost: number | null;
  readonly sanitizerFindingCount: number;
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
  readonly permissionMode: ProviderSmokeEvidence['permissionMode'];
}

const smokePrompt = [
  'Inspect only this synthetic public repository without writing files or using network tools.',
  'Return a strict RunResult that states the file count and detected languages.',
].join(' ');

export async function invokeSmokeProvider(
  invocation: SmokeInvocation,
  processPort: SmokeProcessPort,
  now: () => Date = () => new Date(),
): Promise<ProviderSmokeEvidence> {
  const started = now();
  const summary = createSummary();
  let timedOut = false;
  let childProcessCount = 0;
  let exitClassification: ProviderSmokeEvidence['exitClassification'] = 'spawn_failed';

  try {
    const child = await processPort.spawn({
      executable: invocation.executable,
      argv: invocation.argv,
      cwd: invocation.cwd,
      env: invocation.environment,
      shell: false,
    });
    childProcessCount = 1;
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
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    exitClassification = 'spawn_failed';
  }

  const ended = now();
  return {
    provider: invocation.provider,
    cliVersion: summary.cliVersion,
    executableFingerprint: hashOpaque(basename(invocation.executable).toLowerCase()),
    invocationCount: PROVIDER_SMOKE_MAX_INVOCATIONS,
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
  if (!isRecord(frame)) return;

  captureReportedMetadata(frame, summary);
  const eventType = normalizedEventType(provider, frame);
  if (eventType !== undefined) {
    summary.normalizedEventCounts[eventType] = (summary.normalizedEventCounts[eventType] ?? 0) + 1;
  }
  const sessionId = provider === 'openai' ? frame.thread_id : frame.session_id;
  if (isSafeOpaqueIdentifier(sessionId)) summary.sessionIdHash = hashOpaque(sessionId);
  const candidate = resultCandidate(frame);
  if (candidate !== undefined && runResultSchema.safeParse(candidate).success)
    summary.strictResult = true;
}

function captureReportedMetadata(frame: Record<string, unknown>, summary: ProviderSummary): void {
  if (summary.cliVersion === null && isSemanticVersion(frame.version))
    summary.cliVersion = frame.version;
  if (summary.modelReported === null && isModelIdentifier(frame.model))
    summary.modelReported = frame.model;
  const usage = isRecord(frame.usage) ? frame.usage : undefined;
  if (usage !== undefined) {
    for (const [source, target] of [
      ['input_tokens', 'inputTokens'],
      ['output_tokens', 'outputTokens'],
      ['cache_tokens', 'cacheTokens'],
      ['duration_ms', 'durationMs'],
    ] as const) {
      if (isNonNegativeInteger(usage[source])) summary.usage[target] = usage[source];
    }
  }
  const cost = frame.cost_usd ?? frame.costUSD;
  if (isNonNegativeNumber(cost)) summary.reportedCost = cost;
}

function normalizedEventType(
  provider: SmokeProvider,
  frame: Record<string, unknown>,
): string | undefined {
  if (provider === 'openai') {
    if (frame.type === 'thread.started') return 'run.started';
    if (frame.type === 'item.started') return 'run.tool.started';
    if (frame.type === 'item.completed')
      return 'result' in frame ? 'run.completed' : 'run.tool.completed';
    if (frame.type === 'turn.completed') return 'run.usage';
    if (frame.type === 'system.api_retry') return 'run.retry';
    return undefined;
  }
  if (frame.type === 'system' && frame.subtype === 'init') return 'run.started';
  if (frame.type === 'assistant') return 'run.output.delta';
  if (frame.type === 'tool_use') return 'run.tool.started';
  if (frame.type === 'tool_result') return 'run.tool.completed';
  if (frame.type === 'result')
    return resultCandidate(frame) === undefined ? 'run.usage' : 'run.completed';
  return undefined;
}

function resultCandidate(frame: Record<string, unknown>): unknown {
  if ('result' in frame) return frame.result;
  return isRecord(frame.item) && 'result' in frame.item ? frame.item.result : undefined;
}

function classifyExit(
  exit: { readonly exitCode: number | null; readonly signal: string | null },
  timedOut: boolean,
  strictResult: boolean,
): ProviderSmokeEvidence['exitClassification'] {
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

function isModelIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

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

export async function runDeferredProviderSmoke(): Promise<readonly ProviderSmokeEvidence[]> {
  const environment = process.env;
  const models = providerSmokeModels();
  const runtime = await loadHardenedRuntime();
  const codexExecutable = runtime.resolveTrustedProviderExecutable(
    requiredEnvironment(environment, 'ORION_CODEX_EXECUTABLE'),
    {
      projectRoots: [workspaceRoot],
    },
  );
  const claudeExecutable = runtime.resolveTrustedProviderExecutable(
    requiredEnvironment(environment, 'ORION_CLAUDE_EXECUTABLE'),
    {
      projectRoots: [workspaceRoot],
    },
  );
  const gitExecutable =
    environment.ORION_GIT_EXECUTABLE ??
    join(environment.ProgramFiles ?? 'C:\\Program Files', 'Git', 'cmd', 'git.exe');
  const runtimeDirectory = await mkdtemp(join(tmpdir(), 'orion-provider-smoke-runtime-'));
  let repository: string | undefined;
  return runProviderSmokeWithBestEffortCleanup(
    async () => {
      const snapshotter = new GitReadRunner(gitExecutable, runtimeDirectory);
      repository = await createSyntheticPublicRepository(gitExecutable);
      const schema = join(runtimeDirectory, 'result-schema.json');
      await writeFile(schema, JSON.stringify(providerSmokeResultSchema), {
        encoding: 'utf8',
        mode: 0o600,
      });
      const paths = { repository, schema };
      const baseline = snapshotter.snapshot(repository, 'main');
      const processPort = new runtime.NativeProviderProcessPort() as SmokeProcessPort;
      const childEnvironment = runtime.buildProviderEnvironment(environment, []);
      const codex = await invokeSmokeProvider(
        {
          provider: 'openai',
          executable: codexExecutable,
          argv: codexSmokeArgv(paths, models.codex),
          cwd: repository,
          environment: childEnvironment,
          permissionMode: 'read-only',
        },
        processPort,
      );
      const afterCodex = snapshotter.snapshot(repository, 'main');
      if (!sameSnapshot(baseline, afterCodex)) return [withRepositoryStatus(codex, false)];

      const claude = await invokeSmokeProvider(
        {
          provider: 'anthropic',
          executable: claudeExecutable,
          argv: claudeSmokeArgv(paths, models.claude),
          cwd: repository,
          environment: childEnvironment,
          permissionMode: 'dontAsk-read-only-tools',
        },
        processPort,
      );
      const afterClaude = snapshotter.snapshot(repository, 'main');
      const afterBoth = snapshotter.snapshot(repository, 'main');
      const unchanged = sameSnapshot(baseline, afterClaude) && sameSnapshot(baseline, afterBoth);
      return [withRepositoryStatus(codex, unchanged), withRepositoryStatus(claude, unchanged)];
    },
    () => [repository, runtimeDirectory],
  );
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
    throw new Error('A required trusted provider executable is missing.');
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

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!requiresRealProviderTestOptIn(process.env)) {
    process.exitCode = 1;
  } else {
    try {
      const evidence = await runDeferredProviderSmoke();
      process.stdout.write(`${JSON.stringify(evidence)}\n`);
      process.exitCode = evidence.every(
        (item) => item.exitClassification === 'succeeded' && item.repositoryUnchanged,
      )
        ? 0
        : 1;
    } catch {
      process.stdout.write('[]\n');
      process.exitCode = 1;
    }
  }
}
