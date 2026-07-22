import { describe, expect, it } from 'vitest';

import {
  CLAUDE_DISALLOWED_TOOLS,
  CLAUDE_READ_ONLY_TOOLS,
  CLAUDE_SMOKE_MODEL,
  CODEX_SMOKE_MODEL,
  PROVIDER_SMOKE_MAX_INVOCATIONS,
  PROVIDER_SMOKE_TIMEOUT_MS,
  claudeSmokeArgv,
  codexResumeArgv,
  codexSmokeArgv,
  invokeSmokeProvider,
  providerSmokeModels,
  providerSmokeResultSchema,
  requiresRealProviderTestOptIn,
  sameSnapshot,
  type SmokeProcessPort,
} from '../provider-smoke.js';

const paths = {
  repository: 'C:\\synthetic-public-repository',
  schema: 'C:\\runtime\\result-schema.json',
};

describe('deferred provider smoke contract', () => {
  it('uses only the approved fixed argv, read-only limits, and explicit opt-in', () => {
    expect(requiresRealProviderTestOptIn({})).toBe(false);
    expect(requiresRealProviderTestOptIn({ ORION_REAL_PROVIDER_TESTS: '1' })).toBe(true);
    expect(providerSmokeModels()).toEqual({
      codex: CODEX_SMOKE_MODEL,
      claude: CLAUDE_SMOKE_MODEL,
    });
    expect(PROVIDER_SMOKE_TIMEOUT_MS).toBe(300_000);
    expect(PROVIDER_SMOKE_MAX_INVOCATIONS).toBe(1);

    expect(codexSmokeArgv(paths, CODEX_SMOKE_MODEL)).toEqual([
      'exec',
      '--json',
      '--sandbox',
      'read-only',
      '--cd',
      paths.repository,
      '--output-schema',
      paths.schema,
      '--model',
      CODEX_SMOKE_MODEL,
      '-',
    ]);
    expect(codexResumeArgv(paths, CODEX_SMOKE_MODEL, 'session-1')).toEqual([
      'exec',
      '--json',
      '--model',
      CODEX_SMOKE_MODEL,
      '--sandbox',
      'read-only',
      '--cd',
      paths.repository,
      '--output-schema',
      paths.schema,
      'resume',
      'session-1',
      '-',
    ]);
    expect(claudeSmokeArgv(paths, CLAUDE_SMOKE_MODEL)).toEqual([
      '--print',
      '--output-format',
      'stream-json',
      '--verbose',
      '--json-schema',
      paths.schema,
      '--model',
      CLAUDE_SMOKE_MODEL,
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
    ]);
    expect(JSON.stringify(codexSmokeArgv(paths, CODEX_SMOKE_MODEL))).not.toMatch(
      /dangerously|skip-git-repo-check|fallback/i,
    );
    expect(JSON.stringify(claudeSmokeArgv(paths, CLAUDE_SMOKE_MODEL))).not.toMatch(
      /dangerously|bypassPermissions|fallback/i,
    );
    expect(providerSmokeResultSchema).toMatchObject({
      additionalProperties: false,
      required: expect.arrayContaining(['status', 'findings', 'handoff']),
    });
    const snapshot = {
      defaultBranch: 'main',
      currentBranch: 'main',
      headSha: 'a'.repeat(40),
      dirty: false,
      indexHash: 'index',
      trackedHash: 'tracked',
      untrackedHash: 'untracked',
      filesHash: 'files',
    };
    expect(sameSnapshot(snapshot, { ...snapshot })).toBe(true);
    expect(sameSnapshot(snapshot, { ...snapshot, filesHash: 'changed' })).toBe(false);
  });

  it('normalizes synthetic stream evidence through a fake port without an OS child process', async () => {
    const validResult = {
      status: 'succeeded',
      summary: 'Synthetic repository contains two files.',
      findings: [],
      artifacts: [],
      changes: [],
      tests: [],
      risks: [],
      handoff: 'No follow-up is required.',
    };
    const requests: unknown[] = [];
    const fakePort: SmokeProcessPort = {
      spawn: (request) => {
        requests.push(request);
        return {
          stdout: byteStream([
            `${JSON.stringify({ type: 'thread.started', thread_id: 'session-1', version: '0.138.0' })}\n`,
            `${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 2, duration_ms: 8 }, model: CODEX_SMOKE_MODEL })}\n`,
            `${JSON.stringify({ type: 'item.completed', result: validResult })}\n`,
          ]),
          stderr: byteStream(['Bearer sk-not-an-emitted-token\n']),
          exited: Promise.resolve({ exitCode: 0, signal: null }),
          writeStdin: () => undefined,
          terminateOwnedTree: () => undefined,
          countOwnedDescendants: () => 0,
        };
      },
    };
    const times = [new Date('2026-07-22T00:00:00.000Z'), new Date('2026-07-22T00:00:00.008Z')];
    const evidence = await invokeSmokeProvider(
      {
        provider: 'openai',
        executable: 'C:\\trusted\\codex.exe',
        argv: codexSmokeArgv(paths, CODEX_SMOKE_MODEL),
        cwd: paths.repository,
        environment: {},
        permissionMode: 'read-only',
      },
      fakePort,
      () => times.shift() as Date,
    );

    expect(requests).toEqual([
      expect.objectContaining({
        executable: 'C:\\trusted\\codex.exe',
        argv: codexSmokeArgv(paths, CODEX_SMOKE_MODEL),
        cwd: paths.repository,
        shell: false,
      }),
    ]);
    expect(evidence).toMatchObject({
      provider: 'openai',
      cliVersion: '0.138.0',
      executableFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      invocationCount: 1,
      modelReported: CODEX_SMOKE_MODEL,
      permissionMode: 'read-only',
      durationMs: 8,
      exitClassification: 'succeeded',
      normalizedEventCounts: {
        'run.started': 1,
        'run.usage': 1,
        'run.completed': 1,
      },
      strictResult: true,
      repositoryUnchanged: true,
      childProcessCount: 1,
      reportedUsage: { inputTokens: 3, outputTokens: 2, durationMs: 8 },
      reportedCost: null,
    });
    expect(evidence.sessionIdHash).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.sanitizerFindingCount).toBeGreaterThan(0);
  });
  it('classifies synthetic Claude output and spawn failures without an OS child process', async () => {
    const result = {
      status: 'succeeded',
      summary: 'Synthetic result.',
      findings: [],
      artifacts: [],
      changes: [],
      tests: [],
      risks: [],
      handoff: 'Complete.',
    };
    const fakePort: SmokeProcessPort = {
      spawn: () => ({
        stdout: byteStream([
          `${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-session' })}\n`,
          `${JSON.stringify({ type: 'assistant' })}\n`,
          `${JSON.stringify({ type: 'tool_use' })}\n`,
          `${JSON.stringify({ type: 'tool_result' })}\n`,
          `${JSON.stringify({ type: 'result', usage: { cache_tokens: 4 }, cost_usd: 0.5 })}\n`,
          `${JSON.stringify({ type: 'result', result })}\n`,
        ]),
        stderr: byteStream([]),
        exited: Promise.resolve({ exitCode: 4, signal: null }),
        writeStdin: () => undefined,
        terminateOwnedTree: () => undefined,
        countOwnedDescendants: () => 2,
      }),
    };
    const times = [new Date('2026-07-22T00:00:00.000Z'), new Date('2026-07-22T00:00:00.001Z')];
    const evidence = await invokeSmokeProvider(
      {
        provider: 'anthropic',
        executable: 'C:\\trusted\\claude.exe',
        argv: claudeSmokeArgv(paths, CLAUDE_SMOKE_MODEL),
        cwd: paths.repository,
        environment: {},
        permissionMode: 'dontAsk-read-only-tools',
      },
      fakePort,
      () => times.shift() as Date,
    );

    expect(evidence).toMatchObject({
      exitClassification: 'nonzero_exit',
      childProcessCount: 3,
      strictResult: true,
      reportedUsage: { cacheTokens: 4 },
      reportedCost: 0.5,
      normalizedEventCounts: {
        'run.started': 1,
        'run.output.delta': 1,
        'run.tool.started': 1,
        'run.tool.completed': 1,
        'run.usage': 1,
        'run.completed': 1,
      },
    });

    const spawnFailure = await invokeSmokeProvider(
      {
        provider: 'anthropic',
        executable: 'C:\\trusted\\claude.exe',
        argv: claudeSmokeArgv(paths, CLAUDE_SMOKE_MODEL),
        cwd: paths.repository,
        environment: {},
        permissionMode: 'dontAsk-read-only-tools',
      },
      { spawn: () => Promise.reject(new Error('synthetic failure')) },
      () => new Date('2026-07-22T00:00:00.000Z'),
    );
    expect(spawnFailure).toMatchObject({
      exitClassification: 'spawn_failed',
      childProcessCount: 0,
      strictResult: false,
      reportedUsage: null,
    });
    const invalidResult = await invokeSmokeProvider(
      {
        provider: 'openai',
        executable: 'C:\\trusted\\codex.exe',
        argv: codexSmokeArgv(paths, CODEX_SMOKE_MODEL),
        cwd: paths.repository,
        environment: {},
        permissionMode: 'read-only',
      },
      {
        spawn: () => ({
          stdout: byteStream(['not-json']),
          stderr: byteStream([]),
          exited: Promise.resolve({ exitCode: 0, signal: null }),
          writeStdin: () => undefined,
          terminateOwnedTree: () => undefined,
          countOwnedDescendants: () => 0,
        }),
      },
      () => new Date('2026-07-22T00:00:00.000Z'),
    );
    expect(invalidResult.exitClassification).toBe('result_schema_invalid');

    const signalResult = await invokeSmokeProvider(
      {
        provider: 'openai',
        executable: 'C:\\trusted\\codex.exe',
        argv: codexSmokeArgv(paths, CODEX_SMOKE_MODEL),
        cwd: paths.repository,
        environment: {},
        permissionMode: 'read-only',
      },
      {
        spawn: () => ({
          stdout: byteStream([]),
          stderr: byteStream([]),
          exited: Promise.resolve({ exitCode: null, signal: 'SIGTERM' }),
          writeStdin: () => undefined,
          terminateOwnedTree: () => undefined,
          countOwnedDescendants: () => 0,
        }),
      },
      () => new Date('2026-07-22T00:00:00.000Z'),
    );
    expect(signalResult.exitClassification).toBe('signal');
  });
});

async function* byteStream(chunks: readonly string[]): AsyncIterable<Uint8Array> {
  for (const chunk of chunks) yield Buffer.from(chunk, 'utf8');
}
