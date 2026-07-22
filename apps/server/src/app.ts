import type { DatabaseSync } from 'node:sqlite';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { ulid } from 'ulid';
import type { AgentRuntimeAdapter, Provider } from '@orion/contracts';

import { ClaudeAdapter } from './providers/claude-adapter.js';
import { CodexAdapter } from './providers/codex-adapter.js';
import {
  NativeProviderProcessPort,
  RuntimeOutputSchemaStore,
} from './providers/provider-process.js';
import { getErrorCode, ApplicationError } from './errors.js';
import { defaultTrustedGitExecutablePath } from './config.js';
import { registerHealthRoute } from './health.js';
import { IdempotencyService } from './idempotency.js';
import { ProviderHealthService } from './provider-health-service.js';
import { registerProviderRoutes } from './provider-routes.js';
import { ExecutionRepository } from './repositories/execution-repository.js';
import {
  InMemoryTaskEventBroker,
  registerTaskEventSse,
  type TaskEventBroker,
} from './task-event-sse.js';
import { ProjectPolicyService } from './project-policy.js';
import { ProjectRegistrationService } from './project-registration.js';
import { registerProjectRoutes } from './project-routes.js';
import { assertHost } from './request-security.js';
import { GitReadRunner } from './git-runner.js';
import { ProjectRepository } from './repositories/project-repository.js';
import { IdempotencyRepository } from './repositories/idempotency-repository.js';
import { ProviderPolicyConfirmationRepository } from './repositories/provider-policy-confirmation-repository.js';
import type { ResourceReader } from './resources.js';
import { SystemResourceReader } from './resources.js';
import { SessionManager } from './session.js';
import { registerStaticSpa } from './static-spa.js';

export interface TrustedProviderExecutables {
  readonly codexExecutable?: string;
  readonly claudeExecutable?: string;
}

export function createProductionProviderAdapters(
  runtimeDirectory: string,
  executables: TrustedProviderExecutables = {},
): ReadonlyMap<Provider, AgentRuntimeAdapter> {
  const adapters = new Map<Provider, AgentRuntimeAdapter>();
  const processPort = new NativeProviderProcessPort();
  const schemaStore = new RuntimeOutputSchemaStore(runtimeDirectory);
  const adapterOptions = (executable: string) => ({
    executable,
    processPort,
    schemaStore,
    projectRoot: runtimeDirectory,
    resolveExecutable: (trustedExecutable: string) => trustedExecutable,
  });

  if (executables.codexExecutable !== undefined)
    adapters.set('openai', new CodexAdapter(adapterOptions(executables.codexExecutable)));
  if (executables.claudeExecutable !== undefined)
    adapters.set('anthropic', new ClaudeAdapter(adapterOptions(executables.claudeExecutable)));
  return adapters;
}

export interface CreateApplicationOptions {
  readonly assetRoot: string;
  readonly runtimeDirectory: string;
  readonly gitExecutable?: string;
  readonly database?: DatabaseSync;
  readonly loopbackPort?: number;
  readonly bootstrapToken?: string;
  readonly logger?: FastifyBaseLogger;
  readonly resourceReader?: ResourceReader;
  readonly now?: () => Date;
  readonly requestId?: () => string;
  readonly providerAdapters?: ReadonlyMap<Provider, AgentRuntimeAdapter>;
  readonly trustedProviderExecutables?: TrustedProviderExecutables;
  readonly providerHealth?: ProviderHealthService;
  readonly taskEventBroker?: TaskEventBroker;
}

export async function createApplication(
  options: CreateApplicationOptions,
): Promise<FastifyInstance> {
  const app =
    options.logger === undefined
      ? Fastify({ logger: false })
      : Fastify({ loggerInstance: options.logger });
  const now = options.now ?? (() => new Date());
  const requestId = options.requestId ?? ulid;
  const providerAdapters =
    options.providerAdapters ??
    createProductionProviderAdapters(options.runtimeDirectory, options.trustedProviderExecutables);

  app.setErrorHandler((error, request, reply) => {
    const code = getErrorCode(error) ?? 'INTERNAL_ERROR';
    request.log.error({ code }, 'Request failed');
    if (options.database === undefined && code === 'HEALTH_RESOURCE_MEASUREMENT_FAILED') {
      return reply.code(503).send({ error: { code } });
    }
    const applicationError = error instanceof ApplicationError ? error : undefined;
    const knownCode = isRouteValidationError(error)
      ? 'VALIDATION_FAILED'
      : normalizeErrorCode(code);
    const statusCode =
      applicationError?.statusCode ??
      (knownCode === 'VALIDATION_FAILED'
        ? 422
        : knownCode === 'IDEMPOTENCY_REQUIRED'
          ? 400
          : code === 'HEALTH_RESOURCE_MEASUREMENT_FAILED'
            ? 503
            : 500);
    return reply.code(statusCode).send({
      error: {
        code: knownCode,
        message: applicationError?.message ?? 'The local request could not be completed.',
        ...(applicationError?.details === undefined ? {} : { details: applicationError.details }),
        retryable: applicationError?.retryable ?? false,
      },
      meta: { requestId: requestId(), timestamp: now().toISOString() },
    });
  });

  const healthRouteOptions = {
    resourceReader: options.resourceReader ?? new SystemResourceReader(),
    runtimeDirectory: options.runtimeDirectory,
    ...(options.database === undefined
      ? {}
      : { databaseStatus: () => databaseHealthy(options.database as DatabaseSync) }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
  };
  registerHealthRoute(app, healthRouteOptions);

  if (options.database !== undefined) {
    const port = options.loopbackPort ?? 4317;
    const security = {
      origin: `http://127.0.0.1:${port}`,
      host: `127.0.0.1:${port}`,
      sessions: new SessionManager(now, 60 * 60 * 1000, options.bootstrapToken),
    };
    app.addHook('onRequest', async (request, reply) => {
      assertHost(request, security);
      reply.header('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'");
      reply.header('X-Frame-Options', 'DENY');
      reply.header('Referrer-Policy', 'no-referrer');
    });
    app.post('/api/v1/session/bootstrap', async (request, reply) => {
      if (request.headers.origin !== security.origin)
        throw new ApplicationError('ORIGIN_REJECTED', 'The request origin is not allowed.', {
          statusCode: 403,
        });
      const token = request.headers['x-orion-bootstrap-token'];
      if (typeof token !== 'string')
        throw new ApplicationError('SESSION_REQUIRED', 'The bootstrap token is required.', {
          statusCode: 401,
        });
      const bootstrap = security.sessions.bootstrap(token);
      reply.header(
        'Set-Cookie',
        `orion_session=${bootstrap.cookie}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=3600`,
      );
      return reply.code(201).send({
        data: { csrfToken: bootstrap.session.csrfToken },
        meta: { requestId: requestId(), timestamp: now().toISOString() },
      });
    });
    const projects = new ProjectRepository(options.database, now);
    const execution = new ExecutionRepository(options.database, now);
    const broker = options.taskEventBroker ?? new InMemoryTaskEventBroker();
    const health = options.providerHealth ?? new ProviderHealthService(providerAdapters, now);
    registerProviderRoutes(app, {
      security,
      health,
      idempotency: new IdempotencyService(new IdempotencyRepository(options.database, now), now),
      now,
      requestId,
    });
    registerTaskEventSse(app, {
      security,
      execution,
      broker,
      now,
      requestId,
    });
    const confirmations = new ProviderPolicyConfirmationRepository(options.database, now);
    const registration = new ProjectRegistrationService(
      options.database,
      projects,
      confirmations,
      new ProjectPolicyService(),
      new GitReadRunner(
        options.gitExecutable ?? defaultTrustedGitExecutablePath(),
        options.runtimeDirectory,
      ),
      undefined,
      now,
    );
    registerProjectRoutes(app, {
      security,
      registration,
      projects,
      confirmations,
      idempotency: new IdempotencyService(new IdempotencyRepository(options.database, now), now),
      now,
      requestId,
    });
    app.decorate('orionBootstrapToken', security.sessions.takeBootstrapToken());
  }

  await registerStaticSpa(app, { assetRoot: options.assetRoot });
  return app;
}

function databaseHealthy(database: DatabaseSync): 'ok' | 'error' {
  try {
    database.prepare('SELECT 1').get();
    return 'ok';
  } catch {
    return 'error';
  }
}

function isRouteValidationError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  if (error instanceof Error && error.name === 'ZodError') return true;
  return 'validation' in error || ('code' in error && String(error.code).startsWith('FST_ERR_'));
}

function normalizeErrorCode(code: string): string {
  const known = new Set([
    'BAD_REQUEST',
    'SESSION_REQUIRED',
    'ORIGIN_REJECTED',
    'HOST_REJECTED',
    'CSRF_REJECTED',
    'IDEMPOTENCY_REQUIRED',
    'NOT_FOUND',
    'PERMISSION_DENIED',
    'VALIDATION_FAILED',
    'INVALID_STATE_TRANSITION',
    'IDEMPOTENCY_CONFLICT',
    'PROJECT_CONFLICT',
    'PROJECT_POLICY_CONFLICT',
    'REPOSITORY_MUTATED_DURING_REGISTRATION',
    'TASK_EXECUTION_CONFLICT',
    'WORKTREE_CONFLICT',
    'DATABASE_OPEN_FAILED',
    'DATABASE_CONFIGURATION_FAILED',
    'MIGRATION_FAILED',
    'DATABASE_UNAVAILABLE',
    'CONTROLLED_EXECUTION_BLOCKED',
    'PROVIDER_EXECUTABLE_INVALID',
    'PROVIDER_UNAVAILABLE',
    'PROVIDER_AUTH_REQUIRED',
    'PROVIDER_UNSUPPORTED',
    'PROVIDER_POLICY_REVIEW_REQUIRED',
    'PROVIDER_THROTTLED',
    'MODEL_UNAVAILABLE',
    'ADAPTER_PROTOCOL_ERROR',
    'OUTPUT_SCHEMA_INVALID',
    'PROCESS_CRASHED',
    'RUN_TIMED_OUT',
    'PROVIDER_EXECUTION_FAILED',
  ]);
  return known.has(code) ? code : 'INTERNAL_ERROR';
}
