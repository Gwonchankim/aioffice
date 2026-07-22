import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { assertSafeProviderArguments, eventMapping } from '../../src/providers/adapter.js';
import { ChildProcessOwnershipRegistry } from '../../src/providers/child-process-ownership.js';
import {
  IncrementalLineParser,
  MAX_PROVIDER_LINE_BYTES,
} from '../../src/providers/incremental-line-parser.js';
import {
  buildProviderEnvironment,
  canonicalizeProviderCwd,
  isPermittedProjectEnvironmentName,
  NativeProviderProcessPort,
  RuntimeOutputSchemaStore,
  type ProviderProcessHandle,
} from '../../src/providers/provider-process.js';
import { redactProviderText, SanitizedStderrRing } from '../../src/providers/provider-redaction.js';
import { resolveTrustedProviderExecutable } from '../../src/providers/trusted-provider-executable.js';

function parser() {
  return new IncrementalLineParser((frame) => {
    if (typeof frame !== 'object' || frame === null || !('type' in frame))
      return { kind: 'invalid' };
    return (frame as { type: unknown }).type === 'valid'
      ? eventMapping('run.output.delta', { channel: 'summary', text: 'valid frame' })
      : { kind: 'unknown' };
  });
}

function emptyStream(): AsyncIterable<Uint8Array> {
  return (async function* () {})();
}

function controlledHandle(descendants = 0) {
  let finish:
    ((value: { exitCode: number | null; signal: NodeJS.Signals | null }) => void) | undefined;
  const exited = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      finish = resolve;
    },
  );
  const counters = { graceful: 0, forced: 0 };
  const handle: ProviderProcessHandle = {
    pid: 50_001,
    stdout: emptyStream(),
    stderr: emptyStream(),
    exited,
    writeStdin: () => undefined,
    requestGracefulTermination: () => {
      counters.graceful += 1;
    },
    terminateOwnedTree: () => {
      counters.forced += 1;
    },
    countOwnedDescendants: () => descendants,
  };
  return { handle, counters, finish: finish! };
}

function nativePe(path: string): void {
  const descriptor = openSync(path, 'w');
  const bytes = Buffer.alloc(512);
  bytes[0] = 0x4d;
  bytes[1] = 0x5a;
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes[0x80] = 0x50;
  bytes[0x81] = 0x45;
  writeFileSync(descriptor, bytes);
  closeSync(descriptor);
}

describe('incremental provider protocol security', () => {
  it('preserves UTF-8 and CRLF frames, ignores unknown frames, and resets invalid-frame streaks', () => {
    const value = parser();
    const korean = Buffer.from('{"type":"valid","text":"한국어"}\r\n', 'utf8');
    expect(value.push(korean.subarray(0, korean.length - 2))).toStrictEqual([]);
    expect(value.push(korean.subarray(korean.length - 2))).toHaveLength(1);
    value.push(Buffer.from('{bad}\n{bad}\n{bad}\n{bad}\n'));
    expect(value.diagnostics.consecutiveInvalidFrameCount).toBe(4);
    expect(value.push(Buffer.from('{"type":"valid"}\n'))).toHaveLength(1);
    expect(value.diagnostics.consecutiveInvalidFrameCount).toBe(0);
    expect(value.push(Buffer.from('{"type":"future"}\n'))).toStrictEqual([]);
    expect(value.diagnostics.unknownEventCount).toBe(1);
    expect(value.finish()).toStrictEqual([]);
  });

  it('fails closed after five consecutive invalid records and after an oversized line', () => {
    const invalid = parser();
    invalid.push(Buffer.from('{bad}\n{bad}\n{bad}\n{bad}\n{bad}\n'));
    expect(invalid.error).toMatchObject({ code: 'ADAPTER_PROTOCOL_ERROR' });
    expect(invalid.diagnostics.consecutiveInvalidFrameCount).toBe(5);

    const boundary = parser();
    const exact = `{"type":"future","padding":"${'x'.repeat(MAX_PROVIDER_LINE_BYTES - 31)}"}`;
    boundary.push(Buffer.from(`${exact}\n`));
    expect(boundary.error).toBeUndefined();
    const oversized = parser();
    oversized.push(Buffer.from(`${'x'.repeat(MAX_PROVIDER_LINE_BYTES + 1)}\n`));
    expect(oversized.error).toMatchObject({ code: 'ADAPTER_PROTOCOL_ERROR' });
  });

  it('bounds and masks stderr without converting it to provider output', () => {
    const ring = new SanitizedStderrRing();
    ring.push(Buffer.from('Bearer FAKE-SYNTHETIC-SECRET token=FAKE-SYNTHETIC-SECRET'));
    ring.push(Buffer.alloc(300_000, 120));
    ring.finish();
    expect(ring.byteCount).toBeGreaterThan(256 * 1024);
    expect(ring.omittedByteCount).toBe(ring.byteCount - 256 * 1024);
    expect(ring.text).not.toContain('FAKE-SYNTHETIC-SECRET');
    expect(redactProviderText('credential=secret-value')).toBe('[REDACTED]');
  });
  it('writes a restrictive serialized schema beneath an app runtime directory outside the project', () => {
    const runtime = mkdtempSync(join(tmpdir(), 'orion-runtime-'));
    const source = join(tmpdir(), `orion-schema-${Date.now()}.json`);
    try {
      writeFileSync(source, JSON.stringify({ type: 'object', additionalProperties: false }));
      const schema = new RuntimeOutputSchemaStore(runtime).create(
        '01ARZ3NDEKTSV4RRFFQ69G5FAY',
        source,
      );
      expect(schema.path).toContain('schemas');
      expect(schema.serialized).toBe('{"type":"object","additionalProperties":false}');
      expect(existsSync(schema.path)).toBe(true);
      schema.remove();
      expect(existsSync(schema.path)).toBe(false);
    } finally {
      rmSync(source, { force: true });
      rmSync(runtime, { recursive: true, force: true });
    }
  });
});

describe('provider process security', () => {
  it('accepts only administrator-configured native executables outside the project and rejects wrappers/PATH', () => {
    const outside = mkdtempSync(join(tmpdir(), 'orion-native-'));
    const project = mkdtempSync(join(tmpdir(), 'orion-project-'));
    try {
      const executable = join(outside, 'provider.exe');
      nativePe(executable);
      expect(resolveTrustedProviderExecutable(executable, { projectRoots: [project] })).toContain(
        'provider.exe',
      );
      expect(() =>
        resolveTrustedProviderExecutable('provider', { projectRoots: [project] }),
      ).toThrow(expect.objectContaining({ code: 'PROVIDER_EXECUTABLE_INVALID' }));
      expect(() =>
        resolveTrustedProviderExecutable(process.execPath, { projectRoots: [project] }),
      ).toThrow(expect.objectContaining({ code: 'PROVIDER_EXECUTABLE_INVALID' }));
      const projectExecutable = join(project, 'provider.exe');
      nativePe(projectExecutable);
      expect(() =>
        resolveTrustedProviderExecutable(projectExecutable, { projectRoots: [project] }),
      ).toThrow(expect.objectContaining({ code: 'PROVIDER_EXECUTABLE_INVALID' }));
    } finally {
      rmSync(outside, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('rebuilds the environment by allowed names and denies secret/server names', () => {
    const environment = buildProviderEnvironment(
      {
        PATH: 'safe-path',
        APPDATA: 'safe-app-data',
        SAFE_PROJECT_VALUE: 'safe-value',
        DATABASE_URL: 'never-pass',
      },
      ['SAFE_PROJECT_VALUE'],
    );
    expect(environment).toStrictEqual({
      PATH: 'safe-path',
      APPDATA: 'safe-app-data',
      SAFE_PROJECT_VALUE: 'safe-value',
    });
    expect(isPermittedProjectEnvironmentName('TOKEN_VALUE')).toBe(false);
    expect(isPermittedProjectEnvironmentName('DATABASE_URL')).toBe(false);
    expect(() => buildProviderEnvironment({ TOKEN_VALUE: 'nope' }, ['TOKEN_VALUE'])).toThrow(
      expect.objectContaining({ code: 'VALIDATION_FAILED' }),
    );
  });

  it('requires contained canonical cwd and rejects permission bypass argv', () => {
    const root = mkdtempSync(join(tmpdir(), 'orion-cwd-root-'));
    const nested = join(root, 'nested');
    const outside = mkdtempSync(join(tmpdir(), 'orion-cwd-outside-'));
    try {
      writeFileSync(join(root, '.keep'), 'fixture');
      mkdirSync(nested);
      expect(canonicalizeProviderCwd(nested, root, 'read_only')).toBeDefined();
      expect(() => canonicalizeProviderCwd(outside, root, 'read_only')).toThrow(
        expect.objectContaining({ code: 'VALIDATION_FAILED' }),
      );
      expect(() => assertSafeProviderArguments(['--permission-mode', 'bypassPermissions'])).toThrow(
        expect.objectContaining({ code: 'VALIDATION_FAILED' }),
      );
      expect(() =>
        assertSafeProviderArguments(['--dangerously-bypass-approvals-and-sandbox']),
      ).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('rejects unowned cancellation, force-terminates only owned trees, and verifies descendants are gone', async () => {
    const registry = new ChildProcessOwnershipRegistry(() => 1, 0);
    await expect(registry.cancel('unowned-handle')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    const fake = controlledHandle();
    const owned = registry.register('01ARZ3NDEKTSV4RRFFQ69G5FAY', fake.handle);
    const cancellation = registry.cancel(owned.runtimeHandle);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.counters.graceful).toBe(1);
    expect(fake.counters.forced).toBe(1);
    fake.finish({ exitCode: null, signal: 'SIGKILL' });
    await cancellation;
    expect(registry.has(owned.runtimeHandle)).toBe(false);

    const leaking = controlledHandle(1);
    const leakingOwned = registry.register('01ARZ3NDEKTSV4RRFFQ69G5FAX', leaking.handle);
    const verify = registry.verifyClosed(leakingOwned);
    leaking.finish({ exitCode: 0, signal: null });
    await expect(verify).rejects.toMatchObject({ code: 'PROVIDER_EXECUTION_FAILED' });
  });
  it('returns injected owned-tree counts before and after terminating a benign owned process', async () => {
    let descendantCount = 1;
    const port = new NativeProviderProcessPort(async () => descendantCount);
    const child = port.spawn({
      executable: process.execPath,
      argv: ['--eval', 'setTimeout(() => undefined, 20_000);'],
      cwd: tmpdir(),
      env: process.env,
      shell: false,
    });
    try {
      expect(await child.countOwnedDescendants()).toBeGreaterThan(0);

      child.requestGracefulTermination();
      await child.exited;
      descendantCount = 0;
      expect(await child.countOwnedDescendants()).toBe(0);
    } finally {
      child.requestGracefulTermination();
      await child.exited;
    }
  });
});
