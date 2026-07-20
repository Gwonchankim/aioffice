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
export type BrowserOpener = (actualUrl: AbsoluteUrl) => void;

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
    try {
      (dependencies.browserOpener ?? defaultBrowserOpener(logger, output))(actualUrl);
    } catch {
      reportBrowserOpenFailure(actualUrl, logger, output);
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
