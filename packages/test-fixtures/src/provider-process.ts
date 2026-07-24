export type FakeProvider = 'codex' | 'claude';

export const providerProcessScenarioNames = [
  'normal-start',
  'normal-resume',
  'chunk-split',
  'utf8-korean-split',
  'crlf',
  'unknown-event',
  'malformed-event',
  'five-consecutive-invalid',
  'stderr-flood',
  'secret-like-stderr',
  'missing-final-result',
  'invalid-final-schema',
  'nonzero-exit',
  'process-crash',
  'timeout',
  'graceful-cancel',
  'forced-child-tree-cancel',
  'cancel-after-late-success',
  'duplicate-event',
  'session-id',
  'usage',
  'provider-retry-event',
  'unsupported-cli-capability',
  'unauthenticated-provider',
  'controlled-no-spawn',
] as const;

export type ProviderProcessScenarioName = (typeof providerProcessScenarioNames)[number];
export type FakeCloseOrder = 'exit-before-stream-end' | 'streams-before-exit' | 'simultaneous';
export type FixtureRunEventType =
  | 'run.started'
  | 'run.output.delta'
  | 'run.tool.started'
  | 'run.tool.completed'
  | 'run.usage'
  | 'run.retry'
  | 'run.completed'
  | 'run.failed'
  | 'run.cancelled';
export type FixtureTerminalStatus = 'succeeded' | 'failed' | 'timed_out' | 'cancelled';
export type FixtureErrorCode =
  | 'ADAPTER_PROTOCOL_ERROR'
  | 'OUTPUT_SCHEMA_INVALID'
  | 'PROVIDER_EXECUTION_FAILED'
  | 'PROCESS_CRASHED'
  | 'RUN_TIMED_OUT'
  | 'CONTROLLED_EXECUTION_BLOCKED';

export interface FakeProcessSpawnRequest {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly environmentVariableNames: readonly string[];
  readonly stdinByteCount: number;
  readonly shell: false;
}

export interface FakeProcessExit {
  readonly exitCode: number | null;
  readonly signal: 'SIGTERM' | 'SIGKILL' | 'SIGSEGV' | null;
  readonly closeOrder: FakeCloseOrder;
  readonly durationMs: number;
}

export interface FakeProcessHandle {
  readonly pid: number;
  readonly stdoutChunks: readonly Uint8Array[];
  readonly stderrChunks: readonly Uint8Array[];
  readonly exit: FakeProcessExit;
  readonly descendantPids: readonly number[];
  writeStdin(byteCount: number): void;
  requestGracefulTermination(): void;
  terminateOwnedTree(): void;
}

export interface FakeProcessPort {
  spawn(request: FakeProcessSpawnRequest): FakeProcessHandle;
}

export interface ExpectedNormalizedEvent {
  readonly type: FixtureRunEventType;
  readonly sequence: number;
}

export interface ExpectedRunResult {
  readonly status: 'succeeded' | 'failed' | 'needs_attention';
  readonly summary: string;
  readonly findings: readonly {
    readonly severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
    readonly text: string;
    readonly evidence?: string;
  }[];
  readonly artifacts: readonly {
    readonly kind: string;
    readonly path?: string;
    readonly title: string;
    readonly description?: string;
  }[];
  readonly changes: readonly {
    readonly commitSha?: string;
    readonly files: readonly string[];
    readonly description: string;
  }[];
  readonly tests: readonly {
    readonly command: string;
    readonly status: 'passed' | 'failed' | 'not_run';
    readonly summary: string;
  }[];
  readonly risks: readonly string[];
  readonly handoff: string;
}

export interface FakeProcessFixture {
  readonly provider: FakeProvider;
  readonly scenario: ProviderProcessScenarioName;
  readonly process: {
    readonly stdoutChunks: readonly Uint8Array[];
    readonly stderrChunks: readonly Uint8Array[];
    readonly exit: FakeProcessExit;
    readonly descendantCountBeforeClose: number;
    readonly descendantCountAfterClose: number;
    readonly spawnCapture: FakeProcessSpawnRequest | null;
  };
  readonly expected: {
    readonly normalizedEvents: readonly ExpectedNormalizedEvent[];
    readonly result: ExpectedRunResult | null;
    readonly diagnostics: {
      readonly invalidFrameCount: number;
      readonly consecutiveInvalidFrameCount: number;
      readonly unknownEventCount: number;
      readonly stderrBytes: number;
      readonly stderrOmittedBytes: number;
      readonly sanitizedDiagnostic?: string;
    };
    readonly terminal: {
      readonly status: FixtureTerminalStatus;
      readonly errorCode?: FixtureErrorCode;
      readonly retryable?: boolean;
    };
    readonly spawn: {
      readonly permitted: boolean;
      readonly resolverCalls: number;
      readonly schemaFileCalls: number;
      readonly processCalls: number;
    };
    readonly sessionId?: string;
    readonly sessionPersistedBeforeStarted?: true;
    readonly usage?: {
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly cacheTokens: number;
      readonly reportedCost: null;
    };
    readonly inspection?: {
      readonly installed: boolean;
      readonly cliVersion: string | null;
      readonly authenticated: boolean;
      readonly status: 'unsupported' | 'unauthenticated';
      readonly supportedModels: readonly string[];
      readonly sanitizedError: string;
    };
    readonly cancellation?: {
      readonly gracefulTerminationRequests: number;
      readonly forcedOwnedTreeTerminations: number;
      readonly idempotent: true;
    };
    readonly controlledPayloadKinds?: readonly ['metadata', 'summary', 'excerpt'];
  };
}

export interface CodexResumeRejectionFixture {
  readonly name:
    | 'missing-sandbox'
    | 'sandbox-after-resume'
    | 'missing-cwd'
    | 'forbidden-flag'
    | 'relaxed-resolver'
    | 'secret-shaped-environment-name'
    | 'unsafe-schema-path';
  readonly argv: readonly string[];
  readonly rejectedBy: 'argv-order' | 'forbidden-flag' | 'resolver' | 'environment' | 'schema';
  readonly spawnPermitted: false;
}

const encoder = new TextEncoder();
const syntheticCwd = 'C:\\Synthetic\\runtime\\readonly-worktree';
const syntheticSchemaPath = 'C:\\Synthetic\\runtime\\schemas\\run-result-schema.json';
const syntheticEnvironmentVariableNames = ['APPDATA', 'PATH', 'USERPROFILE'] as const;
const fakeSecretLikeStderr = 'Bearer FAKE-BEARER-NOT-A-CREDENTIAL sk-FAKE-SYNTHETIC-NOT-A-REAL-KEY';

const successResult = (provider: FakeProvider): ExpectedRunResult => ({
  status: 'succeeded',
  summary: `Synthetic ${provider} fixture completed without external execution.`,
  findings: [{ severity: 'info', text: 'Synthetic fixture result only.' }],
  artifacts: [
    {
      kind: 'report',
      path: 'artifacts/synthetic-report.json',
      title: 'Synthetic report',
      description: 'Fixture-only structured output.',
    },
  ],
  changes: [],
  tests: [{ command: 'pnpm test', status: 'passed', summary: 'Synthetic test result.' }],
  risks: [],
  handoff: 'Synthetic fixture handoff only.',
});

const encode = (value: string): Uint8Array => encoder.encode(value);
const line = (value: unknown, ending = '\n'): Uint8Array =>
  encode(`${JSON.stringify(value)}${ending}`);
const malformedLine = (): Uint8Array => encode('{synthetic malformed JSON\n');
const flattenByteLength = (chunks: readonly Uint8Array[]): number =>
  chunks.reduce((total, chunk) => total + chunk.byteLength, 0);

export const decodeFakeProcessChunks = (chunks: readonly Uint8Array[]): string => {
  const size = flattenByteLength(chunks);
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
};

const codexFrames = {
  started: { type: 'thread.started', thread_id: 'synthetic-codex-session' },
  output: {
    type: 'item.completed',
    item: { id: 'codex-output-1', type: 'agent_message', text: 'Synthetic Codex output.' },
  },
  toolStarted: {
    type: 'item.started',
    item: {
      id: 'codex-tool-1',
      type: 'command_execution',
      command: 'git status',
      status: 'in_progress',
    },
  },
  toolCompleted: {
    type: 'item.completed',
    item: { id: 'codex-tool-1', type: 'command_execution', status: 'completed' },
  },
  usage: {
    type: 'turn.completed',
    usage: { input_tokens: 11, cached_input_tokens: 5, output_tokens: 7 },
  },
  retry: { type: 'system.api_retry', attempt: 1, delay_ms: 30_000 },
  unknown: { type: 'future.synthetic_signal' },
};

const claudeFrames = {
  started: {
    type: 'system',
    subtype: 'init',
    session_id: 'synthetic-claude-session',
    uuid: 'claude-system-1',
    model: 'synthetic-claude-model',
  },
  output: {
    type: 'assistant',
    uuid: 'claude-output-1',
    message: { id: 'msg-output-1', content: [{ type: 'text', text: 'Synthetic Claude output.' }] },
  },
  toolStarted: {
    type: 'assistant',
    uuid: 'claude-tool-start-1',
    message: {
      id: 'msg-tool-1',
      content: [{ type: 'tool_use', id: 'claude-tool-1', name: 'Read', input: {} }],
    },
  },
  toolCompleted: {
    type: 'user',
    uuid: 'claude-tool-done-1',
    message: { content: [{ type: 'tool_result', tool_use_id: 'claude-tool-1', is_error: false }] },
  },
  usage: {
    type: 'result',
    uuid: 'claude-usage-1',
    usage: { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 5 },
  },
  retry: { type: 'system', subtype: 'api_retry', uuid: 'claude-retry-1', attempt: 1, retry_delay_ms: 30_000 },
  unknown: { type: 'future.synthetic_signal', uuid: 'claude-unknown-1' },
};

const finalFrame = (provider: FakeProvider) =>
  provider === 'codex'
    ? {
        type: 'item.completed',
        item: {
          id: 'codex-final-1',
          type: 'agent_message',
          text: JSON.stringify(successResult('codex')),
        },
      }
    : {
        type: 'result',
        subtype: 'success',
        uuid: 'claude-final-1',
        structured_output: successResult('claude'),
      };

const invalidFinalFrame = (provider: FakeProvider) =>
  provider === 'codex'
    ? {
        type: 'item.completed',
        item: {
          id: 'codex-invalid-final-1',
          type: 'agent_message',
          text: JSON.stringify({ status: 'not-a-run-result' }),
        },
      }
    : {
        type: 'result',
        uuid: 'claude-invalid-final-1',
        structured_output: { status: 'not-a-run-result' },
      };

const eventSequence = (
  ...types: readonly FixtureRunEventType[]
): readonly ExpectedNormalizedEvent[] =>
  types.map((type, index) => ({ type, sequence: index + 1 }));

const normalEvents = eventSequence(
  'run.started',
  'run.output.delta',
  'run.tool.started',
  'run.tool.completed',
  'run.usage',
  'run.completed',
);

const diagnostics = (
  overrides: Partial<FakeProcessFixture['expected']['diagnostics']> = {},
): FakeProcessFixture['expected']['diagnostics'] => ({
  invalidFrameCount: 0,
  consecutiveInvalidFrameCount: 0,
  unknownEventCount: 0,
  stderrBytes: 0,
  stderrOmittedBytes: 0,
  ...overrides,
});

const successTerminal = { status: 'succeeded' } as const;
const standardUsage = {
  inputTokens: 11,
  outputTokens: 7,
  cacheTokens: 5,
  reportedCost: null,
} as const;
const defaultExit = (): FakeProcessExit => ({
  exitCode: 0,
  signal: null,
  closeOrder: 'streams-before-exit',
  durationMs: 20,
});

const providerSpawnCapture = (provider: FakeProvider, resume = false): FakeProcessSpawnRequest => {
  const sessionId = `synthetic-${provider}-session`;
  const argv =
    provider === 'codex'
      ? [
          'exec',
          '--json',
          '--model',
          'synthetic-codex-model',
          '--sandbox',
          'read-only',
          '--cd',
          syntheticCwd,
          '--output-schema',
          syntheticSchemaPath,
          ...(resume ? ['resume', sessionId] : []),
          '-',
        ]
      : [
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
          ...(resume ? ['--resume', sessionId] : []),
        ];

  return {
    executable: `C:\\Synthetic\\trusted\\${provider}.exe`,
    argv,
    cwd: syntheticCwd,
    environmentVariableNames: syntheticEnvironmentVariableNames,
    stdinByteCount: 67,
    shell: false,
  };
};

const makeFixture = (
  provider: FakeProvider,
  scenario: ProviderProcessScenarioName,
  stdoutChunks: readonly Uint8Array[],
  options: Partial<FakeProcessFixture> &
    Pick<FakeProcessFixture, 'expected'> & {
      readonly stderrChunks?: readonly Uint8Array[];
      readonly exit?: FakeProcessExit;
      readonly descendants?: readonly [number, number];
    },
): FakeProcessFixture => ({
  provider,
  scenario,
  process: {
    stdoutChunks,
    stderrChunks: options.stderrChunks ?? [],
    exit: options.exit ?? defaultExit(),
    descendantCountBeforeClose: options.descendants?.[0] ?? 0,
    descendantCountAfterClose: options.descendants?.[1] ?? 0,
    spawnCapture: options.expected.spawn.permitted
      ? providerSpawnCapture(provider, scenario === 'normal-resume')
      : null,
  },
  expected: options.expected,
});

const makeProviderFixtures = (provider: FakeProvider): readonly FakeProcessFixture[] => {
  const frames = provider === 'codex' ? codexFrames : claudeFrames;
  const sessionId = `synthetic-${provider}-session`;
  const normalStdout = [
    line(frames.started),
    line(frames.output),
    line(frames.toolStarted),
    line(frames.toolCompleted),
    line(frames.usage),
    line(finalFrame(provider)),
  ];
  const outputFrame = line(frames.output);
  const koreanFrame = line(
    provider === 'codex'
      ? {
          type: 'item.completed',
          item: { id: `${provider}-korean-1`, type: 'agent_message', text: '합성 한국어 출력' },
        }
      : {
          type: 'assistant',
          uuid: `${provider}-korean-1`,
          message: { id: `${provider}-korean-msg`, content: [{ type: 'text', text: '합성 한국어 출력' }] },
        },
  );
  const koreanMarker = encode('합');
  const koreanOffset = koreanFrame.findIndex(
    (value, index) =>
      value === koreanMarker[0] &&
      koreanFrame[index + 1] === koreanMarker[1] &&
      koreanFrame[index + 2] === koreanMarker[2],
  );
  const stderrFlood = new Uint8Array(300_000).fill(120);

  return [
    makeFixture(provider, 'normal-start', normalStdout, {
      expected: {
        normalizedEvents: normalEvents,
        result: successResult(provider),
        diagnostics: diagnostics(),
        terminal: successTerminal,
        spawn: { permitted: true, resolverCalls: 1, schemaFileCalls: 1, processCalls: 1 },
        sessionId,
        sessionPersistedBeforeStarted: true,
        usage: standardUsage,
      },
    }),
    makeFixture(
      provider,
      'normal-resume',
      [line(frames.started), line(frames.output), line(frames.usage), line(finalFrame(provider))],
      {
        expected: {
          normalizedEvents: eventSequence(
            'run.started',
            'run.output.delta',
            'run.usage',
            'run.completed',
          ),
          result: successResult(provider),
          diagnostics: diagnostics(),
          terminal: successTerminal,
          spawn: { permitted: true, resolverCalls: 1, schemaFileCalls: 1, processCalls: 1 },
          sessionId,
          sessionPersistedBeforeStarted: true,
          usage: standardUsage,
        },
      },
    ),
    makeFixture(
      provider,
      'chunk-split',
      [
        outputFrame.slice(0, 19),
        outputFrame.slice(19, 43),
        outputFrame.slice(43),
        line(finalFrame(provider)),
      ],
      {
        expected: {
          normalizedEvents: eventSequence('run.output.delta', 'run.completed'),
          result: successResult(provider),
          diagnostics: diagnostics(),
          terminal: successTerminal,
          spawn: { permitted: true, resolverCalls: 1, schemaFileCalls: 1, processCalls: 1 },
        },
      },
    ),
    makeFixture(
      provider,
      'utf8-korean-split',
      [
        koreanFrame.slice(0, koreanOffset + 1),
        koreanFrame.slice(koreanOffset + 1, koreanOffset + 2),
        koreanFrame.slice(koreanOffset + 2),
        line(finalFrame(provider)),
      ],
      {
        expected: {
          normalizedEvents: eventSequence('run.output.delta', 'run.completed'),
          result: successResult(provider),
          diagnostics: diagnostics(),
          terminal: successTerminal,
          spawn: { permitted: true, resolverCalls: 1, schemaFileCalls: 1, processCalls: 1 },
        },
      },
    ),
    makeFixture(
      provider,
      'crlf',
      [
        line(frames.started, '\r\n'),
        line(frames.output, '\r\n'),
        line(finalFrame(provider), '\r\n'),
      ],
      {
        expected: {
          normalizedEvents: eventSequence('run.started', 'run.output.delta', 'run.completed'),
          result: successResult(provider),
          diagnostics: diagnostics(),
          terminal: successTerminal,
          spawn: { permitted: true, resolverCalls: 1, schemaFileCalls: 1, processCalls: 1 },
          sessionId,
          sessionPersistedBeforeStarted: true,
        },
      },
    ),
    makeFixture(
      provider,
      'unknown-event',
      [line(frames.unknown), line(frames.output), line(finalFrame(provider))],
      {
        expected: {
          normalizedEvents: eventSequence('run.output.delta', 'run.completed'),
          result: successResult(provider),
          diagnostics: diagnostics({ unknownEventCount: 1 }),
          terminal: successTerminal,
          spawn: { permitted: true, resolverCalls: 1, schemaFileCalls: 1, processCalls: 1 },
        },
      },
    ),
    makeFixture(
      provider,
      'malformed-event',
      [malformedLine(), line(frames.output), line(finalFrame(provider))],
      {
        expected: {
          normalizedEvents: eventSequence('run.output.delta', 'run.completed'),
          result: successResult(provider),
          diagnostics: diagnostics({ invalidFrameCount: 1 }),
          terminal: successTerminal,
          spawn: { permitted: true, resolverCalls: 1, schemaFileCalls: 1, processCalls: 1 },
        },
      },
    ),
    makeFixture(
      provider,
      'five-consecutive-invalid',
      [malformedLine(), malformedLine(), malformedLine(), malformedLine(), malformedLine()],
      {
        expected: {
          normalizedEvents: [],
          result: null,
          diagnostics: diagnostics({ invalidFrameCount: 5, consecutiveInvalidFrameCount: 5 }),
          terminal: { status: 'failed', errorCode: 'ADAPTER_PROTOCOL_ERROR', retryable: false },
          spawn: { permitted: true, resolverCalls: 1, schemaFileCalls: 1, processCalls: 1 },
        },
      },
    ),
    makeFixture(provider, 'stderr-flood', [line(frames.output), line(finalFrame(provider))], {
      stderrChunks: [stderrFlood],
      expected: {
        normalizedEvents: eventSequence('run.output.delta', 'run.completed'),
        result: successResult(provider),
        diagnostics: diagnostics({ stderrBytes: 300_000, stderrOmittedBytes: 37_856 }),
        terminal: successTerminal,
        spawn: { permitted: true, resolverCalls: 1, schemaFileCalls: 1, processCalls: 1 },
      },
    }),
    makeFixture(provider, 'secret-like-stderr', [line(frames.output), line(finalFrame(provider))], {
      stderrChunks: [encode(fakeSecretLikeStderr)],
      expected: {
        normalizedEvents: eventSequence('run.output.delta', 'run.completed'),
        result: successResult(provider),
        diagnostics: diagnostics({
          stderrBytes: encode(fakeSecretLikeStderr).byteLength,
          sanitizedDiagnostic: '[REDACTED]',
        }),
        terminal: successTerminal,
        spawn: { permitted: true, resolverCalls: 1, schemaFileCalls: 1, processCalls: 1 },
      },
    }),
    makeFixture(provider, 'missing-final-result', [line(frames.started), line(frames.output)], {
      expected: {
        normalizedEvents: eventSequence('run.started', 'run.output.delta'),
        result: null,
        diagnostics: diagnostics(),
        terminal: { status: 'failed', errorCode: 'ADAPTER_PROTOCOL_ERROR', retryable: false },
        spawn: { permitted: true, resolverCalls: 1, schemaFileCalls: 1, processCalls: 1 },
        sessionId,
        sessionPersistedBeforeStarted: true,
      },
    }),
    makeFixture(provider, 'invalid-final-schema', [line(invalidFinalFrame(provider))], {
      expected: {
        normalizedEvents: [],
        result: null,
        diagnostics: diagnostics({ invalidFrameCount: 1, consecutiveInvalidFrameCount: 1 }),
        terminal: { status: 'failed', errorCode: 'OUTPUT_SCHEMA_INVALID', retryable: false },
        spawn: { permitted: true, resolverCalls: 1, schemaFileCalls: 1, processCalls: 1 },
      },
    }),
    makeFixture(provider, 'nonzero-exit', [line(frames.output)], {
      stderrChunks: [encode('Synthetic provider process reported a nonzero exit.')],
      exit: { exitCode: 23, signal: null, closeOrder: 'exit-before-stream-end', durationMs: 15 },
      expected: {
        normalizedEvents: eventSequence('run.output.delta'),
        result: null,
        diagnostics: diagnostics({
          stderrBytes: 51,
          sanitizedDiagnostic: 'Provider execution failed.',
        }),
        terminal: { status: 'failed', errorCode: 'PROVIDER_EXECUTION_FAILED', retryable: false },
        spawn: { permitted: true, resolverCalls: 1, schemaFileCalls: 1, processCalls: 1 },
      },
    }),
    makeFixture(provider, 'process-crash', [], {
      exit: { exitCode: null, signal: 'SIGSEGV', closeOrder: 'simultaneous', durationMs: 3 },
      expected: {
        normalizedEvents: [],
        result: null,
        diagnostics: diagnostics({ sanitizedDiagnostic: 'Synthetic process crash.' }),
        terminal: { status: 'failed', errorCode: 'PROCESS_CRASHED', retryable: true },
        spawn: { permitted: true, resolverCalls: 1, schemaFileCalls: 1, processCalls: 1 },
      },
    }),
    makeFixture(provider, 'timeout', [], {
      exit: {
        exitCode: null,
        signal: 'SIGTERM',
        closeOrder: 'streams-before-exit',
        durationMs: 60_000,
      },
      descendants: [2, 0],
      expected: {
        normalizedEvents: [],
        result: null,
        diagnostics: diagnostics({ sanitizedDiagnostic: 'Run timed out.' }),
        terminal: { status: 'timed_out', errorCode: 'RUN_TIMED_OUT', retryable: false },
        spawn: { permitted: true, resolverCalls: 1, schemaFileCalls: 1, processCalls: 1 },
        cancellation: {
          gracefulTerminationRequests: 1,
          forcedOwnedTreeTerminations: 1,
          idempotent: true,
        },
      },
    }),
    makeFixture(provider, 'graceful-cancel', [line(frames.output)], {
      exit: {
        exitCode: null,
        signal: 'SIGTERM',
        closeOrder: 'streams-before-exit',
        durationMs: 25,
      },
      descendants: [0, 0],
      expected: {
        normalizedEvents: eventSequence('run.output.delta', 'run.cancelled'),
        result: null,
        diagnostics: diagnostics(),
        terminal: { status: 'cancelled', retryable: false },
        spawn: { permitted: true, resolverCalls: 1, schemaFileCalls: 1, processCalls: 1 },
        cancellation: {
          gracefulTerminationRequests: 1,
          forcedOwnedTreeTerminations: 0,
          idempotent: true,
        },
      },
    }),
    makeFixture(provider, 'forced-child-tree-cancel', [], {
      exit: {
        exitCode: null,
        signal: 'SIGKILL',
        closeOrder: 'streams-before-exit',
        durationMs: 5_000,
      },
      descendants: [3, 0],
      expected: {
        normalizedEvents: eventSequence('run.cancelled'),
        result: null,
        diagnostics: diagnostics(),
        terminal: { status: 'cancelled', retryable: false },
        spawn: { permitted: true, resolverCalls: 1, schemaFileCalls: 1, processCalls: 1 },
        cancellation: {
          gracefulTerminationRequests: 1,
          forcedOwnedTreeTerminations: 1,
          idempotent: true,
        },
      },
    }),
    makeFixture(
      provider,
      'cancel-after-late-success',
      [line(frames.output), line(finalFrame(provider))],
      {
        exit: {
          exitCode: null,
          signal: 'SIGTERM',
          closeOrder: 'exit-before-stream-end',
          durationMs: 30,
        },
        expected: {
          normalizedEvents: eventSequence('run.output.delta', 'run.cancelled'),
          result: successResult(provider),
          diagnostics: diagnostics(),
          terminal: { status: 'cancelled', retryable: false },
          spawn: { permitted: true, resolverCalls: 1, schemaFileCalls: 1, processCalls: 1 },
          cancellation: {
            gracefulTerminationRequests: 1,
            forcedOwnedTreeTerminations: 0,
            idempotent: true,
          },
        },
      },
    ),
    makeFixture(
      provider,
      'duplicate-event',
      [line(frames.started), line(frames.output), line(frames.output), line(finalFrame(provider))],
      {
        expected: {
          normalizedEvents: eventSequence('run.started', 'run.output.delta', 'run.completed'),
          result: successResult(provider),
          diagnostics: diagnostics(),
          terminal: successTerminal,
          spawn: { permitted: true, resolverCalls: 1, schemaFileCalls: 1, processCalls: 1 },
          sessionId,
          sessionPersistedBeforeStarted: true,
        },
      },
    ),
    makeFixture(provider, 'session-id', [line(frames.started), line(finalFrame(provider))], {
      expected: {
        normalizedEvents: eventSequence('run.started', 'run.completed'),
        result: successResult(provider),
        diagnostics: diagnostics(),
        terminal: successTerminal,
        spawn: { permitted: true, resolverCalls: 1, schemaFileCalls: 1, processCalls: 1 },
        sessionId,
        sessionPersistedBeforeStarted: true,
      },
    }),
    makeFixture(provider, 'usage', [line(frames.usage), line(finalFrame(provider))], {
      expected: {
        normalizedEvents: eventSequence('run.usage', 'run.completed'),
        result: successResult(provider),
        diagnostics: diagnostics(),
        terminal: successTerminal,
        spawn: { permitted: true, resolverCalls: 1, schemaFileCalls: 1, processCalls: 1 },
        usage: standardUsage,
      },
    }),
    makeFixture(
      provider,
      'provider-retry-event',
      [line(frames.retry), line(finalFrame(provider))],
      {
        expected: {
          normalizedEvents: eventSequence('run.retry', 'run.completed'),
          result: successResult(provider),
          diagnostics: diagnostics(),
          terminal: successTerminal,
          spawn: { permitted: true, resolverCalls: 1, schemaFileCalls: 1, processCalls: 1 },
        },
      },
    ),
    makeFixture(provider, 'unsupported-cli-capability', [], {
      expected: {
        normalizedEvents: [],
        result: null,
        diagnostics: diagnostics({ sanitizedDiagnostic: 'Required capability is unavailable.' }),
        terminal: { status: 'failed', errorCode: 'ADAPTER_PROTOCOL_ERROR', retryable: false },
        spawn: { permitted: false, resolverCalls: 0, schemaFileCalls: 0, processCalls: 0 },
        inspection: {
          installed: true,
          cliVersion: '0.0.0-synthetic',
          authenticated: true,
          status: 'unsupported',
          supportedModels: [],
          sanitizedError: 'Required capability is unavailable.',
        },
      },
    }),
    makeFixture(provider, 'unauthenticated-provider', [], {
      expected: {
        normalizedEvents: [],
        result: null,
        diagnostics: diagnostics({ sanitizedDiagnostic: 'Provider authentication is required.' }),
        terminal: { status: 'failed', errorCode: 'PROVIDER_EXECUTION_FAILED', retryable: false },
        spawn: { permitted: false, resolverCalls: 0, schemaFileCalls: 0, processCalls: 0 },
        inspection: {
          installed: true,
          cliVersion: '0.0.0-synthetic',
          authenticated: false,
          status: 'unauthenticated',
          supportedModels: [],
          sanitizedError: 'Provider authentication is required.',
        },
      },
    }),
    makeFixture(provider, 'controlled-no-spawn', [], {
      expected: {
        normalizedEvents: [],
        result: null,
        diagnostics: diagnostics({
          sanitizedDiagnostic: 'Provider execution is blocked by policy.',
        }),
        terminal: { status: 'failed', errorCode: 'CONTROLLED_EXECUTION_BLOCKED', retryable: false },
        spawn: { permitted: false, resolverCalls: 0, schemaFileCalls: 0, processCalls: 0 },
        controlledPayloadKinds: ['metadata', 'summary', 'excerpt'],
      },
    }),
  ];
};

export const providerProcessFixtures = {
  codex: makeProviderFixtures('codex'),
  claude: makeProviderFixtures('claude'),
} as const;

export const allProviderProcessFixtures = [
  ...providerProcessFixtures.codex,
  ...providerProcessFixtures.claude,
] as const;

export const codexResumeRejectionFixtures: readonly CodexResumeRejectionFixture[] = [
  {
    name: 'missing-sandbox',
    argv: [
      'exec',
      '--json',
      '--model',
      'synthetic-codex-model',
      '--cd',
      syntheticCwd,
      'resume',
      'synthetic-codex-session',
      '-',
    ],
    rejectedBy: 'argv-order',
    spawnPermitted: false,
  },
  {
    name: 'sandbox-after-resume',
    argv: ['exec', '--json', 'resume', 'synthetic-codex-session', '--sandbox', 'read-only', '-'],
    rejectedBy: 'argv-order',
    spawnPermitted: false,
  },
  {
    name: 'missing-cwd',
    argv: ['exec', '--json', '--sandbox', 'read-only', 'resume', 'synthetic-codex-session', '-'],
    rejectedBy: 'argv-order',
    spawnPermitted: false,
  },
  {
    name: 'forbidden-flag',
    argv: [
      'exec',
      '--json',
      '--dangerously-bypass-approvals-and-sandbox',
      'resume',
      'synthetic-codex-session',
      '-',
    ],
    rejectedBy: 'forbidden-flag',
    spawnPermitted: false,
  },
  {
    name: 'relaxed-resolver',
    argv: ['codex', 'exec', '--json', 'resume', 'synthetic-codex-session', '-'],
    rejectedBy: 'resolver',
    spawnPermitted: false,
  },
  {
    name: 'secret-shaped-environment-name',
    argv: [
      'exec',
      '--json',
      '--sandbox',
      'read-only',
      '--cd',
      syntheticCwd,
      'resume',
      'synthetic-codex-session',
      '-',
    ],
    rejectedBy: 'environment',
    spawnPermitted: false,
  },
  {
    name: 'unsafe-schema-path',
    argv: [
      'exec',
      '--json',
      '--sandbox',
      'read-only',
      '--output-schema',
      'C:\\Synthetic\\project\\schema.json',
      'resume',
      'synthetic-codex-session',
      '-',
    ],
    rejectedBy: 'schema',
    spawnPermitted: false,
  },
] as const;
