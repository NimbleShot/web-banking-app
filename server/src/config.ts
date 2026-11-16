// Configuration, read once from environment variables at start-up (docs/decisions/0009).
// Every variable is listed in server/.env.example.

const NODE_ENVS = ['development', 'test', 'production'] as const;
const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

export type NodeEnv = (typeof NODE_ENVS)[number];
export type LogLevel = (typeof LOG_LEVELS)[number];

/** The front end's origin outside production when CORS_ORIGIN is unset: the Vite dev server. */
export const DEV_CORS_ORIGIN = 'http://localhost:5173';

export type AppConfig = {
  port: number;
  nodeEnv: NodeEnv;
  logLevel: LogLevel;
  /** The one origin allowed to call the API from a browser (SEC-3). */
  corsOrigin: string;
};

/** Thrown when the environment can't configure the server; lists every problem at once. */
export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration:\n- ${problems.join('\n- ')}`);
    this.name = 'ConfigError';
  }
}

/**
 * CORS_ORIGIN must be exactly what a browser sends as Origin, `https://bank.example.com` or
 * `http://localhost:5173`: a lower-case scheme and host, a port only when it isn't the default,
 * no path and no trailing slash. Anything else would never match, so it is refused.
 */
function corsOriginProblem(value: string): string | undefined {
  let url: URL | undefined;
  try {
    url = new URL(value);
  } catch {
    url = undefined;
  }
  if (url?.protocol !== 'http:' && url?.protocol !== 'https:') {
    return `CORS_ORIGIN must be one origin, http(s)://host[:port], such as https://bank.example.com (got "${value}")`;
  }
  if (url.origin === value) return undefined;
  return `CORS_ORIGIN must be exactly an origin such as https://bank.example.com (got "${value}"; did you mean "${url.origin}"?)`;
}

function oneOf<T extends string>(value: string, allowed: readonly T[]): value is T {
  return (allowed as readonly string[]).includes(value);
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const problems: string[] = [];
  // A blank line in .env (`PORT=`) means "not set", for every variable alike.
  const read = (name: string): string | undefined => env[name]?.trim() || undefined;

  const rawPort = read('PORT') ?? '3000';
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || port > 65535) {
    problems.push('PORT must be a whole number from 0 to 65535');
  }

  const nodeEnv = read('NODE_ENV') ?? 'development';
  if (!oneOf(nodeEnv, NODE_ENVS)) problems.push(`NODE_ENV must be one of ${NODE_ENVS.join(', ')}`);

  const logLevel = read('LOG_LEVEL') ?? 'info';
  if (!oneOf(logLevel, LOG_LEVELS)) {
    problems.push(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}`);
  }

  const rawCorsOrigin = read('CORS_ORIGIN');
  const corsOrigin = rawCorsOrigin ?? DEV_CORS_ORIGIN;
  if (rawCorsOrigin === undefined && nodeEnv === 'production') {
    problems.push("CORS_ORIGIN must be set in production (the front end's origin)");
  } else {
    const problem = corsOriginProblem(corsOrigin);
    if (problem) problems.push(problem);
  }

  if (problems.length > 0) throw new ConfigError(problems);
  return { port, nodeEnv: nodeEnv as NodeEnv, logLevel: logLevel as LogLevel, corsOrigin };
}
