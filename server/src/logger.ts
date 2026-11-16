import pino, { type Logger } from 'pino';
import type { LogLevel } from './config';

/**
 * JSON logs. Request logs never show credentials: the Authorization and Cookie headers are
 * replaced with "[Redacted]" before a line is written.
 */
export function createLogger(level: LogLevel): Logger {
  return pino({
    level,
    redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
  });
}
