import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { ulid } from 'ulid';

import { agentProfileSeedSkeletons } from '@orion/agent-catalog';
import { createDatabase, withImmediateTransaction } from '../src/database.js';
import { defaultTrustedGitExecutablePath } from '../src/config.js';
import { applyMigrations } from '../src/migrations.js';
import { ProjectRepository } from '../src/repositories/project-repository.js';
import { AgentProfileRepository } from '../src/repositories/agent-profile-repository.js';
import { ExecutionRepository } from '../src/repositories/execution-repository.js';
import { IdempotencyRepository } from '../src/repositories/idempotency-repository.js';
import { ApprovalRepository } from '../src/repositories/approval-repository.js';
import {
  ArcaRegistryRepository,
  type RegistryScope,
} from '../src/repositories/arca-registry-repository.js';
import {
  ArcaArchiveApprovalConsumer,
  archiveActionHash,
} from '../src/arca-archive-approval-consumer.js';
import { IdempotencyService } from '../src/idempotency.js';
import { ProjectPolicyService } from '../src/project-policy.js';
import { MetadataOnlyRegistryTransferService } from '../src/registry-transfer.js';
import { SessionManager, parseSessionCookie, secureSessionCookie } from '../src/session.js';
import { redactValue } from '../src/redaction.js';
import { createApplication } from '../src/app.js';
import { canonicalProjectPath } from '../src/windows-path-policy.js';
import { GitReadRunner } from '../src/git-runner.js';

const cleanup: string[] = [];
const handles: Array<{ close: () => void }> = [];
afterEach(() => {
  handles.splice(0).forEach((handle) => handle.close());
  cleanup.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});
const iso = '2026-07-21T00:00:00.000Z';
const later = '2026-07-21T00:01:00.000Z';
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'orion-m1-'));
  cleanup.push(directory);
  const handle = createDatabase(join(directory, 'orion.db'));
  handles.push(handle);
  applyMigrations(handle.database);
  return handle;
}
function commands() {
  return {
    read: [['git', 'status']] as string[][],
    verify: [['pnpm', 'test']] as string[][],
    localWrite: [['git', 'add']] as string[][],
  };
}
function project(id = ulid()) {
  return {
    id,
    projectKey: 'demo-project',
    name: 'Demo',
    repositoryPath: 'C:\\projects\\demo',
    defaultBranch: 'main',
    classification: 'internal' as const,
    providerPolicy: { openai: false, anthropic: false, allowFable: false },
    allowedAgentIds: ['atlas'],
    allowedCommands: commands(),
    createdAt: iso,
    updatedAt: iso,
    unregisteredAt: null,
  };
}
function scope(): RegistryScope {
  return {
    actor: 'test',
    roles: ['reader'],
    projectKeys: ['demo-project'],
    purpose: 'test',
    classificationAllowance: 'controlled',
    policyVersion: 'v1',
    allowedOperations: [
      'sourcecard-register',
      'sourcecard-update',
      'registry-search',
      'sourcerequest-create',
      'sourcerequest-resolve',
    ],
  };
}

describe('M1 database repositories', () => {
  it('M1-DB-001–010 applies forward migrations, constraints, and deterministic seeds', () => {
    const handle = setup();
    applyMigrations(handle.database);
    expect(
      handle.database.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get(),
    ).toMatchObject({ count: 3 });
    expect(
      handle.database
        .prepare('SELECT COUNT(*) AS count FROM agent_profiles WHERE enabled = 0')
        .get(),
    ).toMatchObject({ count: 18 });
    const projects = new ProjectRepository(handle.database, () => new Date(iso));
    projects.insert(project());
    expect(() =>
      handle.database
        .prepare("UPDATE projects SET project_key = 'other-key' WHERE project_key = 'demo-project'")
        .run(),
    ).toThrow(/IMMUTABLE_PROJECT_KEY/);
    expect(() =>
      handle.database
        .prepare(
          "INSERT INTO source_cards (source_id,title,project_id,connector_type,locator,owner,classification,version,checksum_algorithm,checksum,recorded_at,last_verified_at,status,metadata_version) VALUES (?, 'x', 'missing', 'local-folder', 'C:\\x', 'x','internal','1','sha256',?, ?,?,'active',1)",
        )
        .run(ulid(), 'a'.repeat(64), iso, iso),
    ).toThrow();
  });

  it('M1-STM-001 and M1-EVT-001 atomically guards transitions, event sequences, and snapshots', () => {
    const handle = setup();
    const db = handle.database;
    const projects = new ProjectRepository(db, () => new Date(iso));
    const p = project();
    projects.insert(p);
    const taskId = ulid();
    const stepId = ulid();
    const runId = ulid();
    const profiles = new AgentProfileRepository(db);
    const profile = profiles.find('atlas');
    expect(profile).toBeDefined();
    const execution = new ExecutionRepository(db, () => new Date(later));
    execution.createTask({
      id: taskId,
      projectId: p.id,
      title: 'T',
      objective: 'O',
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
        summary: 's',
        assumptions: [],
        risks: [],
        steps: [
          {
            id: stepId,
            title: 'S',
            agentId: 'atlas',
            dependsOn: [],
            executionMode: 'read_only',
            objective: 'o',
            inputRefs: [],
            expectedArtifacts: [],
            acceptanceCriteria: ['a'],
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
      title: 'S',
      agentId: 'atlas',
      dependsOn: [],
      executionMode: 'read_only',
      objective: 'o',
      inputRefs: [],
      expectedArtifacts: [],
      acceptanceCriteria: ['a'],
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
      model: profile!.model,
      agentProfileSnapshot: profile!,
      status: 'starting',
      sessionId: null,
      createdAt: iso,
      startedAt: null,
      completedAt: null,
    });
    const one = execution.transitionWithEvent({
      entity: 'task',
      id: taskId,
      to: 'planning',
      event: { type: 'task.status', payload: {} },
    });
    expect(one.taskSequence).toBe(1);
    const a = execution.appendRunEvent(runId, { type: 'run.started', payload: {} });
    const b = execution.appendRunEvent(runId, { type: 'run.output.delta', payload: { text: 'x' } });
    expect([a.runSequence, b.runSequence]).toEqual([1, 2]);
    expect(() =>
      db.prepare("UPDATE tasks SET status = 'succeeded' WHERE id = ?").run(taskId),
    ).toThrow(/INVALID_STATE_TRANSITION/);
    expect(() =>
      db.prepare("UPDATE runs SET profile_snapshot_json = '{}' WHERE id = ?").run(runId),
    ).toThrow(/IMMUTABLE_PROFILE_SNAPSHOT/);
    expect(() =>
      db.prepare("UPDATE events SET type = 'run.failed' WHERE id = ?").run(a.id),
    ).toThrow(/EVENTS_APPEND_ONLY/);
    expect(() =>
      withImmediateTransaction(db, () => {
        db.prepare("UPDATE task_steps SET status = 'ready' WHERE id = ?").run(stepId);
        throw new Error('rollback');
      }),
    ).toThrow('rollback');
    expect(db.prepare('SELECT status FROM task_steps WHERE id = ?').get(stepId)).toMatchObject({
      status: 'waiting',
    });
  });
  it('M1-STM-001–006 exhaustively rejects direct-SQL Step and Run illegal transitions', () => {
    const handle = setup();
    const db = handle.database;
    const projects = new ProjectRepository(db, () => new Date(iso));
    const registered = project();
    projects.insert(registered);
    const stepStatuses = [
      'waiting',
      'ready',
      'running',
      'retry_wait',
      'waiting_approval',
      'succeeded',
      'failed',
      'skipped',
      'cancelled',
      'interrupted',
    ];
    const runStatuses = [
      'starting',
      'running',
      'stalled',
      'succeeded',
      'failed',
      'timed_out',
      'cancelled',
      'interrupted',
    ];
    const allowedSteps: Record<string, readonly string[]> = {
      waiting: ['ready', 'skipped', 'cancelled'],
      ready: ['running', 'cancelled', 'skipped'],
      running: [
        'retry_wait',
        'waiting_approval',
        'succeeded',
        'failed',
        'cancelled',
        'interrupted',
      ],
      retry_wait: ['ready', 'failed', 'cancelled'],
      waiting_approval: ['ready', 'cancelled', 'failed'],
      interrupted: ['ready', 'failed', 'cancelled'],
      succeeded: [],
      failed: [],
      skipped: [],
      cancelled: [],
    };
    const allowedRuns: Record<string, readonly string[]> = {
      starting: ['running', 'failed', 'cancelled', 'interrupted'],
      running: ['stalled', 'succeeded', 'failed', 'timed_out', 'cancelled', 'interrupted'],
      stalled: ['running', 'succeeded', 'failed', 'timed_out', 'cancelled', 'interrupted'],
      succeeded: [],
      failed: [],
      timed_out: [],
      cancelled: [],
      interrupted: [],
    };
    const insertTaskAndStep = (status: string) => {
      const taskId = ulid();
      const stepId = ulid();
      db.prepare(
        `INSERT INTO tasks (id, project_id, title, objective, success_criteria_json, input_artifact_ids_json, max_duration_minutes, max_agent_runs, requested_agent_ids_json, status, created_at, updated_at, completed_at)
        VALUES (?, ?, 'task', 'objective', '[]', '[]', 1, 1, '[]', 'draft', ?, ?, NULL)`,
      ).run(taskId, registered.id, iso, iso);
      db.prepare(
        "INSERT INTO task_plans (task_id, version, plan_json, validation_json, created_at) VALUES (?, 1, '{}', '{}', ?)",
      ).run(taskId, iso);
      db.prepare(
        "INSERT INTO task_steps (id, task_id, plan_version, step_json, status, created_at, updated_at, completed_at) VALUES (?, ?, 1, '{}', ?, ?, ?, NULL)",
      ).run(stepId, taskId, status, iso, iso);
      return { stepId };
    };
    for (const from of stepStatuses) {
      const { stepId } = insertTaskAndStep(from);
      for (const to of stepStatuses.filter(
        (candidate) => candidate !== from && !allowedSteps[from].includes(candidate),
      )) {
        expect(() =>
          db.prepare('UPDATE task_steps SET status = ? WHERE id = ?').run(to, stepId),
        ).toThrow(/INVALID_STATE_TRANSITION/);
        expect(db.prepare('SELECT status FROM task_steps WHERE id = ?').get(stepId)).toMatchObject({
          status: from,
        });
      }
    }
    for (const from of runStatuses) {
      const { stepId } = insertTaskAndStep('waiting');
      const runId = ulid();
      db.prepare(
        `INSERT INTO runs (id, step_id, attempt, provider, model, profile_snapshot_json, profile_snapshot_sha256, status, session_id, created_at, started_at, completed_at)
        VALUES (?, ?, 1, 'openai', 'synthetic', '{}', ?, ?, NULL, ?, NULL, NULL)`,
      ).run(runId, stepId, 'a'.repeat(64), from, iso);
      for (const to of runStatuses.filter(
        (candidate) => candidate !== from && !allowedRuns[from].includes(candidate),
      )) {
        expect(() => db.prepare('UPDATE runs SET status = ? WHERE id = ?').run(to, runId)).toThrow(
          /INVALID_STATE_TRANSITION/,
        );
        expect(db.prepare('SELECT status FROM runs WHERE id = ?').get(runId)).toMatchObject({
          status: from,
        });
      }
    }
  });

  it('M1-PRJ-PATH-001–008 rejects unsafe paths and duplicate canonical registrations', () => {
    const handle = setup();
    const directory = mkdtempSync(join(tmpdir(), 'orion-m1-path-'));
    cleanup.push(directory);
    const link = join(directory, 'junction');
    symlinkSync(directory, link, 'junction');
    for (const candidate of [
      'relative\\repository',
      '..\\repository',
      '\\\\server\\share\\repository',
      '\\\\?\\C:\\repository',
      '\\\\.\\C:\\repository',
      'C:\\missing-orion-repository',
      'C:\\repo\\..\\repository',
      link,
    ]) {
      expect(() => canonicalProjectPath(candidate)).toThrow(/canonical local directory/i);
    }
    const canonical = canonicalProjectPath(directory);
    const projects = new ProjectRepository(handle.database, () => new Date(iso));
    projects.insert({ ...project(), repositoryPath: canonical });
    expect(() =>
      projects.insert({
        ...project(ulid()),
        projectKey: 'another-project',
        repositoryPath: canonical,
      }),
    ).toThrow(/already registered/i);
  });
  it('M1-IDEMP, M1-POL, and session utilities protect replay and privilege boundaries', async () => {
    const handle = setup();
    const records = new IdempotencyRepository(handle.database, () => new Date(iso));
    const service = new IdempotencyService(records, () => new Date(iso));
    let effects = 0;
    const first = await service.execute('scope', 'operation', 'key', { b: 2, a: 1 }, () => ({
      statusCode: 201,
      body: { ok: ++effects },
    }));
    const replay = await service.execute('scope', 'operation', 'key', { a: 1, b: 2 }, () => ({
      statusCode: 201,
      body: { ok: ++effects },
    }));
    expect([first.body, replay.body, effects]).toEqual([{ ok: 1 }, { ok: 1 }, 1]);
    await expect(
      service.execute('scope', 'operation', 'key', { a: 2 }, () => ({ statusCode: 200, body: {} })),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    const policy = new ProjectPolicyService();
    const fableProfile = {
      ...agentProfileSeedSkeletons[0],
      provider: 'anthropic' as const,
      model: 'claude-fable-5',
      fallbackModels: [{ provider: 'anthropic' as const, model: 'claude-safe-5' }],
    };
    expect(
      policy.effectiveModels(
        { providerPolicy: { openai: false, anthropic: true, allowFable: false } },
        fableProfile,
      ),
    ).toEqual([{ provider: 'anthropic', model: 'claude-safe-5' }]);
    expect(
      policy.effectiveModels(
        { providerPolicy: { openai: false, anthropic: true, allowFable: true } },
        fableProfile,
      ),
    ).toEqual([
      { provider: 'anthropic', model: 'claude-fable-5' },
      { provider: 'anthropic', model: 'claude-safe-5' },
    ]);
    expect(() =>
      policy.assertRegistrationPolicy(
        'confidential',
        { openai: false, anthropic: false, allowFable: false },
        ['atlas'],
      ),
    ).toThrow();
    expect(() => policy.assertCanPlanOrStart({ classification: 'controlled' })).toThrow();
    const sessions = new SessionManager(() => new Date(iso), 1000, 'bootstrap');
    const session = sessions.bootstrap('bootstrap');
    expect(parseSessionCookie(secureSessionCookie(session.cookie))).toBe(session.cookie);
    expect(() => sessions.bootstrap('bootstrap')).toThrow();
    expect(redactValue({ token: 'a', nested: 'Bearer abc' })).toEqual({
      token: '[REDACTED]',
      nested: '[REDACTED]',
    });
  });

  it('M1-IDEMP-001–005 replays concurrent duplicates from an independent connection and reclaims expiry', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orion-m1-idempotency-'));
    cleanup.push(directory);
    const databasePath = join(directory, 'orion.db');
    const firstHandle = createDatabase(databasePath);
    const secondHandle = createDatabase(databasePath);
    handles.push(firstHandle, secondHandle);
    applyMigrations(firstHandle.database);
    let currentTime = new Date(iso);
    const now = () => currentTime;
    const firstService = new IdempotencyService(
      new IdempotencyRepository(firstHandle.database, now),
      now,
      500,
      2,
    );
    const secondService = new IdempotencyService(
      new IdempotencyRepository(secondHandle.database, now),
      now,
      500,
      2,
    );
    let effects = 0;
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = firstService.execute('scope', 'create', 'same-key', { name: 'one' }, async () => {
      effects += 1;
      signalStarted();
      await blocked;
      return { statusCode: 201, body: { project: 'one' } };
    });
    await started;
    const duplicate = secondService.execute('scope', 'create', 'same-key', { name: 'one' }, () => {
      effects += 1;
      return { statusCode: 201, body: { project: 'two' } };
    });
    release();
    await expect(Promise.all([first, duplicate])).resolves.toEqual([
      { statusCode: 201, body: { project: 'one' } },
      { statusCode: 201, body: { project: 'one' } },
    ]);
    expect(effects).toBe(1);
    await expect(
      secondService.execute('scope', 'create', 'same-key', { name: 'different' }, () => ({
        statusCode: 201,
        body: {},
      })),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await firstService.execute('scope', 'expiry', 'expiry-key', {}, () => ({
      statusCode: 201,
      body: { version: 1 },
    }));
    currentTime = new Date(currentTime.getTime() + 24 * 60 * 60 * 1000 + 1);
    await expect(
      secondService.execute('scope', 'expiry', 'expiry-key', {}, () => ({
        statusCode: 201,
        body: { version: 2 },
      })),
    ).resolves.toEqual({ statusCode: 201, body: { version: 2 } });
  });
  it('M1-ARCA-001–014 preserves metadata-only registry behavior and approval consumption', async () => {
    const handle = setup();
    const db = handle.database;
    new ProjectRepository(db, () => new Date(iso)).insert(project());
    const registry = new ArcaRegistryRepository(db, () => new Date(iso));
    const card = registry.registerSource(
      {
        title: 'Source',
        tags: ['tag'],
        projectId: 'demo-project',
        connectorType: 'local-folder',
        locator: 'C:\\source',
        owner: 'owner',
        classification: 'internal',
        allowedRoles: ['reader'],
        version: '1',
        checksumAlgorithm: 'sha256',
        checksum: 'a'.repeat(64),
      },
      scope(),
    );
    const rawMarker = 'synthetic-raw-source-must-never-persist';
    expect(() =>
      registry.writeAudit({
        actor: 'test',
        action: 'source_registered',
        sourceId: card.sourceId,
        requestId: null,
        projectId: card.projectId,
        purpose: 'test',
        decision: 'allow',
        policyVersion: 'v1',
        connectorType: 'local-folder',
        timestamp: iso,
        rawContent: rawMarker,
      } as never),
    ).toThrow(/approved metadata/i);
    expect(
      JSON.stringify(
        db.prepare('SELECT metadata_json FROM registry_audit_log ORDER BY created_at').all(),
      ),
    ).not.toContain(rawMarker);
    expect(registry.searchVisible('Source', scope())).toHaveLength(1);
    expect(
      registry.findVisibleById(card.sourceId, { ...scope(), roles: ['none'] }),
    ).toBeUndefined();
    const request = registry.createRequest(
      {
        projectId: 'demo-project',
        requestedMaterial: 'm',
        criteria: null,
        acceptableFormats: [],
        expectedLocations: [],
        purpose: 'p',
        requesterRole: 'reader',
      },
      scope(),
    );
    expect(registry.resolveRequest(request.requestId, 1, card.sourceId, scope()).status).toBe(
      'resolved',
    );
    const command = {
      sourceId: card.sourceId,
      projectId: card.projectId,
      expectedMetadataVersion: card.metadataVersion,
      action: 'source_card.archive' as const,
      approvalId: ulid(),
    };
    const actionHash = archiveActionHash(command);
    new ApprovalRepository(db).insert({
      id: command.approvalId,
      action: command.action,
      sourceId: command.sourceId,
      projectKey: command.projectId,
      metadataVersion: command.expectedMetadataVersion,
      actionHash,
      status: 'approved',
      expiresAt: '2026-07-21T01:00:00.000Z',
      consumedAt: null,
    });
    new ArcaArchiveApprovalConsumer(db, registry, () => new Date(iso)).consume({
      ...command,
      actionHash,
    });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM registry_audit_log WHERE action = 'source_archived'",
        )
        .get(),
    ).toMatchObject({ count: 1 });
    expect(() =>
      new ArcaArchiveApprovalConsumer(db, registry, () => new Date(iso)).consume({
        ...command,
        actionHash,
      }),
    ).toThrow();
    let transferred = false;
    const transfer = new MetadataOnlyRegistryTransferService({
      transfer: async () => {
        transferred = true;
      },
    });
    await expect(
      transfer.transfer({
        sourceId: card.sourceId,
        projectId: card.projectId,
        title: card.title,
        summary: card.summary,
        classification: 'controlled',
      }),
    ).rejects.toMatchObject({ code: 'CONTROLLED_EXECUTION_BLOCKED' });
    expect(transferred).toBe(false);
  });
  it('M1-SEC and PRJ routes enforce loopback session controls and sanitized Git reads', async () => {
    const handle = setup();
    const repository = mkdtempSync(join(tmpdir(), 'orion-git-'));
    const assets = mkdtempSync(join(tmpdir(), 'orion-assets-'));
    cleanup.push(repository, assets);
    writeFileSync(join(repository, 'file.txt'), 'fixture');
    for (const argv of [
      ['init', '-b', 'main'],
      ['add', 'file.txt'],
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '-m',
        'fixture',
      ],
    ])
      expect(spawnSync('git', argv, { cwd: repository, shell: false }).status).toBe(0);
    expect(
      spawnSync('git', ['checkout', '-b', 'feature'], { cwd: repository, shell: false }).status,
    ).toBe(0);
    writeFileSync(join(assets, 'index.html'), '<!doctype html>');
    const canonical = canonicalProjectPath(repository);
    const runner = new GitReadRunner(
      defaultTrustedGitExecutablePath(),
      join(tmpdir(), 'orion-git-runtime'),
    );
    const indexBefore = readFileSync(resolvedFixtureIndex(repository));
    const snapshotBefore = runner.snapshot(canonical, 'main');
    const snapshotAfter = runner.snapshot(canonical, 'main');
    expect(snapshotAfter).toEqual(snapshotBefore);
    expect(readFileSync(resolvedFixtureIndex(repository))).toEqual(indexBefore);
    expect(() => canonicalProjectPath('..\\bad')).toThrow();
    const app = await createApplication({
      assetRoot: assets,
      runtimeDirectory: join(tmpdir(), 'orion-git-runtime'),
      database: handle.database,
      loopbackPort: 4317,
      bootstrapToken: 'bootstrap',
      now: () => new Date(iso),
      resourceReader: { read: async () => ({ memoryPercent: 1, freeDiskBytes: 1 }) },
    });
    const headers = { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317' };
    expect(
      (await app.inject({ method: 'POST', url: '/api/v1/projects', headers, payload: {} }))
        .statusCode,
    ).toBe(401);
    const boot = await app.inject({
      method: 'POST',
      url: '/api/v1/session/bootstrap',
      headers: { ...headers, 'x-orion-bootstrap-token': 'bootstrap' },
    });
    expect(boot.statusCode).toBe(201);
    const cookie = boot.headers['set-cookie'] as string;
    const csrf = boot.json().data.csrfToken as string;
    const mutation = { ...headers, cookie, 'x-csrf-token': csrf, 'idempotency-key': 'create-1' };
    const invalidProject = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { ...mutation, 'idempotency-key': 'invalid-project' },
      payload: {},
    });
    expect(invalidProject.statusCode).toBe(422);
    expect(invalidProject.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
    const missingIdempotency = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { ...headers, cookie, 'x-csrf-token': csrf },
      payload: {},
    });
    expect(missingIdempotency.statusCode).toBe(400);
    expect(missingIdempotency.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_REQUIRED' } });
    const hostRejected = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { ...mutation, host: 'localhost:4317' },
      payload: {},
    });
    expect(hostRejected.json()).toMatchObject({ error: { code: 'HOST_REJECTED' } });
    const originRejected = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { ...mutation, origin: 'http://localhost:4317' },
      payload: {},
    });
    expect(originRejected.json()).toMatchObject({ error: { code: 'ORIGIN_REJECTED' } });
    const csrfRejected = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { ...headers, cookie, 'x-csrf-token': 'wrong', 'idempotency-key': 'bad-csrf' },
      payload: {},
    });
    expect(csrfRejected.json()).toMatchObject({ error: { code: 'CSRF_REJECTED' } });
    const fablePolicy = { openai: false, anthropic: false, allowFable: true };
    const rejectedConfirmation = await app.inject({
      method: 'POST',
      url: '/api/v1/provider-policy/fable-confirmations',
      headers: { ...mutation, 'idempotency-key': 'fable-disabled' },
      payload: {
        scope: 'project-create',
        projectKey: 'route-project',
        proposedProviderPolicy: { ...fablePolicy, allowFable: false },
        warningStatementVersion: 'v1',
      },
    });
    expect(rejectedConfirmation).toMatchObject({
      statusCode: 422,
      json: expect.any(Function),
    });
    expect(rejectedConfirmation.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
    const fableConfirmationPayload = {
      scope: 'project-create' as const,
      projectKey: 'route-project',
      proposedProviderPolicy: fablePolicy,
      warningStatementVersion: 'v1',
    };
    const fableConfirmation = await app.inject({
      method: 'POST',
      url: '/api/v1/provider-policy/fable-confirmations',
      headers: { ...mutation, 'idempotency-key': 'fable-confirmation-1' },
      payload: fableConfirmationPayload,
    });
    expect(fableConfirmation.statusCode).toBe(201);
    const confirmation = fableConfirmation.json().data as {
      confirmationId: string;
      expiresAt: string;
      warningStatementVersion: string;
    };
    expect(confirmation).toMatchObject({
      expiresAt: '2026-07-21T00:05:00.000Z',
      warningStatementVersion: 'v1',
    });
    const fableReplay = await app.inject({
      method: 'POST',
      url: '/api/v1/provider-policy/fable-confirmations',
      headers: { ...mutation, 'idempotency-key': 'fable-confirmation-1' },
      payload: fableConfirmationPayload,
    });
    expect(fableReplay.statusCode).toBe(201);
    expect(fableReplay.json().data).toEqual(confirmation);
    const body = {
      projectKey: 'route-project',
      name: 'Route',
      repositoryPath: canonical,
      defaultBranch: 'main',
      classification: 'internal',
      providerPolicy: fablePolicy,
      fableWarningConfirmationId: confirmation.confirmationId,
      allowedAgentIds: ['atlas'],
      allowedCommands: commands(),
    };
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: mutation,
      payload: body,
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().data.git).toEqual(
      expect.objectContaining({
        defaultBranch: 'main',
        currentBranch: 'feature',
        dirty: false,
      }),
    );
    expect(created.json().data.git).not.toHaveProperty('branch');
    const id = created.json().data.project.id as string;
    const missingDefaultBranch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${id}`,
      headers: { ...mutation, 'idempotency-key': 'patch-missing-default' },
      payload: { defaultBranch: 'missing-default' },
    });
    expect(missingDefaultBranch.statusCode).toBe(422);
    expect(missingDefaultBranch.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
    runGit(repository, ['checkout', '--detach', 'HEAD']);
    const detachedStatus = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${id}`,
      headers: { host: headers.host, cookie },
    });
    expect(detachedStatus.statusCode).toBe(200);
    expect(detachedStatus.json().data.git).toMatchObject({
      defaultBranch: 'main',
      currentBranch: null,
      dirty: false,
    });
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/projects',
          headers: { host: headers.host, cookie },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/v1/projects/${id}`,
          headers: { ...mutation, 'idempotency-key': 'patch-1' },
          payload: { name: 'Updated' },
        })
      ).statusCode,
    ).toBe(200);
    const taskId = ulid();
    handle.database
      .prepare(
        `INSERT INTO tasks (
          id, project_id, title, objective, success_criteria_json, input_artifact_ids_json,
          max_duration_minutes, max_agent_runs, requested_agent_ids_json, status, created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        taskId,
        id,
        'Block',
        'Block deletion',
        '[]',
        '[]',
        1,
        1,
        '["atlas"]',
        'running',
        iso,
        iso,
        null,
      );
    const taskConflict = await app.inject({
      method: 'DELETE',
      url: `/api/v1/projects/${id}`,
      headers: { ...mutation, 'idempotency-key': 'delete-task-conflict' },
      payload: {},
    });
    expect(taskConflict.statusCode).toBe(409);
    expect(taskConflict.json()).toMatchObject({
      error: {
        code: 'TASK_EXECUTION_CONFLICT',
        retryable: false,
        details: { projectId: id, tasks: [{ id: taskId, status: 'running' }] },
      },
    });
    expect(
      new ProjectRepository(handle.database, () => new Date(iso)).findActiveById(id),
    ).toBeDefined();
    handle.database.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
    const worktreeId = ulid();
    handle.database
      .prepare(
        `INSERT INTO git_worktrees (
          id, project_id, task_id, run_id, path, branch, base_sha, status, created_at
        ) VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?)`,
      )
      .run(
        worktreeId,
        id,
        join(repository, 'orion-worktree'),
        'orion/fixture',
        'a'.repeat(40),
        'preserved',
        iso,
      );
    const worktreeConflict = await app.inject({
      method: 'DELETE',
      url: `/api/v1/projects/${id}`,
      headers: { ...mutation, 'idempotency-key': 'delete-worktree-conflict' },
      payload: {},
    });
    expect(worktreeConflict.statusCode).toBe(409);
    expect(worktreeConflict.json()).toMatchObject({
      error: {
        code: 'WORKTREE_CONFLICT',
        retryable: false,
        details: {
          projectId: id,
          worktrees: [{ id: worktreeId, status: 'preserved', branch: 'orion/fixture' }],
        },
      },
    });
    handle.database.prepare('DELETE FROM git_worktrees WHERE id = ?').run(worktreeId);
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/v1/projects/${id}`,
      headers: { ...mutation, 'idempotency-key': 'delete-1' },
      payload: {},
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().data.project).toMatchObject({ id, unregisteredAt: iso });
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/health', headers: { host: headers.host } }))
        .statusCode,
    ).toBe(200);
    await app.close();
  }, 20_000);
  it('M1-BENCH-001 reports deterministic synthetic local-operation and event-persistence p95 evidence', async () => {
    const handle = setup();
    const db = handle.database;
    const projects = new ProjectRepository(db, () => new Date(iso));
    const registered = project();
    projects.insert(registered);
    const assets = mkdtempSync(join(tmpdir(), 'orion-m1-benchmark-assets-'));
    cleanup.push(assets);
    writeFileSync(join(assets, 'index.html'), '<!doctype html>');
    const app = await createApplication({
      assetRoot: assets,
      runtimeDirectory: join(tmpdir(), 'orion-m1-benchmark-runtime'),
      database: db,
      loopbackPort: 4317,
      resourceReader: { read: async () => ({ memoryPercent: 1, freeDiskBytes: 1 }) },
    });
    const registry = new ArcaRegistryRepository(db, () => new Date(iso));
    registry.registerSource(
      {
        title: 'Benchmark Source',
        tags: ['benchmark'],
        projectId: registered.projectKey,
        connectorType: 'local-folder',
        locator: 'C:\\benchmark-source',
        owner: 'fixture',
        classification: 'internal',
        allowedRoles: ['reader'],
        version: '1',
        checksumAlgorithm: 'sha256',
        checksum: 'b'.repeat(64),
      },
      scope(),
    );
    const taskId = ulid();
    const stepId = ulid();
    const runId = ulid();
    db.prepare(
      `INSERT INTO tasks (id, project_id, title, objective, success_criteria_json, input_artifact_ids_json, max_duration_minutes, max_agent_runs, requested_agent_ids_json, status, created_at, updated_at, completed_at)
      VALUES (?, ?, 'benchmark', 'benchmark', '[]', '[]', 1, 1, '[]', 'draft', ?, ?, NULL)`,
    ).run(taskId, registered.id, iso, iso);
    db.prepare(
      "INSERT INTO task_plans (task_id, version, plan_json, validation_json, created_at) VALUES (?, 1, '{}', '{}', ?)",
    ).run(taskId, iso);
    db.prepare(
      "INSERT INTO task_steps (id, task_id, plan_version, step_json, status, created_at, updated_at, completed_at) VALUES (?, ?, 1, '{}', 'waiting', ?, ?, NULL)",
    ).run(stepId, taskId, iso, iso);
    db.prepare(
      `INSERT INTO runs (id, step_id, attempt, provider, model, profile_snapshot_json, profile_snapshot_sha256, status, session_id, created_at, started_at, completed_at)
      VALUES (?, ?, 1, 'openai', 'synthetic', '{}', ?, 'starting', NULL, ?, NULL, NULL)`,
    ).run(runId, stepId, 'c'.repeat(64), iso);
    const execution = new ExecutionRepository(db, () => new Date(iso));
    const sampleSize = 64;
    const localOperationSamples: number[] = [];
    for (let sample = 0; sample < sampleSize; sample += 1) {
      localOperationSamples.push(
        await measureAsyncMilliseconds(async () => {
          expect(
            (
              await app.inject({
                method: 'GET',
                url: '/api/v1/health',
                headers: { host: '127.0.0.1:4317' },
              })
            ).statusCode,
          ).toBe(200);
          projects.listActive(50);
          registry.searchVisible('Benchmark', scope());
        }),
      );
    }
    const eventPersistenceSamples = Array.from({ length: sampleSize }, () =>
      measureMilliseconds(() => {
        execution.appendRunEvent(runId, { type: 'run.output.delta', payload: {} });
      }),
    );
    const report = {
      fixture: 'synthetic local SQLite only',
      sampleSize,
      exclusions: 'startup, migrations, filesystem, network, provider, and browser time',
      localOperationsP95Milliseconds: percentile95(localOperationSamples),
      eventPersistenceP95Milliseconds: percentile95(eventPersistenceSamples),
    };
    console.info(`M1-BENCH-001 ${JSON.stringify(report)}`);
    await app.close();
    expect(report.localOperationsP95Milliseconds).toBeLessThanOrEqual(300);
    expect(report.eventPersistenceP95Milliseconds).toBeLessThanOrEqual(100);
  });
  it('AUD-M1-001 and AUD-M1-002 validate primary and linked worktrees without Git mutation', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'orion-git-correction-'));
    const primary = join(fixtureRoot, 'primary');
    const linked = join(fixtureRoot, 'linked');
    cleanup.push(fixtureRoot);
    mkdirSync(primary);
    writeFileSync(join(primary, 'tracked.txt'), 'tracked');

    for (const argv of [
      ['init', '-b', 'main'],
      ['add', 'tracked.txt'],
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '-m',
        'fixture',
      ],
      ['checkout', '-b', 'feature'],
    ])
      runGit(primary, argv);
    runGit(primary, ['worktree', 'add', '-b', 'linked', linked, 'main']);
    writeFileSync(join(linked, 'dirty.txt'), 'dirty');

    const runner = new GitReadRunner(
      defaultTrustedGitExecutablePath(),
      join(tmpdir(), 'orion-git-correction-runtime'),
    );
    const primaryPath = canonicalProjectPath(primary);
    const linkedPath = canonicalProjectPath(linked);
    const primaryBefore = gitFixtureEvidence(primary, runner);
    const linkedBefore = gitFixtureEvidence(linked, runner);
    const linkedPointerBefore = readFileSync(join(linked, '.git'));

    expect(primaryBefore.snapshot).toMatchObject({
      defaultBranch: 'main',
      currentBranch: 'feature',
      dirty: false,
    });
    expect(linkedBefore.snapshot).toMatchObject({
      defaultBranch: 'main',
      currentBranch: 'linked',
      dirty: true,
    });
    expect(runner.validate(linkedPath, 'main')).toMatchObject({
      defaultBranch: 'main',
      currentBranch: 'linked',
      dirty: true,
    });
    expect(() => runner.validate(primaryPath, 'missing-default')).toThrow(
      expect.objectContaining({ code: 'VALIDATION_FAILED', statusCode: 422 }),
    );

    expect(() => canonicalProjectPath('\\\\server\\share\\repository')).toThrow();
    expect(() => canonicalProjectPath('\\\\?\\C:\\device')).toThrow();
    expect(() => canonicalProjectPath('\\\\.\\PhysicalDrive0')).toThrow();
    const junction = join(fixtureRoot, 'primary-junction');
    symlinkSync(primary, junction, 'junction');
    expect(() => canonicalProjectPath(junction)).toThrow();

    const primaryAfter = gitFixtureEvidence(primary, runner);
    const linkedAfter = gitFixtureEvidence(linked, runner);
    expect(primaryAfter).toEqual(primaryBefore);
    expect(linkedAfter).toEqual(linkedBefore);
    expect(readFileSync(join(linked, '.git'))).toEqual(linkedPointerBefore);

    runGit(primary, ['checkout', '--detach', 'HEAD']);
    const detachedBefore = gitFixtureEvidence(primary, runner);
    expect(runner.validate(primaryPath, 'main')).toMatchObject({
      defaultBranch: 'main',
      currentBranch: null,
      headSha: detachedBefore.snapshot.headSha,
      dirty: false,
    });
    expect(gitFixtureEvidence(primary, runner)).toEqual(detachedBefore);
  }, 20_000);
});
async function measureAsyncMilliseconds(operation: () => Promise<void>): Promise<number> {
  const started = performance.now();
  await operation();
  return performance.now() - started;
}
function measureMilliseconds(operation: () => void): number {
  const started = performance.now();
  operation();
  return performance.now() - started;
}

function percentile95(samples: readonly number[]): number {
  const ordered = [...samples].sort((left, right) => left - right);
  return ordered[Math.ceil(ordered.length * 0.95) - 1] ?? 0;
}
function runGit(root: string, argv: readonly string[]): void {
  expect(spawnSync('git', argv, { cwd: root, shell: false }).status).toBe(0);
}

function gitFixtureEvidence(root: string, runner: GitReadRunner) {
  return {
    snapshot: runner.snapshot(canonicalProjectPath(root), 'main'),
    indexBytes: readFileSync(resolvedFixtureIndex(root)),
  };
}

function resolvedFixtureIndex(root: string): string {
  const result = spawnSync('git', ['--no-optional-locks', 'rev-parse', '--git-path', 'index'], {
    cwd: root,
    encoding: 'utf8',
    shell: false,
  });
  expect(result.status).toBe(0);
  const output = result.stdout.endsWith('\r\n')
    ? result.stdout.slice(0, -2)
    : result.stdout.endsWith('\n')
      ? result.stdout.slice(0, -1)
      : result.stdout;
  return isAbsolute(output) ? output : resolve(root, output);
}
