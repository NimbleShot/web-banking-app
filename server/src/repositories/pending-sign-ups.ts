// Pending sign-ups (docs/decisions/0007): the lowercased email, the passcode's HMAC and times.
import {
  hmacsMatch,
  isPasscodeUsable,
  newPasscodeState,
  type PasscodeState,
  replacedPasscodeState,
} from '../services/passcodes';

/** A pending sign-up older than this counts as absent; one exactly this old is still live (docs/decisions/0002, 0007). */
export const PENDING_SIGN_UP_TTL_MS = 24 * 60 * 60_000;

/** Whether a pending sign-up started at `createdAt` still counts at `now`; every store applies this rule. */
export function isPendingSignUpLive(createdAt: Date, now: Date): boolean {
  return now.getTime() - createdAt.getTime() <= PENDING_SIGN_UP_TTL_MS;
}

export type PendingSignUp = {
  /** Lowercased. */
  email: string;
  createdAt: Date;
  passcode: PasscodeState;
};

/**
 * Each method is one atomic step: the in-memory store does it with no `await` inside, so two
 * racing requests can't both pass a check before either writes.
 */
export type PendingSignUpRepository = {
  /** Starts a pending sign-up unless a live one exists (one older than 24 hours doesn't count). */
  create(email: string, hmac: string, now: Date): Promise<boolean>;
  /** Replaces a live pending sign-up's passcode, unless the resend cooldown or cap holds it back. */
  replacePasscode(email: string, hmac: string, now: Date): Promise<boolean>;
  /** Uses up a live, current passcode whose HMAC matches; a mismatch counts one wrong try. */
  usePasscode(email: string, hmac: string, now: Date): Promise<boolean>;
};

const copy = (record: PendingSignUp): PendingSignUp => structuredClone(record);

export class InMemoryPendingSignUpRepository implements PendingSignUpRepository {
  private readonly byEmail = new Map<string, PendingSignUp>();

  private live(email: string, now: Date): PendingSignUp | undefined {
    const record = this.byEmail.get(email);
    return record && isPendingSignUpLive(record.createdAt, now) ? record : undefined;
  }

  async create(email: string, hmac: string, now: Date): Promise<boolean> {
    if (this.live(email, now)) return false;
    this.byEmail.set(email, { email, createdAt: now, passcode: newPasscodeState(hmac, now) });
    return true;
  }

  async replacePasscode(email: string, hmac: string, now: Date): Promise<boolean> {
    const record = this.live(email, now);
    if (!record) return false;
    const next = replacedPasscodeState(record.passcode, hmac, now);
    if (!next) return false;
    record.passcode = next;
    return true;
  }

  async usePasscode(email: string, hmac: string, now: Date): Promise<boolean> {
    const record = this.live(email, now);
    if (!record || !isPasscodeUsable(record.passcode, now)) return false;
    if (!hmacsMatch(record.passcode.hmac, hmac)) {
      record.passcode.wrongTries += 1;
      return false;
    }
    this.byEmail.delete(email);
    return true;
  }

  /** Copies of every stored record, for inspection. */
  snapshot(): PendingSignUp[] {
    return [...this.byEmail.values()].map(copy);
  }
}
