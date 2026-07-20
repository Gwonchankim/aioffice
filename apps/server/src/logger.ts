import pino, { type Logger } from 'pino';

export type StartupLogger = Logger;

export function createLogger(): Logger {
  return pino({ level: process.env.NODE_ENV === 'test' ? 'silent' : 'info' });
}
