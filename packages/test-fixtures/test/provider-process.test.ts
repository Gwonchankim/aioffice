import { describe, expect, it } from 'vitest';

import {
  allProviderProcessFixtures,
  codexResumeRejectionFixtures,
  decodeFakeProcessChunks,
  providerProcessFixtures,
  providerProcessScenarioNames,
} from '../src/index.js';

describe('synthetic M2 provider-process fixtures', () => {
  it('M2-FIX-001 provides the complete fake-only matrix for both Codex and Claude', () => {
    expect(providerProcessFixtures.codex).toHaveLength(providerProcessScenarioNames.length);
    expect(providerProcessFixtures.claude).toHaveLength(providerProcessScenarioNames.length);
    expect(allProviderProcessFixtures).toHaveLength(providerProcessScenarioNames.length * 2);

    for (const [provider, fixtures] of Object.entries(providerProcessFixtures)) {
      expect(new Set(fixtures.map((fixture) => fixture.scenario))).toEqual(
        new Set(providerProcessScenarioNames),
      );
      for (const fixture of fixtures) {
        expect(fixture.provider).toBe(provider);
        expect(Array.isArray(fixture.process.stdoutChunks)).toBe(true);
        expect(Array.isArray(fixture.process.stderrChunks)).toBe(true);
        expect(fixture.process.exit.durationMs).toBeGreaterThanOrEqual(0);
        expect(fixture.process.descendantCountAfterClose).toBeLessThanOrEqual(
          fixture.process.descendantCountBeforeClose,
        );
        expect(fixture.expected.diagnostics.consecutiveInvalidFrameCount).toBeLessThanOrEqual(
          fixture.expected.diagnostics.invalidFrameCount,
        );
        expect(fixture.expected.diagnostics.stderrOmittedBytes).toBeLessThanOrEqual(
          fixture.expected.diagnostics.stderrBytes,
        );
        expect(fixture.expected.normalizedEvents.map((event) => event.sequence)).toEqual(
          fixture.expected.normalizedEvents.map((_, index) => index + 1),
        );
        expect(fixture.expected.spawn.processCalls).toBe(fixture.expected.spawn.permitted ? 1 : 0);
        expect(fixture.process.spawnCapture === null).toBe(!fixture.expected.spawn.permitted);
      }
    }
  });

  it('M2-FIX-002 keeps synthetic chunk bytes, diagnostics, and results internally consistent', () => {
    for (const fixture of allProviderProcessFixtures) {
      const stdout = decodeFakeProcessChunks(fixture.process.stdoutChunks);
      const stderr = decodeFakeProcessChunks(fixture.process.stderrChunks);
      const actualStderrBytes = fixture.process.stderrChunks.reduce(
        (total, chunk) => total + chunk.byteLength,
        0,
      );

      expect(actualStderrBytes).toBe(fixture.expected.diagnostics.stderrBytes);
      if (fixture.expected.result !== null) {
        expect(fixture.expected.result.status).toBe('succeeded');
        expect(fixture.expected.result.summary).toContain('Synthetic');
        expect(fixture.expected.result.handoff).toContain('Synthetic');
        if (fixture.provider === 'codex') expect(stdout).toContain('"type":"agent_message"');
        else expect(stdout).toContain('"structured_output"');
      }
      if (fixture.scenario === 'utf8-korean-split') {
        expect(stdout).toContain('합성 한국어 출력');
        expect(fixture.process.stdoutChunks).toHaveLength(4);
      }
      if (fixture.scenario === 'crlf') {
        expect(stdout).toContain('\r\n');
      }
      if (fixture.scenario === 'secret-like-stderr') {
        expect(stderr).toContain('sk-FAKE-');
        expect(stderr).toContain('FAKE-BEARER');
        expect(fixture.expected.diagnostics.sanitizedDiagnostic).toBe('[REDACTED]');
        expect(fixture.expected.diagnostics.sanitizedDiagnostic).not.toMatch(/sk-|bearer/i);
      }
      if (fixture.scenario === 'stderr-flood') {
        expect(fixture.expected.diagnostics.stderrBytes).toBeGreaterThan(256 * 1024);
        expect(fixture.expected.diagnostics.stderrOmittedBytes).toBeGreaterThan(0);
      }
      if (fixture.scenario === 'five-consecutive-invalid') {
        expect(fixture.expected.terminal.errorCode).toBe('ADAPTER_PROTOCOL_ERROR');
        expect(fixture.expected.diagnostics.consecutiveInvalidFrameCount).toBe(5);
      }
      if (fixture.scenario === 'duplicate-event') {
        expect(
          fixture.expected.normalizedEvents.filter((event) => event.type === 'run.output.delta'),
        ).toHaveLength(1);
      }
      if (fixture.scenario === 'cancel-after-late-success') {
        expect(fixture.expected.result).not.toBeNull();
        expect(fixture.expected.terminal.status).toBe('cancelled');
      }
      if (fixture.expected.sessionId !== undefined) {
        expect(fixture.expected.sessionPersistedBeforeStarted).toBe(true);
        expect(fixture.expected.normalizedEvents[0]?.type).toBe('run.started');
      }
      if (fixture.expected.usage !== undefined) {
        expect(fixture.expected.usage).toEqual({
          inputTokens: 11,
          outputTokens: 7,
          cacheTokens: 5,
          reportedCost: null,
        });
      }
      if (fixture.expected.cancellation !== undefined) {
        expect(fixture.expected.cancellation.gracefulTerminationRequests).toBe(1);
        expect(fixture.expected.cancellation.idempotent).toBe(true);
      }
      if (fixture.expected.inspection !== undefined) {
        expect(fixture.expected.inspection.supportedModels).toEqual([]);
        expect(fixture.expected.inspection.sanitizedError).not.toMatch(
          /(?:token|secret|password|authorization|cookie)/i,
        );
      }
    }
  });

  it('M2-FIX-003 captures safe spawn metadata without prompts or environment values', () => {
    for (const fixture of allProviderProcessFixtures.filter(
      (fixture) => fixture.expected.spawn.permitted,
    )) {
      const capture = fixture.process.spawnCapture;
      expect(capture).not.toBeNull();
      if (capture === null) {
        continue;
      }
      expect(capture.shell).toBe(false);
      expect(capture.executable).toMatch(/^C:\\Synthetic\\trusted\\(?:codex|claude)\.exe$/);
      expect(capture.environmentVariableNames).toEqual(['APPDATA', 'PATH', 'USERPROFILE']);
      expect(capture.stdinByteCount).toBeGreaterThan(0);
      expect(Object.keys(capture)).toEqual([
        'executable',
        'argv',
        'cwd',
        'environmentVariableNames',
        'stdinByteCount',
        'shell',
      ]);
    }

    const codexResume = providerProcessFixtures.codex.find(
      (fixture) => fixture.scenario === 'normal-resume',
    );
    const claudeResume = providerProcessFixtures.claude.find(
      (fixture) => fixture.scenario === 'normal-resume',
    );
    expect(codexResume?.process.spawnCapture?.argv).toEqual([
      'exec',
      '--json',
      '--model',
      'synthetic-codex-model',
      '--sandbox',
      'read-only',
      '--cd',
      'C:\\Synthetic\\runtime\\readonly-worktree',
      '--output-schema',
      'C:\\Synthetic\\runtime\\schemas\\run-result-schema.json',
      'resume',
      'synthetic-codex-session',
      '-',
    ]);
    expect(claudeResume?.process.spawnCapture?.argv).toEqual([
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
    ]);
  });

  it('M2-FIX-004 supplies negative Codex resume and no-spawn policy fixtures', () => {
    expect(codexResumeRejectionFixtures).toHaveLength(7);
    expect(new Set(codexResumeRejectionFixtures.map((fixture) => fixture.rejectedBy))).toEqual(
      new Set(['argv-order', 'forbidden-flag', 'resolver', 'environment', 'schema']),
    );
    for (const fixture of codexResumeRejectionFixtures) {
      expect(fixture.spawnPermitted).toBe(false);
      expect(fixture.argv).toContain('resume');
    }

    for (const fixture of allProviderProcessFixtures.filter(
      (fixture) => fixture.scenario === 'unsupported-cli-capability',
    )) {
      expect(fixture.expected.spawn).toEqual({
        permitted: false,
        resolverCalls: 0,
        schemaFileCalls: 0,
        processCalls: 0,
      });
      expect(fixture.expected.inspection).toMatchObject({
        installed: true,
        authenticated: true,
        status: 'unsupported',
        supportedModels: [],
      });
    }
    for (const fixture of allProviderProcessFixtures.filter(
      (fixture) => fixture.scenario === 'unauthenticated-provider',
    )) {
      expect(fixture.expected.spawn.processCalls).toBe(0);
      expect(fixture.expected.inspection).toMatchObject({
        installed: true,
        authenticated: false,
        status: 'unauthenticated',
        supportedModels: [],
      });
    }
    for (const fixture of allProviderProcessFixtures.filter(
      (fixture) => fixture.scenario === 'controlled-no-spawn',
    )) {
      expect(fixture.expected.controlledPayloadKinds).toEqual(['metadata', 'summary', 'excerpt']);
      expect(fixture.expected.spawn).toEqual({
        permitted: false,
        resolverCalls: 0,
        schemaFileCalls: 0,
        processCalls: 0,
      });
    }
    for (const fixture of allProviderProcessFixtures.filter(
      (fixture) => fixture.scenario === 'forced-child-tree-cancel',
    )) {
      expect(fixture.process.descendantCountAfterClose).toBe(0);
      expect(fixture.expected.cancellation).toEqual({
        gracefulTerminationRequests: 1,
        forcedOwnedTreeTerminations: 1,
        idempotent: true,
      });
    }
  });
});
