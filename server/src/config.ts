// Configuration, read once from environment variables at start-up (docs/decisions/0009).
// Every variable is listed in server/.env.example.

const NODE_ENVS = ['development', 'test', 'production'] as const;
const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

export type NodeEnv = (typeof NODE_ENVS)[number];
export type LogLevel = (typeof LOG_LEVELS)[number];
/** How passcodes are sent. Only the in-memory outbox exists until a real email API is added. */
const MAILERS = ['outbox'] as const;
export type MailerKind = (typeof MAILERS)[number];

/** The front end's origin outside production when CORS_ORIGIN is unset: the Vite dev server. */
export const DEV_CORS_ORIGIN = 'http://localhost:5173';

/** The shortest secret accepted, in UTF-8 bytes (docs/decisions/0010). */
export const MIN_SECRET_BYTES = 32;

/** The command the start-up errors (and server/.env.example) give for making a secret. */
export const GENERATE_SECRET = `node -p "require('node:crypto').randomBytes(${MIN_SECRET_BYTES}).toString('base64')"`;

export type AppConfig = {
  port: number;
  nodeEnv: NodeEnv;
  logLevel: LogLevel;
  /** The one origin allowed to call the API from a browser (SEC-3). */
  corsOrigin: string;
  /** How passcodes are sent; `outbox` keeps them in memory and is refused in production (SEC-5.d). */
  mailer: MailerKind;
  /** Signs and verifies access tokens (HS256); at least 32 bytes. */
  jwtSecret: string;
  /** Keys the passcode HMACs; at least 32 bytes. */
  passcodeSecret: string;
  /** How many proxies sit in front of the server (Express's `trust proxy`); 0 (the default) trusts none. */
  trustProxy: number;
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

/** The problem for a secret that is unset or shorter than MIN_SECRET_BYTES. */
function secretProblem(name: string): string {
  return `${name} must be set to a secret of at least ${MIN_SECRET_BYTES} bytes; generate one with: ${GENERATE_SECRET}`;
}

function oneOf<T extends string>(value: string, allowed: readonly T[]): value is T {
  return (allowed as readonly string[]).includes(value);
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const problems: string[] = [];
  // A blank line in .env (`PORT=`) means "not set", for every variable alike.
  const read = (name: string): string | undefined => env[name]?.trim() || undefined;
  /**
   * A secret is required in every environment and must be at least MIN_SECRET_BYTES of UTF-8.
   * Returns it, or records a problem that names the variable and nothing about its value, not
   * even its length, and returns undefined.
   */
  const requireSecret = (name: string): string | undefined => {
    const value = read(name);
    if (value !== undefined && Buffer.byteLength(value, 'utf8') >= MIN_SECRET_BYTES) return value;
    problems.push(secretProblem(name));
    return undefined;
  };

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

  // The in-memory outbox is refused in production when the server builds its mailer
  // (src/mail/create-mailer.ts, SEC-5.d), not here: this only checks the value.
  const mailer = read('MAILER') ?? 'outbox';
  if (!oneOf(mailer, MAILERS)) problems.push(`MAILER must be one of ${MAILERS.join(', ')}`);

  const rawTrustProxy = read('TRUST_PROXY');
  let trustProxy = 0;
  if (rawTrustProxy !== undefined) {
    trustProxy = Number(rawTrustProxy);
    if (!/^\d+$/.test(rawTrustProxy) || !Number.isSafeInteger(trustProxy)) {
      problems.push(
        `TRUST_PROXY must be a whole number of proxy hops, 0 or more, such as 1 (got "${rawTrustProxy}")`,
      );
    }
  }

  const jwtSecret = requireSecret('JWT_SECRET');
  const passcodeSecret = requireSecret('PASSCODE_SECRET');

  // A missing secret has always recorded a problem; testing it here narrows its type.
  if (problems.length > 0 || jwtSecret === undefined || passcodeSecret === undefined) {
    throw new ConfigError(problems);
  }
  return {
    port,
    nodeEnv: nodeEnv as NodeEnv,
    logLevel: logLevel as LogLevel,
    corsOrigin,
    mailer: mailer as MailerKind,
    jwtSecret,
    passcodeSecret,
    trustProxy,
  };
}
