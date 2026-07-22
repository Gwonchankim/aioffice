import {
  providerProcessErrorCodeSchema,
  type AgentRunRequest,
  type AgentRuntimeAdapter,
  type Event,
  type EventPayload,
  type Provider,
  type ProviderRunEventType,
  type ResumeRunRequest,
  type RunResult,
} from '@orion/contracts';

import { ApplicationError, getErrorCode } from './errors.js';
import {
  ProviderTransferPolicy,
  type ProviderPayloadKind,
  type ProviderSelectionKind,
} from './provider-transfer-policy.js';
import type { ExecutionRepository } from './repositories/execution-repository.js';
import type { TaskEventBroker } from './task-event-sse.js';

export interface ProviderRunInvocation {
  readonly project: {
    readonly classification: 'public' | 'internal' | 'confidential' | 'controlled';
    readonly providerPolicy: {
      readonly openai: boolean;
      readonly anthropic: boolean;
      readonly allowFable: boolean;
    };
  };
  readonly request: AgentRunRequest;
  readonly payloadClassification:
    'public' | 'internal' | 'confidential' | 'controlled' | 'restricted';
  readonly payloadKind: ProviderPayloadKind;
  readonly selection?: ProviderSelectionKind;
  readonly fableConfirmationValid?: boolean;
}

export interface ProviderResumeInvocation extends Omit<ProviderRunInvocation, 'request'> {
  readonly request: ResumeRunRequest;
}

interface ActiveRun {
  readonly adapter: AgentRuntimeAdapter;
  runtimeHandle?: string;
}

interface RuntimeHandleAdapter extends AgentRuntimeAdapter {
  runtimeHandleForRun?(runId: string): string | undefined;
}

export class ProviderRunService {
  private readonly adapters: ReadonlyMap<Provider, AgentRuntimeAdapter>;
  private readonly active = new Map<string, ActiveRun>();
  private readonly cancelled = new Set<string>();
  private readonly results = new Map<string, RunResult>();

  public constructor(
    private readonly execution: ExecutionRepository,
    adapters: ReadonlyMap<Provider, AgentRuntimeAdapter>,
    private readonly transferPolicy = new ProviderTransferPolicy(),
    private readonly broker?: TaskEventBroker,
  ) {
    this.adapters = adapters;
  }

  public async start(invocation: ProviderRunInvocation): Promise<RunResult | undefined> {
    return this.execute(invocation, false);
  }

  public async resume(invocation: ProviderResumeInvocation): Promise<RunResult | undefined> {
    return this.execute(invocation, true);
  }

  public result(runId: string): RunResult | undefined {
    return this.results.get(runId);
  }

  public async cancel(runId: string): Promise<void> {
    if (this.cancelled.has(runId)) return;
    const active = this.active.get(runId);
    if (active === undefined) return;
    this.cancelled.add(runId);
    const runtimeHandle =
      active.runtimeHandle ?? (active.adapter as RuntimeHandleAdapter).runtimeHandleForRun?.(runId);
    if (runtimeHandle !== undefined) await active.adapter.cancel(runtimeHandle);
    if (
      this.execution.runStatus(runId) === 'starting' ||
      this.execution.runStatus(runId) === 'running' ||
      this.execution.runStatus(runId) === 'stalled'
    ) {
      this.persist(
        runId,
        {
          type: 'run.cancelled',
          payload: { requestedBy: 'user', reason: 'The provider run was cancelled.' },
        },
        'cancelled',
      );
    }
  }

  private async execute(
    invocation: ProviderRunInvocation | ProviderResumeInvocation,
    resume: boolean,
  ): Promise<RunResult | undefined> {
    const { request } = invocation;
    try {
      this.transferPolicy.assertAllowed({
        project: invocation.project,
        provider: request.provider,
        model: request.model,
        payloadClassification: invocation.payloadClassification,
        payloadKind: invocation.payloadKind,
        selection: invocation.selection ?? 'direct',
        ...(invocation.fableConfirmationValid === undefined
          ? {}
          : { fableConfirmationValid: invocation.fableConfirmationValid }),
      });
    } catch (error) {
      this.persistPolicyRejection(request.runId);
      throw error;
    }
    const adapter = this.adapters.get(request.provider);
    if (adapter === undefined) {
      const error = new ApplicationError(
        'PROVIDER_UNAVAILABLE',
        'The selected provider is unavailable.',
        {
          retryable: true,
        },
      );
      this.persistFailure(request.runId, error);
      throw error;
    }

    this.active.set(request.runId, { adapter });
    let finalResult: RunResult | undefined;
    let terminal = false;
    try {
      const stream = resume
        ? adapter.resume(request as ResumeRunRequest)
        : adapter.start(request as AgentRunRequest);
      for await (const normalized of stream) {
        if (this.cancelled.has(request.runId)) continue;
        if (normalized.kind === 'session') {
          this.execution.persistRunSession(request.runId, normalized.sessionId);
          continue;
        }
        if (normalized.kind === 'result') {
          finalResult = normalized.result;
          continue;
        }
        if (normalized.kind === 'diagnostic') continue;
        if (this.cancelled.has(request.runId)) continue;
        const status = statusFor(normalized.event.type, normalized.event.payload);
        const payload = durablePayload(normalized.event.type, normalized.event.payload);
        const eventPayload =
          normalized.event.type === 'run.completed' && finalResult !== undefined
            ? { ...payload, result: boundPayload(finalResult) }
            : payload;
        this.persist(
          request.runId,
          {
            type: normalized.event.type,
            payload: eventPayload,
            provider: request.provider,
          },
          status,
        );
        terminal ||= status !== undefined && status !== 'running';
      }
      if (!terminal && !this.cancelled.has(request.runId)) {
        const error = new ApplicationError(
          'PROVIDER_EXECUTION_FAILED',
          'The provider did not emit a terminal result.',
        );
        this.persistFailure(request.runId, error);
        throw error;
      }
      if (finalResult !== undefined) this.results.set(request.runId, finalResult);
      return finalResult;
    } catch (error) {
      if (!terminal && !this.cancelled.has(request.runId))
        this.persistFailure(request.runId, error);
      throw error;
    } finally {
      this.active.delete(request.runId);
    }
  }

  private persist(
    runId: string,
    event: {
      readonly type: Event['type'];
      readonly payload: EventPayload;
      readonly provider?: Provider;
    },
    status?: 'running' | 'succeeded' | 'failed' | 'timed_out' | 'cancelled',
  ): void {
    const persisted = this.execution.persistProviderRunEvent(runId, {
      event: {
        type: event.type,
        payload: event.payload,
        ...(event.provider === undefined ? {} : { provider: event.provider }),
      },
      ...(status === undefined ? {} : { status }),
    });
    this.broker?.publish(persisted);
  }

  private persistPolicyRejection(runId: string): void {
    try {
      this.persist(
        runId,
        {
          type: 'run.failed',
          payload: {
            errorCode: 'PROVIDER_EXECUTION_FAILED',
            retryable: false,
            sanitizedMessage: 'Provider execution is not allowed by policy.',
          },
        },
        'failed',
      );
    } catch {
      // A policy rejection must not disclose repository state when no run was created.
    }
  }

  private persistFailure(runId: string, error: unknown): void {
    try {
      if (
        this.execution.runStatus(runId) !== 'starting' &&
        this.execution.runStatus(runId) !== 'running'
      )
        return;
      const code = providerErrorCode(error);
      this.persist(
        runId,
        {
          type: 'run.failed',
          payload: {
            errorCode: code,
            retryable: error instanceof ApplicationError ? error.retryable : false,
            sanitizedMessage: 'The provider run could not be completed.',
          },
        },
        code === 'RUN_TIMED_OUT' ? 'timed_out' : 'failed',
      );
    } catch {
      // Preserve the original adapter failure when terminal persistence races a cancellation.
    }
  }
}

function statusFor(
  type: ProviderRunEventType,
  payload: unknown,
): 'running' | 'succeeded' | 'failed' | 'timed_out' | 'cancelled' | undefined {
  if (type === 'run.started') return 'running';
  if (type === 'run.completed') return 'succeeded';
  if (type === 'run.cancelled') return 'cancelled';
  if (type === 'run.failed') {
    return typeof payload === 'object' &&
      payload !== null &&
      (payload as { errorCode?: string }).errorCode === 'RUN_TIMED_OUT'
      ? 'timed_out'
      : 'failed';
  }
  return undefined;
}

function durablePayload(type: Event['type'], payload: unknown): EventPayload {
  if (
    type === 'run.output.delta' &&
    typeof payload === 'object' &&
    payload !== null &&
    (payload as { channel?: unknown }).channel === 'raw'
  ) {
    return { channel: 'raw', text: '[REDACTED]' };
  }
  return boundPayload(payload) as EventPayload;
}

function boundPayload(value: unknown): EventPayload[string] {
  if (typeof value === 'string') return value.slice(0, 4096);
  if (Array.isArray(value)) return value.slice(0, 100).map(boundPayload) as EventPayload[string];
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
        key,
        boundPayload(nested),
      ]),
    ) as EventPayload[string];
  }
  return value as EventPayload[string];
}

function providerErrorCode(error: unknown) {
  const code = providerProcessErrorCodeSchema.safeParse(getErrorCode(error));
  return code.success ? code.data : 'PROVIDER_EXECUTION_FAILED';
}
