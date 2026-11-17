import { describe, expect, it } from '@jest/globals';
import type request from 'supertest';
import { InMemoryPendingSignUpRepository } from '../src/repositories/pending-sign-ups';
import { buildTestHarness } from './support/app';
import {
  AFTER_COOLDOWN,
  fieldsOf,
  holdUserLookUps,
  HOUR,
  leavesOf,
  passcodesSentTo,
  resend,
  SECOND,
  signUp,
  signUpServiceOf,
  validSignUp,
} from './support/sign-up';

const PROBLEM_JSON = /^application\/problem\+json/;
const HMAC_HEX = /^[0-9a-f]{64}$/;
const PENDING = { email: validSignUp.email, status: 'pending' };

describe('SU-1 sign up with email, password and phone number', () => {
  it('[SU-1.a] a new email answers 202 pending with the email lowercased', async () => {
    const h = buildTestHarness();

    const res = await signUp(h, { ...validSignUp, email: 'Dana@Example.COM' });

    expect(res.status).toBe(202);
    expect(res.body).toEqual(PENDING);
  });

  it('[SU-1.a] the pending sign-up holds only the lowercased email, an HMAC and times', async () => {
    const h = buildTestHarness();

    await signUp(h, { ...validSignUp, email: 'Dana@Example.COM' });

    const records = h.pendingSignUps.snapshot();
    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record?.email).toBe('dana@example.com');
    const stored = JSON.stringify(record);
    expect(stored).not.toContain(validSignUp.password);
    expect(stored).not.toContain(validSignUp.phone.slice(1));
    const leaves = leavesOf(record);
    expect(leaves.filter((leaf) => typeof leaf === 'string' && HMAC_HEX.test(leaf))).toHaveLength(
      1,
    );
    for (const leaf of leaves) {
      const allowed =
        leaf === 'dana@example.com' ||
        leaf instanceof Date ||
        (typeof leaf === 'number' && Number.isInteger(leaf)) ||
        (typeof leaf === 'string' && HMAC_HEX.test(leaf));
      expect({ leaf, allowed }).toEqual({ leaf, allowed: true });
    }
  });

  it('[SU-1.b] a repeat sign-up within 60 seconds answers the same 202 and sends nothing', async () => {
    const h = buildTestHarness();
    await signUp(h);
    h.clock.advance(30 * SECOND);

    const res = await signUp(h);

    expect(res.status).toBe(202);
    expect(res.body).toEqual(PENDING);
    expect(passcodesSentTo(h)).toHaveLength(1);
    expect(h.pendingSignUps.snapshot()).toHaveLength(1);
  });

  it('[SU-1.b] a repeat sign-up after the cooldown is a resend: the same 202 and a new passcode', async () => {
    const h = buildTestHarness();
    await signUp(h);
    h.clock.advance(AFTER_COOLDOWN);

    const res = await signUp(h);

    expect(res.status).toBe(202);
    expect(res.body).toEqual(PENDING);
    expect(passcodesSentTo(h)).toHaveLength(2);
    expect(h.pendingSignUps.snapshot()).toHaveLength(1);
  });

  it('[SU-1.b] a repeat sign-up in another letter case continues the same pending sign-up', async () => {
    const h = buildTestHarness();
    await signUp(h, { ...validSignUp, email: 'Dana@Example.com' });
    h.clock.advance(AFTER_COOLDOWN);

    const res = await signUp(h, { ...validSignUp, email: 'dana@example.com' });

    expect(res.status).toBe(202);
    expect(res.body).toEqual(PENDING);
    expect(h.pendingSignUps.snapshot()).toHaveLength(1);
    expect(passcodesSentTo(h)).toHaveLength(2);
  });

  it('[SU-1.c] resendOtp sends nothing for a pending sign-up older than 24 hours', async () => {
    const h = buildTestHarness();
    await signUp(h);
    h.clock.advance(24 * HOUR + SECOND);
    const before = h.pendingSignUps.snapshot();

    const res = await resend(h);

    expect(res.status).toBe(202);
    expect(passcodesSentTo(h)).toHaveLength(1);
    expect(h.pendingSignUps.snapshot()).toEqual(before);
  });

  it('[SU-1.c] a pending sign-up younger than 24 hours still gets its resend', async () => {
    const h = buildTestHarness();
    await signUp(h);
    h.clock.advance(23 * HOUR);

    await resend(h);

    expect(passcodesSentTo(h)).toHaveLength(2);
  });

  it('[SU-1.c] signUp after 24 hours starts a new pending sign-up and sends a passcode', async () => {
    const h = buildTestHarness();
    await signUp(h);
    h.clock.advance(24 * HOUR + SECOND);

    const res = await signUp(h);

    expect(res.status).toBe(202);
    expect(res.body).toEqual(PENDING);
    expect(passcodesSentTo(h)).toHaveLength(2);
    const records = h.pendingSignUps.snapshot();
    expect(records).toHaveLength(1);
    expect(records[0]?.createdAt).toEqual(h.clock.now());
  });
});

describe('SU-2 an email can be registered only once', () => {
  it.each(['dana@example.com', 'DANA@Example.Com'])(
    '[SU-2.a] signUp with a verified user\'s email as "%s" answers 409 EMAIL_TAKEN and sends nothing',
    async (email) => {
      const h = buildTestHarness();
      await h.users.insert({ id: 'user-1', email: 'dana@example.com' });

      const res = await signUp(h, { ...validSignUp, email });

      expect(res.status).toBe(409);
      expect(res.headers['content-type']).toMatch(PROBLEM_JSON);
      expect(res.body).toMatchObject({ type: 'about:blank', status: 409, code: 'EMAIL_TAKEN' });
      expect(h.outbox.messages).toHaveLength(0);
      expect(h.pendingSignUps.snapshot()).toHaveLength(0);
    },
  );

  it('[SU-2.c] two concurrent sign-ups for a new email: both 202, one pending sign-up, one passcode', async () => {
    const h = buildTestHarness();
    // Both requests pass the verified-user look-up before either reaches the store.
    holdUserLookUps(h);

    const [first, second] = await Promise.all([signUp(h), signUp(h)]);

    expect([first.status, second.status]).toEqual([202, 202]);
    expect(first.body).toEqual(PENDING);
    expect(second.body).toEqual(PENDING);
    expect(h.pendingSignUps.snapshot()).toHaveLength(1);
    expect(h.outbox.messages).toHaveLength(1);
  });

  it('[SU-2.c] two racing sign-ups in the service start one pending sign-up and send one passcode', async () => {
    const h = buildTestHarness();
    const service = signUpServiceOf(h);

    const results = await Promise.all([
      service.signUp('dana@example.com'),
      service.signUp('Dana@Example.com'),
    ]);

    expect(results.map((outcome) => outcome.result)).toEqual(['accepted', 'accepted']);
    expect(h.pendingSignUps.snapshot()).toHaveLength(1);
    expect(h.outbox.messages).toHaveLength(1);
  });

  it('[SU-2.c] the pending sign-up store starts only one of two racing sign-ups', async () => {
    const store = new InMemoryPendingSignUpRepository();
    const now = new Date('2026-01-01T09:00:00.000Z');

    const results = await Promise.all([
      store.create('dana@example.com', 'a'.repeat(64), now),
      store.create('dana@example.com', 'b'.repeat(64), now),
    ]);

    expect(results.sort()).toEqual([false, true]);
    expect(store.snapshot()).toHaveLength(1);
  });
});

describe('SU-3 email, phone and password formats are validated', () => {
  /** A 400 VALIDATION_FAILED naming exactly `fields`, with nothing recorded or sent. */
  async function expectRejected(body: Record<string, unknown>, fields: string[]) {
    const h = buildTestHarness();

    const res = await signUp(h, body);

    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toMatch(PROBLEM_JSON);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(fieldsOf(res.body)).toEqual(fields);
    expect(h.pendingSignUps.snapshot()).toHaveLength(0);
    expect(h.outbox.messages).toHaveLength(0);
  }

  async function expectAccepted(body: Record<string, unknown>) {
    const res = await signUp(buildTestHarness(), body);
    expect(res.status).toBe(202);
  }

  it.each([
    ['not an address', 'not-an-email'],
    ['a leading space', ' dana@example.com'],
    ['a trailing space', 'dana@example.com '],
    ['255 characters', `${'a'.repeat(243)}@example.com`],
  ])('[SU-3.a] an email with %s answers 400 for email and records nothing', async (_, email) => {
    await expectRejected({ ...validSignUp, email }, ['email']);
  });

  it('[SU-3.a] an email of 254 characters is accepted', async () => {
    await expectAccepted({ ...validSignUp, email: `${'a'.repeat(242)}@example.com` });
  });

  it.each([
    ['a local number', '0501234567'],
    ['a zero after the plus', '+0501234567'],
    ['too few digits', '+123456'],
    ['too many digits', '+1234567890123456'],
    ['spaces', '+972 50 123 4567'],
    ['dashes', '+972-50-1234567'],
    ['letters after it', '+972501234567abc'],
    ['a letter before it', 'x+972501234567'],
    ['a trailing newline', '+972501234567\n'],
    ['a leading space', ' +972501234567'],
  ])('[SU-3.b] a phone with %s answers 400 for phone', async (_, phone) => {
    await expectRejected({ ...validSignUp, phone }, ['phone']);
  });

  it.each(['+1234567', '+123456789012345'])(
    '[SU-3.b] the shortest and longest E.164 phones are accepted: %s',
    async (phone) => {
      await expectAccepted({ ...validSignUp, phone });
    },
  );

  it.each([
    ['7 characters', 'a'.repeat(7)],
    ['73 characters', 'a'.repeat(73)],
    ['19 four-byte emoji (76 bytes)', '😀'.repeat(19)],
    ['37 two-byte letters (74 bytes)', 'é'.repeat(37)],
    ['4 emoji (4 characters, 8 UTF-16 units)', '😀'.repeat(4)],
  ])('[SU-3.c] a password of %s answers 400 for password', async (_, password) => {
    await expectRejected({ ...validSignUp, password }, ['password']);
  });

  it.each([
    ['8 characters', 'a'.repeat(8)],
    ['72 characters', 'a'.repeat(72)],
    ['18 four-byte emoji (72 bytes)', '😀'.repeat(18)],
    ['8 emoji (8 characters, 32 bytes)', '😀'.repeat(8)],
  ])('[SU-3.c] a password of %s is accepted', async (_, password) => {
    await expectAccepted({ ...validSignUp, password });
  });

  it('[SU-3.d] three invalid fields get one entry each', async () => {
    await expectRejected({ email: 'nope', password: 'short', phone: '050' }, [
      'email',
      'password',
      'phone',
    ]);
  });

  it('[SU-3.c] a password too long in bytes is named with a readable message', async () => {
    const res = await signUp(buildTestHarness(), { ...validSignUp, password: '😀'.repeat(19) });

    expect(res.status).toBe(400);
    expect(res.body.errors).toEqual([
      { field: 'password', message: 'must be at most 72 bytes in UTF-8' },
    ]);
  });

  it('[SU-3.d] a password too long in bytes is listed with the other invalid fields', async () => {
    await expectRejected({ ...validSignUp, email: 'nope', password: '😀'.repeat(19) }, [
      'email',
      'password',
    ]);
  });
});

describe('SEC-4 resendOtp does not reveal whether an email is registered', () => {
  /** Everything the client sees, except the Date header, which changes by the second. */
  const visible = (res: request.Response) => {
    const headers = { ...res.headers };
    delete headers.date;
    return { status: res.status, text: res.text, headers };
  };

  it('[SEC-4.b] an unknown, a pending, a cooling-down and a verified email get an identical 202 with no body', async () => {
    const h = buildTestHarness();
    await signUp(h, { ...validSignUp, email: 'pending@example.com' });
    await h.users.insert({ id: 'user-1', email: 'verified@example.com' });
    h.clock.advance(AFTER_COOLDOWN);
    await signUp(h, { ...validSignUp, email: 'cooling@example.com' });

    const answers = [];
    for (const email of [
      'unknown@example.com',
      'pending@example.com',
      'cooling@example.com',
      'verified@example.com',
    ]) {
      answers.push(visible(await resend(h, email)));
    }

    const [unknown, ...others] = answers;
    expect(unknown?.status).toBe(202);
    expect(unknown?.text).toBe('');
    for (const answer of others) expect(answer).toEqual(unknown);
    // The pending email outside its cooldown really got a new passcode; nobody else got one.
    expect(passcodesSentTo(h, 'pending@example.com')).toHaveLength(2);
    expect(passcodesSentTo(h, 'cooling@example.com')).toHaveLength(1);
    expect(h.outbox.messages).toHaveLength(3);
  });
});
