import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { request, createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

import { test as base } from '@playwright/test';
type StartedServer = {
  readonly app: { close(): Promise<unknown> };
  readonly port: number;
};

interface ServerModule {
  createLogger(): unknown;
  startServer(dependencies: { readonly logger: unknown }): Promise<StartedServer | undefined>;
}

interface LauncherModule {
  runProductionLauncher(dependencies: {
    readonly browserOpener: (url: string) => void;
    readonly logger: unknown;
    readonly output: (line: string) => void;
    readonly startServer: () => Promise<StartedServer | undefined>;
  }): Promise<number>;
}

const importEsm = Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<unknown>;

export interface OrionE2eHarness {
  readonly baseURL: string;
  readonly bootstrapUrl: string;
  readonly launcherOutput: readonly string[];
  readonly outputDirectory: string;
  readonly runtimeDirectory: string;
  createGitRepository(): Promise<string>;
  retainedArtifactPaths(): Promise<string[]>;
}

interface OrionFixtures {
  readonly orion: OrionE2eHarness;
}

export const test = base.extend<OrionFixtures>({
  orion: [
    async ({ browserName }, use) => {
      if (browserName !== 'chromium') {
        throw new Error('M1 E2E bootstrap coverage requires Chromium.');
      }
      const temporaryRoot = requiredTemporaryRoot();
      const runtimeDirectory = requiredRuntimeDirectory();
      const outputDirectory = join(temporaryRoot, 'results');
      const proxyPort = requiredProxyPort();
      const baseURL = `http://localhost:${proxyPort}`;
      const launcherOutput: string[] = [];
      const server = (await importEsm(
        pathToFileURL(resolve(process.cwd(), 'apps/server/dist/main.js')).href,
      )) as ServerModule;
      const launcher = (await importEsm(
        pathToFileURL(resolve(process.cwd(), 'scripts/dist/start.js')).href,
      )) as LauncherModule;
      const logger = server.createLogger();
      let started: StartedServer | undefined;
      let rawBootstrapUrl: string | undefined;

      const exitCode = await launcher.runProductionLauncher({
        browserOpener: (url) => {
          rawBootstrapUrl = url;
        },
        logger,
        output: (line) => launcherOutput.push(line),
        startServer: async () => {
          started = (await server.startServer({ logger })) as StartedServer | undefined;
          return started;
        },
      });
      if (exitCode !== 0 || started === undefined || rawBootstrapUrl === undefined) {
        throw new Error(
          'The isolated M1 E2E server did not establish an in-memory browser handoff.',
        );
      }
      const proxy = await startLoopbackProxy(started.port, proxyPort, baseURL);
      const bootstrapUrl = browserBootstrapUrl(rawBootstrapUrl, baseURL);

      const harness: OrionE2eHarness = {
        baseURL,
        bootstrapUrl,
        launcherOutput,
        outputDirectory,
        runtimeDirectory,
        createGitRepository: () => createGitRepository(temporaryRoot),
        retainedArtifactPaths: () => retainedArtifactPaths(outputDirectory),
      };

      try {
        await use(harness);
      } finally {
        await proxy.close();
        await started.app.close();
      }
    },
    { scope: 'worker' },
  ],
});

function requiredTemporaryRoot(): string {
  const temporaryRoot = process.env.ORION_E2E_TEMP_ROOT;
  if (temporaryRoot === undefined) {
    throw new Error('The Playwright temporary root is required.');
  }
  const resolvedRoot = resolve(temporaryRoot);
  const relation = relative(resolve(tmpdir()), resolvedRoot);
  if (relation === '' || relation.startsWith('..') || relation.includes(':')) {
    throw new Error('The Playwright temporary root must be an OS-temp child directory.');
  }
  return resolvedRoot;
}

function requiredRuntimeDirectory(): string {
  const runtimeDirectory = process.env.ORION_RUNTIME_DIR;
  if (runtimeDirectory === undefined) {
    throw new Error('The Playwright runtime directory is required.');
  }
  const resolvedRuntime = resolve(runtimeDirectory);
  if (!resolvedRuntime.startsWith(`${requiredTemporaryRoot()}\\`)) {
    throw new Error('The Playwright runtime directory must remain inside the owned OS-temp root.');
  }
  return resolvedRuntime;
}

function requiredProxyPort(): number {
  const port = Number(process.env.ORION_E2E_PROXY_PORT);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error('The Playwright loopback proxy port is invalid.');
  }
  return port;
}

interface LoopbackProxy {
  close(): Promise<void>;
}

async function startLoopbackProxy(
  backendPort: number,
  proxyPort: number,
  browserOrigin: string,
): Promise<LoopbackProxy> {
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const proxy = createServer((incoming, outgoing) => {
    const headers = { ...incoming.headers, host: `127.0.0.1:${backendPort}` };
    if (headers.origin === browserOrigin) {
      headers.origin = backendOrigin;
    }
    const upstream = request(
      {
        headers,
        hostname: '127.0.0.1',
        method: incoming.method,
        path: incoming.url ?? '/',
        port: backendPort,
      },
      (response) => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(outgoing);
      },
    );
    upstream.on('error', () => {
      if (!outgoing.headersSent) {
        outgoing.writeHead(502);
      }
      outgoing.end();
    });
    incoming.pipe(upstream);
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    proxy.once('error', rejectListen);
    proxy.listen(proxyPort, 'localhost', () => {
      proxy.off('error', rejectListen);
      resolveListen();
    });
  });

  return {
    close: () =>
      new Promise((resolveClose, rejectClose) => {
        proxy.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
      }),
  };
}

function browserBootstrapUrl(rawBootstrapUrl: string, browserOrigin: string): string {
  const browserUrl = new URL(rawBootstrapUrl);
  const browser = new URL(browserOrigin);
  browserUrl.protocol = browser.protocol;
  browserUrl.hostname = browser.hostname;
  browserUrl.port = browser.port;
  return browserUrl.toString();
}

async function createGitRepository(temporaryRoot: string): Promise<string> {
  const repository = await mkdtemp(join(temporaryRoot, 'project-'));
  await writeFile(join(repository, 'fixture.txt'), 'synthetic E2E fixture\n', 'utf8');
  for (const argv of [
    ['init', '-b', 'main'],
    ['add', 'fixture.txt'],
    [
      '-c',
      'user.name=Orion E2E',
      '-c',
      'user.email=e2e@example.invalid',
      'commit',
      '-m',
      'fixture',
    ],
  ]) {
    const result = spawnSync('git', argv, { cwd: repository, shell: false });
    if (result.status !== 0) {
      throw new Error('The synthetic E2E Git repository could not be initialized.');
    }
  }
  return repository;
}

async function retainedArtifactPaths(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const paths = await Promise.all(
      entries.map(async (entry) => {
        const path = join(directory, entry.name);
        return entry.isDirectory() ? retainedArtifactPaths(path) : [path];
      }),
    );
    return paths.flat();
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}
