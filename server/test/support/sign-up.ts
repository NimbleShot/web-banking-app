// Shared by the sign-up and passcode tests.
import request from 'supertest';
import type { NewUser } from '../../src/repositories/users';
import { createPasscodeService } from '../../src/services/passcodes';
import { argon2PasswordHasher, type PasswordHasher } from '../../src/services/passwords';
import { createSignUpService } from '../../src/services/sign-up';
import { buildTestHarness } from './app';

export type Harness = ReturnType<typeof buildTestHarness>;

export const SIGN_UP = '/api/v1/auth/signup';
export const RESEND = '/api/v1/auth/otp/resend';
export const VERIFY = '/api/v1/auth/otp/verify';

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
/** Just past the resend cooldown. */
export const AFTER_COOLDOWN = MINUTE + SECOND;

export const validSignUp = {
  email: 'dana@example.com',
  password: 'correct horse',
  phone: '+972501234567',
};

export const signUp = (h: Harness, body: Record<string, unknown> = validSignUp) =>
  request(h.app).post(SIGN_UP).send(body);

export const resend = (h: Harness, email = validSignUp.email) =>
  request(h.app).post(RESEND).send({ email });

/** The passcodes sent to `email`, oldest first. */
export const passcodesSentTo = (h: Harness, email = validSignUp.email) =>
  h.outbox.sentTo(email).map((message) => message.passcode);

/** verifyOtp with the sign-up form's password and phone and the given passcode. */
export const verify = (h: Harness, passcode: string, overrides: Record<string, unknown> = {}) =>
  request(h.app)
    .post(VERIFY)
    .send({
      email: validSignUp.email,
      passcode,
      password: validSignUp.password,
      phone: validSignUp.phone,
      ...overrides,
    });

/** The latest passcode sent to `email`. */
export const latestPasscode = (h: Harness, email = validSignUp.email) => {
  const passcode = passcodesSentTo(h, email).at(-1);
  if (passcode === undefined) throw new Error(`no passcode was sent to ${email}`);
  return passcode;
};

/** Signs up over HTTP and returns the passcode that was emailed. */
export async function signUpForPasscode(h: Harness, email = validSignUp.email): Promise<string> {
  const res = await signUp(h, { ...validSignUp, email });
  if (res.status !== 202) throw new Error(`sign-up answered ${res.status}`);
  return latestPasscode(h, email.toLowerCase());
}

/** A passcode that is not `passcode`. */
export const wrongPasscode = (passcode: string) => (passcode === '000000' ? '000001' : '000000');

export type ServiceOptions = {
  /** Replaces the starting balance's draw. */
  balanceDraw?: (min: number, max: number) => number;
  /** Replaces the argon2id hasher, e.g. to count calls. */
  passwords?: PasswordHasher;
};

/**
 * The sign-up service over the same stores, outbox, clock and secret as the app under test.
 * `randomInt` replaces the passcode draw.
 */
export const signUpServiceOf = (
  h: Harness,
  randomInt?: (min: number, max: number) => number,
  { balanceDraw, passwords = argon2PasswordHasher }: ServiceOptions = {},
) =>
  createSignUpService({
    ...h.deps.repositories,
    mailer: h.deps.mailer,
    clock: h.deps.clock,
    passcodes: createPasscodeService({ secret: h.deps.config.passcodeSecret, randomInt }),
    passwords,
    balanceDraw,
  });

/** The argon2id hasher, counting its calls. */
export function countingHasher(): PasswordHasher & { calls: number } {
  const hasher = {
    calls: 0,
    hash: (password: string) => {
      hasher.calls += 1;
      return argon2PasswordHasher.hash(password);
    },
  };
  return hasher;
}

/** A verified user for setting up a store; the hash is a placeholder, not a real one. */
export const aUser = (email = validSignUp.email): NewUser => ({
  email,
  phone: validSignUp.phone,
  passwordHash: 'placeholder-not-a-hash',
  balance: 100_000,
  createdAt: new Date('2026-01-01T08:00:00.000Z'),
});

/** A draw that gives 1, 2, 3, ...: every passcode differs from the last. */
export function countingDraw(): () => number {
  let next = 0;
  return () => (next += 1);
}

/**
 * Holds every `findByEmail` call until `count` of them are waiting, then lets them all go: two
 * racing sign-ups then both pass the user look-up before either reaches the store.
 */
export function holdUserLookUps(h: Harness, count = 2): void {
  const findByEmail = h.users.findByEmail.bind(h.users);
  const waiting: (() => void)[] = [];
  h.users.findByEmail = async (email) => {
    await new Promise<void>((resolve) => {
      waiting.push(resolve);
      if (waiting.length === count) for (const release of waiting) release();
    });
    return findByEmail(email);
  };
}

/**
 * Holds every `usePasscode` call on the pending sign-up store until `count` of them are waiting,
 * then lets them all go: racing verifications then reach the store together.
 */
export function holdPasscodeUses(h: Harness, count = 2): void {
  const usePasscode = h.pendingSignUps.usePasscode.bind(h.pendingSignUps);
  const waiting: (() => void)[] = [];
  h.pendingSignUps.usePasscode = async (email, hmac, now) => {
    await new Promise<void>((resolve) => {
      waiting.push(resolve);
      if (waiting.length === count) for (const release of waiting) release();
    });
    return usePasscode(email, hmac, now);
  };
}

/** Every primitive inside `value` (Dates count as one), walking objects and arrays. */
export function leavesOf(value: unknown): unknown[] {
  if (value instanceof Date || value === null || typeof value !== 'object') return [value];
  return Object.values(value).flatMap(leavesOf);
}

export const fieldsOf = (body: { errors?: { field: string }[] }) =>
  (body.errors ?? []).map((error) => error.field).sort();
