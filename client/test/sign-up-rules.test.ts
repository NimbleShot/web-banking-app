import { describe, expect, it } from '@jest/globals';
import { nextDraft } from '../src/auth/codeProgress';
import type { SignUpDraft } from '../src/auth/signUpDraft';
import { MAX_TRIES, RESEND_COOLDOWN_MS, triesAlert } from '../src/forms/passcode';
import { checkEmail, checkPassword, checkPhone } from '../src/forms/rules';

const details = {
  email: 'dana@example.com',
  phone: '+972501234567',
  phoneText: '050-123-4567',
  password: 'correct-horse-9',
};

describe('sign-up form rules', () => {
  it.each([
    ['050-123-4567'],
    ['50 123 4567'],
    ['0501234567'],
    ['+972 50 123 4567'],
    ['+972-050-123-4567'],
    ['00972501234567'],
    ['(050) 123 4567'],
  ])('[UX-2] the Israeli mobile %s is sent as +972501234567', (text) => {
    expect(checkPhone(text)).toEqual({ ok: true, value: '+972501234567' });
  });

  it.each([
    [''],
    ['50 12'],
    ['031234567'],
    ['+1 202 555 0143'],
    ['050123456'],
    ['05012345678'],
    ['05a1234567'],
  ])('[UX-2] the phone %j is refused with the drawn message', (text) => {
    expect(checkPhone(text)).toEqual({
      ok: false,
      message: 'Enter the full number, like 50 123 4567.',
    });
  });

  it('[UX-2] email and password follow the contract, counting characters and UTF-8 bytes', () => {
    expect(checkEmail('dana@example.com').ok).toBe(true);
    for (const bad of [
      '',
      'dana',
      'dana@example',
      ' dana@example.com',
      `${'a'.repeat(250)}@b.co`,
    ]) {
      expect(checkEmail(bad).ok).toBe(false);
    }
    expect(checkPassword('1234567').ok).toBe(false);
    expect(checkPassword('12345678').ok).toBe(true);
    expect(checkPassword('a'.repeat(72)).ok).toBe(true);
    expect(checkPassword('a'.repeat(73)).ok).toBe(false);
    // 18 emoji are 72 bytes and pass; 19 are 19 characters but 76 bytes, which the server refuses.
    expect(checkPassword('😀'.repeat(18)).ok).toBe(true);
    expect(checkPassword('😀'.repeat(19)).ok).toBe(false);
  });
});

describe('the sign-up draft and the tries left', () => {
  const now = 1_000_000;

  it('[UX-2] a repeat sign-up inside the cooldown keeps the tries and countdown of the same code', () => {
    const first = nextDraft(null, details, now);
    expect(first).toMatchObject({ triesLeft: MAX_TRIES, resendAt: now + RESEND_COOLDOWN_MS });

    const tried: SignUpDraft = { ...first, triesLeft: 2 };
    const sameEmail = { ...details, email: 'DANA@example.com' };
    expect(nextDraft(tried, sameEmail, now + 1000)).toMatchObject({
      triesLeft: 2,
      resendAt: first.resendAt,
    });

    const afterCooldown = now + RESEND_COOLDOWN_MS;
    expect(nextDraft(tried, details, afterCooldown)).toMatchObject({
      triesLeft: MAX_TRIES,
      resendAt: afterCooldown + RESEND_COOLDOWN_MS,
    });
    expect(nextDraft(tried, { ...details, email: 'noa@example.com' }, now + 1000)).toMatchObject({
      triesLeft: MAX_TRIES,
    });
  });

  it('[UX-2] the alert warns on the last try and says when none are left', () => {
    expect(triesAlert(4)).toMatchObject({ title: "That code didn't work.", label: 'TRIES LEFT' });
    expect(triesAlert(1)).toMatchObject({
      body: 'One more wrong code and this one stops working.',
      label: 'TRY LEFT',
    });
    expect(triesAlert(0)).toMatchObject({
      title: 'No tries left.',
      body: 'This code no longer works. Send yourself a new one.',
    });
  });
});
