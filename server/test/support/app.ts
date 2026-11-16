// A fresh app per test (docs/decisions/0009), with its responses checked against the contract.
import type { Router } from 'express';
import { createApp } from '../../src/app';
import type { AppConfig } from '../../src/config';
import type { ResponseViolation } from '../../src/http/contract';
import { createLogger } from '../../src/logger';

const violations: ResponseViolation[] = [];

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return { port: 0, nodeEnv: 'test', logLevel: 'silent', ...overrides };
}

/** The app as production builds it, plus response validation; `routes` replaces the operations. */
export function buildTestApp(routes?: Router) {
  return createApp(
    {
      config: testConfig(),
      logger: createLogger('silent'),
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
