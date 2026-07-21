import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createApplication } from '../../apps/server/src/app.js';
import {
  exposedM1Operations,
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
      exposedM1Operations.map(({ method, path }) => [method, path]).sort(),
    );

    for (const expected of exposedM1Operations) {
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
      for (const expected of exposedM1Operations) {
        expect(
          app.hasRoute({ method: expected.method, url: expected.path.replace('{id}', ':id') }),
        ).toBe(true);
      }
      expect(app.printRoutes({ commonPrefix: false }).trim()).toBe(
        [
          '├── /api/v1/health (GET, HEAD)',
          '├── /api/v1/session/bootstrap (POST)',
          '├── /api/v1/projects (GET, HEAD, POST)',
          '│   └── /:id (GET, HEAD, PATCH, DELETE)',
          '├── /api/v1/provider-policy/fable-confirmations (POST)',
          '└── * (GET, HEAD)',
        ].join('\n'),
      );
    } finally {
      await app.close();
    }
  });
});
