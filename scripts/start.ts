import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLogger, startServer, type StartedServer, type StartupLogger } from '@orion/server';

import {
  openBrowser,
  reportBrowserOpenFailure,
  validateAbsoluteUrl,
  type AbsoluteUrl,
  type BrowserLogger,
} from './browser.js';

export type ServerStarter = () => Promise<StartedServer | undefined>;
export type BrowserOpener = (bootstrapUrl: AbsoluteUrl) => void;

export interface ProductionLauncherDependencies {
  readonly browserOpener?: BrowserOpener;
  readonly logger?: StartupLogger;
  readonly output?: (value: string) => void;
  readonly startServer?: ServerStarter;
}

export async function runProductionLauncher(
  dependencies: ProductionLauncherDependencies = {},
): Promise<number> {
  const logger = dependencies.logger ?? createLogger();
  const output = dependencies.output ?? console.log;

  try {
    const started = await (dependencies.startServer ?? startServer)();
    if (started === undefined) {
      return 1;
    }

    const actualUrl = validatedServerUrl(started);
    const bootstrapUrl = bootstrapUrlFor(started, actualUrl);
    try {
      (dependencies.browserOpener ?? defaultBrowserOpener(logger, output))(bootstrapUrl);
    } catch {
      reportBrowserOpenFailure(bootstrapUrl, logger, output);
    }
    return 0;
  } catch {
    logger.error({ code: 'SERVER_STARTUP_FAILED' }, 'Server startup failed');
    return 1;
  }
}

function validatedServerUrl(server: StartedServer): AbsoluteUrl {
  const parsed = new URL(server.url);
  if (
    parsed.protocol !== 'http:' ||
    parsed.hostname !== server.host ||
    parsed.port !== String(server.port)
  ) {
    throw new Error('The started server did not provide its actual loopback URL.');
  }
  return validateAbsoluteUrl(server.url);
}

function bootstrapUrlFor(server: StartedServer, actualUrl: AbsoluteUrl): AbsoluteUrl {
  const token = (server.app as unknown as { readonly orionBootstrapToken?: unknown })
    .orionBootstrapToken;
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('The server did not provide an in-memory bootstrap token.');
  }

  const bootstrapUrl = new URL(actualUrl);
  bootstrapUrl.hash = new URLSearchParams({ bootstrap_token: token }).toString();
  return validateAbsoluteUrl(bootstrapUrl.toString());
}

function defaultBrowserOpener(
  logger: BrowserLogger,
  output: (value: string) => void,
): BrowserOpener {
  return (actualUrl) => {
    openBrowser(actualUrl, { logger, output });
  };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runProductionLauncher().then((exitCode) => {
    if (exitCode !== 0) {
      process.exitCode = exitCode;
    }
  });
}
