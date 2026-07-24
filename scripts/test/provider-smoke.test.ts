import { describe, expect, it } from 'vitest';

import {
  CLAUDE_DISALLOWED_TOOLS,
  CLAUDE_READ_ONLY_TOOLS,
  DEFAULT_CLAUDE_SMOKE_MODEL,
  PROVIDER_SMOKE_MAX_BUDGET_USD,
  PROVIDER_SMOKE_TIMEOUT_MS,
  PROVIDER_SMOKE_CLEANUP_MAX_RETRIES,
  PROVIDER_SMOKE_CLEANUP_RETRY_DELAY_MS,
  claudeSmokeArgv,
  codexSmokeArgv,
  invokeSmokeProvider,
  issueGrant,
  pendingEvidence,
  resolveLedgerDirectory,
  withRepositoryStatus,
  isSmokePass,
  providerSmokeResultSchema,
  requiresRealProviderTestOptIn,
  runProviderSmoke,
  runProviderSmokeWithBestEffortCleanup,
  sameSnapshot,
  AUTHORIZATION_ID_ENV,
  CODEX_MODEL_ENV,
  LEDGER_DIR_ENV,
  type GrantIssuer,
  type ProviderSmokeDirectoryRemover,
  type ProviderSmokePaths,
  type SmokeLedger,
  type SmokeProcessPort,
  type SmokeProvider,
  type SmokeRepository,
} from '../provider-smoke.js';
import {
  SMOKE_GRANT_OPTIONS,
  type AuthorizationGrant,
  type Reservation,
  type SmokeProviderKey,
} from '../provider-authorization-ledger.js';

const paths: ProviderSmokePaths = {
  repository: 'C:\\synthetic-public-repository',
  schemaPath: 'C:\\runtime\\result-schema.json',
  schemaSerialized: '{"type":"object","additionalProperties":false}',
};

const codexModel = 'gpt-5.1-codex';
const claudeModel = 'sonnet';

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

const grant: AuthorizationGrant = {
  schemaVersion: 1,
  authorizationId: 'AUTH-1',
  createdAt: '2026-07-24T00:00:00.000Z',
  providers: {
    openai: { model: codexModel, maxInvocations: 1 },
    anthropic: { model: claudeModel, maxInvocations: 1 },
  },
  options: SMOKE_GRANT_OPTIONS,
};

class InMemoryLedger implements SmokeLedger {
  public claimed = false;
  public readonly used: Record<SmokeProviderKey, number> = { openai: 0, anthropic: 0 };
  public readonly outcomes: Array<{ provider: SmokeProviderKey; ordinal: number }> = [];
  public constructor(private readonly storedGrant: AuthorizationGrant | undefined) {}
  public readGrant(): AuthorizationGrant | undefined {
    return this.storedGrant;
  }
  public claimRun(): boolean {
    if (this.claimed) return false;
    this.claimed = true;
    return true;
  }
  public reserve(_authorizationId: string, provider: SmokeProviderKey): Reservation | null {
    if (this.used[provider] >= 1) return null;
    this.used[provider] += 1;
    return { provider, ordinal: this.used[provider] };
  }
  public usage(
    _authorizationId: string,
    provider: SmokeProviderKey,
  ): { granted: number; used: number } {
    return { granted: 1, used: this.used[provider] };
  }
  public recordOutcome(_authorizationId: string, reservation: Reservation): void {
    this.outcomes.push({ provider: reservation.provider, ordinal: reservation.ordinal });
  }
}

function codexSuccessFrames(): readonly string[] {
  return [
    `${JSON.stringify({ type: 'thread.started', thread_id: 'codex-session', version: '0.145.0' })}\n`,
    `${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 3, cached_input_tokens: 1, output_tokens: 2 } })}\n`,
    `${JSON.stringify({ type: 'item.completed', item: { id: 'final', type: 'agent_message', text: JSON.stringify(validResult) } })}\n`,
  ];
}

function claudeSuccessFrames(): readonly string[] {
  return [
    `${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-session', uuid: 'u0', model: 'sonnet' })}\n`,
    `${JSON.stringify({
      type: 'assistant',
      uuid: 'u1',
      message: {
        id: 'm1',
        content: [
          { type: 'text', text: 'hi' },
          { type: 'tool_use', id: 't1', name: 'Read', input: {} },
        ],
      },
    })}\n`,
    `${JSON.stringify({ type: 'user', uuid: 'u2', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false }] } })}\n`,
    `${JSON.stringify({ type: 'result', uuid: 'u3', usage: { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 1 }, total_cost_usd: 0.5, structured_output: validResult })}\n`,
  ];
}

async function* byteStream(chunks: readonly string[]): AsyncIterable<Uint8Array> {
  for (const chunk of chunks) yield Buffer.from(chunk, 'utf8');
}

function fakeProcess(stdout: readonly string[], stderr: readonly string[] = [], exitCode = 0) {
  return {
    stdout: byteStream(stdout),
    stderr: byteStream(stderr),
    exited: Promise.resolve({ exitCode, signal: null }),
    writeStdin: () => undefined,
    terminateOwnedTree: () => undefined,
    countOwnedDescendants: () => 0,
  };
}

const successPort: SmokeProcessPort = {
  spawn: (request) =>
    fakeProcess(request.argv[0] === 'exec' ? codexSuccessFrames() : claudeSuccessFrames()),
};

function fakeRepository(): SmokeRepository {
  return {
    paths,
    isUnchangedSince: () => true,
    environmentFor: () => ({}),
    executableFor: (provider: SmokeProvider) =>
      provider === 'openai' ? 'C:\\trusted\\codex.exe' : 'C:\\trusted\\claude.exe',
  };
}

describe('deferred provider smoke contract', () => {
  it('passes a schema FILE path to Codex and a serialized schema STRING to Claude', () => {
    expect(requiresRealProviderTestOptIn({})).toBe(false);
    expect(requiresRealProviderTestOptIn({ ORION_REAL_PROVIDER_TESTS: '1' })).toBe(true);
    expect(PROVIDER_SMOKE_TIMEOUT_MS).toBe(300_000);
    expect(DEFAULT_CLAUDE_SMOKE_MODEL).toBe('sonnet');

    const codexArgv = codexSmokeArgv(paths, codexModel);
    expect(codexArgv).toEqual([
      'exec',
      '--json',
      '--sandbox',
      'read-only',
      '--cd',
      paths.repository,
      '--output-schema',
      paths.schemaPath,
      '--model',
      codexModel,
      '-',
    ]);

    const claudeArgv = claudeSmokeArgv(paths, claudeModel);
    // The Claude schema argument is the serialized JSON string, NOT the schema file path.
    const schemaIndex = claudeArgv.indexOf('--json-schema');
    expect(claudeArgv[schemaIndex + 1]).toBe(paths.schemaSerialized);
    expect(claudeArgv).not.toContain(paths.schemaPath);
    expect(claudeArgv).toEqual([
      '--print',
      '--output-format',
      'stream-json',
      '--verbose',
      '--json-schema',
      paths.schemaSerialized,
      '--model',
      claudeModel,
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
    ]);

    expect(JSON.stringify(codexArgv)).not.toMatch(/dangerously|skip-git-repo-check|fallback/i);
    expect(JSON.stringify(claudeArgv)).not.toMatch(/dangerously|bypassPermissions|fallback/i);
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

  it('normalizes synthetic Codex stream evidence through the shared normalizer', async () => {
    const times = [new Date('2026-07-24T00:00:00.000Z'), new Date('2026-07-24T00:00:00.008Z')];
    const evidence = await invokeSmokeProvider(
      {
        provider: 'openai',
        executable: 'C:\\trusted\\codex.exe',
        argv: codexSmokeArgv(paths, codexModel),
        cwd: paths.repository,
        environment: {},
        permissionMode: 'read-only',
        invocationCount: 1,
      },
      { spawn: () => fakeProcess(codexSuccessFrames(), ['Bearer sk-not-emitted-token\n']) },
      () => times.shift() as Date,
    );

    expect(evidence).toMatchObject({
      provider: 'openai',
      reachedStage: 'invocation_completed',
      invocationCount: 1,
      cliVersion: '0.145.0',
      exitClassification: 'succeeded',
      strictResult: true,
      repositoryUnchanged: true,
      childProcessCount: 1,
      normalizedEventCounts: { 'run.started': 1, 'run.usage': 1, 'run.completed': 1 },
      reportedUsage: { inputTokens: 3, outputTokens: 2, cacheTokens: 1 },
    });
    expect(evidence.sessionIdHash).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.sanitizerFindingCount).toBeGreaterThan(0);
  });

  it('normalizes synthetic Claude stream evidence including structured_output and cost', async () => {
    const evidence = await invokeSmokeProvider(
      {
        provider: 'anthropic',
        executable: 'C:\\trusted\\claude.exe',
        argv: claudeSmokeArgv(paths, claudeModel),
        cwd: paths.repository,
        environment: {},
        permissionMode: 'dontAsk-read-only-tools',
        invocationCount: 1,
      },
      { spawn: () => fakeProcess(claudeSuccessFrames(), [], 0) },
      () => new Date('2026-07-24T00:00:00.000Z'),
    );

    expect(evidence).toMatchObject({
      provider: 'anthropic',
      reachedStage: 'invocation_completed',
      exitClassification: 'succeeded',
      strictResult: true,
      modelReported: 'sonnet',
      reportedCost: 0.5,
      reportedUsage: { inputTokens: 3, outputTokens: 2, cacheTokens: 1 },
      normalizedEventCounts: {
        'run.started': 1,
        'run.output.delta': 1,
        'run.tool.started': 1,
        'run.tool.completed': 1,
        'run.usage': 1,
        'run.completed': 1,
      },
    });
  });

  it('classifies a spawn failure as reserved-but-not-spawned without an OS child process', async () => {
    const evidence = await invokeSmokeProvider(
      {
        provider: 'anthropic',
        executable: 'C:\\trusted\\claude.exe',
        argv: claudeSmokeArgv(paths, claudeModel),
        cwd: paths.repository,
        environment: {},
        permissionMode: 'dontAsk-read-only-tools',
        invocationCount: 1,
      },
      { spawn: () => Promise.reject(new Error('synthetic failure')) },
      () => new Date('2026-07-24T00:00:00.000Z'),
    );
    expect(evidence).toMatchObject({
      reachedStage: 'invocation_reserved',
      exitClassification: 'spawn_failed',
      childProcessCount: 0,
      strictResult: false,
      reportedUsage: null,
    });
  });

  it('emits one envelope with reachedStage authorization_missing and zero count (never [])', async () => {
    const result = await runProviderSmoke({
      authorizationId: undefined,
      ledger: new InMemoryLedger(grant),
      processPort: successPort,
      prepareRepository: async () => fakeRepository(),
      models: { openai: codexModel, anthropic: claudeModel },
    });
    expect(result.schemaVersion).toBe(1);
    expect(result.providers).toHaveLength(2);
    expect(result.providers.map((p) => p.reachedStage)).toEqual([
      'authorization_missing',
      'authorization_missing',
    ]);
    expect(result.providers.every((p) => p.invocationCount === 0)).toBe(true);
    expect(isSmokePass(result)).toBe(false);
  });

  it('reports grant_missing and a fail-closed ledger_unsafe without spawning', async () => {
    const missing = await runProviderSmoke({
      authorizationId: 'AUTH-1',
      ledger: new InMemoryLedger(undefined),
      processPort: successPort,
      prepareRepository: async () => {
        throw new Error('must not prepare repository when the grant is missing');
      },
      models: { openai: codexModel, anthropic: claudeModel },
    });
    expect(missing.providers.map((p) => p.reachedStage)).toEqual([
      'grant_missing',
      'grant_missing',
    ]);

    const unsafe = await runProviderSmoke({
      authorizationId: 'AUTH-1',
      ledger: () => {
        throw Object.assign(new Error('unsafe'), { code: 'PROVIDER_LEDGER_PATH_UNSAFE' });
      },
      processPort: successPort,
      prepareRepository: async () => fakeRepository(),
      models: { openai: codexModel, anthropic: claudeModel },
    });
    expect(unsafe.providers.every((p) => p.reachedStage === 'ledger_unsafe')).toBe(true);
  });

  it('reserves both providers, spawns each once, and reports a real cumulative count', async () => {
    const ledger = new InMemoryLedger(grant);
    const spawns: string[] = [];
    const port: SmokeProcessPort = {
      spawn: (request) => {
        spawns.push(String(request.argv[0]));
        return fakeProcess(
          request.argv[0] === 'exec' ? codexSuccessFrames() : claudeSuccessFrames(),
        );
      },
    };
    const result = await runProviderSmoke({
      authorizationId: 'AUTH-1',
      ledger,
      processPort: port,
      prepareRepository: async () => fakeRepository(),
      models: { openai: codexModel, anthropic: claudeModel },
    });

    expect(spawns).toEqual(['exec', '--print']);
    expect(result.providers.map((p) => p.reachedStage)).toEqual([
      'invocation_completed',
      'invocation_completed',
    ]);
    expect(result.providers.map((p) => p.invocationCount)).toEqual([1, 1]);
    expect(result.providers.every((p) => p.strictResult)).toBe(true);
    expect(isSmokePass(result)).toBe(true);
    expect(ledger.outcomes).toHaveLength(2);
  });

  it('denies a rerun with zero spawn while reporting the real prior cumulative count', async () => {
    const ledger = new InMemoryLedger(grant);
    ledger.claimed = true; // a prior run already claimed the authorization.
    ledger.used.openai = 1;
    ledger.used.anthropic = 1;
    const port: SmokeProcessPort = {
      spawn: () => {
        throw new Error('a claim-denied rerun must never spawn a provider');
      },
    };
    const result = await runProviderSmoke({
      authorizationId: 'AUTH-1',
      ledger,
      processPort: port,
      prepareRepository: async () => {
        throw new Error('a claim-denied rerun must never prepare a repository');
      },
      models: { openai: codexModel, anthropic: claudeModel },
    });
    expect(result.providers.every((p) => p.reachedStage === 'run_claim_denied')).toBe(true);
    expect(result.providers.map((p) => p.invocationCount)).toEqual([1, 1]);
    expect(isSmokePass(result)).toBe(false);
  });

  it('preserves computed evidence when synthetic repository cleanup encounters EBUSY', async () => {
    const computed = { schemaVersion: 1 as const, providers: [] };
    const removedPaths: string[] = [];
    const failingRemover: ProviderSmokeDirectoryRemover = async (path) => {
      removedPaths.push(path.toString());
      if (path.toString() === paths.repository) {
        throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
      }
    };
    const evidence = await runProviderSmokeWithBestEffortCleanup(
      async () => computed,
      () => [paths.repository, 'C:\\runtime'],
      failingRemover,
    );
    expect(evidence).toBe(computed);
    expect(removedPaths).toEqual([paths.repository, 'C:\\runtime']);
    expect(PROVIDER_SMOKE_CLEANUP_MAX_RETRIES).toBe(3);
    expect(PROVIDER_SMOKE_CLEANUP_RETRY_DELAY_MS).toBe(100);
  });

  it('issues a grant (0 provider calls) binding operator-selected models to an authorization id', () => {
    const issued: Array<{ authorizationId: string; codexModel: string; claudeModel: string }> = [];
    const issuer: GrantIssuer = {
      grant: (request) => {
        issued.push(request);
        return { ...grant, providers: { ...grant.providers } };
      },
    };
    issueGrant(
      { [AUTHORIZATION_ID_ENV]: 'AUTH-9', [CODEX_MODEL_ENV]: 'gpt-5.1-codex' },
      () => issuer,
    );
    expect(issued).toEqual([
      {
        authorizationId: 'AUTH-9',
        codexModel: 'gpt-5.1-codex',
        claudeModel: DEFAULT_CLAUDE_SMOKE_MODEL,
      },
    ]);
    expect(() => issueGrant({ [CODEX_MODEL_ENV]: 'gpt-5.1-codex' }, () => issuer)).toThrow();
  });

  it('resolves the ledger directory from an override or the LOCALAPPDATA default', () => {
    expect(resolveLedgerDirectory({ [LEDGER_DIR_ENV]: 'D:\\ledger' })).toBe('D:\\ledger');
    expect(resolveLedgerDirectory({ LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' })).toBe(
      'C:\\Users\\x\\AppData\\Local\\Orion\\provider-smoke-ledger',
    );
  });

  it('flags a repository mutation as repository_changed and treats empty evidence as non-pass', () => {
    const succeeded = {
      ...pendingEvidence('openai', 'invocation_completed', 1),
      exitClassification: 'succeeded' as const,
    };
    expect(withRepositoryStatus(succeeded, true).exitClassification).toBe('succeeded');
    expect(withRepositoryStatus(succeeded, false).exitClassification).toBe('repository_changed');
    expect(isSmokePass({ schemaVersion: 1, providers: [] })).toBe(false);
  });
});
