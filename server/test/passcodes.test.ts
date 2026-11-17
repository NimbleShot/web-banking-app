import crypto from 'node:crypto';
import { describe, expect, it, jest } from '@jest/globals';
import { InMemoryPendingSignUpRepository } from '../src/repositories/pending-sign-ups';
import { createPasscodeService } from '../src/services/passcodes';
import { buildTestHarness, TEST_SECRETS } from './support/app';
import {
  AFTER_COOLDOWN,
  countingDraw,
  HOUR,
  leavesOf,
  passcodesSentTo,
  resend,
  SECOND,
  signUp,
  signUpServiceOf,
  validSignUp,
} from './support/sign-up';

const SIX_DIGITS = /^\d{6}$/;
const secret = TEST_SECRETS.PASSCODE_SECRET;

describe('OTP-1 a random 6-digit passcode is emailed at sign-up', () => {
  it('[OTP-1.a] a new sign-up sends exactly one message, to that email, with a 6-digit passcode', async () => {
    const h = buildTestHarness();

    await signUp(h, { ...validSignUp, email: 'Dana@Example.COM' });

    expect(h.outbox.messages).toHaveLength(1);
    const [message] = h.outbox.messages;
    expect(message?.to).toBe('dana@example.com');
    expect(message?.purpose).toBe('signup');
    expect(message?.passcode).toMatch(SIX_DIGITS);
  });

  it.each([
    [42, '000042'],
    [0, '000000'],
    [999_999, '999999'],
  ])('[OTP-1.b] a draw of %p gives the passcode "%s"', (draw, expected) => {
    const calls: [number, number][] = [];
    const passcodes = createPasscodeService({
      secret,
      randomInt: (min, max) => {
        calls.push([min, max]);
        return draw;
      },
    });

    expect(passcodes.draw()).toBe(expected);
    expect(calls).toEqual([[0, 1_000_000]]);
  });

  it('[OTP-1.b] the default draw is crypto.randomInt(0, 1_000_000)', () => {
    const spy = jest.spyOn(crypto, 'randomInt').mockImplementation((() => 42) as never);
    try {
      expect(createPasscodeService({ secret }).draw()).toBe('000042');
      expect(spy.mock.calls).toEqual([[0, 1_000_000]]);
    } finally {
      spy.mockRestore();
    }
  });

  it('[OTP-1.b] 1,000 real draws give at least 990 distinct 6-digit passcodes', () => {
    const passcodes = createPasscodeService({ secret });

    const drawn = Array.from({ length: 1000 }, () => passcodes.draw());

    for (const passcode of drawn) expect(passcode).toMatch(SIX_DIGITS);
    expect(new Set(drawn).size).toBeGreaterThanOrEqual(990);
  });

  it('[OTP-1.c] no stored field of the pending sign-up equals the passcode', async () => {
    const h = buildTestHarness();

    await signUp(h);

    const [passcode] = passcodesSentTo(h);
    expect(passcode).toMatch(SIX_DIGITS);
    const leaves = leavesOf(h.pendingSignUps.snapshot());
    expect(leaves.length).toBeGreaterThan(0);
    expect(leaves).not.toContain(passcode);
    expect(leaves.some((leaf) => typeof leaf === 'string' && /^[0-9a-f]{64}$/.test(leaf))).toBe(
      true,
    );
  });

  it('[OTP-1.c] neither the passcode nor its number is stored (a known draw of 424242)', async () => {
    const h = buildTestHarness();

    await signUpServiceOf(h, () => 424_242).signUp(validSignUp.email);

    expect(passcodesSentTo(h)).toEqual(['424242']);
    const leaves = leavesOf(h.pendingSignUps.snapshot());
    expect(leaves).not.toContain('424242');
    expect(leaves).not.toContain(424_242);
    const expected = crypto
      .createHmac('sha256', secret)
      .update(`signup:${validSignUp.email}:424242`)
      .digest('hex');
    expect(leaves).toContain(expected);
  });

  it('[OTP-1.c] the stored HMAC is HMAC-SHA256 keyed by the server secret, bound to the email and purpose', () => {
    const passcodes = createPasscodeService({ secret });
    const otherSecret = createPasscodeService({ secret: TEST_SECRETS.JWT_SECRET });

    const hmac = passcodes.hmac('signup', 'dana@example.com', '000042');

    expect(hmac).toBe(
      crypto.createHmac('sha256', secret).update('signup:dana@example.com:000042').digest('hex'),
    );
    expect(passcodes.hmac('signup', 'dana@example.com', '000043')).not.toBe(hmac);
    expect(passcodes.hmac('signup', 'noa@example.com', '000042')).not.toBe(hmac);
    expect(passcodes.hmac('reset', 'dana@example.com', '000042')).not.toBe(hmac);
    expect(otherSecret.hmac('signup', 'dana@example.com', '000042')).not.toBe(hmac);
  });

  it('[OTP-1.d] resendOtp after the cooldown answers 202 with no body and sends a new passcode', async () => {
    const h = buildTestHarness();
    await signUp(h);
    h.clock.advance(AFTER_COOLDOWN);

    const res = await resend(h);

    expect(res.status).toBe(202);
    expect(res.text).toBe('');
    expect(passcodesSentTo(h)).toHaveLength(2);
  });

  it('[OTP-1.d] after a resend the previous passcode no longer verifies and the new one does', async () => {
    const h = buildTestHarness();
    const service = signUpServiceOf(h, countingDraw());
    await service.signUp(validSignUp.email);
    h.clock.advance(AFTER_COOLDOWN);

    await service.resend(validSignUp.email);

    expect(passcodesSentTo(h)).toEqual(['000001', '000002']);
    expect(await service.usePasscode(validSignUp.email, '000001')).toBe(false);
    expect(await service.usePasscode(validSignUp.email, '000002')).toBe(true);
  });

  it('[OTP-1.d] resendOtp in another letter case sends to the lowercased email', async () => {
    const h = buildTestHarness();
    await signUp(h);
    h.clock.advance(AFTER_COOLDOWN);

    await resend(h, 'DANA@Example.com');

    expect(passcodesSentTo(h)).toHaveLength(2);
    expect(h.outbox.messages.map((message) => message.to)).toEqual([
      'dana@example.com',
      'dana@example.com',
    ]);
  });

  it('[OTP-1.e] resendOtp within 60 seconds answers the same 202, sends nothing and keeps the passcode', async () => {
    const h = buildTestHarness();
    await signUp(h);
    h.clock.advance(59 * SECOND);

    const res = await resend(h);

    expect(res.status).toBe(202);
    expect(res.text).toBe('');
    const sent = passcodesSentTo(h);
    expect(sent).toHaveLength(1);
    expect(await signUpServiceOf(h).usePasscode(validSignUp.email, sent[0] as string)).toBe(true);
  });

  it('[OTP-1.e] resendOtp exactly 60 seconds after the last passcode still sends nothing', async () => {
    const h = buildTestHarness();
    await signUp(h);
    h.clock.advance(60 * SECOND);

    const res = await resend(h);

    expect(res.status).toBe(202);
    expect(passcodesSentTo(h)).toHaveLength(1);
  });

  it('[OTP-1.e] resendOtp 60 seconds and 1 millisecond after the last passcode sends a new one', async () => {
    const h = buildTestHarness();
    await signUp(h);
    h.clock.advance(60 * SECOND + 1);

    await resend(h);

    expect(passcodesSentTo(h)).toHaveLength(2);
  });

  it('[OTP-1.e] the cooldown runs from the latest passcode, not the first', async () => {
    const h = buildTestHarness();
    await signUp(h);
    h.clock.advance(AFTER_COOLDOWN);
    await resend(h);
    expect(passcodesSentTo(h)).toHaveLength(2);
    h.clock.advance(30 * SECOND);

    const res = await resend(h);

    expect(res.status).toBe(202);
    expect(passcodesSentTo(h)).toHaveLength(2);
  });

  it('[OTP-1.e] after 5 passcodes in an hour resendOtp sends nothing until the oldest is an hour old', async () => {
    const h = buildTestHarness();
    await signUp(h);
    for (let i = 0; i < 4; i += 1) {
      h.clock.advance(AFTER_COOLDOWN);
      await resend(h);
    }
    expect(passcodesSentTo(h)).toHaveLength(5);

    h.clock.advance(AFTER_COOLDOWN);
    const capped = await resend(h);
    expect(capped.status).toBe(202);
    expect(capped.text).toBe('');
    expect(passcodesSentTo(h)).toHaveLength(5);

    // The first passcode went out 5 × 61 s ago: at 3599 s it still counts, at 3601 s it doesn't.
    h.clock.advance(HOUR - SECOND - 5 * AFTER_COOLDOWN);
    await resend(h);
    expect(passcodesSentTo(h)).toHaveLength(5);

    h.clock.advance(2 * SECOND);
    await resend(h);
    expect(passcodesSentTo(h)).toHaveLength(6);
  });

  it('[OTP-1.e] with 5 passcodes sent, a resend exactly an hour after the oldest still sends nothing; 1 ms later it sends', async () => {
    const h = buildTestHarness();
    await signUp(h);
    for (let i = 0; i < 4; i += 1) {
      h.clock.advance(AFTER_COOLDOWN);
      await resend(h);
    }
    expect(passcodesSentTo(h)).toHaveLength(5);

    // The oldest passcode went out 4 × 61 s ago; move to exactly one hour after it.
    h.clock.advance(HOUR - 4 * AFTER_COOLDOWN);
    await resend(h);
    expect(passcodesSentTo(h)).toHaveLength(5);

    h.clock.advance(1);
    await resend(h);
    expect(passcodesSentTo(h)).toHaveLength(6);
  });

  it('[OTP-1.e] a repeat signUp is held by the cooldown and the cap like a resend', async () => {
    const h = buildTestHarness();
    await signUp(h);
    await signUp(h);
    expect(passcodesSentTo(h)).toHaveLength(1);

    for (let i = 0; i < 4; i += 1) {
      h.clock.advance(AFTER_COOLDOWN);
      await signUp(h);
    }
    expect(passcodesSentTo(h)).toHaveLength(5);

    h.clock.advance(AFTER_COOLDOWN);
    const capped = await signUp(h);
    expect(capped.status).toBe(202);
    expect(capped.body).toEqual({ email: validSignUp.email, status: 'pending' });
    expect(passcodesSentTo(h)).toHaveLength(5);
  });

  it('[OTP-1.e] two concurrent resends outside the cooldown send one passcode', async () => {
    const h = buildTestHarness();
    await signUp(h);
    h.clock.advance(AFTER_COOLDOWN);

    const answers = await Promise.all([resend(h), resend(h)]);

    expect(answers.map((res) => res.status)).toEqual([202, 202]);
    expect(passcodesSentTo(h)).toHaveLength(2);
  });

  it('[OTP-1.e] two racing resends in the service send one new passcode', async () => {
    const h = buildTestHarness();
    const service = signUpServiceOf(h);
    await service.signUp(validSignUp.email);
    h.clock.advance(AFTER_COOLDOWN);

    await Promise.all([service.resend(validSignUp.email), service.resend(validSignUp.email)]);

    expect(passcodesSentTo(h)).toHaveLength(2);
  });

  it('[OTP-1.e] two racing repeat sign-ups in the service send one new passcode', async () => {
    const h = buildTestHarness();
    const service = signUpServiceOf(h);
    await service.signUp(validSignUp.email);
    h.clock.advance(AFTER_COOLDOWN);

    await Promise.all([service.signUp(validSignUp.email), service.signUp(validSignUp.email)]);

    expect(passcodesSentTo(h)).toHaveLength(2);
  });

  it('[OTP-1.e] the pending sign-up store replaces the passcode for only one of two racing resends', async () => {
    const store = new InMemoryPendingSignUpRepository();
    const start = new Date('2026-01-01T09:00:00.000Z');
    await store.create('dana@example.com', 'a'.repeat(64), start);
    const later = new Date(start.getTime() + AFTER_COOLDOWN);

    const results = await Promise.all([
      store.replacePasscode('dana@example.com', 'b'.repeat(64), later),
      store.replacePasscode('dana@example.com', 'c'.repeat(64), later),
    ]);

    expect(results.sort()).toEqual([false, true]);
  });
});
