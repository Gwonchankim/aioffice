import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import {
  fableConfirmationInputSchema,
  projectDeleteInputSchema,
  projectIdParamsSchema,
  projectListQuerySchema,
  projectRegistrationInputSchema,
  projectUpdateInputSchema,
  type Project,
} from '@orion/contracts';

import { ApplicationError } from './errors.js';
import type { IdempotencyService } from './idempotency.js';
import { providerPolicyHash } from './project-policy.js';
import type { ProjectRegistrationService } from './project-registration.js';
import type { ProjectRepository } from './repositories/project-repository.js';
import type { ProviderPolicyConfirmationRepository } from './repositories/provider-policy-confirmation-repository.js';
import {
  type RequestSecurityOptions,
  idempotencyKey,
  requireMutationSession,
} from './request-security.js';
import { parseSessionCookie } from './session.js';

export interface ProjectRouteDependencies {
  readonly security: RequestSecurityOptions;
  readonly registration: ProjectRegistrationService;
  readonly projects: ProjectRepository;
  readonly confirmations: ProviderPolicyConfirmationRepository;
  readonly idempotency: IdempotencyService;
  readonly now?: () => Date;
  readonly requestId?: () => string;
}

export function registerProjectRoutes(
  app: FastifyInstance,
  dependencies: ProjectRouteDependencies,
): void {
  const now = dependencies.now ?? (() => new Date());
  const requestId = dependencies.requestId ?? ulid;
  const meta = () => ({ requestId: requestId(), timestamp: now().toISOString() });
  const requireReadSession = (request: FastifyRequest) =>
    dependencies.security.sessions.require(parseSessionCookie(request.headers.cookie));

  app.get('/api/v1/projects', async (request) => {
    requireReadSession(request);
    const query = projectListQuerySchema.parse(request.query);
    return {
      data: { items: dependencies.projects.listActive(query.limit, query.cursor) },
      meta: meta(),
    };
  });

  app.get('/api/v1/projects/:id', async (request) => {
    requireReadSession(request);
    const params = projectIdParamsSchema.parse(request.params);
    return { data: dependencies.registration.status(params.id), meta: meta() };
  });

  app.post('/api/v1/provider-policy/fable-confirmations', async (request, reply) => {
    const session = requireMutationSession(request, dependencies.security);
    const body = fableConfirmationInputSchema.parse(request.body);
    if (!body.proposedProviderPolicy.allowFable)
      throw new ApplicationError(
        'VALIDATION_FAILED',
        'Fable confirmations only acknowledge Fable-enabled policies.',
        { statusCode: 422 },
      );
    const result = await dependencies.idempotency.execute(
      session.scopeHash,
      'fable-confirmation',
      idempotencyKey(request),
      body,
      () => {
        const expiresAt = new Date(now().getTime() + 5 * 60 * 1000).toISOString();
        const confirmation = dependencies.confirmations.create({
          sessionScopeHash: session.scopeHash,
          scope: body.scope,
          projectKey: body.scope === 'project-create' ? body.projectKey : null,
          projectId: body.scope === 'project-update' ? body.projectId : null,
          policyHash: providerPolicyHash(body.proposedProviderPolicy),
          warningStatementVersion: body.warningStatementVersion,
          expiresAt,
        });
        return {
          statusCode: 201,
          body: {
            data: {
              confirmationId: confirmation.id,
              expiresAt,
              warningStatementVersion: confirmation.warningStatementVersion,
            },
            meta: meta(),
          },
        };
      },
    );
    return reply.code(result.statusCode).send(result.body);
  });

  app.post('/api/v1/projects', async (request, reply) => {
    const session = requireMutationSession(request, dependencies.security);
    const body = projectRegistrationInputSchema.parse(request.body);
    const result = await dependencies.idempotency.execute(
      session.scopeHash,
      'projects.create',
      idempotencyKey(request),
      body,
      () => ({
        statusCode: 201,
        body: { data: dependencies.registration.register(body, session.scopeHash), meta: meta() },
      }),
    );
    return reply.code(result.statusCode).send(result.body);
  });

  app.patch('/api/v1/projects/:id', async (request, reply) => {
    const session = requireMutationSession(request, dependencies.security);
    const params = projectIdParamsSchema.parse(request.params);
    const body = projectUpdateInputSchema.parse(request.body);
    const result = await dependencies.idempotency.execute(
      session.scopeHash,
      `projects.update:${params.id}`,
      idempotencyKey(request),
      body,
      () => ({
        statusCode: 200,
        body: {
          data: dependencies.registration.update(params.id, body, session.scopeHash),
          meta: meta(),
        },
      }),
    );
    return reply.code(result.statusCode).send(result.body);
  });

  app.delete('/api/v1/projects/:id', async (request, reply) => {
    const session = requireMutationSession(request, dependencies.security);
    const params = projectIdParamsSchema.parse(request.params);
    const body = projectDeleteInputSchema.parse(request.body ?? {});
    const result = await dependencies.idempotency.execute(
      session.scopeHash,
      `projects.delete:${params.id}`,
      idempotencyKey(request),
      body,
      () => {
        const outcome = dependencies.registration.unregister(params.id);
        if (outcome.tasks.length > 0) {
          return {
            statusCode: 409,
            body: error(
              'TASK_EXECUTION_CONFLICT',
              'Project execution is active.',
              { projectId: params.id, tasks: outcome.tasks },
              meta(),
            ),
          };
        }
        if (outcome.worktrees.length > 0) {
          return {
            statusCode: 409,
            body: error(
              'WORKTREE_CONFLICT',
              'Project worktrees are retained.',
              { projectId: params.id, worktrees: outcome.worktrees },
              meta(),
            ),
          };
        }
        return { statusCode: 200, body: { data: { project: outcome.project }, meta: meta() } };
      },
    );
    return reply.code(result.statusCode).send(result.body);
  });
}

function error(
  code: 'TASK_EXECUTION_CONFLICT' | 'WORKTREE_CONFLICT',
  message: string,
  details: unknown,
  meta: { requestId: string; timestamp: string },
) {
  return { error: { code, message, details, retryable: false }, meta };
}
export function hashSessionScope(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
export type DeleteProjectResponse = { readonly project: Project };
