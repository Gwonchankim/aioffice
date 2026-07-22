import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createApplication } from '../../apps/server/src/app.js';
import {
  exposedApiOperations,
  generateOpenApiDocument,
  openApiOutputPath,
} from '../generate-openapi.js';

const cleanupDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupDirectories
      .splice(0)
      .map((directory) =>
        rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }),
      ),
  );
});

function operationEntries(document: Record<string, unknown>): Array<[string, string]> {
  const paths = document.paths;
  if (typeof paths !== 'object' || paths === null) {
    throw new Error('The generated OpenAPI document has no paths object.');
  }

  return Object.entries(paths).flatMap(([path, pathItem]) => {
    if (typeof pathItem !== 'object' || pathItem === null) {
      return [];
    }

    return Object.keys(pathItem)
      .filter((method) => ['get', 'post', 'patch', 'delete'].includes(method))
      .map((method) => [method.toUpperCase(), path]);
  });
}

function operation(
  document: Record<string, unknown>,
  method: string,
  path: string,
): Record<string, unknown> {
  const paths = document.paths;
  if (typeof paths !== 'object' || paths === null || !(path in paths)) {
    throw new Error(`Missing OpenAPI path ${path}.`);
  }
  const pathItem = paths[path];
  if (typeof pathItem !== 'object' || pathItem === null) {
    throw new Error(`Invalid OpenAPI path item ${path}.`);
  }
  const candidate = pathItem[method.toLowerCase()];
  if (typeof candidate !== 'object' || candidate === null) {
    throw new Error(`Missing OpenAPI operation ${method} ${path}.`);
  }
  return candidate;
}

describe('M1 OpenAPI contract', () => {
  it('M1-API-001 generates the checked-in document deterministically from the route registry', async () => {
    const generated = generateOpenApiDocument();
    const checkedIn = JSON.parse(await readFile(openApiOutputPath, 'utf8')) as Record<
      string,
      unknown
    >;

    expect(checkedIn).toEqual(generated);
    expect(operationEntries(generated as Record<string, unknown>).sort()).toEqual(
      exposedApiOperations.map(({ method, path }) => [method, path]).sort(),
    );

    for (const expected of exposedApiOperations) {
      const documented = operation(
        generated as Record<string, unknown>,
        expected.method,
        expected.path,
      );
      expect(documented.operationId).toBe(expected.operationId);
      expect(documented.responses).toBeTypeOf('object');
      expect(documented.responses).not.toEqual({});
      if (
        expected.operationId !== 'bootstrapSession' &&
        ['POST', 'PATCH', 'DELETE'].includes(expected.method)
      ) {
        expect(documented.requestBody).toBeTypeOf('object');
        expect(documented.parameters).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ in: 'header', name: 'origin', required: true }),
          ]),
        );
      }
    }

    const deleted = operation(
      generated as Record<string, unknown>,
      'DELETE',
      '/api/v1/projects/{id}',
    );
    expect(deleted.responses).toEqual(
      expect.objectContaining({ '409': expect.objectContaining({ content: expect.any(Object) }) }),
    );
    const schemas = (
      generated as {
        components: {
          schemas: {
            ProjectWithGitStatusSuccess: {
              properties: {
                data: {
                  properties: {
                    git: { properties: Record<string, unknown>; required: string[] };
                  };
                };
              };
            };
          };
        };
      }
    ).components.schemas;
    const gitStatus = schemas.ProjectWithGitStatusSuccess.properties.data.properties.git;
    expect(gitStatus.properties).toMatchObject({
      defaultBranch: { type: 'string' },
      currentBranch: { type: 'string', nullable: true },
      headSha: { type: 'string' },
      dirty: { type: 'boolean' },
    });
    expect(gitStatus.required).toEqual(['defaultBranch', 'currentBranch', 'headSha', 'dirty']);
    expect(gitStatus.properties).not.toHaveProperty('branch');
    const providers = operation(generated as Record<string, unknown>, 'GET', '/api/v1/providers');
    expect(providers.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ in: 'header', name: 'cookie', required: true }),
      ]),
    );
    expect(providers.responses).toMatchObject({
      '200': { content: { 'application/json': expect.any(Object) } },
      '401': { content: { 'application/json': expect.any(Object) } },
    });

    const refresh = operation(
      generated as Record<string, unknown>,
      'POST',
      '/api/v1/providers/refresh',
    );
    expect(refresh.requestBody).toMatchObject({
      content: { 'application/json': expect.any(Object) },
    });
    expect(refresh.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ in: 'header', name: 'cookie', required: true }),
        expect.objectContaining({ in: 'header', name: 'origin', required: true }),
        expect.objectContaining({ in: 'header', name: 'x-csrf-token', required: true }),
        expect.objectContaining({ in: 'header', name: 'idempotency-key', required: true }),
      ]),
    );

    const stream = operation(
      generated as Record<string, unknown>,
      'GET',
      '/api/v1/tasks/{id}/events',
    );
    expect(stream.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ in: 'header', name: 'cookie', required: true }),
        expect.objectContaining({ in: 'header', name: 'last-event-id', required: false }),
      ]),
    );
    expect(stream.responses).toMatchObject({
      '200': {
        content: {
          'text/event-stream': { schema: { type: 'string', format: 'event-stream' } },
        },
      },
      '401': { content: { 'application/json': expect.any(Object) } },
    });

    const snapshot = operation(
      generated as Record<string, unknown>,
      'GET',
      '/api/v1/tasks/{id}/events/snapshot',
    );
    expect(snapshot.responses).toMatchObject({
      '200': { content: { 'application/json': expect.any(Object) } },
      '401': { content: { 'application/json': expect.any(Object) } },
    });
    const m2Schemas = schemas as unknown as Record<string, unknown>;
    expect(m2Schemas).toMatchObject({
      ProviderHealthCollectionSuccess: {
        properties: {
          data: {
            properties: {
              providers: {
                type: 'array',
                items: {
                  properties: {
                    provider: { enum: ['openai', 'anthropic'] },
                    installed: { type: 'boolean' },
                    authenticated: { type: 'boolean' },
                    supportedModels: { type: 'array' },
                    sanitizedError: { nullable: true },
                  },
                  additionalProperties: false,
                },
              },
            },
          },
        },
      },
      TaskEventSnapshotSuccess: {
        properties: {
          data: {
            properties: {
              taskId: { type: 'string' },
              highWaterSequence: { type: 'integer', minimum: 0 },
              runs: {
                type: 'array',
                items: {
                  properties: {
                    id: { type: 'string' },
                    provider: { enum: ['openai', 'anthropic'] },
                    model: { type: 'string', minLength: 1, maxLength: 128 },
                  },
                  additionalProperties: false,
                },
              },
            },
          },
        },
      },
    });
  });

  it('M1-API-002 keeps the generated operation set one-to-one with Fastify registration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orion-openapi-contract-'));
    cleanupDirectories.push(root);
    const runtimeDirectory = join(root, 'runtime');
    const database = new DatabaseSync(':memory:');
    await writeFile(join(root, 'index.html'), '<!doctype html><main id="root"></main>');
    const app = await createApplication({
      assetRoot: root,
      database,
      loopbackPort: 4317,
      runtimeDirectory,
    });

    try {
      for (const expected of exposedApiOperations) {
        expect(
          app.hasRoute({ method: expected.method, url: expected.path.replace('{id}', ':id') }),
        ).toBe(true);
      }
      expect(app.printRoutes({ commonPrefix: false }).trim()).toBe(
        [
          '├── /api/v1/health (GET, HEAD)',
          '├── /api/v1/session/bootstrap (POST)',
          '├── /api/v1/providers (GET, HEAD)',
          '│   └── /refresh (POST)',
          '├── /api/v1/provider-policy/fable-confirmations (POST)',
          '├── /api/v1/projects (GET, HEAD, POST)',
          '│   └── /:id (GET, HEAD, PATCH, DELETE)',
          '├── /api/v1/tasks/:id/events (GET, HEAD)',
          '│   └── /snapshot (GET, HEAD)',
          '└── * (GET, HEAD)',
        ].join('\n'),
      );
    } finally {
      await app.close();
    }
  });
});
