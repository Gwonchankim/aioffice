import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import type {
  AgentRunRequest,
  AgentRuntimeAdapter,
  NormalizedAdapterEvent,
  ProviderDiagnostics,
  RunResult,
} from '@orion/contracts';

import { createDatabase } from '../src/database.js';
import { applyMigrations } from '../src/migrations.js';
import { ProviderRunService } from '../src/provider-run-service.js';
import { ProjectRepository } from '../src/repositories/project-repository.js';
import { AgentProfileRepository } from '../src/repositories/agent-profile-repository.js';
import { ExecutionRepository } from '../src/repositories/execution-repository.js';
import { InMemoryTaskEventBroker } from '../src/task-event-sse.js';

const iso = '2026-07-22T00:00:00.000Z';
const cleanup: string[] = [];
const handles: Array<{ close(): void }> = [];
afterEach(() => {
  handles.splice(0).forEach((handle) => handle.close());
  cleanup.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});

const diagnostics: ProviderDiagnostics = {
  invalidFrameCount: 0,
  consecutiveInvalidFrameCount: 0,
  unknownEventCount: 0,
  stderrBytes: 0,
  stderrOmittedBytes: 0,
};
const result: RunResult = {
  status: 'succeeded',
  summary: 'Synthetic provider result.',
  findings: [],
  artifacts: [],
  changes: [],
  tests: [],
  risks: [],
  handoff: 'Synthetic handoff.',
};

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'orion-provider-run-'));
  cleanup.push(directory);
  const handle = createDatabase(join(directory, 'orion.db'));
  handles.push(handle);
  applyMigrations(handle.database);
  const projects = new ProjectRepository(handle.database, () => new Date(iso));
  const projectId = ulid();
  projects.insert({
    id: projectId,
    projectKey: `provider-${projectId.slice(-6).toLowerCase()}`,
    name: 'Provider',
    repositoryPath: directory,
    defaultBranch: 'main',
    classification: 'internal',
    providerPolicy: { openai: true, anthropic: true, allowFable: false },
    allowedAgentIds: ['atlas'],
    allowedCommands: {
      read: [['git', 'status']],
      verify: [['pnpm', 'test']],
      localWrite: [['git', 'add']],
    },
    createdAt: iso,
    updatedAt: iso,
    unregisteredAt: null,
  });
  const execution = new ExecutionRepository(handle.database, () => new Date(iso));
  const taskId = ulid();
  const stepId = ulid();
  const runId = ulid();
  const profile = new AgentProfileRepository(handle.database).find('atlas')!;
  execution.createTask({
    id: taskId,
    projectId,
    title: 'Provider task',
    objective: 'Exercise the provider service.',
    successCriteria: ['done'],
    inputArtifactIds: [],
    maxDurationMinutes: 1,
    maxAgentRuns: 1,
    requestedAgentIds: ['atlas'],
    status: 'draft',
    createdAt: iso,
    updatedAt: iso,
    completedAt: null,
  });
  execution.createPlan({
    taskId,
    version: 1,
    planJson: {
      taskId,
      summary: 'Synthetic',
      assumptions: [],
      risks: [],
      steps: [
        {
          id: stepId,
          title: 'Provider step',
          agentId: 'atlas',
          dependsOn: [],
          executionMode: 'read_only',
          objective: 'Run fake provider.',
          inputRefs: [],
          expectedArtifacts: [],
          acceptanceCriteria: ['done'],
          verificationCommands: [],
          maxAttempts: 1,
        },
      ],
      finalSynthesisStepId: stepId,
    },
    validationJson: { valid: true, issues: [] },
    createdAt: iso,
  });
  execution.createStep({
    id: stepId,
    taskId,
    planVersion: 1,
    title: 'Provider step',
    agentId: 'atlas',
    dependsOn: [],
    executionMode: 'read_only',
    objective: 'Run fake provider.',
    inputRefs: [],
    expectedArtifacts: [],
    acceptanceCriteria: ['done'],
    verificationCommands: [],
    maxAttempts: 1,
    status: 'waiting',
    createdAt: iso,
    updatedAt: iso,
    completedAt: null,
  });
  execution.createRun({
    id: runId,
    stepId,
    attempt: 1,
    provider: 'openai',
    model: profile.model,
    agentProfileSnapshot: profile,
    status: 'starting',
    sessionId: null,
    createdAt: iso,
    startedAt: null,
    completedAt: null,
  });
  const request: AgentRunRequest = {
    runId,
    taskId,
    stepId,
    agentProfileSnapshot: profile,
    provider: 'openai',
    model: profile.model,
    prompt: 'synthetic prompt',
    cwd: directory,
    executionMode: 'read_only',
    outputSchemaPath: join(directory, 'schema.json'),
    allowedTools: [],
    allowedCommands: {
      read: [['git', 'status']],
      verify: [['pnpm', 'test']],
      localWrite: [['git', 'add']],
    },
    timeoutAt: '2026-07-22T01:00:00.000Z',
    environmentVariableNames: [],
  };
  return { directory, handle, execution, projectId, taskId, runId, request };
}

function successAdapter(calls: { value: number }): AgentRuntimeAdapter {
  return {
    async inspect() {
      throw new Error('not used');
    },
    async *start(): AsyncIterable<NormalizedAdapterEvent> {
      calls.value += 1;
      yield { kind: 'session', sessionId: 'synthetic-session', diagnostics };
      yield {
        kind: 'event',
        event: {
          type: 'run.started',
          payload: { attempt: 1, provider: 'openai', model: 'synthetic', profileVersion: 1 },
          diagnostics,
        },
      };
      yield {
        kind: 'event',
        event: {
          type: 'run.output.delta',
          payload: { channel: 'raw', text: 'Bearer synthetic-secret' },
          diagnostics,
        },
      };
      yield { kind: 'result', result, diagnostics };
      yield {
        kind: 'event',
        event: {
          type: 'run.completed',
          payload: { status: 'succeeded', resultArtifactId: ulid(), durationMs: 1 },
          diagnostics,
        },
      };
    },
    async *resume() {},
    async cancel() {},
  };
}

describe('provider run service', () => {
  it('RUN-001 persists monotonic normalized events, session ID, result, and redacts raw stdout', async () => {
    const fixture = setup();
    const calls = { value: 0 };
    const broker = new InMemoryTaskEventBroker();
    const service = new ProviderRunService(
      fixture.execution,
      new Map([['openai', successAdapter(calls)]]),
      undefined,
      broker,
    );
    const published: number[] = [];
    const unsubscribe = broker.subscribe(fixture.taskId, (value) =>
      published.push(value.taskSequence),
    );
    await expect(
      service.start({
        project: {
          classification: 'internal',
          providerPolicy: { openai: true, anthropic: true, allowFable: false },
        },
        request: fixture.request,
        payloadClassification: 'internal',
        payloadKind: 'summary',
      }),
    ).resolves.toEqual(result);
    unsubscribe();
    const events = fixture.execution.taskEvents(fixture.taskId, 0, 100);
    expect(events.map((value) => value.taskSequence)).toEqual([1, 2, 3]);
    expect(events[1]!.payload).toEqual({ channel: 'raw', text: '[REDACTED]' });
    expect(events[2]!.payload).toMatchObject({ result: { summary: result.summary } });
    expect([calls.value, fixture.execution.runStatus(fixture.runId), published]).toEqual([
      1,
      'succeeded',
      [1, 2, 3],
    ]);
    expect(service.result(fixture.runId)).toEqual(result);
    expect(
      fixture.handle.database
        .prepare('SELECT session_id FROM runs WHERE id = ?')
        .get(fixture.runId),
    ).toMatchObject({ session_id: 'synthetic-session' });
  });

  it('RUN-002 applies the transfer seam before adapter start for controlled payloads', async () => {
    const fixture = setup();
    const calls = { value: 0 };
    const service = new ProviderRunService(
      fixture.execution,
      new Map([['openai', successAdapter(calls)]]),
    );
    await expect(
      service.start({
        project: {
          classification: 'internal',
          providerPolicy: { openai: true, anthropic: true, allowFable: false },
        },
        request: fixture.request,
        payloadClassification: 'controlled',
        payloadKind: 'excerpt',
      }),
    ).rejects.toMatchObject({ code: 'CONTROLLED_EXECUTION_BLOCKED' });
    expect(calls.value).toBe(0);
    expect(fixture.execution.runStatus(fixture.runId)).toBe('failed');
    expect(fixture.execution.taskEvents(fixture.taskId, 0, 10)[0]!.payload).not.toHaveProperty(
      'prompt',
    );
  });
  it('RUN-003 resumes through the adapter with the persisted session ID', async () => {
    const fixture = setup();
    const calls = { value: 0 };
    const adapter = successAdapter(calls);
    adapter.resume = adapter.start;
    const service = new ProviderRunService(fixture.execution, new Map([['openai', adapter]]));
    await expect(
      service.resume({
        project: {
          classification: 'internal',
          providerPolicy: { openai: true, anthropic: true, allowFable: false },
        },
        request: { ...fixture.request, sessionId: 'previous-session' },
        payloadClassification: 'internal',
        payloadKind: 'summary',
      }),
    ).resolves.toEqual(result);
    expect(calls.value).toBe(1);
  });

  it('RUN-004 treats an unavailable adapter as a persisted sanitized failure without a spawn', async () => {
    const fixture = setup();
    const service = new ProviderRunService(fixture.execution, new Map());
    await expect(
      service.start({
        project: {
          classification: 'internal',
          providerPolicy: { openai: true, anthropic: true, allowFable: false },
        },
        request: fixture.request,
        payloadClassification: 'internal',
        payloadKind: 'metadata',
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(fixture.execution.runStatus(fixture.runId)).toBe('failed');
    expect(fixture.execution.taskEvents(fixture.taskId, 0, 10)[0]!.payload).toEqual({
      errorCode: 'PROVIDER_UNAVAILABLE',
      retryable: true,
      sanitizedMessage: 'The provider run could not be completed.',
    });
  });

  it('RUN-005 cancels an owned active handle once and cancellation wins over a late success', async () => {
    const fixture = setup();
    let started!: () => void;
    const startedStream = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const releaseStream = new Promise<void>((resolve) => {
      release = resolve;
    });
    let cancels = 0;
    const adapter: AgentRuntimeAdapter & {
      runtimeHandleForRun(runId: string): string | undefined;
    } = {
      async inspect() {
        throw new Error('not used');
      },
      async *start() {
        yield {
          kind: 'event' as const,
          event: {
            type: 'run.started' as const,
            payload: {
              attempt: 1,
              provider: 'openai' as const,
              model: 'synthetic',
              profileVersion: 1,
            },
            diagnostics,
          },
        };
        started();
        await releaseStream;
        yield {
          kind: 'event' as const,
          event: {
            type: 'run.completed' as const,
            payload: { status: 'succeeded' as const, resultArtifactId: ulid(), durationMs: 1 },
            diagnostics,
          },
        };
      },
      async *resume() {},
      async cancel(runtimeHandle: string) {
        expect(runtimeHandle).toBe('runtime-handle');
        cancels += 1;
      },
      runtimeHandleForRun() {
        return 'runtime-handle';
      },
    };
    const service = new ProviderRunService(fixture.execution, new Map([['openai', adapter]]));
    const run = service.start({
      project: {
        classification: 'internal',
        providerPolicy: { openai: true, anthropic: true, allowFable: false },
      },
      request: fixture.request,
      payloadClassification: 'internal',
      payloadKind: 'summary',
    });
    await startedStream;
    await service.cancel(fixture.runId);
    await service.cancel(fixture.runId);
    release();
    await expect(run).resolves.toBeUndefined();
    expect([cancels, fixture.execution.runStatus(fixture.runId)]).toEqual([1, 'cancelled']);
    expect(fixture.execution.taskEvents(fixture.taskId, 0, 10).map((value) => value.type)).toEqual([
      'run.started',
      'run.cancelled',
    ]);
  });
});
