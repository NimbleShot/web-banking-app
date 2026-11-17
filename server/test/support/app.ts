// A fresh app per test (docs/decisions/0009), with its responses checked against the contract.
import type { Router } from 'express';
import type { Logger } from 'pino';
import { createApp } from '../../src/app';
import { type AppConfig, DEV_CORS_ORIGIN } from '../../src/config';
import type { ResponseViolation } from '../../src/http/contract';
import { createLogger } from '../../src/logger';

const violations: ResponseViolation[] = [];

/**
 * Secrets for tests only, each at least 32 bytes as the server requires. They protect nothing:
 * real ones are generated per environment (server/.env.example says how).
 */
export const TEST_SECRETS = {
  JWT_SECRET: 'test-only-token-secret-0123456789abcdef',
  PASSCODE_SECRET: 'test-only-passcode-secret-0123456789abcdef',
} as const;

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 0,
    nodeEnv: 'test',
    logLevel: 'silent',
    corsOrigin: DEV_CORS_ORIGIN,
    jwtSecret: TEST_SECRETS.JWT_SECRET,
    passcodeSecret: TEST_SECRETS.PASSCODE_SECRET,
    ...overrides,
  };
}

export type TestAppOptions = {
  /** Replaces the contract's operations, to put a handler behind the real pipeline. */
  routes?: Router;
  /** Overrides the test configuration. */
  config?: Partial<AppConfig>;
  /** Replaces the silent logger, e.g. with createLogger(level, destination) to capture lines. */
  logger?: Logger;
};

/** The app as production builds it, plus response validation. */
export function buildTestApp({
  routes,
  config = {},
  logger = createLogger('silent'),
}: TestAppOptions = {}) {
  return createApp(
    {
      config: testConfig(config),
      logger,
      onResponseViolation: (violation) => violations.push(violation),
    },
    routes,
  );
}

/** Returns the violations recorded so far and clears them. */
export function takeResponseViolations(): ResponseViolation[] {
  return violations.splice(0);
}

/** Run after every test (setup.ts): a response that broke the contract fails the test. */
export function assertNoResponseViolations(): void {
  const found = takeResponseViolations();
  if (found.length === 0) return;
  const lines = found.map(
    ({ method, path, status, errors }) =>
      `  ${method} ${path} -> ${status}: ${errors.map((e) => `${e.path} ${e.message}`).join('; ')}`,
  );
  throw new Error(
    `[CT-4.c] ${found.length} response(s) broke api/openapi.yaml:\n${lines.join('\n')}`,
  );
}
