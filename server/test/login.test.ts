import { describe, expect, it } from '@jest/globals';
import { decodeProtectedHeader, jwtVerify } from 'jose';
import request from 'supertest';
import { buildTestHarness, TEST_SECRETS } from './support/app';
import {
  answerOf,
  bearer,
  getMe,
  INVALID_CREDENTIALS,
  login,
  LOGIN,
  registerUser,
} from './support/auth';
import {
  aUser,
  fieldsOf,
  type Harness,
  HOUR,
  latestPasscode,
  MINUTE,
  passcodesSentTo,
  resend,
  SECOND,
  signUp,
  signUpForPasscode,
  validSignUp,
  verify,
  wrongPasscode,
} from './support/sign-up';

const PROBLEM_JSON = /^application\/problem\+json/;
const TOKEN_BODY = { accessToken: expect.any(String), tokenType: 'Bearer', expiresIn: 3600 };
const keyOf = (secret: string) => new TextEncoder().encode(secret);

/** The `sub` of a token the app issued, after checking it with the token secret. */
async function subjectOf(h: Harness, token: string): Promise<string | undefined> {
  const { payload } = await jwtVerify(token, keyOf(TEST_SECRETS.JWT_SECRET), {
    algorithms: ['HS256'],
    currentDate: h.clock.now(),
  });
  return payload.sub;
}

describe('LG-1 sign in with the right email and password', () => {
  it("[LG-1.a] a verified user's email and password answer 200 with an hour-long Bearer token", async () => {
    const h = buildTestHarness();
    await registerUser(h);

    const res = await login(h, validSignUp.email, validSignUp.password);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.body).toEqual(TOKEN_BODY);
  });

  it('[LG-1.a] the email in any letter case logs in to the same user', async () => {
    const h = buildTestHarness();
    const { user } = await registerUser(h);

    const res = await login(h, 'DANA@Example.Com', validSignUp.password);

    expect(res.status).toBe(200);
    expect(await subjectOf(h, res.body.accessToken)).toBe(user.id);
  });

  it("[LG-1.a] the token is an HS256 JWT whose sub is the user's id, issued by the injected clock and expiring an hour later", async () => {
    const h = buildTestHarness();
    const { user } = await registerUser(h);
    h.clock.advance(5 * MINUTE);
    const issuedAt = Math.floor(h.clock.now().getTime() / 1000);

    const res = await login(h, validSignUp.email, validSignUp.password);

    const token = res.body.accessToken as string;
    expect(decodeProtectedHeader(token).alg).toBe('HS256');
    const { payload } = await jwtVerify(token, keyOf(TEST_SECRETS.JWT_SECRET), {
      algorithms: ['HS256'],
      currentDate: h.clock.now(),
    });
    expect(payload.sub).toBe(user.id);
    expect(payload.iat).toBe(issuedAt);
    expect(payload.exp).toBe(issuedAt + 3600);
  });

  it("[LG-1.a] with two users, each login's token is for that user, and getMe with it returns that user's account", async () => {
    const h = buildTestHarness();
    const dana = await registerUser(h, 'dana@example.com', 'dana password');
    const omer = await registerUser(h, 'omer@example.com', 'omer password');

    const danaLogin = await login(h, 'dana@example.com', 'dana password');
    const omerLogin = await login(h, 'omer@example.com', 'omer password');

    expect(await subjectOf(h, danaLogin.body.accessToken)).toBe(dana.user.id);
    expect(await subjectOf(h, omerLogin.body.accessToken)).toBe(omer.user.id);
    const danaMe = await getMe(h, `Bearer ${danaLogin.body.accessToken}`);
    const omerMe = await getMe(h, `Bearer ${omerLogin.body.accessToken}`);
    expect(danaMe.status).toBe(200);
    expect(danaMe.body.id).toBe(dana.user.id);
    expect(omerMe.status).toBe(200);
    expect(omerMe.body.id).toBe(omer.user.id);
  });
});

describe('LG-2 wrong credentials get a generic error', () => {
  it('[LG-2.a] a wrong password answers 401 INVALID_CREDENTIALS', async () => {
    const h = buildTestHarness();
    await registerUser(h);

    const res = await login(h, validSignUp.email, 'not the password');

    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toMatch(PROBLEM_JSON);
    expect(res.body).toEqual(INVALID_CREDENTIALS);
  });

  it('[LG-2.a] a user whose stored password hash is not a hash string gets the same 401 as an unknown email, not a 500', async () => {
    const h = buildTestHarness();
    await h.users.insert(aUser('dana@example.com'));

    const malformedHash = await login(h, 'dana@example.com', validSignUp.password);
    const unknownEmail = await login(h, 'nobody@example.com', validSignUp.password);

    expect(malformedHash.status).toBe(401);
    expect(malformedHash.body).toEqual(INVALID_CREDENTIALS);
    expect(answerOf(malformedHash)).toEqual(answerOf(unknownEmail));
  });

  it("[LG-2.a] another user's password does not log in", async () => {
    const h = buildTestHarness();
    await registerUser(h, 'dana@example.com', 'dana password');
    await registerUser(h, 'omer@example.com', 'omer password');

    const res = await login(h, 'dana@example.com', 'omer password');

    expect(res.status).toBe(401);
    expect(res.body).toEqual(INVALID_CREDENTIALS);
  });

  it('[LG-2.a] a wrong password, an unknown email and a pending-only email get an identical 401 (status, body and every header but Date)', async () => {
    const h = buildTestHarness();
    await registerUser(h, 'dana@example.com');
    expect((await signUp(h, { ...validSignUp, email: 'pending@example.com' })).status).toBe(202);

    const wrongPassword = await login(h, 'dana@example.com', 'not the password');
    const unknownEmail = await login(h, 'nobody@example.com', 'not the password');
    // The sign-up form's password: a pending sign-up stores none, so even this one fails.
    const pendingOnly = await login(h, 'pending@example.com', validSignUp.password);

    expect(wrongPassword.body).toEqual(INVALID_CREDENTIALS);
    expect(answerOf(unknownEmail)).toEqual(answerOf(wrongPassword));
    expect(answerOf(pendingOnly)).toEqual(answerOf(wrongPassword));
  });

  it.each<[string, Record<string, unknown>, string[]]>([
    ['a malformed email', { email: 'not-an-email', password: 'any password' }, ['email']],
    ['an empty email', { email: '', password: 'any password' }, ['email']],
    ['no email', { password: 'any password' }, ['email']],
    ['an empty password', { email: 'dana@example.com', password: '' }, ['password']],
    ['no password', { email: 'dana@example.com' }, ['password']],
    [
      'a password of 73 characters',
      { email: 'dana@example.com', password: 'a'.repeat(73) },
      ['password'],
    ],
    [
      'a malformed email and an empty password',
      { email: 'not-an-email', password: '' },
      ['email', 'password'],
    ],
  ])('[LG-2.b] %s answers 400 VALIDATION_FAILED naming the field', async (_what, body, fields) => {
    const h = buildTestHarness();

    const res = await request(h.app).post(LOGIN).send(body);

    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toMatch(PROBLEM_JSON);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(fieldsOf(res.body)).toEqual(fields);
  });

  it('[LG-2.b] a password of 19 four-byte emoji (19 characters, 76 bytes) answers 400 with a readable byte-limit message', async () => {
    const h = buildTestHarness();
    const password = '😀'.repeat(19);
    expect(Buffer.byteLength(password, 'utf8')).toBe(76);

    const res = await login(h, 'dana@example.com', password);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(res.body.errors).toEqual([
      { field: 'password', message: 'must be at most 72 bytes in UTF-8' },
    ]);
  });

  it.each([
    ['72 ASCII characters', 'a'.repeat(72)],
    ['18 four-byte emoji (72 bytes)', '😀'.repeat(18)],
    ['1 character', 'a'],
  ])(
    '[LG-2.b] a password of %s is not refused by validation: an unknown email gets 401',
    async (_what, password) => {
      const h = buildTestHarness();

      const res = await login(h, 'nobody@example.com', password);

      expect(res.status).toBe(401);
      expect(res.body).toEqual(INVALID_CREDENTIALS);
    },
  );
});

describe('OTP-3 after a failed verification no user exists to log in as', () => {
  /** Each way a verification fails, with the sign-up form's email and password. */
  const failures: [string, (h: Harness) => Promise<void>][] = [
    [
      'a wrong passcode',
      async (h) => {
        const passcode = await signUpForPasscode(h);
        expect((await verify(h, wrongPasscode(passcode))).status).toBe(401);
      },
    ],
    [
      'a passcode burned by 5 wrong tries, then the right one',
      async (h) => {
        const passcode = await signUpForPasscode(h);
        for (let i = 0; i < 5; i += 1) await verify(h, wrongPasscode(passcode));
        expect((await verify(h, passcode)).status).toBe(401);
      },
    ],
    [
      'a passcode 10 minutes and 1 millisecond old',
      async (h) => {
        const passcode = await signUpForPasscode(h);
        h.clock.advance(10 * MINUTE + 1);
        expect((await verify(h, passcode)).status).toBe(401);
      },
    ],
    [
      'a pending sign-up 24 hours and 1 millisecond old, with a passcode sent 30 seconds before',
      async (h) => {
        await signUpForPasscode(h);
        h.clock.advance(24 * HOUR - 30 * SECOND);
        await resend(h);
        expect(passcodesSentTo(h)).toHaveLength(2);
        h.clock.advance(30 * SECOND + 1);
        expect((await verify(h, latestPasscode(h))).status).toBe(401);
      },
    ],
    [
      'no pending sign-up for the email',
      async (h) => {
        expect((await verify(h, '123456')).status).toBe(401);
      },
    ],
  ];

  it.each(failures)(
    '[OTP-3.e] after %s, login with the attempted email and password answers 401 INVALID_CREDENTIALS',
    async (_what, failVerification) => {
      const h = buildTestHarness();
      await failVerification(h);

      const res = await login(h, validSignUp.email, validSignUp.password);

      expect(res.status).toBe(401);
      expect(res.headers['content-type']).toMatch(PROBLEM_JSON);
      expect(res.body).toEqual(INVALID_CREDENTIALS);
    },
  );
});

describe('DB-2 the balance does not change by reading it or logging in again', () => {
  it('[DB-2.b] the balance is the same across repeated getMe calls and after a new login', async () => {
    const h = buildTestHarness();
    const { token, user } = await registerUser(h);

    const first = await getMe(h, `Bearer ${token}`);
    h.clock.advance(MINUTE);
    const second = await getMe(h, `Bearer ${token}`);
    const relogin = await login(h, validSignUp.email, validSignUp.password);
    expect(relogin.status).toBe(200);
    const afterLogin = await getMe(h, bearer(relogin.body.accessToken).Authorization);

    for (const res of [first, second, afterLogin]) {
      expect(res.status).toBe(200);
      expect(res.body.balance).toBe(user.balance);
    }
    expect((await h.users.findByEmail(validSignUp.email))?.balance).toBe(user.balance);
  });
});
