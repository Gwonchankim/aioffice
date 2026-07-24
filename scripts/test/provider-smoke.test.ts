import { describe, expect, it } from 'vitest';

import {
  AUTHORIZATION_ID_ENV,
  CLAUDE_DISALLOWED_TOOLS,
  CLAUDE_MODEL_ENV,
  CLAUDE_READ_ONLY_TOOLS,
  CODEX_MODEL_ENV,
  DEFAULT_CLAUDE_SMOKE_MODEL,
  PROVIDER_SMOKE_MAX_BUDGET_USD,
  ResourceTracker,
  claudeSmokeArgv,
  codexSmokeArgv,
  computeLivePolicy,
  grantEnvelope,
  invokeSmokeProvider,
  isSmokePass,
  issueGrant,
  pendingEvidence,
  resolveLedgerDirectory,
  withRepositoryStatus,
  runDeferredProviderSmoke,
  runProviderSmoke,
  runSmokeCli,
  type DeferredSmokeDependencies,
  type GrantEnvelope,
  type GrantIssuer,
  type HardenedRuntime,
  type ProbeResult,
  type ProviderBindingProbe,
  type ProviderSmokeEnvelope,
  type ProviderSmokePaths,
  type RunProviderSmokeDeps,
  type SmokeLedger,
  type SmokeProcess,
  type SmokeProcessPort,
  type SmokeRepository,
} from '../provider-smoke.js';
import {
  ProviderLedgerError,
  SMOKE_GRANT_OPTIONS,
  type AuthorizationGrant,
  type GrantRequest,
  type ProviderBinding,
  type Reservation,
  type SmokeProviderKey,
} from '../provider-authorization-ledger.js';

const livePolicy = computeLivePolicy();
const FP: Record<SmokeProviderKey, string> = { openai: 'a'.repeat(64), anthropic: 'b'.repeat(64) };
const BASENAME: Record<SmokeProviderKey, string> = { openai: 'codex.exe', anthropic: 'claude.exe' };
const CLI: Record<SmokeProviderKey, string> = { openai: '0.145.0', anthropic: '2.1.156' };
const RESOLVED: Record<SmokeProviderKey, string> = {
  openai: 'C:\\trusted\\codex.exe',
  anthropic: 'C:\\trusted\\claude.exe',
};

function binding(provider: SmokeProviderKey, model: string): ProviderBinding {
  return {
    provider,
    model,
    executableBasename: BASENAME[provider],
    executableFingerprint: FP[provider],
    cliVersion: CLI[provider],
  };
}

const grant: AuthorizationGrant = {
  schemaVersion: 2,
  authorizationId: 'AUTH-1',
  createdAt: '2026-07-24T00:00:00.000Z',
  providers: {
    openai: {
      model: 'gpt-5.1-codex',
      maxInvocations: 1,
      binding: binding('openai', 'gpt-5.1-codex'),
    },
    anthropic: { model: 'sonnet', maxInvocations: 1, binding: binding('anthropic', 'sonnet') },
  },
  options: { ...SMOKE_GRANT_OPTIONS, ...livePolicy },
};

const paths: ProviderSmokePaths = {
  repository: 'C:\\synthetic-public-repository',
  schemaPath: 'C:\\runtime\\result-schema.json',
  schemaSerialized: '{"type":"object"}',
};

const validResult = {
  status: 'succeeded',
  summary: 'Synthetic result.',
  findings: [],
  artifacts: [],
  changes: [],
  tests: [],
  risks: [],
  handoff: 'Done.',
};

function codexFrames(): readonly string[] {
  return [
    `${JSON.stringify({ type: 'thread.started', thread_id: 'codex-session', version: '0.145.0' })}\n`,
    `${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 3, cached_input_tokens: 1, output_tokens: 2 } })}\n`,
    `${JSON.stringify({ type: 'item.completed', item: { id: 'final', type: 'agent_message', text: JSON.stringify(validResult) } })}\n`,
  ];
}

function claudeFrames(): readonly string[] {
  return [
    `${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-session', uuid: 'u0', model: 'sonnet' })}\n`,
    `${JSON.stringify({ type: 'result', uuid: 'u3', usage: { input_tokens: 3, output_tokens: 2 }, structured_output: validResult })}\n`,
  ];
}

async function* byteStream(chunks: readonly string[]): AsyncIterable<Uint8Array> {
  for (const chunk of chunks) yield Buffer.from(chunk, 'utf8');
}

function fakeProcess(stdout: readonly string[], exitCode = 0): SmokeProcess {
  return {
    stdout: byteStream(stdout),
    stderr: byteStream([]),
    exited: Promise.resolve({ exitCode, signal: null }),
    writeStdin: () => undefined,
    terminateOwnedTree: () => undefined,
    countOwnedDescendants: () => 0,
  };
}

const successPort: SmokeProcessPort = {
  spawn: (request) => fakeProcess(request.argv[0] === 'exec' ? codexFrames() : claudeFrames()),
};

class InMemoryLedger implements SmokeLedger {
  public claimed = false;
  public readonly reservedCount: Record<SmokeProviderKey, number> = { openai: 0, anthropic: 0 };
  public readonly spawnCount: Record<SmokeProviderKey, number> = { openai: 0, anthropic: 0 };
  public readonly spawnMarks: Array<{ provider: SmokeProviderKey; ordinal: number }> = [];
  public readonly outcomes: Array<{ provider: SmokeProviderKey; ordinal: number }> = [];
  public markThrows = false;
  public constructor(private readonly storedGrant: AuthorizationGrant | undefined) {}
  public readGrant(): AuthorizationGrant | undefined {
    return this.storedGrant;
  }
  public claimRun(): boolean {
    if (this.claimed) return false;
    this.claimed = true;
    return true;
  }
  public reserve(_id: string, provider: SmokeProviderKey): Reservation | null {
    if (this.reservedCount[provider] >= 1) return null;
    this.reservedCount[provider] += 1;
    return { provider, ordinal: 1 };
  }
  public markSpawnAttempt(_id: string, provider: SmokeProviderKey, ordinal: number): void {
    if (this.markThrows) throw new Error('mark failed');
    this.spawnCount[provider] += 1;
    this.spawnMarks.push({ provider, ordinal });
  }
  public usage(
    _id: string,
    provider: SmokeProviderKey,
  ): {
    granted: number;
    reserved: number;
    spawnAttempts: number;
  } {
    return {
      granted: 1,
      reserved: this.reservedCount[provider],
      spawnAttempts: this.spawnCount[provider],
    };
  }
  public recordOutcome(_id: string, reservation: Reservation): void {
    this.outcomes.push({ provider: reservation.provider, ordinal: reservation.ordinal });
  }
}

function fakeProbe(
  overrides: Partial<Record<SmokeProviderKey, Partial<ProbeResult> | 'throw'>> = {},
): ProviderBindingProbe {
  return {
    probe(provider) {
      const override = overrides[provider];
      if (override === 'throw') throw new Error('resolve failed');
      return {
        resolvedPath: RESOLVED[provider],
        executableBasename: BASENAME[provider],
        executableFingerprint: FP[provider],
        cliVersion: CLI[provider],
        ...override,
      };
    },
  };
}

function fakeRepository(isUnchanged: () => boolean = () => true): SmokeRepository {
  return {
    paths,
    isUnchangedSince: isUnchanged,
    environmentFor: () => ({}),
  };
}

function runDeps(overrides: Partial<RunProviderSmokeDeps> = {}): RunProviderSmokeDeps {
  return {
    authorizationId: 'AUTH-1',
    ledger: new InMemoryLedger(grant),
    processPort: successPort,
    prepareRepository: async () => fakeRepository(),
    probe: fakeProbe(),
    environment: {},
    cleanup: async () => 'complete',
    livePolicy,
    ...overrides,
  };
}

describe('SMG-008 argv isolation flags', () => {
  it('adds only installed-CLI-supported flags and never --max-turns', () => {
    const codex = codexSmokeArgv(paths, 'gpt-5.1-codex');
    expect(codex).toEqual([
      'exec',
      '--json',
      '--sandbox',
      'read-only',
      '--cd',
      paths.repository,
      '--output-schema',
      paths.schemaPath,
      '--model',
      'gpt-5.1-codex',
      '--ephemeral',
      '--ignore-user-config',
      '--ignore-rules',
      '-',
    ]);
    const claude = claudeSmokeArgv(paths, 'sonnet');
    expect(claude).toEqual([
      '--print',
      '--output-format',
      'stream-json',
      '--verbose',
      '--json-schema',
      paths.schemaSerialized,
      '--model',
      'sonnet',
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
      '{}',
      '--disable-slash-commands',
      '--max-budget-usd',
      String(PROVIDER_SMOKE_MAX_BUDGET_USD),
    ]);
    expect(claude).not.toContain('--max-turns');
    expect(JSON.stringify(codex)).not.toMatch(/dangerously|skip-git-repo-check|fallback/i);
    expect(JSON.stringify(claude)).not.toMatch(/dangerously|bypassPermissions|fallback/i);
  });
});

describe('SMG-001 grant-model binding', () => {
  it('argv uses the grant model regardless of run-time env (absent/equal)', async () => {
    for (const environment of [
      {},
      { [CODEX_MODEL_ENV]: 'gpt-5.1-codex', [CLAUDE_MODEL_ENV]: 'sonnet' },
    ]) {
      const argv: string[][] = [];
      const port: SmokeProcessPort = {
        spawn: (r) => {
          argv.push([...r.argv]);
          return fakeProcess(r.argv[0] === 'exec' ? codexFrames() : claudeFrames());
        },
      };
      const result = await runProviderSmoke(
        runDeps({ environment, processPort: port, ledger: new InMemoryLedger(grant) }),
      );
      expect(result.providers.map((p) => p.reachedStage)).toEqual([
        'invocation_completed',
        'invocation_completed',
      ]);
      expect(argv[0]).toContain('gpt-5.1-codex');
      expect(argv[1]).toContain('sonnet');
    }
  });

  it('rejects a differing run-time model env with MODEL_BINDING_CONFLICT and 0 spawn', async () => {
    let spawned = 0;
    const port: SmokeProcessPort = {
      spawn: () => {
        spawned += 1;
        return fakeProcess(codexFrames());
      },
    };
    const result = await runProviderSmoke(
      runDeps({ environment: { [CODEX_MODEL_ENV]: 'a-different-model' }, processPort: port }),
    );
    expect(spawned).toBe(0);
    expect(result.providers.every((p) => p.reachedStage === 'model_binding_conflict')).toBe(true);
    expect(result.providers.every((p) => p.errorCode === 'MODEL_BINDING_CONFLICT')).toBe(true);
    expect(isSmokePass(result)).toBe(false);
  });
});

describe('SMG-002 executable binding + policy binding', () => {
  it('mismatched executable fingerprint gives 0 spawn and executable_binding_mismatch', async () => {
    let spawned = 0;
    const port: SmokeProcessPort = {
      spawn: () => {
        spawned += 1;
        return fakeProcess(codexFrames());
      },
    };
    const result = await runProviderSmoke(
      runDeps({
        processPort: port,
        probe: fakeProbe({ openai: { executableFingerprint: 'f'.repeat(64) } }),
      }),
    );
    expect(spawned).toBe(1); // only Claude (Codex mismatch blocks Codex)
    const codex = result.providers.find((p) => p.provider === 'openai');
    expect(codex?.reachedStage).toBe('executable_binding_mismatch');
    expect(codex?.errorCode).toBe('EXECUTABLE_BINDING_MISMATCH');
    expect(codex?.spawnAttemptCount).toBe(0);
  });

  it('rechecks each executable just before its own spawn (swap between providers)', async () => {
    // Codex matches, Claude fingerprint is swapped between the two sequential rechecks.
    const result = await runProviderSmoke(
      runDeps({ probe: fakeProbe({ anthropic: { executableFingerprint: 'f'.repeat(64) } }) }),
    );
    const codex = result.providers.find((p) => p.provider === 'openai');
    const claude = result.providers.find((p) => p.provider === 'anthropic');
    expect(codex?.reachedStage).toBe('invocation_completed');
    expect(claude?.reachedStage).toBe('executable_binding_mismatch');
    expect(claude?.spawnAttemptCount).toBe(0);
  });

  it('a policy projection mismatch (schema/prompt/version drift) gives 0 spawn', async () => {
    let spawned = 0;
    const port: SmokeProcessPort = {
      spawn: () => {
        spawned += 1;
        return fakeProcess(codexFrames());
      },
    };
    const result = await runProviderSmoke(
      runDeps({ processPort: port, livePolicy: { ...livePolicy, schemaHash: '0'.repeat(64) } }),
    );
    expect(spawned).toBe(0);
    expect(result.providers.every((p) => p.reachedStage === 'policy_binding_mismatch')).toBe(true);
    expect(result.providers.every((p) => p.errorCode === 'POLICY_BINDING_MISMATCH')).toBe(true);
  });
});

describe('SMG-004 every path returns the single envelope', () => {
  it('authorization_missing / grant_missing / ledger_unsafe / grant_corrupt / preflight all yield the envelope', async () => {
    const stages: Array<[Partial<RunProviderSmokeDeps>, string]> = [
      [{ authorizationId: undefined }, 'authorization_missing'],
      [{ ledger: new InMemoryLedger(undefined) }, 'grant_missing'],
      [
        {
          ledger: () => {
            throw Object.assign(new Error('unsafe'), { code: 'PROVIDER_LEDGER_PATH_UNSAFE' });
          },
        },
        'ledger_unsafe',
      ],
      [
        {
          ledger: {
            readGrant() {
              throw Object.assign(new Error('corrupt'), { code: 'PROVIDER_GRANT_CORRUPT' });
            },
          } as unknown as SmokeLedger,
        },
        'grant_corrupt',
      ],
      [
        {
          prepareRepository: async () => {
            throw new Error('prepare failed');
          },
        },
        'preflight_unavailable',
      ],
      [{ probe: fakeProbe({ openai: 'throw', anthropic: 'throw' }) }, 'preflight_unavailable'],
    ];
    for (const [override, stage] of stages) {
      const result = await runProviderSmoke(runDeps(override));
      expect(result.schemaVersion).toBe(1);
      expect(result.providers).toHaveLength(2);
      expect(Array.isArray(result.providers)).toBe(true);
      expect(result.providers.some((p) => p.reachedStage === stage)).toBe(true);
      expect(isSmokePass(result)).toBe(false);
    }
  });

  it('preserves already-produced provider evidence when a later step fails', async () => {
    // Codex completes; the snapshot check for the halt then throws -> Claude halts, Codex retained.
    let calls = 0;
    const repo = fakeRepository(() => {
      calls += 1;
      if (calls === 1) throw new Error('snapshot failed');
      return true;
    });
    const result = await runProviderSmoke(runDeps({ prepareRepository: async () => repo }));
    const codex = result.providers.find((p) => p.provider === 'openai');
    const claude = result.providers.find((p) => p.provider === 'anthropic');
    expect(codex?.reachedStage).toBe('invocation_completed');
    expect(codex?.repositoryUnchanged).toBe(false); // fail-closed unknown snapshot
    expect(codex?.exitClassification).toBe('repository_changed');
    expect(claude?.reachedStage).toBe('security_halt');
  });
});

describe('SMG-005 + RB9 cleanup', () => {
  it('cleanup runs and its incompleteness makes the run a non-pass while preserving evidence', async () => {
    let cleaned = 0;
    const result = await runProviderSmoke(
      runDeps({
        cleanup: async () => {
          cleaned += 1;
          return 'incomplete';
        },
      }),
    );
    expect(cleaned).toBe(1);
    expect(result.cleanup).toBe('incomplete');
    expect(result.providers.every((p) => p.reachedStage === 'invocation_completed')).toBe(true);
    expect(isSmokePass(result)).toBe(false); // cleanup incomplete => not a pass
  });

  it('ResourceTracker removes only tracked dirs, bounded, and reports incomplete on EBUSY', async () => {
    const removed: string[] = [];
    const tracker = new ResourceTracker(async (path) => {
      removed.push(path.toString());
      if (path.toString() === 'C:\\temp\\repo')
        throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
    });
    tracker.track('C:\\temp\\runtime');
    tracker.track('C:\\temp\\repo');
    tracker.track('C:\\temp\\runtime'); // dedup
    expect(await tracker.cleanup()).toBe('incomplete');
    expect(removed).toEqual(['C:\\temp\\runtime', 'C:\\temp\\repo']);
    expect(await new ResourceTracker(async () => undefined).cleanup()).toBe('complete');
  });
});

describe('SMG-006 repository-mutation halt', () => {
  it('a Codex repository mutation halts Claude with 0 spawn (reserved, security_halt)', async () => {
    const ledger = new InMemoryLedger(grant);
    let spawned = 0;
    const port: SmokeProcessPort = {
      spawn: (r) => {
        spawned += 1;
        return fakeProcess(r.argv[0] === 'exec' ? codexFrames() : claudeFrames());
      },
    };
    const result = await runProviderSmoke(
      runDeps({
        ledger,
        processPort: port,
        prepareRepository: async () => fakeRepository(() => false),
      }),
    );
    expect(spawned).toBe(1); // Codex only
    const codex = result.providers.find((p) => p.provider === 'openai');
    const claude = result.providers.find((p) => p.provider === 'anthropic');
    expect(codex?.exitClassification).toBe('repository_changed');
    expect(claude?.reachedStage).toBe('security_halt');
    expect(claude?.reservedCount).toBe(1); // reserved but never spawned
    expect(claude?.spawnAttemptCount).toBe(0);
    expect(ledger.spawnMarks.map((m) => m.provider)).toEqual(['openai']);
  });
});

describe('SMG-007 reserved/spawn/invocation counts', () => {
  it('reserves both, spawns each once, and reports spawn-attempt-based invocation counts', async () => {
    const ledger = new InMemoryLedger(grant);
    const spawns: string[] = [];
    const port: SmokeProcessPort = {
      spawn: (r) => {
        spawns.push(String(r.argv[0]));
        return fakeProcess(r.argv[0] === 'exec' ? codexFrames() : claudeFrames());
      },
    };
    const result = await runProviderSmoke(runDeps({ ledger, processPort: port }));
    expect(spawns).toEqual(['exec', '--print']);
    expect(result.providers.map((p) => p.reachedStage)).toEqual([
      'invocation_completed',
      'invocation_completed',
    ]);
    expect(result.providers.map((p) => p.reservedCount)).toEqual([1, 1]);
    expect(result.providers.map((p) => p.spawnAttemptCount)).toEqual([1, 1]);
    expect(result.providers.map((p) => p.invocationCount)).toEqual([1, 1]);
    expect(result.cleanup).toBe('complete');
    expect(isSmokePass(result)).toBe(true);
  });

  it('a spawn failure keeps a durable spawn-attempt count of 1 with no OS child', async () => {
    const ledger = new InMemoryLedger(grant);
    const port: SmokeProcessPort = { spawn: () => Promise.reject(new Error('synthetic failure')) };
    const result = await runProviderSmoke(runDeps({ ledger, processPort: port }));
    const codex = result.providers.find((p) => p.provider === 'openai');
    expect(codex?.exitClassification).toBe('spawn_failed');
    expect(codex?.spawnAttemptCount).toBe(1); // marker written before the failed spawn
    expect(codex?.childProcessCount).toBe(0);
  });

  it('a rerun of the same authorization performs 0 spawn for both providers', async () => {
    const ledger = new InMemoryLedger(grant);
    ledger.claimed = true;
    ledger.reservedCount.openai = 1;
    ledger.reservedCount.anthropic = 1;
    ledger.spawnCount.openai = 1;
    ledger.spawnCount.anthropic = 1;
    const port: SmokeProcessPort = {
      spawn: () => {
        throw new Error('a claim-denied rerun must never spawn');
      },
    };
    const result = await runProviderSmoke(runDeps({ ledger, processPort: port }));
    expect(result.providers.every((p) => p.reachedStage === 'run_claim_denied')).toBe(true);
    expect(result.providers.map((p) => p.reservedCount)).toEqual([1, 1]);
    expect(result.providers.map((p) => p.spawnAttemptCount)).toEqual([1, 1]);
    expect(isSmokePass(result)).toBe(false);
  });
});

describe('SMG-020 evidence sanitization', () => {
  it('the run envelope leaks no raw path/token/email/org', async () => {
    const leakyPort: SmokeProcessPort = {
      spawn: (request) => ({
        stdout: byteStream(request.argv[0] === 'exec' ? codexFrames() : claudeFrames()),
        stderr: byteStream([
          'Bearer sk-SENTINELSECRETVALUE contact user@example.org org=AcmeOrg\n',
        ]),
        exited: Promise.resolve({ exitCode: 0, signal: null }),
        writeStdin: () => undefined,
        terminateOwnedTree: () => undefined,
        countOwnedDescendants: () => 0,
      }),
    };
    const probe = fakeProbe({
      openai: { resolvedPath: 'C:\\secret-path\\codex.exe' },
      anthropic: { resolvedPath: 'C:\\secret-path\\claude.exe' },
    });
    const result = await runProviderSmoke(runDeps({ processPort: leakyPort, probe }));
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('secret-path'); // raw executable path
    expect(serialized).not.toContain('SENTINELSECRETVALUE'); // raw token
    expect(serialized).not.toContain('user@example.org'); // raw email
    expect(serialized).not.toContain('AcmeOrg'); // raw org
    // The credential-shaped stderr is only COUNTED, never emitted.
    expect(result.providers.some((p) => p.sanitizerFindingCount > 0)).toBe(true);
    // executable identity is only the fingerprint hash.
    expect(result.providers[0]?.executableFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('grant issuance (DA) + CLI dispatch (RB5/RB6)', () => {
  const grantEnv = { [AUTHORIZATION_ID_ENV]: 'AUTH-9', [CODEX_MODEL_ENV]: 'gpt-5.1-codex' };
  const grantIssuer: GrantIssuer = {
    grant: (request: GrantRequest) => ({
      ...grant,
      authorizationId: request.authorizationId,
      providers: {
        openai: {
          model: request.providers.openai.model,
          maxInvocations: 1,
          binding: request.providers.openai.binding,
        },
        anthropic: {
          model: request.providers.anthropic.model,
          maxInvocations: 1,
          binding: request.providers.anthropic.binding,
        },
      },
    }),
  };

  it('issueGrant binds operator models + probed bindings and defaults claude to sonnet', () => {
    const captured: GrantRequest[] = [];
    const issued = issueGrant({
      environment: grantEnv,
      ledger: {
        grant: (r) => {
          captured.push(r);
          return grantIssuer.grant(r);
        },
      },
      probe: fakeProbe(),
      policy: livePolicy,
    });
    expect(captured[0]?.providers.openai.model).toBe('gpt-5.1-codex');
    expect(captured[0]?.providers.anthropic.model).toBe(DEFAULT_CLAUDE_SMOKE_MODEL);
    expect(captured[0]?.providers.openai.binding.executableFingerprint).toBe(FP.openai);
    expect(issued.authorizationId).toBe('AUTH-9');
    expect(() =>
      issueGrant({ environment: {}, ledger: grantIssuer, probe: fakeProbe() }),
    ).toThrow();
  });

  it('the grant CLI envelope emits only a hashed authorization id and no raw id/path/identity', async () => {
    const lines: string[] = [];
    let exit = -1;
    await runSmokeCli(['grant'], {
      environment: grantEnv,
      runGrant: () =>
        issueGrant({
          environment: grantEnv,
          ledger: grantIssuer,
          probe: fakeProbe(),
          policy: livePolicy,
        }),
      runSmoke: async () => {
        throw new Error('must not run');
      },
      stdout: (line) => lines.push(line),
      setExitCode: (code) => (exit = code),
    });
    expect(exit).toBe(0);
    const envelope = JSON.parse(lines[0] ?? '{}') as GrantEnvelope;
    expect(envelope).toMatchObject({ schemaVersion: 1, mode: 'grant', result: 'granted' });
    expect(envelope.authorizationIdHash).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.keys(envelope)).not.toContain('authorizationId');
    const serialized = lines[0] ?? '';
    expect(serialized).not.toContain('AUTH-9'); // no raw authorization id
    expect(serialized).not.toContain('C:\\trusted'); // no raw path
    expect(serialized).not.toMatch(/token=|@example|Bearer\s/i);
  });

  it('a grant failure emits a sanitized grant error envelope, never a raw exception', async () => {
    const lines: string[] = [];
    let exit = -1;
    await runSmokeCli(['grant'], {
      environment: grantEnv,
      runGrant: () => {
        throw new ProviderLedgerError('PROVIDER_GRANT_CONFLICT', 'sanitized');
      },
      runSmoke: async () => ({ schemaVersion: 1, providers: [], cleanup: 'not_reached' }),
      stdout: (line) => lines.push(line),
      setExitCode: (code) => (exit = code),
    });
    expect(exit).toBe(1);
    const envelope = JSON.parse(lines[0] ?? '{}') as GrantEnvelope;
    expect(envelope).toEqual({
      schemaVersion: 1,
      mode: 'grant',
      result: 'error',
      errorCode: 'PROVIDER_GRANT_CONFLICT',
    });
    expect(lines[0]).not.toContain('boom');
  });

  it('the run CLI requires the opt-in and never emits [] or a raw exception', async () => {
    const noOptIn: string[] = [];
    let exitA = -1;
    await runSmokeCli([], {
      environment: {},
      runGrant: () => grant,
      runSmoke: async () => {
        throw new Error('should not run without opt-in');
      },
      stdout: (line) => noOptIn.push(line),
      setExitCode: (code) => (exitA = code),
    });
    expect(exitA).toBe(1);
    expect(noOptIn).toEqual([]); // no run envelope emitted

    const lines: string[] = [];
    let exitB = -1;
    await runSmokeCli([], {
      environment: { ORION_REAL_PROVIDER_TESTS: '1' },
      runGrant: () => grant,
      runSmoke: async () => {
        throw new Error('deferred failure');
      },
      stdout: (line) => lines.push(line),
      setExitCode: (code) => (exitB = code),
    });
    expect(exitB).toBe(1);
    const envelope = JSON.parse(lines[0] ?? '{}') as ProviderSmokeEnvelope;
    expect(envelope.schemaVersion).toBe(1);
    expect(Array.isArray(envelope.providers)).toBe(true);
    expect(envelope.providers).toHaveLength(2);
    expect(lines[0]).not.toContain('deferred failure');
  });
});

describe('runDeferredProviderSmoke injectable seams (RB5)', () => {
  const fakeRuntime = {
    NativeProviderProcessPort: class {
      public spawn(request: { readonly argv: readonly string[] }): SmokeProcess {
        return fakeProcess(request.argv[0] === 'exec' ? codexFrames() : claudeFrames());
      }
    },
    buildProviderEnvironment: () => ({}),
    resolveTrustedProviderExecutable: (path: string) => path,
  } as unknown as HardenedRuntime;
  function deferredDeps(
    overrides: Partial<DeferredSmokeDependencies>,
  ): Partial<DeferredSmokeDependencies> {
    return {
      environment: { [AUTHORIZATION_ID_ENV]: 'AUTH-1', ORION_REAL_PROVIDER_TESTS: '1' },
      loadRuntime: async () => fakeRuntime,
      makeProbe: () => fakeProbe(),
      ledgerFactory: () => new InMemoryLedger(grant),
      resourceTracker: new ResourceTracker(async () => undefined),
      prepareRepository: async (_runtime, _env, tracker) => {
        tracker.track('C:\\temp\\smoke-runtime');
        return fakeRepository();
      },
      now: () => new Date('2026-07-24T00:00:00.000Z'),
      ...overrides,
    };
  }

  it('a runtime-load failure returns preflight_unavailable and still cleans up', async () => {
    let cleaned = 0;
    const tracker = new ResourceTracker(async () => {
      cleaned += 1;
    });
    const result = await runDeferredProviderSmoke(
      deferredDeps({
        resourceTracker: tracker,
        loadRuntime: async () => {
          throw new Error('dist missing');
        },
      }),
    );
    expect(result.providers.every((p) => p.reachedStage === 'preflight_unavailable')).toBe(true);
    expect(result.providers.every((p) => p.errorCode === 'RUNTIME_LOAD_FAILED')).toBe(true);
    expect(cleaned).toBe(0); // nothing tracked, nothing to remove
  });

  it('the happy deferred path spawns via the injected fakes and cleans tracked dirs', async () => {
    const removed: string[] = [];
    const tracker = new ResourceTracker(async (path) => {
      removed.push(path.toString());
    });
    const result = await runDeferredProviderSmoke(deferredDeps({ resourceTracker: tracker }));
    expect(removed).toContain('C:\\temp\\smoke-runtime'); // cleanup invoked in the real path
    expect(result.providers).toHaveLength(2);
  });
});

describe('invokeSmokeProvider inspection (shared normalizer)', () => {
  it('normalizes a Codex success stream and reports the bound fingerprint', async () => {
    const evidence = await invokeSmokeProvider(
      {
        provider: 'openai',
        executable: RESOLVED.openai,
        argv: codexSmokeArgv(paths, 'gpt-5.1-codex'),
        cwd: paths.repository,
        environment: {},
        permissionMode: 'read-only',
        executableFingerprint: FP.openai,
      },
      { spawn: () => fakeProcess(codexFrames()) },
      () => new Date('2026-07-24T00:00:00.000Z'),
    );
    expect(evidence).toMatchObject({
      reachedStage: 'invocation_completed',
      exitClassification: 'succeeded',
      strictResult: true,
      executableFingerprint: FP.openai,
      cliVersion: '0.145.0',
      normalizedEventCounts: { 'run.started': 1, 'run.usage': 1, 'run.completed': 1 },
    });
  });
});

describe('pure helpers', () => {
  it('computeLivePolicy is deterministic and matches the grant options', () => {
    expect(computeLivePolicy()).toEqual(livePolicy);
    expect(computeLivePolicy().argvPolicyVersion).toBe(grant.options.argvPolicyVersion);
    expect(computeLivePolicy().schemaHash).toBe(grant.options.schemaHash);
  });

  it('grantEnvelope emits a hashed id, bindings, and policy but no raw id/path', () => {
    const envelope = grantEnvelope(grant, 'granted');
    expect(envelope).toMatchObject({ schemaVersion: 1, mode: 'grant', result: 'granted' });
    expect(envelope.authorizationIdHash).toMatch(/^[a-f0-9]{64}$/);
    expect(envelope.providers?.openai.binding.executableFingerprint).toBe(FP.openai);
    expect(envelope.policy).toEqual(livePolicy);
    expect(JSON.stringify(envelope)).not.toContain('AUTH-1');
  });

  it('resolveLedgerDirectory honors an override or the LOCALAPPDATA default', () => {
    expect(resolveLedgerDirectory({ ORION_PROVIDER_LEDGER_DIR: 'D:\\ledger' })).toBe('D:\\ledger');
    expect(resolveLedgerDirectory({ LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' })).toBe(
      'C:\\Users\\x\\AppData\\Local\\Orion\\provider-smoke-ledger',
    );
  });

  it('withRepositoryStatus flags a mutation and pendingEvidence carries the counts', () => {
    const succeeded = {
      ...pendingEvidence('openai', 'invocation_completed', {
        reservedCount: 1,
        spawnAttemptCount: 1,
        invocationCount: 1,
      }),
      exitClassification: 'succeeded' as const,
    };
    expect(withRepositoryStatus(succeeded, true).exitClassification).toBe('succeeded');
    expect(withRepositoryStatus(succeeded, false).exitClassification).toBe('repository_changed');
    expect(succeeded.spawnAttemptCount).toBe(1);
  });
});
