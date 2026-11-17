// Shared by the sign-up and passcode tests.
import request from 'supertest';
import { createPasscodeService } from '../../src/services/passcodes';
import { createSignUpService } from '../../src/services/sign-up';
import { buildTestHarness } from './app';

export type Harness = ReturnType<typeof buildTestHarness>;

export const SIGN_UP = '/api/v1/auth/signup';
export const RESEND = '/api/v1/auth/otp/resend';

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

/**
 * The sign-up service over the same stores, outbox, clock and secret as the app under test.
 * `randomInt` replaces the random draw.
 */
export const signUpServiceOf = (h: Harness, randomInt?: (min: number, max: number) => number) =>
  createSignUpService({
    ...h.deps.repositories,
    mailer: h.deps.mailer,
    clock: h.deps.clock,
    passcodes: createPasscodeService({ secret: h.deps.config.passcodeSecret, randomInt }),
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

/** Every primitive inside `value` (Dates count as one), walking objects and arrays. */
export function leavesOf(value: unknown): unknown[] {
  if (value instanceof Date || value === null || typeof value !== 'object') return [value];
  return Object.values(value).flatMap(leavesOf);
}

export const fieldsOf = (body: { errors?: { field: string }[] }) =>
  (body.errors ?? []).map((error) => error.field).sort();
