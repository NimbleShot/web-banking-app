// Pending password resets (docs/decisions/0008): the lowercased email and the reset passcode's
// state. Only a verified user's email ever gets one.
import {
  hmacsMatch,
  isPasscodeUsable,
  newPasscodeState,
  type PasscodeState,
  replacedPasscodeState,
} from '../services/passcodes';

export type PasswordReset = {
  /** Lowercased. */
  email: string;
  passcode: PasscodeState;
  /**
   * True once a reset used the passcode up. The record stays, so the cooldown and the cap in
   * `passcode.sentAt` still count the sends made before the reset.
   */
  used: boolean;
};

/**
 * Each method is one atomic step: the in-memory store does it with no `await` inside, so two
 * racing requests can't both pass a check before either writes.
 */
export type PasswordResetRepository = {
  /**
   * Stores a first passcode, or replaces the existing one (also a used one) unless the resend cooldown or the cap
   * holds it back. True when the passcode was stored (and so should be sent).
   */
  issue(email: string, hmac: string, now: Date): Promise<boolean>;
  /**
   * Uses up a current, unused passcode whose HMAC matches (it can never be used again, and the
   * send history stays); a mismatch counts one wrong try.
   */
  usePasscode(email: string, hmac: string, now: Date): Promise<boolean>;
};

const copy = (record: PasswordReset): PasswordReset => structuredClone(record);

export class InMemoryPasswordResetRepository implements PasswordResetRepository {
  private readonly byEmail = new Map<string, PasswordReset>();

  issue: PasswordResetRepository['issue'] = async (email, hmac, now) => {
    const record = this.byEmail.get(email);
    if (!record) {
      this.byEmail.set(email, { email, passcode: newPasscodeState(hmac, now), used: false });
      return true;
    }
    const next = replacedPasscodeState(record.passcode, hmac, now);
    if (!next) return false;
    record.passcode = next;
    record.used = false;
    return true;
  };

  usePasscode: PasswordResetRepository['usePasscode'] = async (email, hmac, now) => {
    const record = this.byEmail.get(email);
    if (!record || record.used || !isPasscodeUsable(record.passcode, now)) return false;
    if (!hmacsMatch(record.passcode.hmac, hmac)) {
      record.passcode.wrongTries += 1;
      return false;
    }
    record.used = true;
    return true;
  };

  /** Copies of every stored record, for inspection. */
  snapshot(): PasswordReset[] {
    return [...this.byEmail.values()].map(copy);
  }
}
