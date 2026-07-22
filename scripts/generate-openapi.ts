import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  extendZodWithOpenApi,
  OpenApiGeneratorV3,
  OpenAPIRegistry,
  type ResponseConfig,
  type RouteConfig,
} from '@asteasolutions/zod-to-openapi';
import {
  errorEnvelopeSchema,
  fableConfirmationSuccessSchema,
  healthSuccessSchema,
  projectDeleteSuccessSchema,
  projectListSuccessSchema,
  projectRouteRegistry,
  projectWithGitStatusSuccessSchema,
  providerHealthCollectionSuccessSchema,
  providerRouteRegistry,
  runStatusSchema,
  successEnvelopeSchema,
  taskStatusSchema,
  ulidSchema,
} from '@orion/contracts';
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(
  scriptDirectory,
  basename(scriptDirectory) === 'dist' ? '../..' : '..',
);
const contractZod = await import(
  pathToFileURL(resolve(workspaceRoot, 'packages/contracts/node_modules/zod/index.js')).href
);
extendZodWithOpenApi(contractZod as never);

export const openApiOutputPath = resolve(workspaceRoot, 'openapi/orion-local-m1.openapi.json');

export const exposedApiOperations = [
  { method: 'GET', path: '/api/v1/health', operationId: 'getHealth' },
  { method: 'POST', path: '/api/v1/session/bootstrap', operationId: 'bootstrapSession' },
  {
    method: projectRouteRegistry.fableConfirmations.method,
    path: projectRouteRegistry.fableConfirmations.path,
    operationId: 'createFableConfirmation',
  },
  {
    method: projectRouteRegistry.listProjects.method,
    path: projectRouteRegistry.listProjects.path,
    operationId: 'listProjects',
  },
  {
    method: projectRouteRegistry.createProject.method,
    path: projectRouteRegistry.createProject.path,
    operationId: 'createProject',
  },
  {
    method: projectRouteRegistry.getProject.method,
    path: projectRouteRegistry.getProject.path,
    operationId: 'getProject',
  },
  {
    method: projectRouteRegistry.updateProject.method,
    path: projectRouteRegistry.updateProject.path,
    operationId: 'updateProject',
  },
  {
    method: projectRouteRegistry.deleteProject.method,
    path: projectRouteRegistry.deleteProject.path,
    operationId: 'deleteProject',
  },
  {
    method: providerRouteRegistry.listProviders.method,
    path: providerRouteRegistry.listProviders.path,
    operationId: 'listProviders',
  },
  {
    method: providerRouteRegistry.refreshProviders.method,
    path: providerRouteRegistry.refreshProviders.path,
    operationId: 'refreshProviders',
  },
  {
    method: 'GET',
    path: '/api/v1/tasks/{id}/events',
    operationId: 'streamTaskEvents',
  },
  {
    method: 'GET',
    path: '/api/v1/tasks/{id}/events/snapshot',
    operationId: 'getTaskEventSnapshot',
  },
] as const;

function jsonResponse(schema: unknown, description: string): ResponseConfig {
  return {
    description,
    content: { 'application/json': { schema: schema as never } },
  };
}

function headers(...names: string[]) {
  return names.map((name) => ({
    name,
    in: 'header' as const,
    required: true,
    schema: { type: 'string' as const, minLength: 1 },
  }));
}

function optionalHeader(name: string, schema: Record<string, unknown>) {
  return [{ name, in: 'header' as const, required: false, schema }];
}

function streamResponse(description: string): ResponseConfig {
  return {
    description,
    content: {
      'text/event-stream': {
        schema: { type: 'string', format: 'event-stream' },
      },
    },
  };
}

function responseSchemas(
  responseRegistry: Readonly<Record<number, unknown>>,
  success: unknown,
  error: unknown,
): Record<string, ResponseConfig> {
  return Object.fromEntries(
    Object.keys(responseRegistry).map((status) => [
      status,
      jsonResponse(status.startsWith('2') ? success : error, `HTTP ${status} response.`),
    ]),
  );
}

function routes(registry: OpenAPIRegistry): RouteConfig[] {
  const healthSuccess = registry.register('HealthSuccess', healthSuccessSchema);
  const error = registry.register('ErrorEnvelope', errorEnvelopeSchema);
  const fableConfirmationSuccess = registry.register(
    'FableConfirmationSuccess',
    fableConfirmationSuccessSchema,
  );
  const projectListSuccess = registry.register('ProjectListSuccess', projectListSuccessSchema);
  const projectWithGitStatusSuccess = registry.register(
    'ProjectWithGitStatusSuccess',
    projectWithGitStatusSuccessSchema,
  );
  const projectDeleteSuccess = registry.register(
    'ProjectDeleteSuccess',
    projectDeleteSuccessSchema,
  );
  const bootstrapSuccess = registry.registerComponent('schemas', 'BootstrapSessionSuccess', {
    type: 'object',
    additionalProperties: false,
    required: ['data', 'meta'],
    properties: {
      data: {
        type: 'object',
        additionalProperties: false,
        required: ['csrfToken'],
        properties: { csrfToken: { type: 'string', minLength: 1 } },
      },
      meta: {
        type: 'object',
        additionalProperties: false,
        required: ['requestId', 'timestamp'],
        properties: {
          requestId: { type: 'string' },
          timestamp: { type: 'string', format: 'date-time' },
        },
      },
    },
  });
  const providerHealthCollectionSuccess = registry.register(
    'ProviderHealthCollectionSuccess',
    providerHealthCollectionSuccessSchema,
  );
  const taskEventSnapshotSuccess = registry.register(
    'TaskEventSnapshotSuccess',
    successEnvelopeSchema(
      contractZod
        .object({
          taskId: ulidSchema,
          status: taskStatusSchema,
          highWaterSequence: contractZod.number().int().nonnegative(),
          runs: contractZod.array(
            contractZod
              .object({
                id: ulidSchema,
                status: runStatusSchema,
                provider: contractZod.enum(['openai', 'anthropic']),
                model: contractZod.string().min(1).max(128),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
  );

  return [
    {
      method: 'get',
      path: '/api/v1/health',
      operationId: 'getHealth',
      responses: {
        200: jsonResponse(healthSuccess, 'Initialized local health status.'),
        500: jsonResponse(error, 'Unexpected local failure.'),
      },
    },
    {
      method: 'post',
      path: '/api/v1/session/bootstrap',
      operationId: 'bootstrapSession',
      parameters: headers('origin', 'x-orion-bootstrap-token'),
      responses: {
        201: jsonResponse(bootstrapSuccess, 'Session established.'),
        401: jsonResponse(error, 'Bootstrap token rejected.'),
        403: jsonResponse(error, 'Origin rejected.'),
      },
    },
    {
      method: 'get',
      path: providerRouteRegistry.listProviders.path,
      operationId: 'listProviders',
      parameters: headers('cookie'),
      responses: responseSchemas(
        providerRouteRegistry.listProviders.responses,
        providerHealthCollectionSuccess,
        error,
      ),
    },
    {
      method: 'post',
      path: providerRouteRegistry.refreshProviders.path,
      operationId: 'refreshProviders',
      parameters: headers('cookie', 'origin', 'x-csrf-token', 'idempotency-key'),
      request: {
        body: {
          content: { 'application/json': { schema: providerRouteRegistry.refreshProviders.body } },
        },
      },
      responses: responseSchemas(
        providerRouteRegistry.refreshProviders.responses,
        providerHealthCollectionSuccess,
        error,
      ),
    },
    {
      method: 'get',
      path: '/api/v1/tasks/{id}/events',
      operationId: 'streamTaskEvents',
      parameters: [
        ...headers('cookie'),
        ...optionalHeader('last-event-id', {
          type: 'string',
          pattern: '^[1-9][0-9]*$',
        }),
      ],
      request: { params: contractZod.object({ id: ulidSchema }).strict() },
      responses: {
        200: streamResponse('Authenticated task event replay and live stream.'),
        401: jsonResponse(error, 'Session required.'),
        404: jsonResponse(error, 'Task not found.'),
        422: jsonResponse(error, 'Invalid task identifier.'),
      },
    },
    {
      method: 'get',
      path: '/api/v1/tasks/{id}/events/snapshot',
      operationId: 'getTaskEventSnapshot',
      parameters: headers('cookie'),
      request: { params: contractZod.object({ id: ulidSchema }).strict() },
      responses: {
        200: jsonResponse(taskEventSnapshotSuccess, 'Authenticated task event reset snapshot.'),
        401: jsonResponse(error, 'Session required.'),
        404: jsonResponse(error, 'Task not found.'),
        422: jsonResponse(error, 'Invalid task identifier.'),
      },
    },
    {
      method: 'post',
      path: projectRouteRegistry.fableConfirmations.path,
      operationId: 'createFableConfirmation',
      parameters: headers('cookie', 'origin', 'x-csrf-token', 'idempotency-key'),
      request: {
        body: {
          content: { 'application/json': { schema: projectRouteRegistry.fableConfirmations.body } },
        },
      },
      responses: responseSchemas(
        projectRouteRegistry.fableConfirmations.responses,
        fableConfirmationSuccess,
        error,
      ),
    },
    {
      method: 'get',
      path: projectRouteRegistry.listProjects.path,
      operationId: 'listProjects',
      parameters: headers('cookie'),
      request: { query: projectRouteRegistry.listProjects.query },
      responses: responseSchemas(
        projectRouteRegistry.listProjects.responses,
        projectListSuccess,
        error,
      ),
    },
    {
      method: 'post',
      path: projectRouteRegistry.createProject.path,
      operationId: 'createProject',
      parameters: headers('cookie', 'origin', 'x-csrf-token', 'idempotency-key'),
      request: {
        body: {
          content: { 'application/json': { schema: projectRouteRegistry.createProject.body } },
        },
      },
      responses: responseSchemas(
        projectRouteRegistry.createProject.responses,
        projectWithGitStatusSuccess,
        error,
      ),
    },
    {
      method: 'get',
      path: projectRouteRegistry.getProject.path,
      operationId: 'getProject',
      parameters: headers('cookie'),
      request: { params: projectRouteRegistry.getProject.params },
      responses: responseSchemas(
        projectRouteRegistry.getProject.responses,
        projectWithGitStatusSuccess,
        error,
      ),
    },
    {
      method: 'patch',
      path: projectRouteRegistry.updateProject.path,
      operationId: 'updateProject',
      parameters: headers('cookie', 'origin', 'x-csrf-token', 'idempotency-key'),
      request: {
        params: projectRouteRegistry.updateProject.params,
        body: {
          content: { 'application/json': { schema: projectRouteRegistry.updateProject.body } },
        },
      },
      responses: responseSchemas(
        projectRouteRegistry.updateProject.responses,
        projectWithGitStatusSuccess,
        error,
      ),
    },
    {
      method: 'delete',
      path: projectRouteRegistry.deleteProject.path,
      operationId: 'deleteProject',
      parameters: headers('cookie', 'origin', 'x-csrf-token', 'idempotency-key'),
      request: {
        params: projectRouteRegistry.deleteProject.params,
        body: {
          content: { 'application/json': { schema: projectRouteRegistry.deleteProject.body } },
        },
      },
      responses: responseSchemas(
        projectRouteRegistry.deleteProject.responses,
        projectDeleteSuccess,
        error,
      ),
    },
  ];
}

export function generateOpenApiDocument() {
  const registry = new OpenAPIRegistry();
  for (const route of routes(registry)) {
    registry.registerPath(route);
  }

  return new OpenApiGeneratorV3(registry.definitions).generateDocument({
    openapi: '3.0.3',
    info: { title: 'Orion Console Local M1 API', version: '1.0.0' },
    servers: [{ url: 'http://127.0.0.1:{port}', variables: { port: { default: '4317' } } }],
  });
}

export async function writeOpenApiDocument(): Promise<void> {
  await mkdir(dirname(openApiOutputPath), { recursive: true });
  await writeFile(
    openApiOutputPath,
    `${JSON.stringify(generateOpenApiDocument(), null, 2)}\n`,
    'utf8',
  );
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  await writeOpenApiDocument();
}
