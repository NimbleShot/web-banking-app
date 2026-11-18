import { describe, expect, it } from '@jest/globals';
import request from 'supertest';
import { ConfigError, DEV_CORS_ORIGIN, loadConfig } from '../src/config';
import { buildTestHarness, TEST_SECRETS } from './support/app';
import {
  answerOf,
  bearer,
  getMe,
  INVALID_CREDENTIALS,
  login,
  LOGIN,
  registerUser,
  TRANSACTIONS,
  TRANSFERS,
} from './support/auth';
import {
  FORGOT,
  NEW_PASSWORD,
  RESET,
  requestReset,
  resetPassword,
  userWithResetPasscode,
} from './support/password-reset';
import {
  AFTER_COOLDOWN,
  aUser,
  type Harness,
  MINUTE,
  RESEND,
  SECOND,
  SIGN_UP,
  validSignUp,
  VERIFY,
} from './support/sign-up';

const RATE_LIMITED = {
  type: 'about:blank',
  title: 'Too many requests',
  status: 429,
  code: 'RATE_LIMITED',
};
const NOT_FOUND = { type: 'about:blank', title: 'Not found', status: 404, code: 'NOT_FOUND' };
const PROBLEM_JSON = /^application\/problem\+json/;

const CREDENTIAL_WINDOW_SECONDS = 15 * 60;
const EMAIL_WINDOW_SECONDS = 60 * 60;

/** One address behind one proxy: the test then names the client with X-Forwarded-For. */
const BEHIND_ONE_PROXY = { trustProxy: 1 };

type Ip = string | undefined;
const as = <T extends request.Test>(req: T, ip: Ip): T =>
  ip ? (req.set('X-Forwarded-For', ip) as T) : req;

/** The three operations that share the credential limiter, each sent so it fails with a 401. */
const failingCredentialOps = {
  login: (h: Harness, ip?: Ip, email = validSignUp.email) =>
    as(request(h.app).post(LOGIN).send({ email, password: 'wrong password' }), ip),
  verifyOtp: (h: Harness, ip?: Ip, email = validSignUp.email) =>
    as(
      request(h.app).post(VERIFY).send({
        email,
        passcode: '000000',
        password: validSignUp.password,
        phone: validSignUp.phone,
      }),
      ip,
    ),
  resetPassword: (h: Harness, ip?: Ip, email = validSignUp.email) =>
    as(request(h.app).post(RESET).send({ email, passcode: '000000', password: NEW_PASSWORD }), ip),
};
type CredentialOp = keyof typeof failingCredentialOps;
const CREDENTIAL_OPS = Object.keys(failingCredentialOps) as CredentialOp[];

/** The three operations that share the email limiter; `n` makes each request's email its own. */
const emailOps = {
  signUp: (h: Harness, n: number, ip?: Ip) =>
    as(
      request(h.app)
        .post(SIGN_UP)
        .send({ ...validSignUp, email: `person${n}@example.com` }),
      ip,
    ),
  resendOtp: (h: Harness, n: number, ip?: Ip) =>
    as(
      request(h.app)
        .post(RESEND)
        .send({ email: `person${n}@example.com` }),
      ip,
    ),
  requestPasswordReset: (h: Harness, n: number, ip?: Ip) =>
    as(
      request(h.app)
        .post(FORGOT)
        .send({ email: `person${n}@example.com` }),
      ip,
    ),
};
type EmailOp = keyof typeof emailOps;
const EMAIL_OPS = Object.keys(emailOps) as EmailOp[];

/** `count` requests one after the other; returns every status. */
async function statuses(count: number, send: (i: number) => Promise<request.Response>) {
  const found: number[] = [];
  for (let i = 0; i < count; i += 1) found.push((await send(i)).status);
  return found;
}
const all = (count: number, status: number) => Array<number>(count).fill(status);

/** A 429 answer: the contract's problem, and Retry-After as whole seconds within the window. */
function expectRateLimited(res: request.Response, windowSeconds: number) {
  expect(res.status).toBe(429);
  expect(res.headers['content-type']).toMatch(PROBLEM_JSON);
  expect(res.body).toEqual(RATE_LIMITED);
  const retryAfter = res.headers['retry-after'];
  expect(retryAfter).toMatch(/^\d+$/);
  expect(Number(retryAfter)).toBeGreaterThanOrEqual(1);
  expect(Number(retryAfter)).toBeLessThanOrEqual(windowSeconds);
}

describe('SEC-2.a failed credential checks are limited', () => {
  it('[SEC-2.a] the 10th failed login is answered 401, the 11th is 429 RATE_LIMITED with Retry-After', async () => {
    const h = buildTestHarness();

    const first = await statuses(10, () => failingCredentialOps.login(h));
    const eleventh = await failingCredentialOps.login(h);

    expect(first).toEqual(all(10, 401));
    expectRateLimited(eleventh, CREDENTIAL_WINDOW_SECONDS);
  });

  it.each(CREDENTIAL_OPS)(
    '[SEC-2.a] 10 failures spread over login, verifyOtp and resetPassword limit the next %s too',
    async (operation) => {
      const h = buildTestHarness();
      const spread: CredentialOp[] = [
        ...all(4, 0).map(() => 'login' as const),
        ...all(3, 0).map(() => 'verifyOtp' as const),
        ...all(3, 0).map(() => 'resetPassword' as const),
      ];

      const first: number[] = [];
      for (const op of spread) first.push((await failingCredentialOps[op](h)).status);
      const next = await failingCredentialOps[operation](h);

      expect(first).toEqual(all(10, 401));
      expectRateLimited(next, CREDENTIAL_WINDOW_SECONDS);
    },
  );

  it('[SEC-2.a] the count is per address, not per email: 10 failures with 10 different emails limit an 11th with yet another', async () => {
    const h = buildTestHarness();
    const ops = [
      ...all(4, 0).map(() => 'login' as const),
      ...all(3, 0).map(() => 'verifyOtp' as const),
      ...all(3, 0).map(() => 'resetPassword' as const),
    ];
    const first: number[] = [];
    for (const [i, op] of ops.entries()) {
      first.push((await failingCredentialOps[op](h, undefined, `person${i}@example.com`)).status);
    }

    const next = await failingCredentialOps.login(h, undefined, 'person99@example.com');

    expect(first).toEqual(all(10, 401));
    expectRateLimited(next, CREDENTIAL_WINDOW_SECONDS);
  });

  it('[SEC-2.a] with correct credentials the 11th login is still 429, and no token is issued', async () => {
    const h = buildTestHarness();
    await registerUser(h);
    await statuses(10, () => failingCredentialOps.login(h));

    const res = await login(h, validSignUp.email, validSignUp.password);

    expectRateLimited(res, CREDENTIAL_WINDOW_SECONDS);
    expect(res.body).not.toHaveProperty('accessToken');
  });

  it('[SEC-2.a] with the correct passcode the 11th verifyOtp is 429 and the sign-up stays pending', async () => {
    const h = buildTestHarness();
    await request(h.app).post(SIGN_UP).send(validSignUp);
    const passcode = h.outbox.sentTo(validSignUp.email)[0]?.passcode as string;
    await statuses(10, () => failingCredentialOps.login(h));

    const res = await request(h.app).post(VERIFY).send({
      email: validSignUp.email,
      passcode,
      password: validSignUp.password,
      phone: validSignUp.phone,
    });

    expectRateLimited(res, CREDENTIAL_WINDOW_SECONDS);
    expect(await h.users.findByEmail(validSignUp.email)).toBeUndefined();
  });

  it('[SEC-2.a] with the correct passcode the 11th resetPassword is 429 and the password is unchanged', async () => {
    const h = buildTestHarness();
    const { passcode, user } = await userWithResetPasscode(h);
    await statuses(10, () => failingCredentialOps.login(h));

    const res = await resetPassword(h, passcode);

    expectRateLimited(res, CREDENTIAL_WINDOW_SECONDS);
    expect((await h.users.findByEmail(validSignUp.email))?.passwordHash).toBe(user.passwordHash);
  });

  it('[SEC-2.a] a 429 does not push the window out: it ends 15 minutes after the first failure', async () => {
    const h = buildTestHarness();
    await registerUser(h);
    await statuses(10, () => failingCredentialOps.login(h));
    h.clock.advance(10 * MINUTE);

    const limited = await login(h, validSignUp.email, validSignUp.password);
    h.clock.advance(4 * MINUTE + 30 * SECOND);
    const stillLimited = await login(h, validSignUp.email, validSignUp.password);
    h.clock.advance(MINUTE);
    const afterWindow = await login(h, validSignUp.email, validSignUp.password);

    expectRateLimited(limited, CREDENTIAL_WINDOW_SECONDS);
    expect(limited.headers['retry-after']).toBe('300');
    expectRateLimited(stillLimited, CREDENTIAL_WINDOW_SECONDS);
    expect(stillLimited.headers['retry-after']).toBe('30');
    expect(afterWindow.status).toBe(200);
  });

  it('[SEC-2.a] after the window the count starts again: 10 more failures are allowed, the 11th is refused', async () => {
    const h = buildTestHarness();
    await statuses(10, () => failingCredentialOps.login(h));
    h.clock.advance(15 * MINUTE + SECOND);

    const again = await statuses(10, () => failingCredentialOps.login(h));
    const next = await failingCredentialOps.login(h);

    expect(again).toEqual(all(10, 401));
    expectRateLimited(next, CREDENTIAL_WINDOW_SECONDS);
  });

  it('[SEC-2.a] the window slides: 10 failures within any 15 minutes limit the next, even when the first was long after the client first appeared', async () => {
    const h = buildTestHarness();
    await registerUser(h);
    h.clock.advance(14 * MINUTE);
    await statuses(10, () => failingCredentialOps.login(h));
    h.clock.advance(2 * MINUTE);

    const next = await login(h, validSignUp.email, validSignUp.password);

    expectRateLimited(next, CREDENTIAL_WINDOW_SECONDS);
    expect(next.headers['retry-after']).toBe('780');
  });

  it('[SEC-2.a] a failure stays counted at exactly 15 minutes and leaves the window one second later, and Retry-After says when', async () => {
    const h = buildTestHarness();
    await failingCredentialOps.login(h);
    h.clock.advance(14 * MINUTE);
    const nine = await statuses(9, () => failingCredentialOps.login(h));

    const limited = await failingCredentialOps.login(h);
    h.clock.advance(MINUTE);
    const atExactly15 = await failingCredentialOps.login(h);
    h.clock.advance(SECOND);
    const oneMore = await failingCredentialOps.login(h);
    const thenLimited = await failingCredentialOps.login(h);

    expect(nine).toEqual(all(9, 401));
    expectRateLimited(limited, CREDENTIAL_WINDOW_SECONDS);
    expect(limited.headers['retry-after']).toBe('60');
    expectRateLimited(atExactly15, CREDENTIAL_WINDOW_SECONDS);
    expect(oneMore.status).toBe(401);
    expectRateLimited(thenLimited, CREDENTIAL_WINDOW_SECONDS);
  });
});

describe('SEC-2.b successful attempts do not count', () => {
  it('[SEC-2.b] 20 correct logins from one address are all 200', async () => {
    const h = buildTestHarness();
    await registerUser(h);

    const found = await statuses(20, () => login(h, validSignUp.email, validSignUp.password));

    expect(found).toEqual(all(20, 200));
  });

  it('[SEC-2.b] successes leave the failure count alone: after 9 failures and 20 logins, the 10th failure is 401 and the 11th is 429', async () => {
    const h = buildTestHarness();
    await registerUser(h);
    const nine = await statuses(9, () => failingCredentialOps.login(h));
    const logins = await statuses(20, () => login(h, validSignUp.email, validSignUp.password));

    const tenth = await failingCredentialOps.login(h);
    const eleventh = await failingCredentialOps.login(h);

    expect([...nine, ...logins]).toEqual([...all(9, 401), ...all(20, 200)]);
    expect(tenth.status).toBe(401);
    expect(tenth.body).toEqual(INVALID_CREDENTIALS);
    expectRateLimited(eleventh, CREDENTIAL_WINDOW_SECONDS);
  });

  it('[SEC-2.b] 12 passcodes verified from one address are all 200', async () => {
    const h = buildTestHarness();
    const found: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      const email = `person${i}@example.com`;
      await request(h.app)
        .post(SIGN_UP)
        .send({ ...validSignUp, email });
      const passcode = h.outbox.sentTo(email)[0]?.passcode as string;
      const res = await request(h.app)
        .post(VERIFY)
        .send({ email, passcode, password: validSignUp.password, phone: validSignUp.phone });
      found.push(res.status);
    }

    expect(found).toEqual(all(12, 200));
  });

  it('[SEC-2.b] 11 password resets that work, from one address, are all 204', async () => {
    const h = buildTestHarness();
    const found: number[] = [];
    for (let i = 0; i < 11; i += 1) {
      const email = `person${i}@example.com`;
      await h.users.insert(aUser(email));
      await requestReset(h, email);
      const passcode = h.outbox.sentTo(email)[0]?.passcode as string;
      found.push((await resetPassword(h, passcode, { email })).status);
    }

    expect(found).toEqual(all(11, 204));
  });
});

describe('SEC-2.c email-sending requests are limited', () => {
  it.each(EMAIL_OPS)(
    '[SEC-2.c] 20 requests spread over signUp, resendOtp and requestPasswordReset each send mail; the 21st %s is 429 and sends none',
    async (operation) => {
      const h = buildTestHarness();
      // Every request targets a real recipient, seeded directly so seeding spends none of the 20:
      // without a limiter each one, the 21st included, would send a passcode.
      const earlier = new Date(h.clock.now().getTime() - AFTER_COOLDOWN);
      const spread: EmailOp[] = [
        ...all(7, 0).map(() => 'signUp' as const),
        ...all(7, 0).map(() => 'resendOtp' as const),
        ...all(6, 0).map(() => 'requestPasswordReset' as const),
      ];
      const first: number[] = [];
      for (const [i, op] of spread.entries()) {
        if (op === 'resendOtp')
          await h.pendingSignUps.create(`person${i}@example.com`, 'placeholder-hmac', earlier);
        if (op === 'requestPasswordReset') await h.users.insert(aUser(`person${i}@example.com`));
        first.push((await emailOps[op](h, i)).status);
      }
      expect(first).toEqual(all(20, 202));
      expect(h.outbox.messages).toHaveLength(20);
      if (operation === 'resendOtp')
        await h.pendingSignUps.create('person99@example.com', 'placeholder-hmac', earlier);
      if (operation === 'requestPasswordReset') await h.users.insert(aUser('person99@example.com'));

      const next = await emailOps[operation](h, 99);

      expectRateLimited(next, EMAIL_WINDOW_SECONDS);
      expect(h.outbox.messages).toHaveLength(20);
    },
  );

  it('[SEC-2.c] the 20th sign-up is 202 and sends a passcode, the 21st is 429 and sends none', async () => {
    const h = buildTestHarness();
    const found = await statuses(20, (i) => emailOps.signUp(h, i));
    expect(h.outbox.messages).toHaveLength(20);

    const next = await emailOps.signUp(h, 20);

    expect(found).toEqual(all(20, 202));
    expectRateLimited(next, EMAIL_WINDOW_SECONDS);
    expect(h.outbox.messages).toHaveLength(20);
    expect(h.pendingSignUps.snapshot().map((pending) => pending.email)).not.toContain(
      'person20@example.com',
    );
  });

  it('[SEC-2.c] a sign-up for a registered email (409) counts too, so the limit cannot be used to probe emails', async () => {
    const h = buildTestHarness();
    await h.users.insert(aUser(validSignUp.email));
    const found = await statuses(20, () => request(h.app).post(SIGN_UP).send(validSignUp));

    const next = await request(h.app).post(SIGN_UP).send(validSignUp);

    expect(found).toEqual(all(20, 409));
    expectRateLimited(next, EMAIL_WINDOW_SECONDS);
  });

  it('[SEC-2.c] the window slides: a request stays counted at exactly an hour and leaves it a second later; hammering while limited does not extend the wait', async () => {
    const h = buildTestHarness();
    await emailOps.requestPasswordReset(h, 0);
    h.clock.advance(59 * MINUTE);
    const nineteen = await statuses(19, (i) => emailOps.requestPasswordReset(h, i + 1));

    const limited = await emailOps.requestPasswordReset(h, 50);
    h.clock.advance(MINUTE);
    const atExactlyAnHour = await emailOps.requestPasswordReset(h, 51);
    h.clock.advance(SECOND);
    const oneMore = await emailOps.requestPasswordReset(h, 52);
    const thenLimited = await emailOps.requestPasswordReset(h, 53);

    expect(nineteen).toEqual(all(19, 202));
    expectRateLimited(limited, EMAIL_WINDOW_SECONDS);
    expect(limited.headers['retry-after']).toBe('60');
    expectRateLimited(atExactlyAnHour, EMAIL_WINDOW_SECONDS);
    expect(oneMore.status).toBe(202);
    expectRateLimited(thenLimited, EMAIL_WINDOW_SECONDS);
  });

  it('[SEC-2.c] 10 failed logins do not limit sign-ups, and 20 emails do not limit logins', async () => {
    const h = buildTestHarness();
    await registerUser(h);
    await statuses(10, () => failingCredentialOps.login(h));
    // registerUser's own sign-up was the first of the 20.
    const signUps = await statuses(19, (i) => emailOps.signUp(h, i));
    const limitedEmail = await emailOps.signUp(h, 99);
    const limitedLogin = await login(h, validSignUp.email, validSignUp.password);

    expect(signUps).toEqual(all(19, 202));
    expectRateLimited(limitedEmail, EMAIL_WINDOW_SECONDS);
    expectRateLimited(limitedLogin, CREDENTIAL_WINDOW_SECONDS);

    const h2 = buildTestHarness();
    await registerUser(h2);
    await statuses(19, (i) => emailOps.resendOtp(h2, i));
    const stillOk = await login(h2, validSignUp.email, validSignUp.password);
    expect(stillOk.status).toBe(200);
  });
});

describe('SEC-2.d counts are per client address', () => {
  it('[SEC-2.d] behind one proxy, a second X-Forwarded-For address is not limited by the first one', async () => {
    const h = buildTestHarness({ config: BEHIND_ONE_PROXY });
    await registerUser(h);
    await statuses(10, () => failingCredentialOps.login(h, '203.0.113.1'));
    const limited = await failingCredentialOps.login(h, '203.0.113.1');

    const other = await failingCredentialOps.login(h, '203.0.113.2');
    const correct = await as(
      request(h.app).post(LOGIN).send({ email: validSignUp.email, password: validSignUp.password }),
      '203.0.113.2',
    );

    expectRateLimited(limited, CREDENTIAL_WINDOW_SECONDS);
    expect(other.status).toBe(401);
    expect(correct.status).toBe(200);
  });

  it('[SEC-2.d] the email limit is per address too', async () => {
    const h = buildTestHarness({ config: BEHIND_ONE_PROXY });
    await statuses(20, (i) => emailOps.signUp(h, i, '203.0.113.1'));
    const limited = await emailOps.signUp(h, 90, '203.0.113.1');

    const other = await emailOps.signUp(h, 91, '203.0.113.2');

    expectRateLimited(limited, EMAIL_WINDOW_SECONDS);
    expect(other.status).toBe(202);
  });

  it('[SEC-2.d] with one proxy hop only the address the proxy added counts: forged earlier entries do not dodge the limit', async () => {
    const h = buildTestHarness({ config: BEHIND_ONE_PROXY });
    await statuses(10, (i) => failingCredentialOps.login(h, `198.51.100.${i}, 203.0.113.7`));

    const next = await failingCredentialOps.login(h, '192.0.2.99, 203.0.113.7');

    expectRateLimited(next, CREDENTIAL_WINDOW_SECONDS);
  });

  it('[SEC-2.d] without TRUST_PROXY, X-Forwarded-For is ignored: every request from one socket shares one counter', async () => {
    const h = buildTestHarness();
    const first = await statuses(10, (i) => failingCredentialOps.login(h, `203.0.113.${i}`));

    const next = await failingCredentialOps.login(h, '203.0.113.200');
    const emails = await statuses(20, (i) => emailOps.signUp(h, i, `198.51.100.${i}`));
    const nextEmail = await emailOps.signUp(h, 99, '198.51.100.200');

    expect(first).toEqual(all(10, 401));
    expectRateLimited(next, CREDENTIAL_WINDOW_SECONDS);
    expect(emails).toEqual(all(20, 202));
    expectRateLimited(nextEmail, EMAIL_WINDOW_SECONDS);
  });

  // Pins the library's default of grouping IPv6 clients by their /56 network.
  it('[SEC-2.d] an IPv6 client cannot dodge the limit by changing the low bits of its address; another network is not limited', async () => {
    const h = buildTestHarness({ config: BEHIND_ONE_PROXY });
    await statuses(10, (i) => failingCredentialOps.login(h, `2001:db8:abcd:12::${i + 1}`));

    const sameNetwork = await failingCredentialOps.login(h, '2001:db8:abcd:12:ffff::1');
    const otherNetwork = await failingCredentialOps.login(h, '2001:db8:1234:12::1');

    expectRateLimited(sameNetwork, CREDENTIAL_WINDOW_SECONDS);
    expect(otherNetwork.status).toBe(401);
  });
});

describe('SEC-2 what the limiters sit in front of', () => {
  it('[SEC-2.a] unknown paths and unknown methods answer 404 NOT_FOUND and are never counted, limited or not', async () => {
    const h = buildTestHarness();
    const unknown = async () => [
      await request(h.app).post('/api/v1/auth/nowhere').send({}),
      await request(h.app).get(LOGIN),
      await request(h.app).put(SIGN_UP).send({}),
    ];
    for (let i = 0; i < 25; i += 1) {
      for (const res of await unknown())
        expect(answerOf(res)).toMatchObject({ status: 404, body: NOT_FOUND });
    }

    const credential = await statuses(10, () => failingCredentialOps.login(h));
    const email = await statuses(20, (i) => emailOps.signUp(h, i));
    expect(credential).toEqual(all(10, 401));
    expect(email).toEqual(all(20, 202));
    expectRateLimited(await failingCredentialOps.login(h), CREDENTIAL_WINDOW_SECONDS);
    expectRateLimited(await emailOps.signUp(h, 99), EMAIL_WINDOW_SECONDS);
    for (const res of await unknown())
      expect(answerOf(res)).toMatchObject({ status: 404, body: NOT_FOUND });
  });

  it('[SEC-2.a] a request that fails validation (400) is not a failed check: 25 of them leave all 10 failures available', async () => {
    const h = buildTestHarness();
    const invalid = await statuses(25, () =>
      request(h.app).post(LOGIN).send({ email: 'dana@example.com' }),
    );

    const failures = await statuses(10, () => failingCredentialOps.login(h));
    const next = await failingCredentialOps.login(h);

    expect(invalid).toEqual(all(25, 400));
    expect(failures).toEqual(all(10, 401));
    expectRateLimited(next, CREDENTIAL_WINDOW_SECONDS);
  });

  it.each(CREDENTIAL_OPS)(
    '[SEC-2.a] a limited client sending an invalid %s body still gets the 400 that names its fields, not a 429',
    async (operation) => {
      const h = buildTestHarness();
      await statuses(10, () => failingCredentialOps.login(h));
      const path = { login: LOGIN, verifyOtp: VERIFY, resetPassword: RESET }[operation];

      const res = await request(h.app).post(path).send({});

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'VALIDATION_FAILED' });
    },
  );

  it('[SEC-2.c] a request that fails validation (400) does not count as one of the 20 emails', async () => {
    const h = buildTestHarness();
    const invalid = await statuses(25, () =>
      request(h.app).post(SIGN_UP).send({ email: 'not an email' }),
    );

    const valid = await statuses(20, (i) => emailOps.signUp(h, i));
    const next = await emailOps.signUp(h, 99);

    expect(invalid).toEqual(all(25, 400));
    expect(valid).toEqual(all(20, 202));
    expectRateLimited(next, EMAIL_WINDOW_SECONDS);
  });

  it('[SEC-2.a] a 401 from the token check (getMe with a bad token) is not a failed credential check', async () => {
    const h = buildTestHarness();
    const bad = await statuses(25, () => getMe(h, 'Bearer not-a-token'));

    const failures = await statuses(10, () => failingCredentialOps.login(h));

    expect(bad).toEqual(all(25, 401));
    expect(failures).toEqual(all(10, 401));
  });

  it('[SEC-2.a] the token-secured getMe is never limited, even after both limits are used up', async () => {
    const h = buildTestHarness();
    const { token } = await registerUser(h);
    await statuses(10, () => failingCredentialOps.login(h));
    await statuses(19, (i) => emailOps.signUp(h, i)); // registerUser's sign-up was the 20th
    expectRateLimited(await failingCredentialOps.login(h), CREDENTIAL_WINDOW_SECONDS);

    const found = await statuses(60, () => getMe(h, bearer(token).Authorization));

    expect(found).toEqual(all(60, 200));
  });

  it('[SEC-2.a] listTransactions and createTransfer are never limited, even after both limits are used up', async () => {
    const h = buildTestHarness();
    const { token } = await registerUser(h);
    await h.users.insert(aUser('omer@example.com'));
    await statuses(10, () => failingCredentialOps.login(h));
    await statuses(19, (i) => emailOps.signUp(h, i)); // registerUser's sign-up was the 20th
    expectRateLimited(await failingCredentialOps.login(h), CREDENTIAL_WINDOW_SECONDS);
    expectRateLimited(await emailOps.signUp(h, 99), EMAIL_WINDOW_SECONDS);

    const listed = await statuses(60, () => request(h.app).get(TRANSACTIONS).set(bearer(token)));
    const sent = await statuses(60, () =>
      request(h.app)
        .post(TRANSFERS)
        .set(bearer(token))
        .send({ toEmail: 'omer@example.com', amount: 1 }),
    );

    expect(listed).toEqual(all(60, 200));
    expect(sent).toEqual(all(60, 201));
  });

  it('[SEC-2.d] a preflight from the front end is not counted against either limit', async () => {
    const h = buildTestHarness();
    for (let i = 0; i < 40; i += 1) {
      const res = await request(h.app)
        .options(LOGIN)
        .set('Origin', DEV_CORS_ORIGIN)
        .set('Access-Control-Request-Method', 'POST');
      expect(res.status).toBe(204);
    }

    const failures = await statuses(10, () => failingCredentialOps.login(h));
    const emails = await statuses(20, (i) => emailOps.signUp(h, i));

    expect(failures).toEqual(all(10, 401));
    expect(emails).toEqual(all(20, 202));
  });

  it('[SEC-2.a] a 429 to the front end carries its CORS headers, lets the page read Retry-After, and carries helmet headers', async () => {
    const h = buildTestHarness();
    await statuses(10, () => failingCredentialOps.login(h));

    const res = await failingCredentialOps.login(h).set('Origin', DEV_CORS_ORIGIN);

    expectRateLimited(res, CREDENTIAL_WINDOW_SECONDS);
    expect(res.headers['access-control-allow-origin']).toBe(DEV_CORS_ORIGIN);
    expect(res.headers['access-control-expose-headers']?.toLowerCase()).toContain('retry-after');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBeDefined();
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('[SEC-2.c] a 429 to another origin carries no Access-Control-Allow-Origin', async () => {
    const h = buildTestHarness();
    await statuses(20, (i) => emailOps.signUp(h, i));

    const res = await emailOps.signUp(h, 99).set('Origin', 'https://evil.example');

    expectRateLimited(res, EMAIL_WINDOW_SECONDS);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('[SEC-2.a] a 429 carries nothing about the client: its body is the same for every operation and headers differ only by Retry-After and Date', async () => {
    const h = buildTestHarness();
    await statuses(10, () => failingCredentialOps.login(h));
    await statuses(20, (i) => emailOps.signUp(h, i));

    const answers = [
      answerOf(await failingCredentialOps.login(h)),
      answerOf(await failingCredentialOps.verifyOtp(h)),
      answerOf(await failingCredentialOps.resetPassword(h)),
      answerOf(await emailOps.signUp(h, 98)),
      answerOf(await emailOps.resendOtp(h, 98)),
      answerOf(await emailOps.requestPasswordReset(h, 98)),
    ];

    const withoutRetryAfter = (headers: Record<string, unknown>) => {
      const rest = { ...headers };
      delete rest['retry-after'];
      return rest;
    };
    for (const answer of answers) {
      expect(answer.status).toBe(429);
      expect(answer.body).toEqual(RATE_LIMITED);
      expect(withoutRetryAfter(answer.headers)).toEqual(withoutRetryAfter(answers[0]!.headers));
    }
  });
});

describe('SEC-2.d TRUST_PROXY, how many proxies sit in front of the server', () => {
  const env = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    ...TEST_SECRETS,
    ...overrides,
  });

  it('[SEC-2.d] unset, blank and 0 all mean no proxy is trusted: the config says so', () => {
    expect(loadConfig(env()).trustProxy).toBe(0);
    expect(loadConfig(env({ TRUST_PROXY: '  ' })).trustProxy).toBe(0);
    expect(loadConfig(env({ TRUST_PROXY: '0' })).trustProxy).toBe(0);
  });

  it.each([
    ['1', 1],
    ['2', 2],
    [' 3 ', 3],
  ])('[SEC-2.d] TRUST_PROXY=%p is %p proxy hops', (value, hops) => {
    expect(loadConfig(env({ TRUST_PROXY: value })).trustProxy).toBe(hops);
  });

  it.each([
    'true',
    'false',
    '-1',
    '1.5',
    'one',
    '1 2',
    '0x1',
    '1e2',
    '99999999999999999999',
    'loopback',
  ])('[SEC-2.d] TRUST_PROXY=%p is refused at start-up, naming the variable', (value) => {
    const load = () => loadConfig(env({ TRUST_PROXY: value }));

    expect(load).toThrow(ConfigError);
    expect(load).toThrow(/TRUST_PROXY must be a whole number of proxy hops/);
  });

  it('[SEC-2.d] with TRUST_PROXY=0, X-Forwarded-For is ignored like when it is unset', async () => {
    const h = buildTestHarness({ config: { trustProxy: 0 } });
    await statuses(10, (i) => failingCredentialOps.login(h, `203.0.113.${i}`));

    const next = await failingCredentialOps.login(h, '203.0.113.200');

    expectRateLimited(next, CREDENTIAL_WINDOW_SECONDS);
  });
});
