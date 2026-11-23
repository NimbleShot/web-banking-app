import { MAX_TRIES, RESEND_COOLDOWN_MS } from '../forms/passcode';

/** How far the user is with the code emailed to them. */
export type CodeProgress = { triesLeft: number; resendAt: number };

/** Inside the cooldown the server sends nothing, so the code already emailed stays the live one. */
export function isSameCode(
  previous: ({ email: string } & CodeProgress) | null,
  email: string,
  now: number,
): boolean {
  return (
    previous !== null &&
    previous.email.toLowerCase() === email.toLowerCase() &&
    now < previous.resendAt
  );
}

/** The draft after a code was asked for: the same live code keeps its tries and countdown. */
export function nextDraft<T extends { email: string }>(
  previous: (T & CodeProgress) | null,
  details: T,
  now: number,
): T & CodeProgress {
  const sameCode = isSameCode(previous, details.email, now);
  return {
    ...details,
    triesLeft: sameCode && previous ? previous.triesLeft : MAX_TRIES,
    resendAt: sameCode && previous ? previous.resendAt : now + RESEND_COOLDOWN_MS,
  };
}
