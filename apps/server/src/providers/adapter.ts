import { isAbsolute, relative, win32 } from 'node:path';
import { realpathSync } from 'node:fs';

import { ulid } from 'ulid';

import {
  agentRunRequestSchema,
  normalizedAdapterEventSchema,
  resumeRunRequestSchema,
  type AgentRunRequest,
  type AgentRuntimeAdapter,
  type NormalizedAdapterEvent,
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

export interface AdapterMapperContext {
  readonly provider: 'openai' | 'anthropic';
  readonly model: string;
  readonly profileVersion: number;
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

export abstract class BaseProviderAdapter implements AgentRuntimeAdapter {
  private readonly ownership: ChildProcessOwnershipRegistry;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly now: () => number;
  private readonly runningHandles = new Map<string, string>();

  protected constructor(protected readonly options: ProviderAdapterOptions) {
    this.ownership = options.ownership ?? new ChildProcessOwnershipRegistry();
    this.environment = options.environment ?? process.env;
    this.now = options.now ?? Date.now;
  }

  protected abstract readonly provider: 'openai' | 'anthropic';

  protected abstract buildCommand(
    request: AgentRunRequest | ResumeRunRequest,
    schema: { readonly path: string; readonly serialized: string },
    resume: boolean,
  ): BuiltProviderCommand;

  protected abstract createMapper(context: AdapterMapperContext): ProviderFrameMapper;

  public async inspect(): Promise<ProviderHealth> {
    return {
      provider: this.provider,
      installed: true,
      cliVersion: 'configured',
      authenticated: false,
      status: 'untested',
      supportedModels: [],
      lastCheckedAt: new Date(this.now()).toISOString(),
      sanitizedError: null,
    };
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
