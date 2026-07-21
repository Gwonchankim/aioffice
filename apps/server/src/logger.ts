import pino, { type Logger } from 'pino';

import { pinoRedactionPaths } from './redaction.js';

export type StartupLogger = Logger;

export function createLogger(): Logger {
  return pino({
    level: process.env.NODE_ENV === 'test' ? 'silent' : 'info',
    redact: { paths: [...pinoRedactionPaths], censor: '[REDACTED]' },
  });
}
