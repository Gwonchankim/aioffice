import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';

import type { FastifyInstance } from 'fastify';

import { createApplication, type CreateApplicationOptions } from './app.js';
import { LOOPBACK_HOST, type ServerConfig, loadServerConfig } from './config.js';
import { ApplicationError, getErrorCode } from './errors.js';
import { createLogger, type StartupLogger } from './logger.js';
import { type PortBinder, SequentialPortBinder } from './port.js';
import { NodeRuntimeFileSystem, type RuntimeFileSystem } from './runtime.js';
export { createLogger, type StartupLogger } from './logger.js';

export interface StartedServer {
  readonly app: FastifyInstance;
  readonly host: typeof LOOPBACK_HOST;
  readonly port: number;
  readonly url: string;
}

export interface StartupDependencies {
  readonly appFactory?: (options: CreateApplicationOptions) => Promise<FastifyInstance>;
  readonly addressReader?: (app: FastifyInstance) => AddressInfo;
  readonly config?: ServerConfig;
  readonly exit?: (code: number) => void;
  readonly logger?: StartupLogger;
  readonly now?: () => Date;
  readonly pid?: () => number;
  readonly portBinder?: PortBinder;
  readonly runtimeFileSystem?: RuntimeFileSystem;
}

export async function startServer(
  dependencies: StartupDependencies = {},
): Promise<StartedServer | undefined> {
  const logger = dependencies.logger ?? createLogger();
  let app: FastifyInstance | undefined;
  let listenerOwned = false;

  try {
    const config = dependencies.config ?? loadServerConfig();
    const runtimeFileSystem =
      dependencies.runtimeFileSystem ?? new NodeRuntimeFileSystem(config.runtimeDirectory);
    const application = await (dependencies.appFactory ?? createApplication)({
      assetRoot: config.assetRoot,
      runtimeDirectory: config.runtimeDirectory,
      logger,
    });
    app = application;

    await runtimeFileSystem.ensureDirectory();
    await (dependencies.portBinder ?? new SequentialPortBinder()).bind(
      (options) => application.listen(options),
      config.port,
    );
    listenerOwned = true;

    const address = (dependencies.addressReader ?? readLoopbackAddress)(application);
    await runtimeFileSystem.writeMetadata({
      pid: (dependencies.pid ?? (() => process.pid))(),
      host: LOOPBACK_HOST,
      port: address.port,
      startedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
    });

    const url = `http://${LOOPBACK_HOST}:${address.port}`;
    logger.info({ host: LOOPBACK_HOST, port: address.port, url }, 'Server listening');
    return { app: application, host: LOOPBACK_HOST, port: address.port, url };
  } catch (error) {
    if (listenerOwned && app !== undefined) {
      try {
        await app.close();
      } catch {
        logger.error({ code: 'SERVER_CLOSE_FAILED' }, 'Server listener cleanup failed');
      }
    }

    logger.error({ code: startupErrorCode(error) }, 'Server startup failed');
    (dependencies.exit ?? process.exit)(1);
    return undefined;
  }
}

function readLoopbackAddress(app: FastifyInstance): AddressInfo {
  const address = app.server.address();
  if (
    address === null ||
    typeof address === 'string' ||
    address.address !== LOOPBACK_HOST ||
    !Number.isSafeInteger(address.port)
  ) {
    throw new ApplicationError(
      'PORT_BIND_FAILED',
      'The listener did not report a loopback address.',
    );
  }

  return address;
}

function startupErrorCode(error: unknown): string {
  return getErrorCode(error) ?? 'SERVER_STARTUP_FAILED';
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void startServer();
}
