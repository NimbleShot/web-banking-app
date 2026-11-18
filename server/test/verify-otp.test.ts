import crypto from 'node:crypto';
import { describe, expect, it, jest } from '@jest/globals';
import argon2 from 'argon2';
import { jwtVerify } from 'jose';
import type request from 'supertest';
import { createLogger } from '../src/logger';
import { InMemoryPendingSignUpRepository } from '../src/repositories/pending-sign-ups';
import { DuplicateEmailError, InMemoryUserRepository, type User } from '../src/repositories/users';
import { createPasscodeService } from '../src/services/passcodes';
import { buildTestHarness, TEST_SECRETS } from './support/app';
import {
  AFTER_COOLDOWN,
  aUser,
  countingDraw,
  countingHasher,
  fieldsOf,
  type Harness,
  holdPasscodeUses,
  HOUR,
  latestPasscode,
  leavesOf,
  MINUTE,
  passcodesSentTo,
  resend,
  SECOND,
  signUpForPasscode,
  signUpServiceOf,
  validSignUp,
  verify,
  wrongPasscode,
} from './support/sign-up';

const PROBLEM_JSON = /^application\/problem\+json/;
const ARGON2ID = /^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/;
const PASSCODE_INVALID = {
  type: 'about:blank',
  title: 'Wrong or expired passcode',
  status: 401,
  code: 'PASSCODE_INVALID',
};
const TOKEN_BODY = { accessToken: expect.any(String), tokenType: 'Bearer', expiresIn: 3600 };

const keyOf = (secret: string) => new TextEncoder().encode(secret);

/** Everything a client can tell two answers apart by, except the Date header. */
const answerOf = (res: request.Response) => ({
  status: res.status,
  contentType: res.headers['content-type'],
  body: res.body as unknown,
});

/** The one stored user; fails if there isn't exactly one. */
function onlyUser(h: Harness) {
  const users = h.users.snapshot();
  expect(users).toHaveLength(1);
  return users[0]!;
}

describe('OTP-2 a correct passcode completes registration', () => {
  it('[OTP-2.a] a correct passcode, with the email in another letter case, answers 200 with an hour-long Bearer token', async () => {
    const h = buildTestHarness();
    const passcode = await signUpForPasscode(h);

    const res = await verify(h, passcode, { email: 'Dana@Example.COM' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.body).toEqual(TOKEN_BODY);
  });

  it('[OTP-2.a] it creates one verified user with the lowercased email, the phone and an argon2id hash of the password, and removes the pending sign-up', async () => {
    const h = buildTestHarness();
    const passcode = await signUpForPasscode(h);
    h.clock.advance(2 * MINUTE);

    await verify(h, passcode, { email: 'Dana@Example.COM', phone: '+15551234567' });

    const user = onlyUser(h);
    expect(user.email).toBe('dana@example.com');
    expect(user.phone).toBe('+15551234567');
    expect(user.passwordHash).toMatch(ARGON2ID);
    expect(await argon2.verify(user.passwordHash, validSignUp.password)).toBe(true);
    expect(user.createdAt).toEqual(h.clock.now());
    expect(typeof user.id).toBe('string');
    expect(user.id.length).toBeGreaterThan(0);
    expect(h.pendingSignUps.snapshot()).toHaveLength(0);
  });

  it("[OTP-2.b] the token is an HS256 JWT whose sub is the new user's id, issued by the injected clock and expiring an hour later", async () => {
    const h = buildTestHarness();
    const passcode = await signUpForPasscode(h);
    h.clock.advance(3 * MINUTE + 500);

    const res = await verify(h, passcode);

    const { payload, protectedHeader } = await jwtVerify(
      res.body.accessToken as string,
      keyOf(TEST_SECRETS.JWT_SECRET),
      { algorithms: ['HS256'], currentDate: h.clock.now() },
    );
    expect(protectedHeader.alg).toBe('HS256');
    expect(payload.sub).toBe(onlyUser(h).id);
    // The test clock reads 2026-01-01, not today: a token stamped by Date.now() fails here.
    expect(payload.iat).toBe(Math.floor(h.clock.now().getTime() / 1000));
    expect(payload.exp).toBe(payload.iat! + 3600);
  });

  it("[OTP-2.b] verifyOtp's token is signed with the token secret: it does not verify with the passcode secret", async () => {
    const h = buildTestHarness();
    const passcode = await signUpForPasscode(h);

    const res = await verify(h, passcode);

    expect(res.status).toBe(200);
    const options = { algorithms: ['HS256'], currentDate: h.clock.now() };
    const token = res.body.accessToken as string;
    await expect(jwtVerify(token, keyOf(TEST_SECRETS.JWT_SECRET), options)).resolves.toBeDefined();
    await expect(jwtVerify(token, keyOf(TEST_SECRETS.PASSCODE_SECRET), options)).rejects.toThrow();
  });

  it('[OTP-2.c] a passcode accepted once answers 401 PASSCODE_INVALID the second time and creates no second user', async () => {
    const h = buildTestHarness();
    const passcode = await signUpForPasscode(h);
    expect((await verify(h, passcode)).status).toBe(200);
    const [first] = h.users.snapshot();

    const again = await verify(h, passcode, { password: 'another password' });

    expect(again.status).toBe(401);
    expect(again.headers['content-type']).toMatch(PROBLEM_JSON);
    expect(again.body).toEqual(PASSCODE_INVALID);
    expect(h.users.snapshot()).toEqual([first]);
  });
});

describe('OTP-3 a wrong passcode is refused and the user stays unverified', () => {
  it('[OTP-3.a] a wrong passcode answers 401 PASSCODE_INVALID, creates no user and counts one wrong try', async () => {
    const h = buildTestHarness();
    const passcode = await signUpForPasscode(h);

    const res = await verify(h, wrongPasscode(passcode));

    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toMatch(PROBLEM_JSON);
    expect(res.body).toEqual(PASSCODE_INVALID);
    expect(h.users.snapshot()).toHaveLength(0);
    expect(h.pendingSignUps.snapshot().map((record) => record.passcode.wrongTries)).toEqual([1]);
  });

  it('[OTP-3.a] a wrong passcode costs no password hash; the correct one costs one', async () => {
    const h = buildTestHarness();
    const hasher = countingHasher();
    const service = signUpServiceOf(h, undefined, { passwords: hasher });
    await service.signUp(validSignUp.email);
    const passcode = latestPasscode(h);
    const attempt = { ...validSignUp, passcode };

    const wrong = await service.verify({ ...attempt, passcode: wrongPasscode(passcode) });

    expect(wrong).toEqual({ result: 'invalid' });
    expect(hasher.calls).toBe(0);
    expect((await service.verify(attempt)).result).toBe('verified');
    expect(hasher.calls).toBe(1);
  });

  it('[OTP-3.b] after 5 wrong tries the correct passcode answers 401 PASSCODE_INVALID too', async () => {
    const h = buildTestHarness();
    const passcode = await signUpForPasscode(h);
    for (let i = 0; i < 5; i += 1) {
      expect((await verify(h, wrongPasscode(passcode))).status).toBe(401);
    }

    const res = await verify(h, passcode);

    expect(res.status).toBe(401);
    expect(res.body).toEqual(PASSCODE_INVALID);
    expect(h.users.snapshot()).toHaveLength(0);
  });

  it('[OTP-3.b] after 4 wrong tries the correct passcode still verifies', async () => {
    const h = buildTestHarness();
    const passcode = await signUpForPasscode(h);
    for (let i = 0; i < 4; i += 1) {
      expect((await verify(h, wrongPasscode(passcode))).status).toBe(401);
    }

    const res = await verify(h, passcode);

    expect(res.status).toBe(200);
    expect(h.users.snapshot()).toHaveLength(1);
  });

  it("[OTP-3.b] after 5 wrong tries, the new passcode resendOtp sends verifies; the burned one doesn't", async () => {
    const h = buildTestHarness();
    const service = signUpServiceOf(h, countingDraw());
    await service.signUp(validSignUp.email);
    for (let i = 0; i < 5; i += 1) await verify(h, wrongPasscode('000001'));
    h.clock.advance(AFTER_COOLDOWN);

    await service.resend(validSignUp.email);

    expect(passcodesSentTo(h)).toEqual(['000001', '000002']);
    expect((await verify(h, '000001')).status).toBe(401);
    expect((await verify(h, '000002')).status).toBe(200);
    expect(h.users.snapshot()).toHaveLength(1);
  });

  it('[OTP-3.c] a passcode exactly 10 minutes old still verifies', async () => {
    const h = buildTestHarness();
    const passcode = await signUpForPasscode(h);
    h.clock.advance(10 * MINUTE);

    expect((await verify(h, passcode)).status).toBe(200);
  });

  it('[OTP-3.c] a passcode 10 minutes and 1 millisecond old answers 401 PASSCODE_INVALID and creates no user', async () => {
    const h = buildTestHarness();
    const passcode = await signUpForPasscode(h);
    h.clock.advance(10 * MINUTE + 1);

    const res = await verify(h, passcode);

    expect(res.status).toBe(401);
    expect(res.body).toEqual(PASSCODE_INVALID);
    expect(h.users.snapshot()).toHaveLength(0);
  });

  /**
   * A pending sign-up for `email` that is exactly 24 hours old plus `pastExpiryMs`, holding a
   * passcode sent 30 seconds before (a resend), so the 10-minute validity can't be what refuses it.
   * Returns that fresh passcode.
   */
  async function pendingNearExpiry(h: Harness, email: string, pastExpiryMs: number) {
    await signUpForPasscode(h, email);
    h.clock.advance(24 * HOUR - 30 * SECOND);
    await resend(h, email);
    expect(passcodesSentTo(h, email)).toHaveLength(2);
    h.clock.advance(30 * SECOND + pastExpiryMs);
    return latestPasscode(h, email);
  }

  /** The answer to a wrong passcode for another, live pending sign-up in the same app. */
  async function wrongPasscodeAnswer(h: Harness) {
    const passcode = await signUpForPasscode(h, 'other@example.com');
    return answerOf(await verify(h, wrongPasscode(passcode), { email: 'other@example.com' }));
  }

  /** Each case: what to set up (outside the attempt), then the attempt itself. */
  it.each<[string, (h: Harness) => Promise<() => Promise<request.Response>>]>([
    ['an unknown email', async (h) => () => verify(h, '123456', { email: 'unknown@example.com' })],
    [
      'an already verified email',
      async (h) => {
        await h.users.insert(aUser('verified@example.com'));
        return () => verify(h, '123456', { email: 'verified@example.com' });
      },
    ],
    [
      'a pending sign-up 24 hours and 1 millisecond old, with a passcode sent 30 seconds before',
      async (h) => {
        const passcode = await pendingNearExpiry(h, 'old@example.com', 1);
        return () => verify(h, passcode, { email: 'old@example.com' });
      },
    ],
  ])('[OTP-3.d] %s answers the same 401 PASSCODE_INVALID as a wrong passcode', async (_, setUp) => {
    const h = buildTestHarness();
    const attempt = await setUp(h);
    const usersBefore = h.users.snapshot();

    const res = await attempt();

    expect(h.users.snapshot()).toEqual(usersBefore);
    const wrong = await wrongPasscodeAnswer(h);
    expect(wrong.status).toBe(401);
    expect(wrong.body).toEqual(PASSCODE_INVALID);
    expect(answerOf(res)).toEqual(wrong);
  });

  it('[OTP-3.d] a pending sign-up exactly 24 hours old still verifies', async () => {
    const h = buildTestHarness();
    const passcode = await pendingNearExpiry(h, validSignUp.email, 0);

    expect((await verify(h, passcode)).status).toBe(200);
  });
});

describe('OTP-1 the passcode replaced by a resend', () => {
  it('[OTP-1.d] after a resend, verifyOtp with the previous passcode answers 401 and with the new one 200', async () => {
    const h = buildTestHarness();
    const service = signUpServiceOf(h, countingDraw());
    await service.signUp(validSignUp.email);
    h.clock.advance(AFTER_COOLDOWN);
    await service.resend(validSignUp.email);
    expect(passcodesSentTo(h)).toEqual(['000001', '000002']);

    const previous = await verify(h, '000001');

    expect(previous.status).toBe(401);
    expect(previous.body).toEqual(PASSCODE_INVALID);
    expect((await verify(h, '000002')).status).toBe(200);
  });
});

describe('SU-2 an email can be registered only once', () => {
  it('[SU-2.b] two concurrent verifications with the correct passcode: one 200, one 401 PASSCODE_INVALID, one user', async () => {
    const h = buildTestHarness();
    const passcode = await signUpForPasscode(h);
    // Both requests reach the pending sign-up store before either has used the passcode.
    holdPasscodeUses(h);

    const answers = await Promise.all([
      verify(h, passcode),
      verify(h, passcode, { password: 'another password' }),
    ]);

    const ok = answers.filter((res) => res.status === 200);
    const refused = answers.filter((res) => res.status === 401);
    expect(ok).toHaveLength(1);
    expect(ok[0]?.body).toEqual(TOKEN_BODY);
    expect(refused).toHaveLength(1);
    expect(refused[0]?.body).toEqual(PASSCODE_INVALID);
    expect(onlyUser(h).email).toBe(validSignUp.email);
  });

  it('[SU-2.b] two racing verifications in the service: one verified, one invalid, one user, one hash', async () => {
    const h = buildTestHarness();
    const hasher = countingHasher();
    const service = signUpServiceOf(h, undefined, { passwords: hasher });
    await service.signUp(validSignUp.email);
    const attempt = { ...validSignUp, passcode: latestPasscode(h) };

    const outcomes = await Promise.all([
      service.verify(attempt),
      service.verify({ ...attempt, email: 'DANA@example.com', password: 'another password' }),
    ]);

    expect(outcomes.map((outcome) => outcome.result).sort()).toEqual(['invalid', 'verified']);
    const user = onlyUser(h);
    const winner = outcomes.find((outcome) => outcome.result === 'verified');
    expect(winner).toEqual({ result: 'verified', user });
    // A racer that also passed the passcode check would have hashed too.
    expect(hasher.calls).toBe(1);
  });

  it('[SU-2.b] the pending sign-up store uses up a passcode for only one of two racing uses', async () => {
    const store = new InMemoryPendingSignUpRepository();
    const now = new Date('2026-01-01T09:00:00.000Z');
    await store.create('dana@example.com', 'a'.repeat(64), now);

    const results = await Promise.all([
      store.usePasscode('dana@example.com', 'a'.repeat(64), now),
      store.usePasscode('dana@example.com', 'a'.repeat(64), now),
    ]);

    expect(results.sort()).toEqual([false, true]);
    expect(store.snapshot()).toHaveLength(0);
  });

  it('[SU-2.d] the user store refuses a second user with the same email, called directly with no look-up first', async () => {
    const users = new InMemoryUserRepository();
    const first = await users.insert(aUser('dana@example.com'));

    await expect(
      users.insert({ ...aUser('dana@example.com'), phone: '+15551234567', balance: 1 }),
    ).rejects.toBeInstanceOf(DuplicateEmailError);

    expect(users.snapshot()).toEqual([first]);
  });

  it('[SU-2.d] the user store refuses a second user whose email differs only in letter case', async () => {
    const users = new InMemoryUserRepository();
    const first = await users.insert(aUser('dana@example.com'));

    await expect(users.insert(aUser('Dana@Example.COM'))).rejects.toBeInstanceOf(
      DuplicateEmailError,
    );

    expect(users.snapshot()).toEqual([first]);
  });

  it('[SU-2.d] the user store stores the email it keys on: a direct insert of a mixed-case email stores it lowercased', async () => {
    const users = new InMemoryUserRepository();

    const stored = await users.insert(aUser('Dana@Example.COM'));

    expect(stored.email).toBe('dana@example.com');
    expect(users.snapshot().map((user) => user.email)).toEqual(['dana@example.com']);
    expect((await users.findByEmail('dana@example.com'))?.id).toBe(stored.id);
  });

  it('[SU-2.d] of two racing inserts of one email, the user store keeps one and refuses the other', async () => {
    const users = new InMemoryUserRepository();

    const results = await Promise.allSettled([
      users.insert(aUser('dana@example.com')),
      users.insert({ ...aUser('dana@example.com'), balance: 1 }),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    const refused = results.find((result) => result.status === 'rejected');
    expect(refused?.reason).toBeInstanceOf(DuplicateEmailError);
    expect(users.snapshot()).toHaveLength(1);
  });

  it('[SU-2.d] verifyOtp for an email that became a user after its passcode was checked answers 401 PASSCODE_INVALID and adds no user', async () => {
    const h = buildTestHarness();
    const passcode = await signUpForPasscode(h);
    // Another way of creating the user lands between the passcode check and the insert, and no
    // look-up sees it: only the store's own refusal can stop a second user.
    let existing: User | undefined;
    const usePasscode = h.pendingSignUps.usePasscode.bind(h.pendingSignUps);
    h.pendingSignUps.usePasscode = async (email, hmac, now) => {
      const used = await usePasscode(email, hmac, now);
      if (used) existing = await h.users.insert(aUser(validSignUp.email));
      return used;
    };
    h.users.findByEmail = async () => undefined;

    const res = await verify(h, passcode);

    expect(existing).toBeDefined();
    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toMatch(PROBLEM_JSON);
    expect(res.body).toEqual(PASSCODE_INVALID);
    expect(h.users.snapshot()).toEqual([existing]);
    expect(h.pendingSignUps.snapshot()).toHaveLength(0);
  });
});

describe('DB-2 a random balance is set once, at sign-up', () => {
  it.each([
    [1_000, 100_000],
    [10_000, 1_000_000],
  ])(
    '[DB-2.a] a stubbed draw of %p shekels gives a starting balance of %p agorot',
    async (draw, agorot) => {
      const h = buildTestHarness();
      const calls: [number, number][] = [];
      const service = signUpServiceOf(h, undefined, {
        balanceDraw: (min, max) => {
          calls.push([min, max]);
          return draw;
        },
      });
      await service.signUp(validSignUp.email);

      const outcome = await service.verify({ ...validSignUp, passcode: latestPasscode(h) });

      expect(calls).toEqual([[1_000, 10_001]]);
      expect(outcome.result).toBe('verified');
      expect(onlyUser(h).balance).toBe(agorot);
    },
  );

  it('[DB-2.a] the default draw is crypto.randomInt(1_000, 10_001)', async () => {
    const h = buildTestHarness();
    const passcode = await signUpForPasscode(h);
    const spy = jest.spyOn(crypto, 'randomInt').mockImplementation((() => 4_321) as never);
    try {
      const outcome = await signUpServiceOf(h).verify({ ...validSignUp, passcode });

      expect(outcome.result).toBe('verified');
      expect(spy.mock.calls).toEqual([[1_000, 10_001]]);
    } finally {
      spy.mockRestore();
    }
    expect(onlyUser(h).balance).toBe(432_100);
  });

  it('[DB-2.a] a real draw over HTTP gives a whole number of shekels from 1,000 to 10,000', async () => {
    const h = buildTestHarness();
    const passcode = await signUpForPasscode(h);

    expect((await verify(h, passcode)).status).toBe(200);

    const { balance } = onlyUser(h);
    expect(Number.isInteger(balance)).toBe(true);
    expect(balance % 100).toBe(0);
    expect(balance).toBeGreaterThanOrEqual(100_000);
    expect(balance).toBeLessThanOrEqual(1_000_000);
  });
});

describe('SEC-1 passwords are stored only as a slow, salted hash', () => {
  const password = 'Unique-Pa55phrase!';

  it('[SEC-1.a] the stored password is only an argon2id hash (19 MiB, t=2, p=1); no stored field of a user or a pending sign-up equals or contains it', async () => {
    const h = buildTestHarness();
    const passcode = await signUpForPasscode(h);
    // A failed attempt carries the password too: the pending sign-up must not keep it.
    await verify(h, wrongPasscode(passcode), { password });
    const pendingLeaves = leavesOf(h.pendingSignUps.snapshot());
    expect(pendingLeaves.length).toBeGreaterThan(0);

    expect((await verify(h, passcode, { password })).status).toBe(200);

    const user = onlyUser(h);
    expect(user.passwordHash).toMatch(ARGON2ID);
    expect(await argon2.verify(user.passwordHash, password)).toBe(true);
    for (const leaf of [...pendingLeaves, ...leavesOf(user)]) {
      expect(leaf).not.toBe(password);
      if (typeof leaf === 'string') expect(leaf).not.toContain(password);
    }
  });

  it('[SEC-1.b] two users with the same password get different hashes, and each verifies', async () => {
    const h = buildTestHarness();
    for (const email of ['dana@example.com', 'noa@example.com']) {
      const passcode = await signUpForPasscode(h, email);
      expect((await verify(h, passcode, { email, password })).status).toBe(200);
    }

    const hashes = h.users.snapshot().map((user) => user.passwordHash);

    expect(hashes).toHaveLength(2);
    expect(hashes[0]).not.toBe(hashes[1]);
    for (const hash of hashes) expect(await argon2.verify(hash, password)).toBe(true);
  });
});

describe('SU-3 verifyOtp applies the sign-up rules without using up the passcode', () => {
  it.each([
    ['a password of 7 characters', { password: 'a'.repeat(7) }, 'password'],
    ['a password of 73 characters', { password: 'a'.repeat(73) }, 'password'],
    ['a password of 19 four-byte emoji (76 bytes)', { password: '😀'.repeat(19) }, 'password'],
    ['a local phone number', { phone: '0501234567' }, 'phone'],
    ['a phone with spaces', { phone: '+972 50 123 4567' }, 'phone'],
  ])(
    '[SU-3.e] verifyOtp with %s answers 400 for that field and leaves the passcode usable',
    async (_, invalid, field) => {
      const h = buildTestHarness();
      const passcode = await signUpForPasscode(h);

      const res = await verify(h, passcode, invalid);

      expect(res.status).toBe(400);
      expect(res.headers['content-type']).toMatch(PROBLEM_JSON);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect(fieldsOf(res.body)).toEqual([field]);
      expect(h.users.snapshot()).toHaveLength(0);
      expect(h.pendingSignUps.snapshot().map((record) => record.passcode.wrongTries)).toEqual([0]);
      expect((await verify(h, passcode)).status).toBe(200);
    },
  );
});

describe('SU-3 verifyOtp accepts the edges of the sign-up rules', () => {
  it.each([
    ['a password of 8 characters', { password: 'a'.repeat(8) }],
    ['a password of 72 characters', { password: 'a'.repeat(72) }],
    ['a password of 18 four-byte emoji (72 bytes)', { password: '😀'.repeat(18) }],
    ['the shortest E.164 phone, +1234567', { phone: '+1234567' }],
    ['the longest E.164 phone, +123456789012345', { phone: '+123456789012345' }],
  ])('[SU-3.e] verifyOtp accepts %s', async (_, valid) => {
    const h = buildTestHarness();
    const passcode = await signUpForPasscode(h);

    const res = await verify(h, passcode, valid);

    expect(res.status).toBe(200);
    const user = onlyUser(h);
    if ('phone' in valid) expect(user.phone).toBe(valid.phone);
    if ('password' in valid)
      expect(await argon2.verify(user.passwordHash, valid.password)).toBe(true);
  });
});

describe('SEC-5 no secret reaches the logs', () => {
  it('[SEC-5.a] verifications logged at trace level carry no password, passcode, passcode HMAC, password hash, token or server secret', async () => {
    const lines: string[] = [];
    const logger = createLogger('trace', { write: (line: string) => void lines.push(line) });
    const h = buildTestHarness({ logger });
    const password = 'Unique-Pa55phrase!';
    // A known passcode, matched below as a whole number so no timestamp can contain it by chance.
    await signUpServiceOf(h, () => 424_242).signUp(validSignUp.email);
    expect(passcodesSentTo(h)).toEqual(['424242']);
    await verify(h, wrongPasscode('424242'), { password });

    const res = await verify(h, '424242', { password });

    expect(res.status).toBe(200);
    const hmac = createPasscodeService({ secret: TEST_SECRETS.PASSCODE_SECRET }).hmac(
      'signup',
      validSignUp.email,
      '424242',
    );
    const secrets = [
      password,
      hmac,
      onlyUser(h).passwordHash,
      res.body.accessToken as string,
      TEST_SECRETS.JWT_SECRET,
      TEST_SECRETS.PASSCODE_SECRET,
    ];
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const line of lines) {
      expect(line).not.toMatch(/(?<!\d)424242(?!\d)/);
      for (const secret of secrets) expect(line).not.toContain(secret);
    }
  });
});
