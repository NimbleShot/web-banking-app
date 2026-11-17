import pino, { type DestinationStream, type Logger } from 'pino';
import type { LogLevel } from './config';

/** Where AppConfig's secrets sit in a log object: the config itself, `{ config }`, `{ deps }`. */
const SECRET_PATHS = ['jwtSecret', 'passcodeSecret'].flatMap((key) => [
  key,
  `config.${key}`,
  `deps.config.${key}`,
]);

/**
 * JSON logs, to stdout unless `destination` is given (tests capture the lines with one). Lines
 * never show credentials: the Authorization and Cookie headers and the configuration's secrets
 * are replaced with "[Redacted]" before a line is written. The paths are explicit, since pino's
 * wildcard paths cost time on every line.
 */
export function createLogger(level: LogLevel, destination?: DestinationStream): Logger {
  const options = {
    level,
    redact: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      ...SECRET_PATHS,
    ],
  };
  return destination ? pino(options, destination) : pino(options);
}
