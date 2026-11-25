// DP-2: passcode emails are sent after the answer, so neither the time to answer nor a failed send
// tells a registered email from an unknown one.
import { setImmediate as tick } from 'node:timers/promises';
import { describe, expect, it } from '@jest/globals';
import request from 'supertest';
import { createApp } from '../src/app';
import { createLogger } from '../src/logger';
import type { Mailer, PasscodeMessage } from '../src/mail/mailer';
import { MailerError } from '../src/mail/resend';
import { buildTestHarness } from './support/app';
import { answerOf } from './support/auth';
import { AFTER_COOLDOWN, aUser, RESEND, SIGN_UP, validSignUp } from './support/sign-up';

const FORGOT = '/api/v1/auth/password/forgot';

/** A mailer whose sends never finish while the test runs. */
function stuckMailer() {
  const started: PasscodeMessage[] = [];
  const mailer: Mailer = {
    sendPasscode: (message) => {
      started.push(message);
      return new Promise<void>(() => undefined);
    },
  };
  return { mailer, started };
}

/**
 * A mailer whose sends fail: resets as the email API refusing them, sign-ups with an unexpected
 * error that carries the passcode and the address.
 */
function failingMailer() {
  const started: PasscodeMessage[] = [];
  const mailer: Mailer = {
    sendPasscode: async (message) => {
      started.push(message);
      if (message.purpose === 'reset') throw new MailerError(422, 'answered 422');
      throw new Error(`could not send ${message.passcode} to ${message.to}`);
    },
  };
  return { mailer, started };
}

describe('DP-2 passcode emails are sent after the answer', () => {
  it('[DP-2] sign-up, resend and password-reset requests answer 202 while their emails are still being sent', async () => {
    const h = buildTestHarness();
    const { mailer, started } = stuckMailer();
    const app = createApp({ ...h.deps, mailer });
    await h.users.insert(aUser('omer@example.com'));

    const signedUp = await request(app).post(SIGN_UP).send(validSignUp);
    h.clock.advance(AFTER_COOLDOWN);
    const resent = await request(app).post(RESEND).send({ email: validSignUp.email });
    const forgot = await request(app).post(FORGOT).send({ email: 'omer@example.com' });

    expect([signedUp.status, resent.status, forgot.status]).toEqual([202, 202, 202]);
    expect(started.map((message) => [message.to, message.purpose])).toEqual([
      [validSignUp.email, 'signup'],
      [validSignUp.email, 'signup'],
      ['omer@example.com', 'reset'],
    ]);
  });

  it('[DP-2] when the email fails, a reset request for a registered email answers like one for an unknown email, and the failure is logged without the passcode or the address', async () => {
    const lines: string[] = [];
    const logger = createLogger('info', { write: (line: string) => void lines.push(line) });
    const h = buildTestHarness({ logger });
    const { mailer, started } = failingMailer();
    const app = createApp({ ...h.deps, mailer });
    await h.users.insert(aUser('omer@example.com'));

    const registered = await request(app).post(FORGOT).send({ email: 'omer@example.com' });
    const unknown = await request(app).post(FORGOT).send({ email: 'nobody@example.com' });
    const signedUp = await request(app).post(SIGN_UP).send(validSignUp);
    await tick();

    expect(registered.status).toBe(202);
    expect(answerOf(registered)).toEqual(answerOf(unknown));
    expect(signedUp.status).toBe(202);
    expect(started).toHaveLength(2);
    const failures = lines
      .map((line) => JSON.parse(line) as { msg: string; purpose?: string; err?: unknown })
      .filter((line) => line.msg === 'passcode email not sent');
    expect(failures).toMatchObject([
      {
        purpose: 'reset',
        err: { type: 'MailerError', message: 'the email API answered 422', status: 422 },
      },
      { purpose: 'signup', err: { type: 'Error' } },
    ]);
    expect(failures[1]?.err).toEqual({ type: 'Error' });
    for (const message of started) {
      expect(lines.join('')).not.toContain(message.passcode);
      expect(lines.join('')).not.toContain(message.to);
    }
  });
});
