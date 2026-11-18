// Shared by the password reset tests.
import request from 'supertest';
import { createPasscodeService, type PasscodePurpose } from '../../src/services/passcodes';
import { argon2PasswordHasher, type PasswordHasher } from '../../src/services/passwords';
import { createPasswordResetService } from '../../src/services/password-resets';
import { TEST_SECRETS } from './app';
import { registerUser } from './auth';
import { type Harness, validSignUp } from './sign-up';

export const FORGOT = '/api/v1/auth/password/forgot';
export const RESET = '/api/v1/auth/password/reset';

/** A valid password that is not the one the sign-up used. */
export const NEW_PASSWORD = 'a brand new password';

export const requestReset = (h: Harness, email = validSignUp.email) =>
  request(h.app).post(FORGOT).send({ email });

/** resetPassword for the sign-up's email with the new password, unless `overrides` say otherwise. */
export const resetPassword = (
  h: Harness,
  passcode: string,
  overrides: Record<string, unknown> = {},
) =>
  request(h.app)
    .post(RESET)
    .send({ email: validSignUp.email, passcode, password: NEW_PASSWORD, ...overrides });

/** The reset passcodes sent to `email` (not the sign-up ones), oldest first. */
export const resetPasscodesSentTo = (h: Harness, email = validSignUp.email) =>
  h.outbox
    .sentTo(email)
    .filter((message) => message.purpose === 'reset')
    .map((message) => message.passcode);

/** The latest reset passcode sent to `email`. */
export const latestResetPasscode = (h: Harness, email = validSignUp.email) => {
  const passcode = resetPasscodesSentTo(h, email).at(-1);
  if (passcode === undefined) throw new Error(`no reset passcode was sent to ${email}`);
  return passcode;
};

/** The HMAC the server stores for a passcode, computed with the test passcode secret. */
export const hmacOf = (purpose: PasscodePurpose, email: string, passcode: string) =>
  createPasscodeService({ secret: TEST_SECRETS.PASSCODE_SECRET }).hmac(purpose, email, passcode);

/**
 * A verified user made the way a person makes one (sign-up, verifyOtp), who then asks for a reset
 * over HTTP. Returns the reset passcode that was emailed and the user's sign-up token.
 */
export async function userWithResetPasscode(
  h: Harness,
  email = validSignUp.email,
  password = validSignUp.password,
) {
  const { token, user } = await registerUser(h, email, password);
  const res = await requestReset(h, email);
  if (res.status !== 202) throw new Error(`requestPasswordReset answered ${res.status}`);
  return { passcode: latestResetPasscode(h, email), token, user };
}

/**
 * The reset service over the same stores, outbox, clock and secret as the app under test.
 * `randomInt` replaces the passcode draw, `passwords` the hasher.
 */
export const resetServiceOf = (
  h: Harness,
  randomInt?: (min: number, max: number) => number,
  passwords: PasswordHasher = argon2PasswordHasher,
) =>
  createPasswordResetService({
    ...h.deps.repositories,
    mailer: h.deps.mailer,
    clock: h.deps.clock,
    passcodes: createPasscodeService({ secret: h.deps.config.passcodeSecret, randomInt }),
    passwords,
  });

/**
 * Holds every `usePasscode` call on the password reset store until `count` of them are waiting,
 * then lets them all go: racing resets then reach the store together.
 */
export function holdResetPasscodeUses(h: Harness, count = 2): void {
  const usePasscode = h.passwordResets.usePasscode.bind(h.passwordResets);
  const waiting: (() => void)[] = [];
  h.passwordResets.usePasscode = async (email, hmac, now) => {
    await new Promise<void>((resolve) => {
      waiting.push(resolve);
      if (waiting.length === count) for (const release of waiting) release();
    });
    return usePasscode(email, hmac, now);
  };
}
