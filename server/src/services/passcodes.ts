// Passcodes (docs/decisions/0001): drawn with crypto.randomInt, stored only as an HMAC.
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

export type PasscodePurpose = 'signup' | 'reset';

/** ADR-0001's numbers. */
export const PASSCODE_RULES = {
  validForMs: 10 * 60_000,
  maxWrongTries: 5,
  resendCooldownMs: 60_000,
  maxSendsPerHour: 5,
} as const;

const HOUR_MS = 60 * 60_000;

/** A passcode as stored: its HMAC and the bookkeeping the rules need, never the code. */
export type PasscodeState = {
  hmac: string;
  issuedAt: Date;
  wrongTries: number;
  /** When each passcode for this email was sent within the last hour, oldest first. */
  sentAt: Date[];
};

export type PasscodeServiceOptions = {
  /** Keys the HMACs (config.passcodeSecret). */
  secret: string;
  /** The random draw, crypto.randomInt unless a test replaces it. */
  randomInt?: (min: number, max: number) => number;
};

export type PasscodeService = {
  /** A new 6-digit passcode, leading zeros kept. */
  draw(): string;
  /**
   * The HMAC-SHA256, keyed by the server secret, of `purpose:email:passcode`. It is stored in
   * place of the passcode; binding the email and purpose means a stored HMAC can only ever match
   * its own email and flow (a sign-up passcode never resets a password).
   */
  hmac(purpose: PasscodePurpose, email: string, passcode: string): string;
};

export function createPasscodeService({
  secret,
  randomInt: draw = randomInt,
}: PasscodeServiceOptions): PasscodeService {
  return {
    draw: () => String(draw(0, 1_000_000)).padStart(6, '0'),
    hmac: (purpose, email, passcode) =>
      createHmac('sha256', secret).update(`${purpose}:${email}:${passcode}`).digest('hex'),
  };
}

/** A first passcode, sent at `now`. */
export function newPasscodeState(hmac: string, now: Date): PasscodeState {
  return { hmac, issuedAt: now, wrongTries: 0, sentAt: [now] };
}

/**
 * The state after replacing the passcode at `now`, or undefined when the 60-second cooldown
 * (from the latest send, 60 s itself included) or the cap of 5 sends in the past hour holds it
 * back.
 */
export function replacedPasscodeState(
  state: PasscodeState,
  hmac: string,
  now: Date,
): PasscodeState | undefined {
  const t = now.getTime();
  // A send exactly an hour ago still counts as in the past hour.
  const recent = state.sentAt.filter((sent) => t - sent.getTime() <= HOUR_MS);
  const latest = recent.at(-1);
  if (latest && t - latest.getTime() <= PASSCODE_RULES.resendCooldownMs) return undefined;
  if (recent.length >= PASSCODE_RULES.maxSendsPerHour) return undefined;
  return { hmac, issuedAt: now, wrongTries: 0, sentAt: [...recent, now] };
}

/** Within 10 minutes of being sent (10:00 itself included) and not burned by wrong tries. */
export function isPasscodeUsable(state: PasscodeState, now: Date): boolean {
  return (
    now.getTime() - state.issuedAt.getTime() <= PASSCODE_RULES.validForMs &&
    state.wrongTries < PASSCODE_RULES.maxWrongTries
  );
}

/** Compares two hex HMACs in constant time. */
export function hmacsMatch(stored: string, given: string): boolean {
  const a = Buffer.from(stored, 'hex');
  const b = Buffer.from(given, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
