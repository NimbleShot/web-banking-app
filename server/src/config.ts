// Configuration, read once from environment variables at start-up (docs/decisions/0009).
// Every variable is listed in server/.env.example.

const NODE_ENVS = ['development', 'test', 'production'] as const;
const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

export type NodeEnv = (typeof NODE_ENVS)[number];
export type LogLevel = (typeof LOG_LEVELS)[number];
/** How passcodes are sent: kept in memory (tests and development), or emailed through Resend. */
const MAILERS = ['outbox', 'resend'] as const;
export type MailerKind = (typeof MAILERS)[number];

/** The front end's origin outside production when CORS_ORIGIN is unset: the Vite dev server. */
export const DEV_CORS_ORIGIN = 'http://localhost:5173';

/** Resend's API when RESEND_API_URL is unset (DP-1). */
export const RESEND_API_URL = 'https://api.resend.com';

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
  /** Resend's settings, set exactly when `mailer` is `resend` (DP-1). The key is redacted in logs. */
  resend?: { apiKey: string; from: string; apiUrl: string };
  /** Signs and verifies access tokens (HS256); at least 32 bytes. */
  jwtSecret: string;
  /** Keys the passcode HMACs; at least 32 bytes. */
  passcodeSecret: string;
  /** How many proxies sit in front of the server (Express's `trust proxy`); 0 (the default) trusts none. */
  trustProxy: number;
  /**
   * The MongoDB connection string; unset means in-memory storage, which production refuses
   * (docs/decisions/0013). It can carry a password, so it is redacted in logs and never echoed.
   */
  mongodbUri?: string;
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

/** A sender address, `codes@mail.example.com` or `Bank <codes@mail.example.com>`. */
const MAIL_FROM = /^(?:[^<>@]*<[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>|[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)$/;

/**
 * RESEND_API_URL is exactly an http(s) origin: no path, query, fragment or credentials, which would
 * break every send. Production takes https only, except a loopback address (a local rehearsal
 * against a fake email API), so the key never crosses a network in the clear.
 */
function resendApiUrlProblem(value: string, nodeEnv: string): string | undefined {
  let url: URL | undefined;
  try {
    url = new URL(value);
  } catch {
    url = undefined;
  }
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:') || url.origin !== value) {
    return `RESEND_API_URL must be an http(s) origin with no path, such as ${RESEND_API_URL} (got "${value}")`;
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (nodeEnv === 'production' && url.protocol !== 'https:' && !loopback) {
    return 'RESEND_API_URL must use https in production';
  }
  return undefined;
}

/** The problem for a secret that is unset or shorter than MIN_SECRET_BYTES. */
function secretProblem(name: string): string {
  return `${name} must be set to a secret of at least ${MIN_SECRET_BYTES} bytes; generate one with: ${GENERATE_SECRET}`;
}

function oneOf<T extends string>(value: string, allowed: readonly T[]): value is T {
  return (allowed as readonly string[]).includes(value);
}

/**
 * Where the server listens (DP-3): every interface in production, this machine only otherwise.
 * A host deployed without NODE_ENV=production then can't be reached, so its deploy fails instead
 * of serving the test outbox's passcodes to anyone.
 */
export function listenHost(nodeEnv: NodeEnv): string {
  return nodeEnv === 'production' ? '0.0.0.0' : '127.0.0.1';
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

  // Resend's settings are read only for MAILER=resend; the messages never show the key.
  let resend: AppConfig['resend'];
  if (mailer === 'resend') {
    const apiKey = read('RESEND_API_KEY');
    if (apiKey === undefined) {
      problems.push('RESEND_API_KEY must be set when MAILER=resend (an API key from resend.com)');
    }
    const from = read('MAIL_FROM');
    if (from === undefined || !MAIL_FROM.test(from)) {
      problems.push(
        'MAIL_FROM must be set when MAILER=resend to a sender on a verified domain, such as ' +
          `"Bank <codes@mail.example.com>"${from === undefined ? '' : ` (got "${from}")`}`,
      );
    }
    const apiUrl = (read('RESEND_API_URL') ?? RESEND_API_URL).replace(/\/$/, '');
    const urlProblem = resendApiUrlProblem(apiUrl, nodeEnv);
    if (urlProblem) problems.push(urlProblem);
    if (apiKey !== undefined && from !== undefined && !urlProblem)
      resend = { apiKey, from, apiUrl };
  }

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
  // Optional; production without it is refused when the server opens its storage
  // (src/storage.ts), after the mailer's own check.
  const mongodbUri = read('MONGODB_URI');

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
    ...(resend && { resend }),
    jwtSecret,
    passcodeSecret,
    trustProxy,
    mongodbUri,
  };
}
