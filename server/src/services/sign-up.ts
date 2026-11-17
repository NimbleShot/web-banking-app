// Sign-up (docs/decisions/0007): a pending sign-up and an emailed passcode, nothing else yet.
import type { Clock } from '../clock';
import type { Mailer } from '../mail/mailer';
import type { PendingSignUpRepository } from '../repositories/pending-sign-ups';
import type { UserRepository } from '../repositories/users';
import type { PasscodeService } from './passcodes';

export type SignUpDeps = {
  users: UserRepository;
  pendingSignUps: PendingSignUpRepository;
  mailer: Mailer;
  clock: Clock;
  passcodes: PasscodeService;
};

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
};

/** Every method takes the email as given and lowercases it. */
export function createSignUpService(deps: SignUpDeps): SignUpService {
  const { users, pendingSignUps, mailer, clock, passcodes } = deps;

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

    async usePasscode(rawEmail, passcode) {
      const email = rawEmail.toLowerCase();
      return pendingSignUps.usePasscode(
        email,
        passcodes.hmac('signup', email, passcode),
        clock.now(),
      );
    },
  };
}
