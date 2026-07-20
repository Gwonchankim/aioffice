import { readFile, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { ApplicationError } from './errors.js';

export interface StaticSpaOptions {
  readonly assetRoot: string;
}

export async function registerStaticSpa(
  app: FastifyInstance,
  options: StaticSpaOptions,
): Promise<void> {
  const assetRoot = resolve(options.assetRoot);
  const indexPath = resolve(assetRoot, 'index.html');
  await assertIndexFile(indexPath);

  app.route({
    method: ['GET', 'HEAD'],
    url: '/*',
    async handler(request, reply) {
      const path = requestedPath(request);
      if (path === undefined || path === 'api' || path.startsWith('api/')) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
      }

      const assetPath = resolveAssetPath(assetRoot, path);
      if (assetPath !== undefined && (await isFile(assetPath))) {
        return sendFile(reply, assetPath, request.method);
      }

      if (isNavigationRequest(request, path)) {
        return sendFile(reply, indexPath, request.method);
      }

      return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
    },
  });
}

async function assertIndexFile(indexPath: string): Promise<void> {
  if (!(await isFile(indexPath))) {
    throw new ApplicationError(
      'STATIC_ASSET_ROOT_INVALID',
      'The production SPA index asset is unavailable.',
    );
  }
}

function requestedPath(request: FastifyRequest): string | undefined {
  const wildcard = (request.params as { '*': string | undefined })['*'];
  if (wildcard === undefined) {
    return '';
  }

  try {
    return decodeURIComponent(wildcard);
  } catch {
    return undefined;
  }
}

function resolveAssetPath(assetRoot: string, path: string): string | undefined {
  if (path.includes('\0')) {
    return undefined;
  }

  const assetPath = resolve(assetRoot, path);
  const pathFromRoot = relative(assetRoot, assetPath);
  if (pathFromRoot.startsWith('..') || isAbsolute(pathFromRoot)) {
    return undefined;
  }

  return assetPath;
}

function isNavigationRequest(request: FastifyRequest, path: string): boolean {
  return extname(path) === '' && request.headers.accept?.includes('text/html') === true;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function sendFile(reply: FastifyReply, path: string, method: string): Promise<FastifyReply> {
  const contents = await readFile(path);
  reply.type(contentType(path));

  if (method === 'HEAD') {
    return reply.send();
  }

  return reply.send(contents);
}

function contentType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.css':
      return 'text/css';
    case '.html':
      return 'text/html';
    case '.js':
      return 'application/javascript';
    case '.json':
      return 'application/json';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.woff2':
      return 'font/woff2';
    default:
      return 'application/octet-stream';
  }
}
