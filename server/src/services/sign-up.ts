// Sign-up (docs/decisions/0007): a pending sign-up and an emailed passcode, then verification,
// which creates the user.
import { randomInt } from 'node:crypto';
import type { Clock } from '../clock';
import type { Mailer } from '../mail/mailer';
import type { PendingSignUpRepository } from '../repositories/pending-sign-ups';
import { DuplicateEmailError, type User, type UserRepository } from '../repositories/users';
import type { PasscodeService } from './passcodes';
import type { PasswordHasher } from './passwords';

export type SignUpDeps = {
  users: UserRepository;
  pendingSignUps: PendingSignUpRepository;
  mailer: Mailer;
  clock: Clock;
  passcodes: PasscodeService;
  passwords: PasswordHasher;
  /** The starting balance's draw, crypto.randomInt unless a test replaces it. */
  balanceDraw?: (min: number, max: number) => number;
};

/** What verifyOtp sends with the passcode: the sign-up form's credentials (docs/decisions/0007). */
export type Verification = {
  email: string;
  passcode: string;
  password: string;
  phone: string;
};

/** The starting balance: a whole number of shekels from 1,000 to 10,000, in agorot (DB-2). */
export const STARTING_BALANCE_SHEKELS = { min: 1_000, max: 10_000 } as const;

/** `verified` with the new user, or `invalid` for every failure alike (OTP-3.d). */
export type VerifyOutcome = { result: 'verified'; user: User } | { result: 'invalid' };

export type SignUpService = {
  /**
   * `taken` when a verified user has the email; otherwise `accepted` with the lowercased email,
   * and a passcode went out unless the cooldown or cap held it back.
   */
  signUp(email: string): Promise<{ result: 'accepted'; email: string } | { result: 'taken' }>;
  /** Sends a new passcode if a sign-up is pending, outside the cooldown and cap; else nothing. */
  resend(email: string): Promise<void>;
  /** True when `passcode` is the pending sign-up's current one; it is then used up. */
  usePasscode(email: string, passcode: string): Promise<boolean>;
  /**
   * Uses up the passcode first; only then hashes the password and creates the verified user with
   * a random starting balance.
   */
  verify(verification: Verification): Promise<VerifyOutcome>;
};

/** Every method takes the email as given and lowercases it. */
export function createSignUpService(deps: SignUpDeps): SignUpService {
  const { users, pendingSignUps, mailer, clock, passcodes, passwords } = deps;
  const balanceDraw = deps.balanceDraw ?? randomInt;

  /** A fresh passcode and its HMAC; only the HMAC is stored. */
  const fresh = (email: string) => {
    const passcode = passcodes.draw();
    return { passcode, hmac: passcodes.hmac('signup', email, passcode) };
  };

  /** Sends only after the store accepted this passcode, so a racing loser sends nothing. */
  const send = (email: string, passcode: string) =>
    mailer.sendPasscode({ to: email, purpose: 'signup', passcode });

  /** Replaces the passcode with `code` (a fresh one unless given) and sends it if accepted. */
  const resend = async (email: string, code = fresh(email)): Promise<void> => {
    if (await pendingSignUps.replacePasscode(email, code.hmac, clock.now())) {
      await send(email, code.passcode);
    }
  };

  /** True when `passcode` is the pending sign-up's current one; it is then used up. */
  const usePasscode = (rawEmail: string, passcode: string): Promise<boolean> => {
    const email = rawEmail.toLowerCase();
    return pendingSignUps.usePasscode(
      email,
      passcodes.hmac('signup', email, passcode),
      clock.now(),
    );
  };

  return {
    async signUp(rawEmail) {
      const email = rawEmail.toLowerCase();
      if (await users.findByEmail(email)) return { result: 'taken' };
      const code = fresh(email);
      if (await pendingSignUps.create(email, code.hmac, clock.now())) {
        await send(email, code.passcode);
      } else {
        // Already pending: a repeat sign-up is a resend, under its cooldown and cap.
        await resend(email, code);
      }
      return { result: 'accepted', email };
    },

    resend: (rawEmail) => resend(rawEmail.toLowerCase()),

    usePasscode,

    async verify({ email: rawEmail, passcode, password, phone }) {
      const email = rawEmail.toLowerCase();
      // One store step decides: of two racing verifications only one gets past here, and a wrong
      // passcode never costs a password hash.
      if (!(await usePasscode(email, passcode))) return { result: 'invalid' };
      const passwordHash = await passwords.hash(password);
      const { min, max } = STARTING_BALANCE_SHEKELS;
      const balance = balanceDraw(min, max + 1) * 100;
      try {
        const user = await users.insert({
          email,
          phone,
          passwordHash,
          balance,
          createdAt: clock.now(),
        });
        return { result: 'verified', user };
      } catch (error) {
        // The email became a user some other way since the sign-up began: the store refused a
        // second one. The answer is the same as for any failed verification.
        if (error instanceof DuplicateEmailError) return { result: 'invalid' };
        throw error;
      }
    },
  };
}
