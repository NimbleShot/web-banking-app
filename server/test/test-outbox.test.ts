// SEC-5.d: the test-only passcode outbox route and the MAILER setting (docs/decisions/0012).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from '@jest/globals';
import { Router } from 'express';
import request from 'supertest';
import { createApp } from '../src/app';
import { TEST_OUTBOX_PATH as OUTBOX } from '../src/http/test-outbox';
import { ConfigError, DEV_CORS_ORIGIN, loadConfig } from '../src/config';
import { createMailer } from '../src/mail/create-mailer';
import { OutboxMailer } from '../src/mail/outbox';
import type { Mailer, PasscodeMessage } from '../src/mail/mailer';
import { answerOf, registerUser } from './support/auth';
import { buildTestHarness, TEST_SECRETS, testConfig } from './support/app';
import { requestReset } from './support/password-reset';
import { runServer } from './support/run-server';
import {
  AFTER_COOLDOWN,
  latestPasscode,
  signUp,
  signUpForPasscode,
  validSignUp,
} from './support/sign-up';

const PRODUCTION_ORIGIN = 'https://bank.example.com';

/** A valid environment for loadConfig; each test adds or overrides what it is about. */
const env = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  ...TEST_SECRETS,
  ...overrides,
});

/** Something that sends passcodes but is not the in-memory outbox. */
class RecordingMailer implements Mailer {
  readonly sent: PasscodeMessage[] = [];
  async sendPasscode(message: PasscodeMessage): Promise<void> {
    this.sent.push(message);
  }
}

/** The app of `buildTestHarness`, with its mailer replaced; sign-ups then reach `mailer`. */
function appWithMailer(mailer: Mailer, config: Parameters<typeof testConfig>[0] = {}) {
  const h = buildTestHarness();
  return createApp({ ...h.deps, config: testConfig(config), mailer });
}

/** A mailer shaped like the outbox (messages, sentTo, the same behaviour) that is not the class. */
class LookalikeMailer implements Mailer {
  readonly messages: PasscodeMessage[] = [];
  async sendPasscode(message: PasscodeMessage): Promise<void> {
    this.messages.push({ ...message });
  }
  sentTo(email: string): PasscodeMessage[] {
    return this.messages.filter((message) => message.to === email);
  }
}

/**
 * A mounted route answers a call with no email (or an empty one) with 400; a route that is not
 * mounted answers the 404 of an unknown path. Telling these apart is what proves "not mounted".
 */
const PROBES = [{}, { email: '' }];

async function expectRouteMounted(app: Parameters<typeof request>[0]): Promise<void> {
  for (const query of PROBES) {
    const res = await request(app).get(OUTBOX).query(query);
    expect(res.status).toBe(400);
  }
}

async function expectRouteAbsent(app: Parameters<typeof request>[0], email: string): Promise<void> {
  const unknown = await request(app).get('/__test/nothing');
  expect(unknown.status).toBe(404);
  for (const query of [...PROBES, { email }]) {
    const res = await request(app).get(OUTBOX).query(query);
    expect(res.status).toBe(404);
    expect(problemOf(res).code).toBe('NOT_FOUND');
    expect(answerOf(res)).toEqual(answerOf(unknown));
  }
}

const problemOf = (res: request.Response) => res.body as { code?: string; errors?: unknown };

function configProblems(variables: NodeJS.ProcessEnv): string[] {
  try {
    loadConfig(variables);
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  return [];
}

describe('SEC-5.d the in-memory outbox is refused at start-up in production', () => {
  it('[SEC-5.d] MAILER=outbox is accepted by the configuration, in every environment, and kept', () => {
    for (const nodeEnv of ['development', 'test']) {
      expect(loadConfig(env({ NODE_ENV: nodeEnv, MAILER: 'outbox' })).mailer).toBe('outbox');
    }
    const production = { NODE_ENV: 'production', CORS_ORIGIN: PRODUCTION_ORIGIN };
    expect(loadConfig(env({ ...production, MAILER: 'outbox' })).mailer).toBe('outbox');
  });

  it('[SEC-5.d] MAILER unset or blank means the outbox', () => {
    expect(loadConfig(env()).mailer).toBe('outbox');
    expect(loadConfig(env({ MAILER: '   ' })).mailer).toBe('outbox');
    const production = { NODE_ENV: 'production', CORS_ORIGIN: PRODUCTION_ORIGIN };
    expect(loadConfig(env(production)).mailer).toBe('outbox');
  });

  it.each(['smtp', 'Outbox', 'none'])(
    '[SEC-5.d] MAILER=%s is not a mailer that exists: refused, naming MAILER',
    (value) => {
      const problems = configProblems(env({ MAILER: value }));
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('MAILER');
    },
  );

  it('[SEC-5.d] createMailer builds the outbox outside production', () => {
    for (const nodeEnv of ['development', 'test'] as const) {
      expect(createMailer(testConfig({ nodeEnv, mailer: 'outbox' }))).toBeInstanceOf(OutboxMailer);
    }
  });

  it('[SEC-5.d] createMailer refuses the outbox in production, naming MAILER and no secret', () => {
    const config = testConfig({
      nodeEnv: 'production',
      corsOrigin: PRODUCTION_ORIGIN,
      mailer: 'outbox',
    });
    expect(() => createMailer(config)).toThrow(ConfigError);
    try {
      createMailer(config);
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('MAILER');
      for (const secret of Object.values(TEST_SECRETS)) expect(message).not.toContain(secret);
    }
  });

  it.each([
    ['MAILER=outbox', { MAILER: 'outbox' }],
    ['MAILER unset', {}],
  ])(
    '[SEC-5.d] the server process exits with an error and never listens in production with %s',
    async (_name, extra) => {
      const run = await runServer({
        ...env(),
        NODE_ENV: 'production',
        CORS_ORIGIN: PRODUCTION_ORIGIN,
        ...extra,
      });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('MAILER');
      expect(run.stdout).not.toContain('server listening');
      for (const secret of Object.values(TEST_SECRETS)) {
        expect(run.stdout + run.stderr).not.toContain(secret);
      }
    },
    30000,
  );

  it('[SEC-5.d] in production, a real outbox that holds a passcode still gets no route: 404 as an unknown path', async () => {
    const h = buildTestHarness();
    const app = createApp({
      ...h.deps,
      config: testConfig({ nodeEnv: 'production', corsOrigin: PRODUCTION_ORIGIN }),
    });
    h.outbox.messages.push({ to: validSignUp.email, purpose: 'signup', passcode: '123456' });
    await expectRouteAbsent(app, validSignUp.email);
  });
});

describe('SEC-5.d GET /__test/outbox answers the latest passcode sent to an email', () => {
  it('[SEC-5.d] after a sign-up it answers 200 with the email, purpose signup and the passcode, and nothing else', async () => {
    const h = buildTestHarness();
    const passcode = await signUpForPasscode(h);
    const res = await request(h.app).get(OUTBOX).query({ email: validSignUp.email });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.body).toEqual({ email: validSignUp.email, purpose: 'signup', passcode });
    expect(passcode).toMatch(/^\d{6}$/);
  });

  it('[SEC-5.d] it needs no token', async () => {
    const h = buildTestHarness();
    await signUpForPasscode(h);
    const res = await request(h.app)
      .get(OUTBOX)
      .query({ email: validSignUp.email })
      .set('Authorization', 'Bearer not-a-token');
    expect(res.status).toBe(200);
  });

  it('[SEC-5.d] it answers the latest of several messages, not the first', async () => {
    const h = buildTestHarness();
    const first = await signUpForPasscode(h);
    h.clock.advance(AFTER_COOLDOWN);
    await signUp(h).expect(202);
    const second = latestPasscode(h);
    expect(second).not.toBe(first);
    const res = await request(h.app).get(OUTBOX).query({ email: validSignUp.email });
    expect(res.body).toEqual({ email: validSignUp.email, purpose: 'signup', passcode: second });
  });

  it('[SEC-5.d] after a password reset request it answers purpose reset with the reset passcode', async () => {
    const h = buildTestHarness();
    await registerUser(h);
    h.clock.advance(AFTER_COOLDOWN);
    await requestReset(h).expect(202);
    const reset = h.outbox.sentTo(validSignUp.email).filter((m) => m.purpose === 'reset');
    expect(reset).toHaveLength(1);
    const res = await request(h.app).get(OUTBOX).query({ email: validSignUp.email });
    expect(res.body).toEqual({
      email: validSignUp.email,
      purpose: 'reset',
      passcode: reset[0]?.passcode,
    });
  });

  it('[SEC-5.d] the email is lowercased, like everywhere else', async () => {
    const h = buildTestHarness();
    const passcode = await signUpForPasscode(h, 'dana@example.com');
    const res = await request(h.app).get(OUTBOX).query({ email: 'Dana@EXAMPLE.com' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ email: 'dana@example.com', purpose: 'signup', passcode });
  });

  it('[SEC-5.d] a message for another email is not answered', async () => {
    const h = buildTestHarness();
    await signUpForPasscode(h, 'dana@example.com');
    const res = await request(h.app).get(OUTBOX).query({ email: 'eli@example.com' });
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain(latestPasscode(h, 'dana@example.com'));
  });

  it('[SEC-5.d] with no message for the email it answers exactly what an unknown path answers', async () => {
    const h = buildTestHarness();
    await signUpForPasscode(h, 'dana@example.com');
    const none = await request(h.app).get(OUTBOX).query({ email: 'eli@example.com' });
    const unknown = await request(h.app).get('/__test/nothing').query({ email: 'eli@example.com' });
    expect(none.status).toBe(404);
    expect(problemOf(none).code).toBe('NOT_FOUND');
    expect(answerOf(none)).toEqual(answerOf(unknown));
  });

  it.each([
    ['no email', {}],
    ['an empty email', { email: '' }],
    ['two emails', { email: ['dana@example.com', 'eli@example.com'] }],
  ])(
    '[SEC-5.d] %s answers 400 VALIDATION_FAILED naming email, even when messages exist',
    async (_name, query) => {
      const h = buildTestHarness();
      await signUpForPasscode(h, 'dana@example.com');
      const res = await request(h.app).get(OUTBOX).query(query);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
      expect((res.body as { errors: { field: string }[] }).errors.map((e) => e.field)).toEqual([
        'email',
      ]);
      expect(JSON.stringify(res.body)).not.toMatch(/\d{6}/);
    },
  );

  it.each(['post', 'put', 'delete', 'patch'] as const)(
    '[SEC-5.d] %s on the path answers the 404 of an unknown method, even when a message exists',
    async (method) => {
      const h = buildTestHarness();
      await signUpForPasscode(h);
      const res = await request(h.app)[method](OUTBOX).query({ email: validSignUp.email });
      const unknown = await request(h.app)[method]('/__test/nothing').query({
        email: validSignUp.email,
      });
      expect(res.status).toBe(404);
      expect(problemOf(res).code).toBe('NOT_FOUND');
      expect(answerOf(res)).toEqual(answerOf(unknown));
    },
  );

  it('[SEC-5.d] it is mounted by createApp, ahead of the contract: it answers with a custom router too', async () => {
    const h = buildTestHarness({ routes: Router() });
    // An empty router has no sign-up: the message is put in the outbox directly.
    h.outbox.messages.push({ to: validSignUp.email, purpose: 'signup', passcode: '123456' });
    const res = await request(h.app).get(OUTBOX).query({ email: validSignUp.email });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ email: validSignUp.email, purpose: 'signup', passcode: '123456' });
  });

  it('[SEC-5.d] it is not part of the contract: api/openapi.yaml never mentions it', () => {
    const contract = readFileSync(resolve(__dirname, '../../api/openapi.yaml'), 'utf8');
    expect(contract).not.toContain('__test');
    expect(contract).not.toContain('outbox');
  });

  it('[SEC-5.d] it sits behind helmet and CORS: security headers, and no CORS header for another origin', async () => {
    const h = buildTestHarness();
    await signUpForPasscode(h);
    const res = await request(h.app)
      .get(OUTBOX)
      .query({ email: validSignUp.email })
      .set('Origin', 'https://evil.example.com');
    expect(res.status).toBe(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    const own = await request(h.app)
      .get(OUTBOX)
      .query({ email: validSignUp.email })
      .set('Origin', DEV_CORS_ORIGIN);
    expect(own.headers['access-control-allow-origin']).toBe(DEV_CORS_ORIGIN);
    expect(own.headers['vary']).toMatch(/Origin/i);
  });

  it('[SEC-5.d] it is not rate limited: 60 requests from one address all get their answer', async () => {
    const h = buildTestHarness();
    await signUpForPasscode(h);
    for (let i = 0; i < 60; i += 1) {
      const res = await request(h.app).get(OUTBOX).query({ email: validSignUp.email });
      expect(res.status).toBe(200);
    }
  });
});

describe('SEC-5.d with any other mailer the route does not exist', () => {
  // No opposite pairing exists until a second MailerKind does: the setting alone can't pick a
  // mailer, so "another mailer" is an object of another type, and the setting stays 'outbox'.
  it('[SEC-5.d] control: with the outbox the route is mounted: the probe answers 400, the passcode 200', async () => {
    const h = buildTestHarness();
    const mailer = h.outbox;
    const app = appWithMailer(mailer);
    await request(app).post('/api/v1/auth/signup').send(validSignUp).expect(202);
    expect(mailer.sentTo(validSignUp.email)).toHaveLength(1);
    await expectRouteMounted(app);
    await request(app).get(OUTBOX).query({ email: validSignUp.email }).expect(200);
  });

  it('[SEC-5.d] another mailer that HAS sent a passcode: the route answers 404 NOT_FOUND as an unknown path, the probe too, though the setting says outbox', async () => {
    const mailer = new RecordingMailer();
    const app = appWithMailer(mailer, { mailer: 'outbox' });
    await request(app).post('/api/v1/auth/signup').send(validSignUp).expect(202);
    expect(mailer.sent).toEqual([
      { to: validSignUp.email, purpose: 'signup', passcode: expect.stringMatching(/^\d{6}$/) },
    ]);
    await expectRouteAbsent(app, validSignUp.email);
    expect(
      JSON.stringify((await request(app).get(OUTBOX).query({ email: validSignUp.email })).body),
    ).not.toContain(mailer.sent[0]?.passcode ?? 'unreachable');
  });

  it('[SEC-5.d] a mailer that looks like the outbox (messages, sentTo) but is not one does not mount it', async () => {
    const lookalike = new LookalikeMailer();
    const app = appWithMailer(lookalike);
    await request(app).post('/api/v1/auth/signup').send(validSignUp).expect(202);
    expect(lookalike.sentTo(validSignUp.email)).toHaveLength(1);
    await expectRouteAbsent(app, validSignUp.email);
  });

  it('[SEC-5.d] HEAD answers 200 with no body for a message, and the unknown path 404 with another mailer', async () => {
    const h = buildTestHarness();
    await signUpForPasscode(h);
    const head = await request(h.app).head(OUTBOX).query({ email: validSignUp.email });
    expect(head.status).toBe(200);
    expect(head.text ?? '').toBe('');
    const mailer = new RecordingMailer();
    const app = appWithMailer(mailer);
    await request(app).post('/api/v1/auth/signup').send(validSignUp).expect(202);
    const absent = await request(app).head(OUTBOX).query({ email: validSignUp.email });
    const unknown = await request(app).head('/__test/nothing').query({ email: validSignUp.email });
    expect(absent.status).toBe(404);
    expect(answerOf(absent)).toEqual(answerOf(unknown));
  });
});
