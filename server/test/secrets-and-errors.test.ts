import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from '@jest/globals';
import { Router } from 'express';
import type { Logger } from 'pino';
import request, { type Response } from 'supertest';
import {
  type AppConfig,
  ConfigError,
  GENERATE_SECRET,
  loadConfig,
  MIN_SECRET_BYTES,
} from '../src/config';
import { createLogger } from '../src/logger';
import { buildTestApp, TEST_SECRETS, testConfig } from './support/app';
import { signedInApp } from './support/auth';

const validSignUp = {
  email: 'dana@example.com',
  password: 'correct horse',
  phone: '+972501234567',
};

/**
 * The contract's InternalError answer (api/openapi.yaml, its INTERNAL_ERROR example). Pinned in
 * full here: the run-time response check never validates a 5xx answer.
 */
const INTERNAL_ERROR = {
  type: 'about:blank',
  title: 'Internal server error',
  status: 500,
  code: 'INTERNAL_ERROR',
};

/** What a failing handler knows and the caller must never see. */
const SECRET_MESSAGE = 'connection to mongodb://admin:hunter2@db.internal refused';
/** A neutral error message, for the test that the server log keeps it. */
const LOGGED_MESSAGE = 'unexpected failure 7f3a';
/** A file:line:column position, as every stack frame has. */
const STACK_FRAME = /\.[cm]?[jt]s:\d+:\d+/;

/** The answer is exactly the contract's 500, and nothing in it carries `leaks`. */
function expectInternalError(res: Response, leaks: string[] = [SECRET_MESSAGE]): void {
  expect(res.status).toBe(500);
  expect(res.headers['content-type']).toBe('application/problem+json; charset=utf-8');
  expect(res.body).toEqual(INTERNAL_ERROR);
  const everything = `${JSON.stringify(res.headers)}\n${res.text}`;
  for (const leak of leaks) expect(everything).not.toContain(leak);
  expect(everything).not.toMatch(STACK_FRAME);
}

/** signUp, with a handler that throws `value` synchronously. */
const signUpThrowing = (value: unknown) =>
  Router().post('/api/v1/auth/signup', () => {
    throw value;
  });

/** getMe, with a handler whose promise rejects after an await (Express 5 forwards it). */
const getMeRejecting = (value: unknown) =>
  Router().get('/api/v1/me', async () => {
    await Promise.resolve();
    throw value;
  });

const postSignUp = (routes: Router, config: Partial<AppConfig> = {}, logger?: Logger) =>
  request(buildTestApp({ routes, config, logger })).post('/api/v1/auth/signup').send(validSignUp);

/** The production logger (createLogger, with its redaction), keeping every line it writes. */
function capturedLogger() {
  const lines: string[] = [];
  const logger = createLogger('info', { write: (line: string) => void lines.push(line) });
  const parsed = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { logger, lines, parsed };
}

/** A complete environment for loadConfig; each test overrides what it is about. */
const env = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  ...TEST_SECRETS,
  ...overrides,
});

/** The ConfigError loadConfig throws for `environment`, or a failure if it doesn't throw one. */
function configErrorFor(environment: NodeJS.ProcessEnv): ConfigError {
  try {
    loadConfig(environment);
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('loadConfig accepted the environment');
}

const SECRETS = ['JWT_SECRET', 'PASSCODE_SECRET'] as const;
const bytes = (value: string) => Buffer.byteLength(value, 'utf8');

type Run = { status: number | null; stdout: string; stderr: string };

/** Runs the real entry point (src/server.ts) with only `variables` set; it must exit by itself. */
function runServer(variables: NodeJS.ProcessEnv): Promise<Run> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
      cwd: resolve(__dirname, '..'),
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        PORT: '0',
        NODE_ENV: 'development',
        LOG_LEVEL: 'info',
        ...variables,
      },
      // A server that starts listens forever: it is killed here, and the test fails on its
      // status. Generous, so a cold machine compiling the TypeScript doesn't hit it.
      timeout: 20000,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', fail);
    child.on('close', (status) => done({ status, stdout, stderr }));
  });
}

describe('SEC-5 secrets and error details never leak', () => {
  describe('an unexpected error in a handler', () => {
    it('[SEC-5.c] a handler that throws answers 500 INTERNAL_ERROR with no message or stack trace', async () => {
      const error = new Error(SECRET_MESSAGE);

      const res = await postSignUp(signUpThrowing(error));

      expectInternalError(res, [SECRET_MESSAGE, error.stack!.split('\n')[1]!.trim()]);
    });

    it('[SEC-5.c] a handler whose promise rejects answers the same 500', async () => {
      const { app, auth } = await signedInApp({
        routes: getMeRejecting(new Error(SECRET_MESSAGE)),
      });
      const res = await request(app).get('/api/v1/me').set(auth);

      expectInternalError(res);
    });

    it.each<[string, unknown]>([
      ['a string', SECRET_MESSAGE],
      [
        'a plain object with a message and a stack',
        { message: SECRET_MESSAGE, stack: `Error: ${SECRET_MESSAGE}\n    at db (/srv/db.ts:1:1)` },
      ],
      ['a number', 4242],
    ])(
      '[SEC-5.c] a handler that throws %s, not an Error, answers the same 500',
      async (_name, value) => {
        const res = await postSignUp(signUpThrowing(value));

        expectInternalError(res, [SECRET_MESSAGE, '/srv/db.ts', '4242']);
      },
    );

    it('[SEC-5.c] a promise rejected with a non-Error value answers the same 500', async () => {
      const { app, auth } = await signedInApp({ routes: getMeRejecting(SECRET_MESSAGE) });
      const res = await request(app).get('/api/v1/me').set(auth);

      expectInternalError(res);
    });

    it.each(['development', 'production'] as const)(
      '[SEC-5.c] with NODE_ENV %s the answer is the same, with no detail',
      async (nodeEnv) => {
        const res = await postSignUp(signUpThrowing(new Error(SECRET_MESSAGE)), { nodeEnv });

        expectInternalError(res);
      },
    );

    it("[SEC-5.c] an unexpected error's message: the answer leaves it out, the server log keeps it", async () => {
      const { logger, parsed } = capturedLogger();

      const res = await postSignUp(signUpThrowing(new Error(LOGGED_MESSAGE)), {}, logger);

      expectInternalError(res, [LOGGED_MESSAGE]);
      const errorLines = parsed().filter((line) => Number(line.level) >= 50);
      expect(errorLines.some((line) => JSON.stringify(line).includes(LOGGED_MESSAGE))).toBe(true);
    });
  });

  describe('the logger', () => {
    it("[SEC-5.a] logging the configuration, alone or inside the app's dependencies, shows neither secret", () => {
      const { logger, lines, parsed } = capturedLogger();
      const config = testConfig();

      logger.info(config, 'the configuration itself');
      logger.info({ config }, 'the configuration as a field');
      logger.info({ deps: { config } }, "the app's dependencies");

      expect(lines).toHaveLength(3);
      for (const line of lines) {
        expect(line).not.toContain(config.jwtSecret);
        expect(line).not.toContain(config.passcodeSecret);
      }
      // The secrets were there, and were replaced (not just absent from the line).
      const [itself, field, deps] = parsed() as {
        jwtSecret?: unknown;
        passcodeSecret?: unknown;
        config?: { jwtSecret?: unknown; passcodeSecret?: unknown };
        deps?: { config?: { jwtSecret?: unknown; passcodeSecret?: unknown } };
      }[];
      for (const logged of [itself, field?.config, deps?.deps?.config]) {
        expect(logged).toMatchObject({ jwtSecret: '[Redacted]', passcodeSecret: '[Redacted]' });
      }
    });
  });

  describe('start-up secrets', () => {
    it.each(SECRETS)('[SEC-5.e] the server refuses to start without %s', (name) => {
      const error = configErrorFor(env({ [name]: undefined }));

      expect(error.problems).toHaveLength(1);
      expect(error.problems[0]).toContain(name);
    });

    it.each(SECRETS.flatMap((name) => ['', '   '].map((value) => [name, value] as const)))(
      '[SEC-5.e] a blank %s (%p) counts as unset and is refused',
      (name, value) => {
        const error = configErrorFor(env({ [name]: value }));

        expect(error.problems).toHaveLength(1);
        expect(error.problems[0]).toContain(name);
      },
    );

    it.each([
      ['development', {}],
      ['test', {}],
      ['production', { CORS_ORIGIN: 'https://bank.example.com' }],
    ] as const)(
      '[SEC-5.e] with NODE_ENV %s and neither secret, both are reported at once',
      (nodeEnv, rest) => {
        const error = configErrorFor({ NODE_ENV: nodeEnv, ...rest });

        expect(error.problems).toHaveLength(2);
        expect(error.problems.join('\n')).toContain('JWT_SECRET');
        expect(error.problems.join('\n')).toContain('PASSCODE_SECRET');
      },
    );

    it.each(SECRETS)('[SEC-5.e] a %s of 31 bytes is refused', (name) => {
      const error = configErrorFor(env({ [name]: 'x'.repeat(31) }));

      expect(error.problems).toHaveLength(1);
      expect(error.problems[0]).toContain(name);
    });

    it('[SEC-5.e] secrets of 32 bytes are accepted and kept in the configuration', () => {
      const jwtSecret = 'j'.repeat(32);
      const passcodeSecret = 'p'.repeat(32);

      const config = loadConfig(env({ JWT_SECRET: jwtSecret, PASSCODE_SECRET: passcodeSecret }));

      expect(config.jwtSecret).toBe(jwtSecret);
      expect(config.passcodeSecret).toBe(passcodeSecret);
    });

    it.each([
      ['é'.repeat(16), 'accepted'], // 16 characters, 32 bytes
      ['🔑'.repeat(8), 'accepted'], // 8 characters (16 UTF-16 units), 32 bytes
      ['é'.repeat(15) + 'x', 'refused'], // 16 characters, 31 bytes
    ] as const)('[SEC-5.e] length is counted in UTF-8 bytes: %p is %s', (secret, outcome) => {
      expect(secret.length).toBeLessThan(32);
      const load = () => loadConfig(env({ JWT_SECRET: secret, PASSCODE_SECRET: secret }));

      if (outcome === 'accepted') {
        expect(bytes(secret)).toBe(32);
        expect(load().jwtSecret).toBe(secret);
      } else {
        expect(bytes(secret)).toBe(31);
        expect(load).toThrow(ConfigError);
      }
    });

    it('[SEC-5.e] spaces around a secret are not counted: the length checked is the one used', () => {
      const padded = `   ${'x'.repeat(30)}   `; // 36 bytes as written, 30 once trimmed

      const error = configErrorFor(env({ JWT_SECRET: padded }));

      expect(error.problems).toHaveLength(1);
      expect(error.problems[0]).toContain('JWT_SECRET');
    });

    it.each(SECRETS)('[SEC-5.e] a %s is kept without the spaces around it', (name) => {
      const config = loadConfig(env({ [name]: `  ${'x'.repeat(32)}  ` }));

      const kept = name === 'JWT_SECRET' ? config.jwtSecret : config.passcodeSecret;
      expect(kept).toBe('x'.repeat(32));
    });

    it("[SEC-5.e] the error names the variable but never shows a secret's value", () => {
      const shortToken = 'short-token-secret-value';
      const shortPasscode = 'short-passcode-secret';
      const goodToken = TEST_SECRETS.JWT_SECRET;

      const both = configErrorFor({ JWT_SECRET: shortToken, PASSCODE_SECRET: shortPasscode });
      const one = configErrorFor({ JWT_SECRET: goodToken, PASSCODE_SECRET: shortPasscode });

      for (const error of [both, one]) {
        const messages = `${error.message}\n${error.problems.join('\n')}`;
        const text = `${messages}\n${error.stack ?? ''}`;
        expect(text).toContain('PASSCODE_SECRET');
        for (const value of [shortToken, shortPasscode, goodToken]) {
          expect(text).not.toContain(value);
          expect(text).not.toContain(value.slice(0, 8));
        }
        // Nor its length. The messages' own numbers are the fixed minimum and the generate
        // command (which holds the minimum too); with those removed, no number may remain. The
        // stack is left out: its line:column numbers are no secret.
        const variablePart = messages
          .replaceAll(GENERATE_SECRET, '')
          .replaceAll(`${MIN_SECRET_BYTES} bytes`, '');
        expect(variablePart).not.toMatch(/\d/);
      }
      expect(both.message).toContain('JWT_SECRET');
    });

    it('[SEC-5.e] the server process exits with an error and never listens when a secret is missing or short', async () => {
      const shortPasscode = 'short-passcode-secret';

      const [missing, short] = await Promise.all([
        runServer({}),
        runServer({ JWT_SECRET: TEST_SECRETS.JWT_SECRET, PASSCODE_SECRET: shortPasscode }),
      ]);

      expect(missing.status).toBe(1);
      expect(missing.stderr).toContain('JWT_SECRET');
      expect(missing.stderr).toContain('PASSCODE_SECRET');
      expect(missing.stdout).not.toContain('server listening');

      expect(short.status).toBe(1);
      expect(short.stderr).toContain('PASSCODE_SECRET');
      expect(short.stdout).not.toContain('server listening');
      const output = `${short.stdout}\n${short.stderr}`;
      expect(output).not.toContain(shortPasscode);
      expect(output).not.toContain(TEST_SECRETS.JWT_SECRET);
    }, 30000);
  });
});
