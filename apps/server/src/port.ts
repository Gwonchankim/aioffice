import { LOOPBACK_HOST, MAX_PORT_ATTEMPTS } from './config.js';
import { ApplicationError, PortExhaustedError, getErrorCode } from './errors.js';

export interface LoopbackListenOptions {
  readonly host: typeof LOOPBACK_HOST;
  readonly port: number;
}

export interface PortBinder {
  bind(
    listen: (options: LoopbackListenOptions) => Promise<unknown>,
    startPort: number,
  ): Promise<number>;
}

export class SequentialPortBinder implements PortBinder {
  public async bind(
    listen: (options: LoopbackListenOptions) => Promise<unknown>,
    startPort: number,
  ): Promise<number> {
    if (!Number.isSafeInteger(startPort) || startPort < 1 || startPort > 65535) {
      throw new ApplicationError('PORT_BIND_FAILED', 'The configured port is invalid.');
    }

    const lastPort = Math.min(startPort + MAX_PORT_ATTEMPTS - 1, 65535);

    for (let port = startPort; port <= lastPort; port += 1) {
      try {
        await listen({ host: LOOPBACK_HOST, port });
        return port;
      } catch (error) {
        if (getErrorCode(error) !== 'EADDRINUSE') {
          throw new ApplicationError(
            'PORT_BIND_FAILED',
            'The loopback listener could not be started.',
          );
        }
      }
    }

    throw new PortExhaustedError();
  }
}
