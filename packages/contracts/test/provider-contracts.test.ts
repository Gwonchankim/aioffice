import { describe, expect, it } from 'vitest';

import {
  agentRunRequestSchema,
  normalizedAdapterEventSchema,
  providerHealthCollectionSchema,
  providerHealthSchema,
  providerInspectionSchema,
  providerRefreshInputSchema,
  resumeRunRequestSchema,
  runEventSchema,
  runResultSchema,
} from '../src/index.js';

const ids = {
  task: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
  step: '01ARZ3NDEKTSV4RRFFQ69G5FAX',
  run: '01ARZ3NDEKTSV4RRFFQ69G5FAY',
  event: '01ARZ3NDEKTSV4RRFFQ69G5FAZ',
  artifact: '01ARZ3NDEKTSV4RRFFQ69G5FB0',
} as const;

const timestamp = '2026-07-22T09:00:00.000Z';

const validProfile = () => ({
  id: 'atlas',
  version: 1,
  name: 'Atlas',
  displayName: 'Atlas Advisor',
  description: 'Synthetic adapter contract profile with no provider credentials or personal data.',
  provider: 'openai',
  model: 'synthetic-codex-model',
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
  capabilities: ['contract-validation'],
  enabled: false,
  executionMode: 'skeleton',
});

const validRunRequest = () => ({
  runId: ids.run,
  taskId: ids.task,
  stepId: ids.step,
  agentProfileSnapshot: validProfile(),
  provider: 'openai',
  model: 'synthetic-codex-model',
  prompt: 'Return only a synthetic structured result for this contract test.',
  cwd: 'C:\\Synthetic\\runtime\\readonly-worktree',
  executionMode: 'read_only',
  outputSchemaPath: 'C:\\Synthetic\\runtime\\schemas\\run-result-schema.json',
  allowedTools: ['Read', 'Glob'],
  allowedCommands: { read: [['git', 'status']], verify: [['pnpm', 'test']], localWrite: [] },
  timeoutAt: timestamp,
  environmentVariableNames: ['PATH', 'APPDATA'],
});

const validRunResult = () => ({
  status: 'succeeded',
  summary: 'Synthetic final result was validated.',
  findings: [{ severity: 'info', text: 'No external provider was invoked.' }],
  artifacts: [
    {
      kind: 'report',
      path: 'artifacts/synthetic-report.json',
      title: 'Synthetic report',
      description: 'A fixture-only report.',
    },
  ],
  changes: [
    { files: ['packages/contracts/src/provider.ts'], description: 'Synthetic contract change.' },
  ],
  tests: [{ command: 'pnpm test', status: 'passed', summary: 'Synthetic test passed.' }],
  risks: [],
  handoff: 'Synthetic handoff only.',
});

const validProviderHealth = () => ({
  provider: 'openai',
  installed: true,
  cliVersion: '0.0.0-synthetic',
  authenticated: true,
  status: 'ready',
  supportedModels: ['synthetic-codex-model'],
  lastCheckedAt: timestamp,
  sanitizedError: null,
});

const validRunEvent = () => ({
  schemaVersion: 1,
  id: ids.event,
  sequence: 1,
  taskId: ids.task,
  stepId: ids.step,
  runId: ids.run,
  provider: 'openai',
  type: 'run.started',
  timestamp,
  diagnostics: {
    invalidFrameCount: 0,
    consecutiveInvalidFrameCount: 0,
    unknownEventCount: 0,
    stderrBytes: 0,
    stderrOmittedBytes: 0,
  },
  payload: {
    attempt: 1,
    provider: 'openai',
    model: 'synthetic-codex-model',
    profileVersion: 1,
    sessionId: 'synthetic-codex-session',
  },
});

const validDiagnostics = {
  invalidFrameCount: 0,
  consecutiveInvalidFrameCount: 0,
  unknownEventCount: 0,
  stderrBytes: 0,
  stderrOmittedBytes: 0,
};

describe('M2 provider contracts', () => {
  it('M2-CON-001 accepts strict start, resume, inspect, and normalized event contracts', () => {
    expect(agentRunRequestSchema.parse(validRunRequest()).cwd).toContain('Synthetic');
    expect(
      resumeRunRequestSchema.parse({ ...validRunRequest(), sessionId: 'synthetic-codex-session' })
        .sessionId,
    ).toBe('synthetic-codex-session');
    expect(providerHealthSchema.parse(validProviderHealth()).status).toBe('ready');
    expect(
      providerInspectionSchema.parse({
        provider: 'openai',
        health: validProviderHealth(),
        capabilities: [
          { name: 'jsonl', supported: true },
          { name: 'output_schema', supported: true },
          { name: 'resume', supported: true },
          { name: 'sandbox', supported: true },
        ],
      }).capabilities,
    ).toHaveLength(4);
    expect(runEventSchema.parse(validRunEvent()).sequence).toBe(1);
    expect(
      normalizedAdapterEventSchema.parse({
        kind: 'event',
        event: {
          providerEventId: 'codex-event-1',
          diagnostics: validDiagnostics,
          type: 'run.output.delta',
          payload: { channel: 'summary', text: 'Synthetic output.' },
        },
      }).kind,
    ).toBe('event');
  });

  it('M2-CON-002 rejects unknown fields and invalid enums on all public provider inputs', () => {
    expect(agentRunRequestSchema.safeParse({ ...validRunRequest(), unknown: true }).success).toBe(
      false,
    );
    expect(
      resumeRunRequestSchema.safeParse({ ...validRunRequest(), sessionId: 'bad session id' })
        .success,
    ).toBe(false);
    expect(
      agentRunRequestSchema.safeParse({ ...validRunRequest(), executionMode: 'bypass_permissions' })
        .success,
    ).toBe(false);
    expect(
      agentRunRequestSchema.safeParse({
        ...validRunRequest(),
        environmentVariableNames: ['PATH', 'FAKE_TOKEN'],
      }).success,
    ).toBe(false);
    expect(
      normalizedAdapterEventSchema.safeParse({
        kind: 'event',
        event: {
          providerEventId: 'codex-event-1',
          diagnostics: validDiagnostics,
          type: 'run.output.delta',
          payload: { channel: 'stderr', text: 'Not an allowed channel.' },
        },
      }).success,
    ).toBe(false);
    expect(providerRefreshInputSchema.safeParse({ refresh: true }).success).toBe(false);
  });

  it('M2-CON-003 permits exactly eight ProviderHealth fields and rejects identity, token, and path data', () => {
    const health = validProviderHealth();
    expect(Object.keys(health)).toEqual([
      'provider',
      'installed',
      'cliVersion',
      'authenticated',
      'status',
      'supportedModels',
      'lastCheckedAt',
      'sanitizedError',
    ]);

    for (const forbidden of [
      { email: 'synthetic@example.invalid' },
      { organization: 'synthetic-organization' },
      { accountId: 'synthetic-account' },
      { token: 'sk-FAKE-SYNTHETIC-NOT-A-REAL-KEY' },
      { authFilePath: 'C:\\Synthetic\\auth.json' },
      { executablePath: 'C:\\Synthetic\\trusted\\codex.exe' },
      { environment: { PATH: 'not-allowed' } },
    ]) {
      expect(providerHealthSchema.safeParse({ ...health, ...forbidden }).success).toBe(false);
    }

    expect(
      providerHealthSchema.safeParse({ ...health, status: 'installed-and-ready' }).success,
    ).toBe(false);
    expect(
      providerHealthSchema.safeParse({ ...health, sanitizedError: 'Bearer FAKE-UNSANITIZED' })
        .success,
    ).toBe(false);
    expect(providerHealthCollectionSchema.safeParse({ providers: [health, health] }).success).toBe(
      false,
    );
  });

  it('M2-CON-004 requires a fully strict final RunResult including strict nested objects', () => {
    const result = validRunResult();
    expect(runResultSchema.parse(result).summary).toBe(result.summary);
    expect(runResultSchema.safeParse({ ...result, rawProviderOutput: 'forbidden' }).success).toBe(
      false,
    );
    expect(
      runResultSchema.safeParse({
        ...result,
        findings: [{ ...result.findings[0], rawDiagnostic: 'forbidden' }],
      }).success,
    ).toBe(false);
    expect(
      runResultSchema.safeParse({
        ...result,
        tests: [{ ...result.tests[0], status: 'unknown' }],
      }).success,
    ).toBe(false);
    expect(
      runResultSchema.safeParse({ ...result, changes: [{ files: [], description: '' }] }).success,
    ).toBe(false);
  });

  it('M2-CON-005 enforces wire sequence and sanitized diagnostic invariants', () => {
    const event = validRunEvent();
    expect(runEventSchema.safeParse({ ...event, sequence: 0 }).success).toBe(false);
    expect(
      runEventSchema.safeParse({
        ...event,
        diagnostics: { ...event.diagnostics, consecutiveInvalidFrameCount: 1 },
      }).success,
    ).toBe(false);
    expect(
      runEventSchema.safeParse({
        ...event,
        type: 'run.completed',
        payload: { status: 'succeeded', resultArtifactId: ids.artifact, durationMs: 20 },
      }).success,
    ).toBe(true);
    expect(
      runEventSchema.safeParse({
        ...event,
        type: 'run.completed',
        payload: { status: 'failed', resultArtifactId: ids.artifact, durationMs: 20 },
      }).success,
    ).toBe(false);
  });
});
