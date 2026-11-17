import { describe, expect, it } from '@jest/globals';
import argon2 from 'argon2';
import type request from 'supertest';
import { createLogger } from '../src/logger';
import { InMemoryPasswordResetRepository } from '../src/repositories/password-resets';
import { InMemoryPendingSignUpRepository } from '../src/repositories/pending-sign-ups';
import { InMemoryUserRepository } from '../src/repositories/users';
import { buildTestHarness, TEST_SECRETS } from './support/app';
import { answerOf, bearer, getMe, INVALID_CREDENTIALS, login, registerUser } from './support/auth';
import {
  hmacOf,
  holdResetPasscodeUses,
  latestResetPasscode,
  NEW_PASSWORD,
  requestReset,
  resetPassword,
  resetPasscodesSentTo,
  resetServiceOf,
  userWithResetPasscode,
} from './support/password-reset';
import {
  AFTER_COOLDOWN,
  aUser,
  countingDraw,
  countingHasher,
  fieldsOf,
  type Harness,
  HOUR,
  leavesOf,
  MINUTE,
  passcodesSentTo,
  SECOND,
  signUp,
  signUpForPasscode,
  signUpServiceOf,
  validSignUp,
  verify,
  wrongPasscode,
} from './support/sign-up';

const PROBLEM_JSON = /^application\/problem\+json/;
const SIX_DIGITS = /^\d{6}$/;
const ARGON2ID = /^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/;
const PASSCODE_INVALID = {
  type: 'about:blank',
  title: 'Wrong or expired passcode',
  status: 401,
  code: 'PASSCODE_INVALID',
};
const dana = validSignUp.email;
const start = new Date('2026-01-01T09:00:00.000Z');

/** The one stored reset record; fails if there isn't exactly one. */
function onlyReset(h: Harness) {
  const records = h.passwordResets.snapshot();
  expect(records).toHaveLength(1);
  return records[0]!;
}

const wrongTriesOf = (h: Harness) => h.passwordResets.snapshot().map((r) => r.passcode.wrongTries);

/** A verified user (no password hash that could log in) and the reset sends up to `count`. */
async function requestResets(h: Harness, count: number) {
  await h.users.insert(aUser());
  await requestReset(h);
  for (let i = 1; i < count; i += 1) {
    h.clock.advance(AFTER_COOLDOWN);
    await requestReset(h);
  }
  expect(resetPasscodesSentTo(h)).toHaveLength(count);
}

describe('PW-1 a verified user asks for a reset passcode', () => {
  it('[PW-1.a] a verified email in another letter case answers 202 with no body and sends one reset passcode to the lowercased email', async () => {
    const h = buildTestHarness();
    await registerUser(h);

    const res = await requestReset(h, 'DANA@Example.Com');

    expect(res.status).toBe(202);
    expect(res.text).toBe('');
    expect(res.body).toEqual({});
    const sent = h.outbox.sentTo(dana).filter((message) => message.purpose === 'reset');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.passcode).toMatch(SIX_DIGITS);
    expect(onlyReset(h).email).toBe(dana);
  });

  it('[PW-1.a] the stored state holds the reset-purpose HMAC of the passcode and never the passcode (a known draw of 424242)', async () => {
    const h = buildTestHarness();
    await h.users.insert(aUser());

    await resetServiceOf(h, () => 424_242).request('Dana@Example.com');

    expect(resetPasscodesSentTo(h)).toEqual(['424242']);
    const leaves = leavesOf(h.passwordResets.snapshot());
    expect(leaves).not.toContain('424242');
    expect(leaves).not.toContain(424_242);
    expect(leaves).toContain(hmacOf('reset', dana, '424242'));
  });

  it('[PW-1.a] a passcode exactly 10 minutes old still resets the password', async () => {
    const h = buildTestHarness();
    const { passcode } = await userWithResetPasscode(h);
    h.clock.advance(10 * MINUTE);

    expect((await resetPassword(h, passcode)).status).toBe(204);
  });

  it('[PW-1.a] after 4 wrong tries the correct passcode still resets the password', async () => {
    const h = buildTestHarness();
    const { passcode } = await userWithResetPasscode(h);
    for (let i = 0; i < 4; i += 1) {
      expect((await resetPassword(h, wrongPasscode(passcode))).status).toBe(401);
    }

    expect((await resetPassword(h, passcode)).status).toBe(204);
  });

  it('[PW-1.a] after 5 wrong tries the passcode is burned, and the new passcode a later request sends works', async () => {
    const h = buildTestHarness();
    await h.users.insert(aUser());
    const service = resetServiceOf(h, countingDraw());
    await service.request(dana);
    for (let i = 0; i < 5; i += 1) await resetPassword(h, wrongPasscode('000001'));
    h.clock.advance(AFTER_COOLDOWN);

    await service.request(dana);

    expect(resetPasscodesSentTo(h)).toEqual(['000001', '000002']);
    expect((await resetPassword(h, '000001')).status).toBe(401);
    expect((await resetPassword(h, '000002')).status).toBe(204);
  });

  it('[PW-1.a] a new request after the cooldown replaces the passcode: the old one no longer works, the new one does', async () => {
    const h = buildTestHarness();
    await h.users.insert(aUser());
    const service = resetServiceOf(h, countingDraw());
    await service.request(dana);
    h.clock.advance(AFTER_COOLDOWN);
    await service.request(dana);
    expect(resetPasscodesSentTo(h)).toEqual(['000001', '000002']);

    expect((await resetPassword(h, '000001')).status).toBe(401);
    expect((await resetPassword(h, '000002')).status).toBe(204);
  });

  it('[PW-1.a] a request within 60 seconds answers the same 202, sends nothing and keeps the passcode', async () => {
    const h = buildTestHarness();
    const { passcode } = await userWithResetPasscode(h);
    h.clock.advance(59 * SECOND);

    const res = await requestReset(h);

    expect(res.status).toBe(202);
    expect(res.text).toBe('');
    expect(resetPasscodesSentTo(h)).toEqual([passcode]);
    expect((await resetPassword(h, passcode)).status).toBe(204);
  });

  it('[PW-1.a] a request exactly 60 seconds after the last passcode still sends nothing', async () => {
    const h = buildTestHarness();
    await requestResets(h, 1);
    h.clock.advance(60 * SECOND);

    const res = await requestReset(h);

    expect(res.status).toBe(202);
    expect(resetPasscodesSentTo(h)).toHaveLength(1);
  });

  it('[PW-1.a] a request 60 seconds and 1 millisecond after the last passcode sends a new one', async () => {
    const h = buildTestHarness();
    await requestResets(h, 1);
    h.clock.advance(60 * SECOND + 1);

    await requestReset(h);

    expect(resetPasscodesSentTo(h)).toHaveLength(2);
  });

  it('[PW-1.a] the cooldown runs from the latest passcode, not the first', async () => {
    const h = buildTestHarness();
    await requestResets(h, 2);
    h.clock.advance(30 * SECOND);

    const res = await requestReset(h);

    expect(res.status).toBe(202);
    expect(resetPasscodesSentTo(h)).toHaveLength(2);
  });

  it('[PW-1.a] after 5 passcodes in an hour a request sends nothing; exactly an hour after the oldest it still sends nothing, and 1 ms later it sends', async () => {
    const h = buildTestHarness();
    await requestResets(h, 5);

    h.clock.advance(AFTER_COOLDOWN);
    const capped = await requestReset(h);
    expect(capped.status).toBe(202);
    expect(capped.text).toBe('');
    expect(resetPasscodesSentTo(h)).toHaveLength(5);

    // The oldest passcode went out 4 × 61 s + 61 s ago; move to exactly one hour after it.
    h.clock.advance(HOUR - 5 * AFTER_COOLDOWN);
    await requestReset(h);
    expect(resetPasscodesSentTo(h)).toHaveLength(5);

    h.clock.advance(1);
    await requestReset(h);
    expect(resetPasscodesSentTo(h)).toHaveLength(6);
  });

  it('[PW-1.a] the 10 minutes restart when a new request replaces the passcode: 14 minutes after the first request, the second passcode resets and the first does not', async () => {
    const h = buildTestHarness();
    await h.users.insert(aUser());
    const service = resetServiceOf(h, countingDraw());
    await service.request(dana);
    h.clock.advance(9 * MINUTE);
    await service.request(dana);
    expect(resetPasscodesSentTo(h)).toEqual(['000001', '000002']);
    h.clock.advance(5 * MINUTE);

    expect((await resetPassword(h, '000001')).status).toBe(401);
    expect((await resetPassword(h, '000002')).status).toBe(204);
  });

  it('[PW-1.a] a request the cooldown holds back does not restart the cooldown: sent at 0, held at 50 s, sent at 61 s', async () => {
    const h = buildTestHarness();
    await requestResets(h, 1);
    h.clock.advance(50 * SECOND);
    await requestReset(h);
    expect(resetPasscodesSentTo(h)).toHaveLength(1);

    h.clock.advance(11 * SECOND);
    await requestReset(h);

    expect(resetPasscodesSentTo(h)).toHaveLength(2);
  });

  it('[PW-1.a] a request the cooldown holds back does not count toward the cap: 4 sent, one held, then the 5th is still sent', async () => {
    const h = buildTestHarness();
    await requestResets(h, 4);
    h.clock.advance(30 * SECOND);
    await requestReset(h);
    expect(resetPasscodesSentTo(h)).toHaveLength(4);

    h.clock.advance(31 * SECOND);
    await requestReset(h);

    expect(resetPasscodesSentTo(h)).toHaveLength(5);
  });

  it('[PW-1.a] a request the cap holds back does not count either: when the oldest send is an hour old, the next request sends', async () => {
    const h = buildTestHarness();
    await requestResets(h, 5);
    // Ten requests refused by the cap, spaced outside the cooldown, over the next half hour.
    for (let i = 0; i < 10; i += 1) {
      h.clock.advance(AFTER_COOLDOWN);
      await requestReset(h);
    }
    expect(resetPasscodesSentTo(h)).toHaveLength(5);
    // Now is 14 × 61 s after the first send; move to 1 h + 1 ms after it, when one slot is free.
    h.clock.advance(HOUR + 1 - 14 * AFTER_COOLDOWN);
    await requestReset(h);

    expect(resetPasscodesSentTo(h)).toHaveLength(6);
  });

  it('[PW-1.a] the cooldown counts from a passcode that a reset already used: request at 0, reset at 5 s, request at 6 s sends nothing', async () => {
    const h = buildTestHarness();
    const { passcode } = await userWithResetPasscode(h);
    h.clock.advance(5 * SECOND);
    expect((await resetPassword(h, passcode)).status).toBe(204);
    h.clock.advance(SECOND);

    const res = await requestReset(h);

    expect(res.status).toBe(202);
    expect(resetPasscodesSentTo(h)).toEqual([passcode]);
  });

  it('[PW-1.a] after a reset a request exactly 60 s after the last passcode still sends nothing, and 1 ms later it sends a new, working one', async () => {
    const h = buildTestHarness();
    await h.users.insert(aUser());
    const service = resetServiceOf(h, countingDraw());
    await service.request(dana);
    h.clock.advance(5 * SECOND);
    expect((await resetPassword(h, '000001')).status).toBe(204);
    h.clock.advance(55 * SECOND);
    await service.request(dana);
    expect(resetPasscodesSentTo(h)).toEqual(['000001']);

    h.clock.advance(1);
    await service.request(dana);

    // The held request drew 000002 but sent nothing.
    expect(resetPasscodesSentTo(h)).toEqual(['000001', '000003']);
    expect((await resetPassword(h, '000001')).status).toBe(401);
    expect((await resetPassword(h, '000003')).status).toBe(204);
  });

  it('[PW-1.a] the 5 per hour cap counts the passcodes sent before a reset: 5 sent, the 5th used by a reset, a 6th request sends nothing', async () => {
    const h = buildTestHarness();
    await h.users.insert(aUser());
    const service = resetServiceOf(h, countingDraw());
    await service.request(dana);
    for (let i = 0; i < 4; i += 1) {
      h.clock.advance(AFTER_COOLDOWN);
      await service.request(dana);
    }
    expect(resetPasscodesSentTo(h)).toHaveLength(5);
    expect((await resetPassword(h, '000005')).status).toBe(204);
    h.clock.advance(AFTER_COOLDOWN);

    const res = await requestReset(h);

    expect(res.status).toBe(202);
    expect(resetPasscodesSentTo(h)).toHaveLength(5);
  });

  it('[PW-1.a] two concurrent requests outside the cooldown send one passcode', async () => {
    const h = buildTestHarness();
    await requestResets(h, 1);
    h.clock.advance(AFTER_COOLDOWN);

    const answers = await Promise.all([requestReset(h), requestReset(h)]);

    expect(answers.map((res) => res.status)).toEqual([202, 202]);
    expect(resetPasscodesSentTo(h)).toHaveLength(2);
  });

  it('[PW-1.a] two racing first requests in the service send one passcode', async () => {
    const h = buildTestHarness();
    await h.users.insert(aUser());
    const service = resetServiceOf(h);

    await Promise.all([service.request(dana), service.request('DANA@example.com')]);

    expect(resetPasscodesSentTo(h)).toHaveLength(1);
  });

  it('[PW-1.a] two racing requests in the service outside the cooldown send one new passcode', async () => {
    const h = buildTestHarness();
    await h.users.insert(aUser());
    const service = resetServiceOf(h);
    await service.request(dana);
    h.clock.advance(AFTER_COOLDOWN);

    await Promise.all([service.request(dana), service.request(dana)]);

    expect(resetPasscodesSentTo(h)).toHaveLength(2);
  });

  it('[PW-1.a] the reset store takes a new passcode for only one of two racing issues', async () => {
    const store = new InMemoryPasswordResetRepository();
    await store.issue(dana, 'a'.repeat(64), start);
    const later = new Date(start.getTime() + AFTER_COOLDOWN);

    const results = await Promise.all([
      store.issue(dana, 'b'.repeat(64), later),
      store.issue(dana, 'c'.repeat(64), later),
    ]);

    expect(results.sort()).toEqual([false, true]);
  });

  it('[PW-1.a] the reset store keeps its record when the cooldown holds a new passcode back', async () => {
    const store = new InMemoryPasswordResetRepository();
    expect(await store.issue(dana, 'a'.repeat(64), start)).toBe(true);
    const before = store.snapshot();

    const held = await store.issue(dana, 'b'.repeat(64), new Date(start.getTime() + 60 * SECOND));

    expect(held).toBe(false);
    expect(store.snapshot()).toEqual(before);
    expect(before.map((r) => r.passcode.hmac)).toEqual(['a'.repeat(64)]);
  });
});

describe('PW-1 an unknown or pending-only email gets the same answer and nothing is sent', () => {
  it('[PW-1.b] an unknown email answers 202 with no body, sends nothing and stores nothing', async () => {
    const h = buildTestHarness();

    const res = await requestReset(h, 'Unknown@Example.com');

    expect(res.status).toBe(202);
    expect(res.text).toBe('');
    expect(h.outbox.messages).toHaveLength(0);
    expect(h.passwordResets.snapshot()).toEqual([]);
  });

  it('[PW-1.b] an email whose sign-up is only pending answers 202, sends no reset passcode, stores nothing and leaves the sign-up passcode usable', async () => {
    const h = buildTestHarness();
    const signUpPasscode = await signUpForPasscode(h);

    const res = await requestReset(h);

    expect(res.status).toBe(202);
    expect(res.text).toBe('');
    expect(h.outbox.messages.map((m) => m.purpose)).toEqual(['signup']);
    expect(h.passwordResets.snapshot()).toEqual([]);
    expect(h.pendingSignUps.snapshot().map((r) => r.passcode.wrongTries)).toEqual([0]);
    expect((await verify(h, signUpPasscode)).status).toBe(200);
  });

  it('[PW-1.b] the reset service sends nothing and stores nothing for an unknown email', async () => {
    const h = buildTestHarness();

    await resetServiceOf(h).request('nobody@example.com');

    expect(h.outbox.messages).toHaveLength(0);
    expect(h.passwordResets.snapshot()).toEqual([]);
  });
});

describe('PW-1 a correct passcode and a valid new password change the password', () => {
  it('[PW-1.c] answers 204 with no body, and login accepts the new password', async () => {
    const h = buildTestHarness();
    const { passcode } = await userWithResetPasscode(h);

    const res = await resetPassword(h, passcode);

    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect((await login(h, dana, NEW_PASSWORD)).status).toBe(200);
  });

  it('[PW-1.c] login answers the old password 401 INVALID_CREDENTIALS', async () => {
    const h = buildTestHarness();
    const { passcode } = await userWithResetPasscode(h);
    await resetPassword(h, passcode);

    const res = await login(h, dana, validSignUp.password);

    expect(res.status).toBe(401);
    expect(res.body).toEqual(INVALID_CREDENTIALS);
  });

  it('[PW-1.c] the passcode is used up: the same passcode again answers 401 PASSCODE_INVALID and the first new password stays', async () => {
    const h = buildTestHarness();
    const { passcode } = await userWithResetPasscode(h);
    await resetPassword(h, passcode);

    const again = await resetPassword(h, passcode, { password: 'yet another password' });

    expect(again.status).toBe(401);
    expect(again.body).toEqual(PASSCODE_INVALID);
    const record = onlyReset(h);
    expect(record.used).toBe(true);
    // The refused second use counts no wrong try, and the send history stays.
    expect(record.passcode.wrongTries).toBe(0);
    expect(record.passcode.sentAt).toHaveLength(1);
    expect((await login(h, dana, NEW_PASSWORD)).status).toBe(200);
    expect((await login(h, dana, 'yet another password')).status).toBe(401);
  });

  it('[PW-1.c] the email in another letter case resets the same user', async () => {
    const h = buildTestHarness();
    const { passcode } = await userWithResetPasscode(h);

    const res = await resetPassword(h, passcode, { email: 'DANA@Example.COM' });

    expect(res.status).toBe(204);
    expect((await login(h, dana, NEW_PASSWORD)).status).toBe(200);
  });

  it('[PW-1.c] only the password hash changes, to a new argon2id hash of the new password', async () => {
    const h = buildTestHarness();
    const { passcode, user } = await userWithResetPasscode(h);

    await resetPassword(h, passcode);

    const [after] = h.users.snapshot();
    expect(after).toEqual({ ...user, passwordHash: expect.any(String) });
    expect(after?.passwordHash).toMatch(ARGON2ID);
    expect(after?.passwordHash).not.toBe(user.passwordHash);
    expect(await argon2.verify(after!.passwordHash, NEW_PASSWORD)).toBe(true);
    expect(await argon2.verify(after!.passwordHash, validSignUp.password)).toBe(false);
  });

  it('[PW-1.c] the new password is stored only as its hash: no stored field of a user or a reset equals it', async () => {
    const h = buildTestHarness();
    const { passcode } = await userWithResetPasscode(h);
    await resetPassword(h, passcode);

    for (const leaf of [
      ...leavesOf(h.users.snapshot()),
      ...leavesOf(h.passwordResets.snapshot()),
    ]) {
      expect(leaf).not.toBe(NEW_PASSWORD);
    }
  });

  it('[PW-1.c] a correct reset costs exactly one password hash', async () => {
    const h = buildTestHarness();
    await h.users.insert(aUser());
    const hasher = countingHasher();
    const service = resetServiceOf(h, () => 424_242, hasher);
    await service.request(dana);

    const outcome = await service.reset({
      email: dana,
      passcode: '424242',
      password: NEW_PASSWORD,
    });

    expect(outcome).toEqual({ result: 'reset' });
    expect(hasher.calls).toBe(1);
    expect(await argon2.verify((await h.users.findByEmail(dana))!.passwordHash, NEW_PASSWORD)).toBe(
      true,
    );
  });

  it("[PW-1.c] two concurrent resets with the correct passcode: one 204, one 401 PASSCODE_INVALID, and the winner's password is the one that works", async () => {
    const h = buildTestHarness();
    const { passcode } = await userWithResetPasscode(h);
    // Both requests reach the reset store before either has used the passcode.
    holdResetPasscodeUses(h);
    const passwords = ['first new password', 'second new password'];

    const answers = await Promise.all(
      passwords.map((password) => resetPassword(h, passcode, { password })),
    );

    expect(answers.map((res) => res.status).sort()).toEqual([204, 401]);
    const winner = answers.findIndex((res) => res.status === 204);
    expect(answers[1 - winner]?.body).toEqual(PASSCODE_INVALID);
    expect((await login(h, dana, passwords[winner]!)).status).toBe(200);
    expect((await login(h, dana, passwords[1 - winner]!)).status).toBe(401);
  });

  it('[PW-1.c] two racing resets in the service: one reset, one invalid, one hash', async () => {
    const h = buildTestHarness();
    await h.users.insert(aUser());
    const hasher = countingHasher();
    const service = resetServiceOf(h, () => 424_242, hasher);
    await service.request(dana);
    const attempt = { email: dana, passcode: '424242', password: NEW_PASSWORD };

    const outcomes = await Promise.all([
      service.reset(attempt),
      service.reset({ ...attempt, email: 'DANA@example.com', password: 'another password' }),
    ]);

    expect(outcomes.map((outcome) => outcome.result).sort()).toEqual(['invalid', 'reset']);
    // A racer that also passed the passcode check would have hashed too.
    expect(hasher.calls).toBe(1);
  });

  it('[PW-1.c] the reset store uses up a passcode for only one of two racing uses', async () => {
    const store = new InMemoryPasswordResetRepository();
    await store.issue(dana, 'a'.repeat(64), start);

    const results = await Promise.all([
      store.usePasscode(dana, 'a'.repeat(64), start),
      store.usePasscode(dana, 'a'.repeat(64), start),
    ]);

    expect(results.sort()).toEqual([false, true]);
    const [record] = store.snapshot();
    expect(record?.used).toBe(true);
    expect(record?.passcode.sentAt).toEqual([start]);
  });

  it('[PW-1.c] the user store replaces only the hash of the user, found by email in any letter case', async () => {
    const users = new InMemoryUserRepository();
    const user = await users.insert(aUser());

    expect(await users.updatePasswordHash('DANA@Example.com', 'a new hash')).toBe(true);

    expect(await users.findById(user.id)).toEqual({ ...user, passwordHash: 'a new hash' });
    expect(await users.findByEmail(dana)).toEqual({ ...user, passwordHash: 'a new hash' });
    expect(users.snapshot()).toHaveLength(1);
  });

  it('[PW-1.c] the user store changes nothing and answers false for an email it does not hold', async () => {
    const users = new InMemoryUserRepository();
    const user = await users.insert(aUser());

    expect(await users.updatePasswordHash('nobody@example.com', 'a new hash')).toBe(false);

    expect(users.snapshot()).toEqual([user]);
  });
});

describe('PW-1 every failed reset answers the same 401 and leaves the password alone', () => {
  type Scenario = {
    /** The user whose password must stay what it is, if the email has a user. */
    email: string;
    password?: string;
    attempt: () => Promise<request.Response>;
  };

  /** What a reset attempt is set up with: nothing happens until `attempt` is called. */
  const scenarios: [string, (h: Harness) => Promise<Scenario>][] = [
    [
      'a wrong passcode',
      async (h) => {
        const { passcode } = await userWithResetPasscode(h);
        return {
          email: dana,
          password: validSignUp.password,
          attempt: () => resetPassword(h, wrongPasscode(passcode)),
        };
      },
    ],
    [
      'a passcode 10 minutes and 1 millisecond old',
      async (h) => {
        const { passcode } = await userWithResetPasscode(h);
        h.clock.advance(10 * MINUTE + 1);
        return {
          email: dana,
          password: validSignUp.password,
          attempt: () => resetPassword(h, passcode),
        };
      },
    ],
    [
      'the correct passcode after 5 wrong tries burned it',
      async (h) => {
        const { passcode } = await userWithResetPasscode(h);
        for (let i = 0; i < 5; i += 1) await resetPassword(h, wrongPasscode(passcode));
        return {
          email: dana,
          password: validSignUp.password,
          attempt: () => resetPassword(h, passcode),
        };
      },
    ],
    [
      'a passcode that was already used',
      async (h) => {
        const { passcode } = await userWithResetPasscode(h);
        expect((await resetPassword(h, passcode)).status).toBe(204);
        return {
          email: dana,
          password: NEW_PASSWORD,
          attempt: () => resetPassword(h, passcode, { password: 'a second new password' }),
        };
      },
    ],
    [
      'a passcode replaced by a newer one',
      async (h) => {
        await registerUser(h);
        const service = resetServiceOf(h, countingDraw());
        await service.request(dana);
        h.clock.advance(AFTER_COOLDOWN);
        await service.request(dana);
        expect(resetPasscodesSentTo(h)).toEqual(['000001', '000002']);
        return {
          email: dana,
          password: validSignUp.password,
          attempt: () => resetPassword(h, '000001'),
        };
      },
    ],
    [
      'a verified email for which no reset was requested',
      async (h) => {
        await registerUser(h);
        return {
          email: dana,
          password: validSignUp.password,
          attempt: () => resetPassword(h, '123456'),
        };
      },
    ],
    [
      'an unknown email',
      async (h) => ({
        email: 'unknown@example.com',
        attempt: () => resetPassword(h, '123456', { email: 'unknown@example.com' }),
      }),
    ],
    [
      "another user's passcode",
      async (h) => {
        const { passcode } = await userWithResetPasscode(h, 'noa@example.com', 'noa password 1');
        await registerUser(h);
        return {
          email: dana,
          password: validSignUp.password,
          attempt: () => resetPassword(h, passcode),
        };
      },
    ],
    [
      "a pending sign-up's passcode",
      async (h) => {
        const passcode = await signUpForPasscode(h);
        return { email: dana, attempt: () => resetPassword(h, passcode) };
      },
    ],
  ];

  /** The answer to a wrong passcode for another user with a live reset, in the same app. */
  async function referenceAnswer(h: Harness) {
    const { passcode } = await userWithResetPasscode(h, 'reference@example.com', 'reference pw 1');
    return answerOf(
      await resetPassword(h, wrongPasscode(passcode), { email: 'reference@example.com' }),
    );
  }

  it.each(scenarios)(
    '[PW-1.d] %s answers 401 PASSCODE_INVALID, identical to the reference, and the password does not change',
    async (_, setUp) => {
      const h = buildTestHarness();
      // The reference is made first, so the users compared below are the scenario's own.
      const reference = await referenceAnswer(h);
      const scenario = await setUp(h);
      const usersBefore = h.users.snapshot();

      const res = await scenario.attempt();

      expect(res.status).toBe(401);
      expect(res.headers['content-type']).toMatch(PROBLEM_JSON);
      expect(res.body).toEqual(PASSCODE_INVALID);
      expect(reference.status).toBe(401);
      expect(reference.body).toEqual(PASSCODE_INVALID);
      expect(answerOf(res)).toEqual(reference);
      expect(h.users.snapshot()).toEqual(usersBefore);
      if (scenario.password !== undefined) {
        expect((await login(h, scenario.email, scenario.password)).status).toBe(200);
      } else {
        expect(await h.users.findByEmail(scenario.email)).toBeUndefined();
      }
    },
  );

  it('[PW-1.d] a wrong passcode counts one wrong try and creates no record where none was requested', async () => {
    const h = buildTestHarness();
    const { passcode } = await userWithResetPasscode(h);

    await resetPassword(h, wrongPasscode(passcode));
    expect(wrongTriesOf(h)).toEqual([1]);

    await resetPassword(h, wrongPasscode(passcode), { email: 'unknown@example.com' });
    expect(h.passwordResets.snapshot().map((r) => r.email)).toEqual([dana]);
    expect(wrongTriesOf(h)).toEqual([1]);
  });

  it('[PW-1.d] a wrong passcode costs no password hash; the correct one costs one', async () => {
    const h = buildTestHarness();
    await h.users.insert(aUser());
    const hasher = countingHasher();
    const service = resetServiceOf(h, () => 424_242, hasher);
    await service.request(dana);
    const attempt = { email: dana, passcode: '424242', password: NEW_PASSWORD };

    const wrong = await service.reset({ ...attempt, passcode: wrongPasscode('424242') });

    expect(wrong).toEqual({ result: 'invalid' });
    expect(hasher.calls).toBe(0);
    expect((await service.reset(attempt)).result).toBe('reset');
    expect(hasher.calls).toBe(1);
  });

  it('[PW-1.d] a passcode for an email with no user, though a record exists for it, answers invalid and creates no user', async () => {
    const h = buildTestHarness();
    await h.passwordResets.issue(dana, hmacOf('reset', dana, '424242'), h.clock.now());

    const res = await resetPassword(h, '424242');

    expect(res.status).toBe(401);
    expect(res.body).toEqual(PASSCODE_INVALID);
    expect(h.users.snapshot()).toEqual([]);
  });

  it('[PW-1.d] the reset store takes a passcode exactly 10 minutes old', async () => {
    const store = new InMemoryPasswordResetRepository();
    await store.issue(dana, 'a'.repeat(64), start);

    expect(
      await store.usePasscode(dana, 'a'.repeat(64), new Date(start.getTime() + 10 * MINUTE)),
    ).toBe(true);
  });

  it('[PW-1.d] the reset store refuses a passcode 10 minutes and 1 ms old', async () => {
    const store = new InMemoryPasswordResetRepository();
    await store.issue(dana, 'a'.repeat(64), start);

    expect(
      await store.usePasscode(dana, 'a'.repeat(64), new Date(start.getTime() + 10 * MINUTE + 1)),
    ).toBe(false);
  });

  it('[PW-1.d] the reset store burns a passcode after 5 wrong tries and counts each one', async () => {
    const store = new InMemoryPasswordResetRepository();
    await store.issue(dana, 'a'.repeat(64), start);

    for (let i = 1; i <= 5; i += 1) {
      expect(await store.usePasscode(dana, 'b'.repeat(64), start)).toBe(false);
      expect(store.snapshot().map((r) => r.passcode.wrongTries)).toEqual([i]);
    }
    expect(await store.usePasscode(dana, 'a'.repeat(64), start)).toBe(false);
  });

  it('[PW-1.d] the reset store answers false and stores nothing for an email with no record', async () => {
    const store = new InMemoryPasswordResetRepository();

    expect(await store.usePasscode(dana, 'a'.repeat(64), start)).toBe(false);

    expect(store.snapshot()).toEqual([]);
  });
});

describe('PW-1 a sign-up passcode and a reset passcode work only for their own flow', () => {
  it('[PW-1.e] a sign-up passcode sent to resetPassword answers 401, changes no password and leaves the real reset passcode working', async () => {
    const h = buildTestHarness();
    await registerUser(h);
    // The same email has a live sign-up passcode too (it became a user some other way).
    await h.pendingSignUps.create(dana, hmacOf('signup', dana, '000001'), h.clock.now());
    await resetServiceOf(h, () => 2).request(dana);
    expect(resetPasscodesSentTo(h)).toEqual(['000002']);

    const res = await resetPassword(h, '000001');

    expect(res.status).toBe(401);
    expect(res.body).toEqual(PASSCODE_INVALID);
    expect((await login(h, dana, validSignUp.password)).status).toBe(200);
    expect(wrongTriesOf(h)).toEqual([1]);
    expect(h.pendingSignUps.snapshot().map((r) => r.passcode.wrongTries)).toEqual([0]);
    expect((await resetPassword(h, '000002')).status).toBe(204);
  });

  it('[PW-1.e] a reset passcode sent to verifyOtp answers 401, creates no user and leaves the real sign-up passcode working', async () => {
    const h = buildTestHarness();
    const noa = 'noa@example.com';
    await signUpServiceOf(h, () => 1).signUp(noa);
    expect(passcodesSentTo(h, noa)).toEqual(['000001']);
    // A reset record for the same email (it became a user some other way).
    await h.passwordResets.issue(noa, hmacOf('reset', noa, '000002'), h.clock.now());

    const res = await verify(h, '000002', { email: noa });

    expect(res.status).toBe(401);
    expect(res.body).toEqual(PASSCODE_INVALID);
    expect(h.users.snapshot()).toEqual([]);
    expect(h.pendingSignUps.snapshot().map((r) => r.passcode.wrongTries)).toEqual([1]);
    expect(wrongTriesOf(h)).toEqual([0]);
    expect((await verify(h, '000001', { email: noa })).status).toBe(200);
  });

  it('[PW-1.e] the reset passcode sent for a verified user does not verify anything either', async () => {
    const h = buildTestHarness();
    const { passcode } = await userWithResetPasscode(h);

    const res = await verify(h, passcode);

    expect(res.status).toBe(401);
    expect(res.body).toEqual(PASSCODE_INVALID);
    expect(h.users.snapshot()).toHaveLength(1);
    expect(wrongTriesOf(h)).toEqual([0]);
    expect((await resetPassword(h, passcode)).status).toBe(204);
  });

  it("[PW-1.e] with the same passcode 424242 in both flows, each store refuses the other flow's HMAC and takes its own", async () => {
    const resets = new InMemoryPasswordResetRepository();
    const pendings = new InMemoryPendingSignUpRepository();
    const signupHmac = hmacOf('signup', dana, '424242');
    const resetHmac = hmacOf('reset', dana, '424242');
    await resets.issue(dana, resetHmac, start);
    await pendings.create(dana, signupHmac, start);

    // A sign-up passcode never resets a password.
    expect(await resets.usePasscode(dana, signupHmac, start)).toBe(false);
    expect(resets.snapshot().map((r) => r.passcode.wrongTries)).toEqual([1]);
    // A reset passcode never verifies a sign-up.
    expect(await pendings.usePasscode(dana, resetHmac, start)).toBe(false);
    expect(pendings.snapshot().map((r) => r.passcode.wrongTries)).toEqual([1]);
    // Each takes its own.
    expect(await resets.usePasscode(dana, resetHmac, start)).toBe(true);
    expect(await pendings.usePasscode(dana, signupHmac, start)).toBe(true);
  });

  it('[PW-1.e] the HMAC of the same email and passcode differs by purpose', () => {
    expect(hmacOf('signup', dana, '424242')).not.toBe(hmacOf('reset', dana, '424242'));
  });

  it('[PW-1.e] the reset service accepts only a reset-purpose HMAC: a record made with the sign-up HMAC of 424242 does not reset', async () => {
    const h = buildTestHarness();
    await h.users.insert(aUser());
    await h.passwordResets.issue(dana, hmacOf('signup', dana, '424242'), h.clock.now());
    const hasher = countingHasher();

    const outcome = await resetServiceOf(h, undefined, hasher).reset({
      email: dana,
      passcode: '424242',
      password: NEW_PASSWORD,
    });

    expect(outcome).toEqual({ result: 'invalid' });
    expect(hasher.calls).toBe(0);
    expect((await h.users.findByEmail(dana))?.passwordHash).toBe(aUser().passwordHash);
  });

  it('[PW-1.e] the sign-up service accepts only a sign-up-purpose HMAC: a pending record made with the reset HMAC of 424242 does not verify', async () => {
    const h = buildTestHarness();
    await h.pendingSignUps.create(dana, hmacOf('reset', dana, '424242'), h.clock.now());

    const outcome = await signUpServiceOf(h).verify({ ...validSignUp, passcode: '424242' });

    expect(outcome).toEqual({ result: 'invalid' });
    expect(h.users.snapshot()).toEqual([]);
  });

  it('[PW-1.e] a reset request sends a message marked as a reset, a sign-up one as a sign-up', async () => {
    const h = buildTestHarness();
    await userWithResetPasscode(h);

    expect(h.outbox.messages.map((message) => message.purpose)).toEqual(['signup', 'reset']);
  });
});

describe('PW-1 a token issued before the reset keeps working', () => {
  it('[PW-1.f] getMe with a token issued 61 seconds before the reset answers 200 with the same account after it, for the sign-up token and a login token alike', async () => {
    const h = buildTestHarness();
    const { passcode, token } = await userWithResetPasscode(h);
    const loginToken = (
      (await login(h, dana, validSignUp.password)).body as { accessToken: string }
    ).accessToken;
    const before = await getMe(h, `Bearer ${token}`);
    expect(before.status).toBe(200);
    // The tokens' issue time is in whole seconds: the reset must come later than that.
    h.clock.advance(AFTER_COOLDOWN);

    expect((await resetPassword(h, passcode)).status).toBe(204);

    for (const old of [token, loginToken]) {
      const after = await getMe(h, `Bearer ${old}`);
      expect(after.status).toBe(200);
      expect(after.body).toEqual(before.body);
    }
  });

  it('[PW-1.f] a token issued before the reset still expires on its own an hour after it was issued', async () => {
    const h = buildTestHarness();
    const { passcode, token } = await userWithResetPasscode(h);
    h.clock.advance(AFTER_COOLDOWN);
    await resetPassword(h, passcode);
    h.clock.advance(HOUR - AFTER_COOLDOWN + SECOND);

    expect((await getMe(h, `Bearer ${token}`)).status).toBe(401);
  });

  it('[PW-1.f] the token from a login with the new password works too', async () => {
    const h = buildTestHarness();
    const { passcode } = await userWithResetPasscode(h);
    await resetPassword(h, passcode);

    const res = await login(h, dana, NEW_PASSWORD);

    const me = await getMe(
      h,
      bearer((res.body as { accessToken: string }).accessToken).Authorization,
    );
    expect(me.status).toBe(200);
  });
});

describe('SU-3 resetPassword applies the sign-up password rules without using up the passcode', () => {
  it.each([
    ['a password of 7 characters', 'a'.repeat(7)],
    ['a password of 73 characters', 'a'.repeat(73)],
    ['a password of 19 four-byte emoji (76 bytes)', '😀'.repeat(19)],
  ])(
    '[SU-3.e] resetPassword with %s answers 400 for password and leaves the passcode usable',
    async (_, password) => {
      const h = buildTestHarness();
      const { passcode } = await userWithResetPasscode(h);

      const res = await resetPassword(h, passcode, { password });

      expect(res.status).toBe(400);
      expect(res.headers['content-type']).toMatch(PROBLEM_JSON);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect(fieldsOf(res.body)).toEqual(['password']);
      expect(wrongTriesOf(h)).toEqual([0]);
      expect((await login(h, dana, validSignUp.password)).status).toBe(200);
      expect((await resetPassword(h, passcode)).status).toBe(204);
    },
  );

  it('[SU-3.e] an invalid password with a wrong passcode answers 400 and counts no wrong try', async () => {
    const h = buildTestHarness();
    const { passcode } = await userWithResetPasscode(h);

    const res = await resetPassword(h, wrongPasscode(passcode), { password: 'short' });

    expect(res.status).toBe(400);
    expect(fieldsOf(res.body)).toEqual(['password']);
    expect(wrongTriesOf(h)).toEqual([0]);
  });

  it.each([
    ['a password of 8 characters', 'a'.repeat(8)],
    ['a password of 72 characters', 'a'.repeat(72)],
    ['a password of 18 four-byte emoji (72 bytes)', '😀'.repeat(18)],
  ])('[SU-3.e] resetPassword accepts %s', async (_, password) => {
    const h = buildTestHarness();
    const { passcode } = await userWithResetPasscode(h);

    const res = await resetPassword(h, passcode, { password });

    expect(res.status).toBe(204);
    expect((await login(h, dana, password)).status).toBe(200);
  });
});

describe('SEC-4 requestPasswordReset does not reveal whether an email is registered', () => {
  it('[SEC-4.b] an unknown, a pending, a cooling-down, a capped, a burned and a verified email get an identical 202 with no body', async () => {
    const h = buildTestHarness();
    await signUp(h, { ...validSignUp, email: 'pending@example.com' });
    for (const email of ['verified', 'cooling', 'capped', 'burned']) {
      await h.users.insert(aUser(`${email}@example.com`));
    }
    // capped: 5 passcodes within the hour, the last one 61 s ago.
    await requestReset(h, 'capped@example.com');
    await requestReset(h, 'burned@example.com');
    for (let i = 0; i < 4; i += 1) {
      h.clock.advance(AFTER_COOLDOWN);
      await requestReset(h, 'capped@example.com');
    }
    h.clock.advance(AFTER_COOLDOWN);
    // burned: its passcode is used up by 5 wrong tries.
    const burnedCode = latestResetPasscode(h, 'burned@example.com');
    for (let i = 0; i < 5; i += 1) {
      await resetPassword(h, wrongPasscode(burnedCode), { email: 'burned@example.com' });
    }
    await requestReset(h, 'cooling@example.com');
    expect(resetPasscodesSentTo(h, 'capped@example.com')).toHaveLength(5);

    const emails = [
      'unknown@example.com',
      'pending@example.com',
      'cooling@example.com',
      'capped@example.com',
      'burned@example.com',
      'verified@example.com',
      'Verified@Example.com',
    ];
    const answers = [];
    for (const email of emails) answers.push(answerOf(await requestReset(h, email)));

    const [unknown, ...others] = answers;
    expect(unknown?.status).toBe(202);
    expect(unknown?.body).toEqual({});
    expect(others).toHaveLength(6);
    for (const answer of others) expect(answer).toEqual(unknown);
    // Who really got a passcode: the verified email (once) and the burned one (a replacement).
    expect(resetPasscodesSentTo(h, 'verified@example.com')).toHaveLength(1);
    expect(resetPasscodesSentTo(h, 'burned@example.com')).toHaveLength(2);
    expect(resetPasscodesSentTo(h, 'cooling@example.com')).toHaveLength(1);
    expect(resetPasscodesSentTo(h, 'capped@example.com')).toHaveLength(5);
    expect(resetPasscodesSentTo(h, 'unknown@example.com')).toHaveLength(0);
    expect(resetPasscodesSentTo(h, 'pending@example.com')).toHaveLength(0);
  });
});

describe('SEC-4 verifyOtp and resetPassword answer every failure alike', () => {
  type Failure = [string, (h: Harness) => Promise<request.Response>];

  const verifyFailures: Failure[] = [
    ['an unknown email', async (h) => verify(h, '123456', { email: 'unknown@example.com' })],
    [
      'an email with nothing pending',
      async (h) => {
        await h.users.insert(aUser());
        return verify(h, '123456');
      },
    ],
    ['a wrong passcode', async (h) => verify(h, wrongPasscode(await signUpForPasscode(h)))],
    [
      'a passcode more than 10 minutes old',
      async (h) => {
        const passcode = await signUpForPasscode(h);
        h.clock.advance(10 * MINUTE + 1);
        return verify(h, passcode);
      },
    ],
    [
      'a passcode burned by 5 wrong tries',
      async (h) => {
        const passcode = await signUpForPasscode(h);
        for (let i = 0; i < 5; i += 1) await verify(h, wrongPasscode(passcode));
        return verify(h, passcode);
      },
    ],
    [
      'a passcode already used',
      async (h) => {
        const passcode = await signUpForPasscode(h);
        expect((await verify(h, passcode)).status).toBe(200);
        return verify(h, passcode);
      },
    ],
  ];

  const resetFailures: Failure[] = [
    ['an unknown email', async (h) => resetPassword(h, '123456', { email: 'unknown@example.com' })],
    [
      'an email with nothing pending',
      async (h) => {
        await registerUser(h);
        return resetPassword(h, '123456');
      },
    ],
    [
      'a wrong passcode',
      async (h) => {
        const { passcode } = await userWithResetPasscode(h);
        return resetPassword(h, wrongPasscode(passcode));
      },
    ],
    [
      'a passcode more than 10 minutes old',
      async (h) => {
        const { passcode } = await userWithResetPasscode(h);
        h.clock.advance(10 * MINUTE + 1);
        return resetPassword(h, passcode);
      },
    ],
    [
      'a passcode burned by 5 wrong tries',
      async (h) => {
        const { passcode } = await userWithResetPasscode(h);
        for (let i = 0; i < 5; i += 1) await resetPassword(h, wrongPasscode(passcode));
        return resetPassword(h, passcode);
      },
    ],
    [
      'a passcode already used',
      async (h) => {
        const { passcode } = await userWithResetPasscode(h);
        expect((await resetPassword(h, passcode)).status).toBe(204);
        return resetPassword(h, passcode);
      },
    ],
  ];

  it.each(verifyFailures)(
    '[SEC-4.c] verifyOtp with %s answers the one 401 PASSCODE_INVALID',
    async (_, fail) => {
      const res = await fail(buildTestHarness());

      expect(res.status).toBe(401);
      expect(res.headers['content-type']).toMatch(PROBLEM_JSON);
      expect(res.body).toEqual(PASSCODE_INVALID);
    },
  );

  it.each(resetFailures)(
    '[SEC-4.c] resetPassword with %s answers the one 401 PASSCODE_INVALID',
    async (_, fail) => {
      const res = await fail(buildTestHarness());

      expect(res.status).toBe(401);
      expect(res.headers['content-type']).toMatch(PROBLEM_JSON);
      expect(res.body).toEqual(PASSCODE_INVALID);
    },
  );

  it('[SEC-4.c] all twelve failures are identical in status, body and every header but Date', async () => {
    const answers = [];
    for (const [, fail] of [...verifyFailures, ...resetFailures]) {
      answers.push(answerOf(await fail(buildTestHarness())));
    }

    expect(answers).toHaveLength(12);
    for (const answer of answers) expect(answer).toEqual(answers[0]);
    expect(answers[0]?.status).toBe(401);
  });
});

describe('SEC-5 no secret reaches the logs', () => {
  it('[SEC-5.a] reset requests and resets logged at trace level carry no password, passcode, passcode HMAC, password hash or server secret', async () => {
    const lines: string[] = [];
    const logger = createLogger('trace', { write: (line: string) => void lines.push(line) });
    const h = buildTestHarness({ logger });
    const oldPassword = 'Old-Pa55phrase-unique!';
    const newPassword = 'New-Pa55phrase-unique!';
    const { user } = await registerUser(h, dana, oldPassword);
    // A known passcode, matched below as a whole number so no timestamp can contain it by chance.
    await resetServiceOf(h, () => 424_242).request(dana);
    expect(resetPasscodesSentTo(h)).toEqual(['424242']);
    await resetPassword(h, wrongPasscode('424242'), { password: newPassword });
    await requestReset(h, 'unknown@example.com');

    const res = await resetPassword(h, '424242', { password: newPassword });

    expect(res.status).toBe(204);
    const [after] = h.users.snapshot();
    const secrets = [
      oldPassword,
      newPassword,
      hmacOf('reset', dana, '424242'),
      user.passwordHash,
      after!.passwordHash,
      TEST_SECRETS.JWT_SECRET,
      TEST_SECRETS.PASSCODE_SECRET,
    ];
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const line of lines) {
      expect(line).not.toMatch(/(?<!\d)424242(?!\d)/);
      for (const secret of secrets) expect(line).not.toContain(secret);
    }
  });
});
