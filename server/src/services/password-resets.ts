// Password reset (docs/decisions/0008): an emailed passcode, then a new password.
import type { Clock } from '../clock';
import type { Mailer } from '../mail/mailer';
import type { PasswordResetRepository } from '../repositories/password-resets';
import type { UserRepository } from '../repositories/users';
import type { PasscodeService } from './passcodes';
import type { PasswordHasher } from './passwords';

export type PasswordResetDeps = {
  users: UserRepository;
  passwordResets: PasswordResetRepository;
  mailer: Mailer;
  clock: Clock;
  passcodes: PasscodeService;
  passwords: PasswordHasher;
};

/** What resetPassword sends with the passcode. */
export type ResetAttempt = { email: string; passcode: string; password: string };

/** `reset` once the password changed, or `invalid` for every failure alike (SEC-4.c). */
export type ResetOutcome = { result: 'reset' } | { result: 'invalid' };

export type PasswordResetService = {
  /**
   * Sends a reset passcode when a verified user has the email, outside the cooldown and cap; for
   * any other email nothing is sent or stored.
   */
  request(email: string): Promise<void>;
  /** Uses up the passcode first; only then hashes the new password and stores the hash. */
  reset(attempt: ResetAttempt): Promise<ResetOutcome>;
};

/** Every method takes the email as given and lowercases it. */
export function createPasswordResetService(deps: PasswordResetDeps): PasswordResetService {
  const { users, passwordResets, mailer, clock, passcodes, passwords } = deps;

  return {
    async request(rawEmail) {
      const email = rawEmail.toLowerCase();
      // An unknown email and a pending sign-up have no user: nothing is stored or sent.
      if (!(await users.findByEmail(email))) return;
      const passcode = passcodes.draw();
      // Sends only after the store accepted this passcode, so the cooldown, the cap and a racing
      // request each leave nothing sent.
      if (
        await passwordResets.issue(email, passcodes.hmac('reset', email, passcode), clock.now())
      ) {
        await mailer.sendPasscode({ to: email, purpose: 'reset', passcode });
      }
    },

    async reset({ email: rawEmail, passcode, password }) {
      const email = rawEmail.toLowerCase();
      // One store step decides: of two racing resets only one gets past here, and a wrong passcode
      // never costs a password hash.
      const used = await passwordResets.usePasscode(
        email,
        passcodes.hmac('reset', email, passcode),
        clock.now(),
      );
      if (!used) return { result: 'invalid' };
      const passwordHash = await passwords.hash(password);
      // False only if the user is gone since the passcode was sent: the same answer as any failure.
      return (await users.updatePasswordHash(email, passwordHash))
        ? { result: 'reset' }
        : { result: 'invalid' };
    },
  };
}
