import { isAbsolute, relative, win32 } from 'node:path';
import { realpathSync } from 'node:fs';

import { ulid } from 'ulid';

import {
  agentRunRequestSchema,
  normalizedAdapterEventSchema,
  resumeRunRequestSchema,
  runResultSchema,
  type AgentRunRequest,
  type AgentRuntimeAdapter,
  type NormalizedAdapterEvent,
  type ProviderCapabilityName,
  type ProviderDiagnostics,
  type ProviderHealth,
  type ProviderProcessErrorCode,
  type ProviderRunEventType,
  type ResumeRunRequest,
  type RunResult,
} from '@orion/contracts';

import { ApplicationError } from '../errors.js';
import {
  ChildProcessOwnershipRegistry,
  type OwnedProviderProcess,
} from './child-process-ownership.js';
import {
  IncrementalLineParser,
  type ProviderFrameMapper,
  type ProviderFrameMapping,
} from './incremental-line-parser.js';
import {
  buildProviderEnvironment,
  canonicalizeProviderCwd,
  type OutputSchemaStore,
  type ProviderProcessPort,
  type ProviderProcessExit,
  validateProviderModel,
} from './provider-process.js';
import { redactProviderText, SanitizedStderrRing } from './provider-redaction.js';
import {
  type NormalizedFrame,
  type NormalizedItem,
  type NormalizedUsage,
} from './provider-frame-normalization.js';

export interface AdapterMapperContext {
  readonly provider: 'openai' | 'anthropic';
  readonly model: string;
  readonly profileVersion: number;
  readonly now: () => number;
}

export interface ToolTimer {
  readonly startedAt: number;
  readonly toolName: string;
}

export interface ProviderAdapterOptions {
  readonly executable: string;
  readonly processPort: ProviderProcessPort;
  readonly schemaStore: OutputSchemaStore;
  readonly projectRoot: string;
  readonly worktreeRoot?: string;
  readonly resolveExecutable: (path: string) => string;
  readonly ownership?: ChildProcessOwnershipRegistry;
  readonly environment?: NodeJS.ProcessEnv;
  readonly now?: () => number;
}

export interface BuiltProviderCommand {
  readonly argv: readonly string[];
}
interface ProviderInspectionState {
  readonly health: ProviderHealth;
  readonly capabilities: ReadonlySet<ProviderCapabilityName>;
}

interface ProbeResult {
  readonly exit: ProviderProcessExit;
  readonly stdout: string;
}

export abstract class BaseProviderAdapter implements AgentRuntimeAdapter {
  private readonly ownership: ChildProcessOwnershipRegistry;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly now: () => number;
  private readonly runningHandles = new Map<string, string>();
  private inspection: ProviderInspectionState | undefined;

  protected constructor(protected readonly options: ProviderAdapterOptions) {
    this.ownership = options.ownership ?? new ChildProcessOwnershipRegistry();
    this.environment = options.environment ?? process.env;
    this.now = options.now ?? Date.now;
  }

  protected abstract readonly provider: 'openai' | 'anthropic';
  protected abstract readonly requiredCapabilities: readonly ProviderCapabilityName[];

  protected abstract readonly authenticationProbeArgs: readonly string[];

  protected abstract buildCommand(
    request: AgentRunRequest | ResumeRunRequest,
    schema: { readonly path: string; readonly serialized: string },
    resume: boolean,
  ): BuiltProviderCommand;

  protected abstract createMapper(context: AdapterMapperContext): ProviderFrameMapper;

  public async inspect(): Promise<ProviderHealth> {
    const checkedAt = new Date(this.now()).toISOString();
    try {
      const executable = this.options.resolveExecutable(this.options.executable);
      const cwd = canonicalizeProviderCwd(
        this.options.projectRoot,
        this.options.projectRoot,
        'read_only',
      );
      const version = await this.probe(executable, ['--version'], cwd);
      if (version.exit.exitCode !== 0) {
        return this.recordInspection(
          {
            provider: this.provider,
            installed: false,
            cliVersion: null,
            authenticated: false,
            status: 'not_installed',
            supportedModels: [],
            lastCheckedAt: checkedAt,
            sanitizedError: 'The provider command is unavailable.',
          },
          [],
        );
      }

      const cliVersion = parseCliVersion(version.stdout);
      if (cliVersion === undefined) {
        return this.recordInspection(
          {
            provider: this.provider,
            installed: true,
            cliVersion: null,
            authenticated: false,
            status: 'error',
            supportedModels: [],
            lastCheckedAt: checkedAt,
            sanitizedError: 'The provider version probe returned an invalid response.',
          },
          [],
        );
      }

      const authentication = await this.probe(executable, this.authenticationProbeArgs, cwd);
      if (!isAuthenticated(authentication)) {
        return this.recordInspection(
          {
            provider: this.provider,
            installed: true,
            cliVersion,
            authenticated: false,
            status: 'unauthenticated',
            supportedModels: [],
            lastCheckedAt: checkedAt,
            sanitizedError: 'Provider authentication is required.',
          },
          [],
        );
      }

      const metadata = `${version.stdout}\n${authentication.stdout}`;
      const supportedModels = parseProbeModels(metadata);
      const capabilities = parseProbeCapabilities(metadata);
      const supportsRequiredCapabilities = this.requiredCapabilities.every((capability) =>
        capabilities.has(capability),
      );
      if (!supportsRequiredCapabilities || supportedModels.length === 0) {
        return this.recordInspection(
          {
            provider: this.provider,
            installed: true,
            cliVersion,
            authenticated: true,
            status: 'unsupported',
            supportedModels,
            lastCheckedAt: checkedAt,
            sanitizedError: 'The provider does not support the required capabilities.',
          },
          capabilities,
        );
      }

      return this.recordInspection(
        {
          provider: this.provider,
          installed: true,
          cliVersion,
          authenticated: true,
          status: 'ready',
          supportedModels,
          lastCheckedAt: checkedAt,
          sanitizedError: null,
        },
        capabilities,
      );
    } catch {
      return this.recordInspection(
        {
          provider: this.provider,
          installed: false,
          cliVersion: null,
          authenticated: false,
          status: 'not_installed',
          supportedModels: [],
          lastCheckedAt: checkedAt,
          sanitizedError: 'The provider command is unavailable.',
        },
        [],
      );
    }
  }

  public start(request: AgentRunRequest): AsyncIterable<NormalizedAdapterEvent> {
    return this.execute(agentRunRequestSchema.parse(request), false);
  }

  public resume(request: ResumeRunRequest): AsyncIterable<NormalizedAdapterEvent> {
    return this.execute(resumeRunRequestSchema.parse(request), true);
  }

  public async cancel(runtimeHandle: string): Promise<void> {
    await this.ownership.cancel(runtimeHandle);
  }

  public runtimeHandleForRun(runId: string): string | undefined {
    return this.runningHandles.get(runId);
  }
  private recordInspection(
    health: ProviderHealth,
    capabilities: ReadonlySet<ProviderCapabilityName> | readonly ProviderCapabilityName[],
  ): ProviderHealth {
    this.inspection = { health, capabilities: new Set(capabilities) };
    return health;
  }

  private async probe(
    executable: string,
    argv: readonly string[],
    cwd: string,
  ): Promise<ProbeResult> {
    const child = await this.options.processPort.spawn({
      executable,
      argv,
      cwd,
      env: buildProviderEnvironment(this.environment, []),
      shell: false,
    });
    const [stdout, exit] = await Promise.all([
      collectProbeOutput(child.stdout),
      child.exited,
      drainProbeOutput(child.stderr),
    ]);
    return { exit, stdout };
  }

  private inspectionFailure(model: string):
    | {
        readonly code: ProviderProcessErrorCode;
        readonly retryable: boolean;
        readonly message: string;
      }
    | undefined {
    const inspection = this.inspection;
    if (inspection === undefined) return undefined;
    if (!inspection.health.installed) {
      return {
        code: 'PROVIDER_UNAVAILABLE',
        retryable: true,
        message: 'The selected provider is unavailable.',
      };
    }
    if (!inspection.health.authenticated) {
      return {
        code: 'PROVIDER_AUTH_REQUIRED',
        retryable: false,
        message: 'Provider authentication is required.',
      };
    }
    if (
      inspection.health.status !== 'ready' ||
      !inspection.health.supportedModels.includes(model) ||
      !this.requiredCapabilities.every((capability) => inspection.capabilities.has(capability))
    ) {
      return {
        code: 'PROVIDER_UNSUPPORTED',
        retryable: false,
        message: 'The provider does not support the requested capability.',
      };
    }
    return undefined;
  }

  private async *execute(
    request: AgentRunRequest | ResumeRunRequest,
    resume: boolean,
  ): AsyncGenerator<NormalizedAdapterEvent> {
    const startedAt = this.now();
    if (request.provider !== this.provider) {
      throw new ApplicationError(
        'VALIDATION_FAILED',
        'The request provider does not match this adapter.',
      );
    }
    const model = validateProviderModel(request.model);
    if (this.inspection === undefined) await this.inspect();
    const inspectionFailure = this.inspectionFailure(model);
    if (inspectionFailure !== undefined) {
      yield adapterEvent(
        'run.failed',
        {
          errorCode: inspectionFailure.code,
          retryable: inspectionFailure.retryable,
          sanitizedMessage: inspectionFailure.message,
        },
        EMPTY_PROVIDER_DIAGNOSTICS,
      );
      return;
    }
    const cwd = canonicalizeProviderCwd(
      request.cwd,
      this.options.projectRoot,
      request.executionMode,
      this.options.worktreeRoot,
    );
    const executable = this.options.resolveExecutable(this.options.executable);
    const schema = this.options.schemaStore.create(request.runId, request.outputSchemaPath);
    if (
      !isSafeRuntimeSchemaPath(schema.path, [
        this.options.projectRoot,
        ...(this.options.worktreeRoot === undefined ? [] : [this.options.worktreeRoot]),
      ])
    ) {
      schema.remove();
      throw new ApplicationError(
        'OUTPUT_SCHEMA_INVALID',
        'The output schema file must be outside project and worktree paths.',
      );
    }
    let owned: OwnedProviderProcess | undefined;
    let timeout: NodeJS.Timeout | undefined;
    try {
      const command = this.buildCommand({ ...request, cwd, model }, schema, resume);
      assertSafeProviderArguments(command.argv);
      const child = await this.options.processPort.spawn({
        executable,
        argv: command.argv,
        cwd,
        env: buildProviderEnvironment(this.environment, request.environmentVariableNames),
        shell: false,
      });
      owned = this.ownership.register(request.runId, child);
      this.runningHandles.set(request.runId, owned.runtimeHandle);
      try {
        await child.writeStdin(Buffer.from(request.prompt, 'utf8'));
      } catch {
        this.ownership.terminateForFailure(owned);
        throw new ApplicationError(
          'PROVIDER_EXECUTION_FAILED',
          'The provider prompt could not be delivered.',
        );
      }

      const timeoutAt = Date.parse(request.timeoutAt);
      const armTimeout = () => {
        const remaining = timeoutAt - this.now();
        if (remaining <= 0) {
          this.ownership.markTimedOut(owned as OwnedProviderProcess);
          return;
        }
        timeout = setTimeout(armTimeout, Math.min(remaining, MAX_TIMEOUT_DELAY_MS));
      };
      armTimeout();

      const stderr = new SanitizedStderrRing();
      const stderrTask = drainStderr(child.stderr, stderr);
      const parser = new IncrementalLineParser(
        this.createMapper({
          provider: this.provider,
          model,
          profileVersion: request.agentProfileSnapshot.version,
          now: this.now,
        }),
      );
      let streamFailure: ApplicationError | undefined;
      let protocolStopRequested = false;
      try {
        for await (const chunk of child.stdout) {
          for (const event of parser.push(chunk)) yield event;
          if (parser.error !== undefined && !protocolStopRequested) {
            protocolStopRequested = true;
            this.ownership.terminateForFailure(owned);
          }
        }
        for (const event of parser.finish()) yield event;
      } catch {
        streamFailure = new ApplicationError(
          'PROCESS_CRASHED',
          'The provider output stream ended unexpectedly.',
          {
            retryable: true,
          },
        );
      }

      const [exit] = await Promise.all([child.exited, stderrTask]);
      if (timeout !== undefined) clearTimeout(timeout);
      await this.ownership.verifyClosed(owned);
      const diagnostics = mergeDiagnostics(parser.diagnostics, stderr);
      const terminal = classifyTerminal({
        cancelled: this.ownership.wasCancelled(owned),
        timedOut: this.ownership.wasTimedOut(owned),
        parserError: parser.error,
        streamFailure,
        exit,
        hasResult: parser.result !== undefined,
        stderr: stderr.text,
      });

      if (terminal.kind === 'cancelled') {
        yield adapterEvent(
          'run.cancelled',
          {
            requestedBy: 'user',
            reason: 'The provider run was cancelled.',
          },
          diagnostics,
        );
        return;
      }
      if (terminal.kind === 'failed') {
        yield adapterEvent(
          'run.failed',
          {
            errorCode: terminal.code,
            retryable: terminal.retryable,
            sanitizedMessage: terminal.message,
          },
          diagnostics,
        );
        return;
      }

      const result = parser.result;
      if (result === undefined || result.status !== 'succeeded') {
        yield adapterEvent(
          'run.failed',
          {
            errorCode: 'PROVIDER_EXECUTION_FAILED',
            retryable: false,
            sanitizedMessage: 'The provider did not report a successful result.',
          },
          diagnostics,
        );
        return;
      }
      yield adapterEvent(
        'run.completed',
        {
          status: 'succeeded',
          resultArtifactId: ulid(),
          durationMs: Math.max(0, this.now() - startedAt),
        },
        diagnostics,
      );
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      this.runningHandles.delete(request.runId);
      schema.remove();
    }
  }
}

export function eventMapping(
  type: ProviderRunEventType,
  payload: Record<string, unknown>,
  providerEventId?: string,
): ProviderFrameMapping {
  return {
    kind: 'recognized',
    ...(providerEventId === undefined ? {} : { providerEventId }),
    createEvents: (diagnostics) => [adapterEvent(type, payload, diagnostics, providerEventId)],
  };
}

export function sessionAndStartedMapping(
  context: AdapterMapperContext,
  sessionId: string,
  providerEventId?: string,
): ProviderFrameMapping {
  return {
    kind: 'recognized',
    ...(providerEventId === undefined ? {} : { providerEventId }),
    sessionMarker: `${context.provider}:${sessionId}`,
    createEvents: (diagnostics) => [
      normalizedAdapterEventSchema.parse({ kind: 'session', sessionId, diagnostics }),
      adapterEvent(
        'run.started',
        {
          attempt: 1,
          provider: context.provider,
          model: context.model,
          profileVersion: context.profileVersion,
          sessionId,
        },
        diagnostics,
        providerEventId,
      ),
    ],
  };
}

export function resultMapping(result: RunResult, providerEventId?: string): ProviderFrameMapping {
  return {
    kind: 'recognized',
    ...(providerEventId === undefined ? {} : { providerEventId }),
    result,
    createEvents: () => [],
  };
}

export function unknownMapping(): ProviderFrameMapping {
  return { kind: 'unknown' };
}

export function invalidMapping(finalSchema = false): ProviderFrameMapping {
  return finalSchema ? { kind: 'invalid', finalSchema: true } : { kind: 'invalid' };
}

export function adapterEvent(
  type: ProviderRunEventType,
  payload: Record<string, unknown>,
  diagnostics: ProviderDiagnostics,
  providerEventId?: string,
): NormalizedAdapterEvent {
  return normalizedAdapterEventSchema.parse({
    kind: 'event',
    event: {
      ...(providerEventId === undefined ? {} : { providerEventId }),
      type,
      payload,
      diagnostics,
    },
  });
}

/**
 * Shared conversion of a provider-agnostic NormalizedFrame into a single ProviderFrameMapping.
 * Both the Codex and Claude adapters delegate here so the only per-provider logic is the pure
 * frame normalizer. Redaction and RunResult validation are applied here; tool-duration state is
 * mutated ONLY inside `createEvents` (i.e. after IncrementalLineParser dedup acceptance).
 */
export function buildProviderFrameMapping(
  normalized: NormalizedFrame,
  context: AdapterMapperContext,
  toolTimers: Map<string, ToolTimer>,
): ProviderFrameMapping {
  if (normalized.kind === 'unknown') return unknownMapping();
  if (normalized.kind === 'invalid') return invalidMapping(normalized.finalSchema === true);

  let result: RunResult | undefined;
  if (normalized.result !== undefined) {
    const parsed = runResultSchema.safeParse(normalized.result);
    if (!parsed.success) return invalidMapping(true);
    result = parsed.data;
  }

  const sessionItem = normalized.items.find(
    (item): item is Extract<NormalizedItem, { kind: 'session' }> => item.kind === 'session',
  );
  const sessionMarker =
    sessionItem === undefined ? undefined : `${context.provider}:${sessionItem.sessionId}`;

  return {
    kind: 'recognized',
    ...(normalized.frameIdentity === undefined
      ? {}
      : { providerEventId: normalized.frameIdentity }),
    ...(sessionMarker === undefined ? {} : { sessionMarker }),
    ...(result === undefined ? {} : { result }),
    createEvents: (diagnostics) =>
      normalized.items.flatMap((item) =>
        buildNormalizedItemEvents(item, context, toolTimers, diagnostics),
      ),
  };
}

function buildNormalizedItemEvents(
  item: NormalizedItem,
  context: AdapterMapperContext,
  toolTimers: Map<string, ToolTimer>,
  diagnostics: ProviderDiagnostics,
): readonly NormalizedAdapterEvent[] {
  switch (item.kind) {
    case 'session':
      return [
        normalizedAdapterEventSchema.parse({
          kind: 'session',
          sessionId: item.sessionId,
          diagnostics,
        }),
        adapterEvent(
          'run.started',
          {
            attempt: 1,
            provider: context.provider,
            model: context.model,
            profileVersion: context.profileVersion,
            sessionId: item.sessionId,
          },
          diagnostics,
        ),
      ];
    case 'output':
      return [
        adapterEvent(
          'run.output.delta',
          { channel: 'summary', text: nonEmptyRedacted(item.text) },
          diagnostics,
          item.identity,
        ),
      ];
    case 'tool.started':
      toolTimers.set(item.toolId, { startedAt: context.now(), toolName: item.toolName });
      return [
        adapterEvent(
          'run.tool.started',
          {
            toolName: item.toolName,
            sanitizedInput: nonEmptyRedacted(
              item.sanitizedInput ?? 'Provider tool input was omitted.',
            ),
            externalMutation: false,
          },
          diagnostics,
          item.identity,
        ),
      ];
    case 'tool.completed': {
      const timer = toolTimers.get(item.toolId);
      const durationMs = timer === undefined ? 0 : Math.max(0, context.now() - timer.startedAt);
      const toolName = timer?.toolName ?? item.toolName;
      toolTimers.delete(item.toolId);
      return [
        adapterEvent(
          'run.tool.completed',
          { toolName, status: item.status, durationMs },
          diagnostics,
          item.identity,
        ),
      ];
    }
    case 'usage': {
      const payload = usageEventPayload(item.usage);
      return payload === undefined
        ? []
        : [adapterEvent('run.usage', payload, diagnostics, item.identity)];
    }
    case 'retry':
      return [
        adapterEvent(
          'run.retry',
          { attempt: item.attempt, delayMs: item.delayMs, reasonCode: 'PROVIDER_THROTTLED' },
          diagnostics,
          item.identity,
        ),
      ];
  }
}

function usageEventPayload(usage: NormalizedUsage): Record<string, number | string> | undefined {
  const payload: Record<string, number | string> = {};
  if (usage.inputTokens !== undefined) payload.inputTokens = usage.inputTokens;
  if (usage.outputTokens !== undefined) payload.outputTokens = usage.outputTokens;
  if (usage.cacheTokens !== undefined) payload.cacheTokens = usage.cacheTokens;
  if (usage.durationMs !== undefined) payload.durationMs = usage.durationMs;
  if (usage.reportedCost !== undefined && usage.currency !== undefined) {
    payload.reportedCost = usage.reportedCost;
    payload.currency = usage.currency;
  }
  return Object.keys(payload).length === 0 ? undefined : payload;
}

function nonEmptyRedacted(value: string): string {
  const redacted = redactProviderText(value);
  return redacted.length === 0 ? '[REDACTED]' : redacted;
}

export function assertSafeProviderArguments(argv: readonly string[]): void {
  if (
    argv.some(
      (argument) =>
        argument.startsWith('--dangerously-') ||
        argument === '--skip-git-repo-check' ||
        argument === '--allow-dangerously-skip-permissions' ||
        argument === '--fallback-model' ||
        argument === 'bypassPermissions',
    )
  ) {
    throw new ApplicationError(
      'VALIDATION_FAILED',
      'Provider command arguments include a forbidden permission bypass.',
    );
  }
}

const EMPTY_PROVIDER_DIAGNOSTICS: ProviderDiagnostics = {
  invalidFrameCount: 0,
  consecutiveInvalidFrameCount: 0,
  unknownEventCount: 0,
  stderrBytes: 0,
  stderrOmittedBytes: 0,
};

const MAX_PROBE_OUTPUT_BYTES = 16 * 1024;
const CAPABILITY_NAMES = new Set<ProviderCapabilityName>([
  'jsonl',
  'stream_json',
  'output_schema',
  'resume',
  'sandbox',
  'permission_mode',
]);

async function collectProbeOutput(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Buffer[] = [];
  let retained = 0;
  for await (const chunk of stream) {
    const remaining = MAX_PROBE_OUTPUT_BYTES - retained;
    if (remaining <= 0) continue;
    const bounded = Buffer.from(chunk).subarray(0, remaining);
    chunks.push(bounded);
    retained += bounded.byteLength;
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function drainProbeOutput(stream: AsyncIterable<Uint8Array>): Promise<void> {
  for await (const chunk of stream) {
    void chunk;
    // Drain all probe diagnostics without retaining provider output.
  }
}

function parseCliVersion(output: string): string | undefined {
  const match = /\b[vV]?(\d+(?:\.\d+){1,3})\b/.exec(output);
  return match?.[1];
}

function isAuthenticated(probe: ProbeResult): boolean {
  return (
    probe.exit.exitCode === 0 &&
    probe.exit.signal === null &&
    !/\b(?:not\s+(?:logged\s+in|authenticated)|unauthenticated|login\s+required|authentication\s+required)\b/i.test(
      probe.stdout,
    )
  );
}

function parseProbeModels(output: string): string[] {
  return parseProbeList(output, 'models').filter(
    (model) =>
      /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(model) &&
      !/(?:token|secret|password|authorization|credential|cookie|^sk-)/i.test(model),
  );
}

function parseProbeCapabilities(output: string): Set<ProviderCapabilityName> {
  const capabilities = new Set<ProviderCapabilityName>();
  for (const value of parseProbeList(output, 'capabilities')) {
    if (CAPABILITY_NAMES.has(value as ProviderCapabilityName))
      capabilities.add(value as ProviderCapabilityName);
  }
  return capabilities;
}

function parseProbeList(output: string, name: 'models' | 'capabilities'): string[] {
  const values = new Set<string>();
  const expression = new RegExp(`^\\s*${name}\\s*[:=]\\s*(.+)$`, 'i');
  for (const line of output.split(/\r?\n/)) {
    const match = expression.exec(line);
    if (match?.[1] === undefined) continue;
    for (const value of match[1].split(',')) {
      const normalized = value.trim();
      if (normalized.length > 0) values.add(normalized);
    }
  }
  return [...values].slice(0, 128);
}
function mergeDiagnostics(
  base: ProviderDiagnostics,
  stderr: SanitizedStderrRing,
): ProviderDiagnostics {
  return {
    ...base,
    stderrBytes: stderr.byteCount,
    stderrOmittedBytes: stderr.omittedByteCount,
  };
}

async function drainStderr(
  stream: AsyncIterable<Uint8Array>,
  stderr: SanitizedStderrRing,
): Promise<void> {
  for await (const chunk of stream) stderr.push(chunk);
  stderr.finish();
}

function isSafeRuntimeSchemaPath(path: string, roots: readonly string[]): boolean {
  if (!isAbsolute(path) && !win32.isAbsolute(path)) return false;
  let candidate = path;
  try {
    candidate = realpathSync.native(path);
  } catch {
    // Test ports may expose a synthetic safe path; production stores create the file first.
  }
  return roots.every((root) => {
    let canonicalRoot = root;
    try {
      canonicalRoot = realpathSync.native(root);
    } catch {
      return false;
    }
    const relativePath = relative(canonicalRoot, candidate);
    return relativePath.startsWith('..') || isAbsolute(relativePath);
  });
}
const MAX_TIMEOUT_DELAY_MS = 2_147_483_647;
type TerminalClassification =
  | { readonly kind: 'success' }
  | { readonly kind: 'cancelled' }
  | {
      readonly kind: 'failed';
      readonly code: ProviderProcessErrorCode;
      readonly retryable: boolean;
      readonly message: string;
    };

function classifyTerminal(input: {
  readonly cancelled: boolean;
  readonly timedOut: boolean;
  readonly parserError: ApplicationError | undefined;
  readonly streamFailure: ApplicationError | undefined;
  readonly exit: ProviderProcessExit;
  readonly hasResult: boolean;
  readonly stderr: string;
}): TerminalClassification {
  if (input.cancelled) return { kind: 'cancelled' };
  if (input.timedOut) {
    return {
      kind: 'failed',
      code: 'RUN_TIMED_OUT',
      retryable: false,
      message: 'The provider run timed out.',
    };
  }
  if (input.parserError !== undefined) {
    return {
      kind: 'failed',
      code: input.parserError.code as ProviderProcessErrorCode,
      retryable: false,
      message: input.parserError.message,
    };
  }
  if (input.streamFailure !== undefined || input.exit.signal !== null) {
    return {
      kind: 'failed',
      code: 'PROCESS_CRASHED',
      retryable: true,
      message: 'The provider process crashed.',
    };
  }
  if (input.exit.exitCode !== 0) {
    const message = redactProviderText(input.stderr).toLowerCase();
    if (message.includes('auth') || message.includes('login')) {
      return {
        kind: 'failed',
        code: 'PROVIDER_AUTH_REQUIRED',
        retryable: false,
        message: 'Provider authentication is required.',
      };
    }
    if (message.includes('thrott') || message.includes('rate limit')) {
      return {
        kind: 'failed',
        code: 'PROVIDER_THROTTLED',
        retryable: true,
        message: 'The provider is temporarily throttled.',
      };
    }
    if (message.includes('model')) {
      return {
        kind: 'failed',
        code: 'MODEL_UNAVAILABLE',
        retryable: false,
        message: 'The requested model is unavailable.',
      };
    }
    return {
      kind: 'failed',
      code: 'PROVIDER_EXECUTION_FAILED',
      retryable: false,
      message: 'Provider execution failed.',
    };
  }
  if (!input.hasResult) {
    return {
      kind: 'failed',
      code: 'ADAPTER_PROTOCOL_ERROR',
      retryable: false,
      message: 'The provider exited without a final result.',
    };
  }
  return { kind: 'success' };
}
