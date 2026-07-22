import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { allProviderProcessFixtures, type FakeProcessFixture } from '@orion/test-fixtures';
import type { AgentRunRequest, NormalizedAdapterEvent, ResumeRunRequest } from '@orion/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { ChildProcessOwnershipRegistry } from '../../src/providers/child-process-ownership.js';
import { ClaudeAdapter } from '../../src/providers/claude-adapter.js';
import { CodexAdapter } from '../../src/providers/codex-adapter.js';
import type { ProviderAdapterOptions } from '../../src/providers/adapter.js';
import type {
  OutputSchemaFile,
  OutputSchemaStore,
  ProviderProcessExit,
  ProviderProcessHandle,
  ProviderProcessPort,
  ProviderProcessSpawnRequest,
} from '../../src/providers/provider-process.js';

const cleanupPaths: string[] = [];
const farFuture = '2030-07-22T09:00:00.000Z';
const ids = {
  task: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
  step: '01ARZ3NDEKTSV4RRFFQ69G5FAX',
  run: '01ARZ3NDEKTSV4RRFFQ69G5FAY',
};

afterEach(() => {
  for (const path of cleanupPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

class FixturePort implements ProviderProcessPort {
  public request: ProviderProcessSpawnRequest | undefined;
  public stdinBytes = 0;
  public gracefulRequests = 0;
  public forceRequests = 0;

  public constructor(
    private readonly fixture: FakeProcessFixture,
    private readonly gate?: Promise<void>,
  ) {}

  public spawn(request: ProviderProcessSpawnRequest): ProviderProcessHandle {
    this.request = request;
    let resolveExit: (exit: ProviderProcessExit) => void = () => undefined;
    const exited = new Promise<ProviderProcessExit>((resolve) => {
      resolveExit = resolve;
    });
    const chunks = async function* (values: readonly Uint8Array[], pause?: Promise<void>) {
      if (pause !== undefined) await pause;
      for (const value of values) yield value;
    };
    const stdout = chunks(this.fixture.process.stdoutChunks, this.gate);
    const stderr = chunks(this.fixture.process.stderrChunks, this.gate);
    const exit = this.fixture.process.exit;
    const complete = async function* (stream: AsyncIterable<Uint8Array>) {
      for await (const value of stream) yield value;
      resolveExit({ exitCode: exit.exitCode, signal: exit.signal });
    };
    return {
      pid: 41_001,
      stdout: complete(stdout),
      stderr,
      exited,
      writeStdin: (input) => {
        this.stdinBytes += input.byteLength;
      },
      requestGracefulTermination: () => {
        this.gracefulRequests += 1;
      },
      terminateOwnedTree: () => {
        this.forceRequests += 1;
      },
      countOwnedDescendants: () => this.fixture.process.descendantCountAfterClose,
    };
  }
}

const schemaStore: OutputSchemaStore = {
  create: (): OutputSchemaFile => ({
    path: 'C:\\Synthetic\\runtime\\schemas\\result-schema.json',
    serialized: '{"type":"object"}',
    remove: () => undefined,
  }),
};

function options(port: ProviderProcessPort, root: string): ProviderAdapterOptions {
  return {
    executable: 'C:\\Synthetic\\trusted\\provider.exe',
    processPort: port,
    schemaStore,
    projectRoot: root,
    resolveExecutable: (path) => path,
    environment: {
      PATH: 'C:\\Windows',
      APPDATA: 'C:\\AppData',
      USERPROFILE: 'C:\\Users\\Synthetic',
    },
  };
}

function request(
  provider: 'openai' | 'anthropic',
  root: string,
  timeoutAt = farFuture,
): AgentRunRequest {
  return {
    runId: ids.run,
    taskId: ids.task,
    stepId: ids.step,
    agentProfileSnapshot: {
      id: 'atlas',
      version: 1,
      name: 'Atlas',
      displayName: 'Atlas Advisor',
      description:
        'Synthetic provider adapter test profile without credentials or external access.',
      provider,
      model: provider === 'openai' ? 'synthetic-codex-model' : 'synthetic-claude-model',
      fallbackModels: [],
      reasoningEffort: 'high',
      permissionTemplate: 'advisor',
      permissions: {
        networkReadAllowed: false,
        projectReadAllowed: true,
        artifactWriteAllowed: true,
        worktreeWriteAllowed: false,
        localCommitAllowed: false,
        externalActionsAllowed: false,
      },
      capabilities: ['provider-adapter-test'],
      enabled: false,
      executionMode: 'skeleton',
    },
    provider,
    model: provider === 'openai' ? 'synthetic-codex-model' : 'synthetic-claude-model',
    prompt: 'Return a synthetic structured result without external execution.',
    cwd: root,
    executionMode: 'read_only',
    outputSchemaPath: 'C:\\Synthetic\\runtime\\schema-source.json',
    allowedTools: ['Read', 'Glob'],
    allowedCommands: { read: [['git', 'status']], verify: [['pnpm', 'test']], localWrite: [] },
    timeoutAt,
    environmentVariableNames: ['PATH', 'APPDATA'],
  };
}

async function collect(
  stream: AsyncIterable<NormalizedAdapterEvent>,
): Promise<NormalizedAdapterEvent[]> {
  const values: NormalizedAdapterEvent[] = [];
  for await (const value of stream) values.push(value);
  return values;
}

function eventTypes(events: readonly NormalizedAdapterEvent[]): string[] {
  return events.flatMap((value) => (value.kind === 'event' ? [value.event.type] : []));
}

function adapterFor(fixture: FakeProcessFixture, port: FixturePort, root: string) {
  return fixture.provider === 'codex'
    ? new CodexAdapter(options(port, root))
    : new ClaudeAdapter(options(port, root));
}

describe('fixture-driven Codex and Claude adapters', () => {
  it.each(allProviderProcessFixtures)(
    '$provider $scenario consumes its synthetic stdout without a real provider invocation',
    async (fixture) => {
      const root = mkdtempSync(join(tmpdir(), 'orion-provider-root-'));
      cleanupPaths.push(root);
      const port = new FixturePort(fixture);
      const adapter = adapterFor(fixture, port, root);
      const provider = fixture.provider === 'codex' ? 'openai' : 'anthropic';
      const timeoutAt = fixture.scenario === 'timeout' ? new Date(0).toISOString() : farFuture;
      const events = await collect(adapter.start(request(provider, root, timeoutAt)));

      expect(port.request?.shell).toBe(false);
      expect(port.stdinBytes).toBeGreaterThan(0);
      for (const expected of fixture.expected.normalizedEvents) {
        if (expected.type !== 'run.cancelled') expect(eventTypes(events)).toContain(expected.type);
      }
      expect(
        events.every(
          (event) =>
            event.kind !== 'event' ||
            event.event.type !== 'run.output.delta' ||
            !event.event.payload.text?.includes('Bearer'),
        ),
      ).toBe(true);
    },
  );

  it('uses the frozen Codex start and resume argv shape with sandbox and cwd before resume', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orion-provider-root-'));
    cleanupPaths.push(root);
    const fixture = allProviderProcessFixtures.find(
      (candidate) => candidate.provider === 'codex' && candidate.scenario === 'normal-start',
    );
    if (fixture === undefined) throw new Error('Missing Codex fixture.');
    const port = new FixturePort(fixture);
    const adapter = new CodexAdapter(options(port, root));
    await collect(adapter.start(request('openai', root)));
    const canonicalCwd = port.request?.cwd;
    expect(canonicalCwd).toBeDefined();
    expect(port.request?.argv).toStrictEqual([
      'exec',
      '--json',
      '--sandbox',
      'read-only',
      '--cd',
      canonicalCwd!,
      '--output-schema',
      'C:\\Synthetic\\runtime\\schemas\\result-schema.json',
      '--model',
      'synthetic-codex-model',
      '-',
    ]);

    const resumePort = new FixturePort(fixture);
    const resumeAdapter = new CodexAdapter(options(resumePort, root));
    const resume: ResumeRunRequest = {
      ...request('openai', root),
      sessionId: 'synthetic-codex-session',
    };
    await collect(resumeAdapter.resume(resume));
    const resumeCwd = resumePort.request?.cwd;
    expect(resumeCwd).toBeDefined();
    expect(resumePort.request?.argv).toStrictEqual([
      'exec',
      '--json',
      '--model',
      'synthetic-codex-model',
      '--sandbox',
      'read-only',
      '--cd',
      resumeCwd!,
      '--output-schema',
      'C:\\Synthetic\\runtime\\schemas\\result-schema.json',
      'resume',
      'synthetic-codex-session',
      '-',
    ]);
  });

  it('uses a read-only Claude argv and supports resume plus the optional capped budget', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orion-provider-root-'));
    cleanupPaths.push(root);
    const fixture = allProviderProcessFixtures.find(
      (candidate) => candidate.provider === 'claude' && candidate.scenario === 'normal-start',
    );
    if (fixture === undefined) throw new Error('Missing Claude fixture.');
    const port = new FixturePort(fixture);
    const adapter = new ClaudeAdapter(options(port, root), 0.5);
    await collect(
      adapter.resume({ ...request('anthropic', root), sessionId: 'synthetic-claude-session' }),
    );
    expect(port.request?.argv).toStrictEqual([
      '--print',
      '--output-format',
      'stream-json',
      '--verbose',
      '--json-schema',
      '{"type":"object"}',
      '--model',
      'synthetic-claude-model',
      '--effort',
      'low',
      '--permission-mode',
      'dontAsk',
      '--allowedTools',
      'Read,Glob,Grep',
      '--disallowedTools',
      'Bash,Edit,Write,WebFetch,WebSearch',
      '--resume',
      'synthetic-claude-session',
      '--max-budget-usd',
      '0.5',
    ]);
  });

  it('reports only sanitized untested health until a separate inspection policy runs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orion-provider-root-'));
    cleanupPaths.push(root);
    const fixture = allProviderProcessFixtures[0];
    if (fixture === undefined) throw new Error('Missing provider fixture.');
    const port = new FixturePort(fixture);
    const health = await new CodexAdapter(options(port, root)).inspect();
    expect(health).toStrictEqual({
      provider: 'openai',
      installed: true,
      cliVersion: 'configured',
      authenticated: false,
      status: 'untested',
      supportedModels: [],
      lastCheckedAt: expect.any(String),
      sanitizedError: null,
    });
    expect(port.request).toBeUndefined();
  });
  it('records cancellation before a late final result and never reports late success', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orion-provider-root-'));
    cleanupPaths.push(root);
    const fixture = allProviderProcessFixtures.find(
      (candidate) =>
        candidate.provider === 'codex' && candidate.scenario === 'cancel-after-late-success',
    );
    if (fixture === undefined) throw new Error('Missing cancellation fixture.');
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const port = new FixturePort(fixture, gate);
    const registry = new ChildProcessOwnershipRegistry(() => 1, 0);
    const adapter = new CodexAdapter({ ...options(port, root), ownership: registry });
    const iterator = adapter.start(request('openai', root))[Symbol.asyncIterator]();
    const pending = iterator.next();
    await Promise.resolve();
    const handle = adapter.runtimeHandleForRun(ids.run);
    expect(handle).toBeDefined();
    const cancellation = adapter.cancel(handle!);
    release!();
    const values: NormalizedAdapterEvent[] = [];
    const first = await pending;
    if (!first.done) values.push(first.value);
    for await (const value of { [Symbol.asyncIterator]: () => iterator }) values.push(value);
    await cancellation;
    expect(eventTypes(values)).toContain('run.cancelled');
    expect(eventTypes(values)).not.toContain('run.completed');
    expect(port.gracefulRequests).toBe(1);
  });
});
