// What the passcode screens share. The server enforces the limits; these numbers only inform the
// user, so a count that drifts (after a reload, say) can never allow an extra try.

export const CODE_LENGTH = 6;
export const MAX_TRIES = 5;
export const RESEND_COOLDOWN_MS = 60_000;

export function codeDigits(text: string): string {
  return text.replace(/\D/g, '').slice(0, CODE_LENGTH);
}

export function triesAlert(triesLeft: number) {
  const label = triesLeft === 1 ? 'TRY LEFT' : 'TRIES LEFT';
  if (triesLeft === 0) {
    return {
      title: 'No tries left.',
      body: 'This code no longer works. Send yourself a new one.',
      label,
    };
  }
  return {
    title: "That code didn't work.",
    body:
      triesLeft === 1
        ? 'One more wrong code and this one stops working.'
        : 'It may be mistyped or expired. Check your email and try again.',
    label,
  };
}

/** `0:42` for the time left, rounded up so it reaches 0:00 only when the wait is over. */
export function countdownText(milliseconds: number): string {
  const seconds = Math.ceil(Math.min(milliseconds, RESEND_COOLDOWN_MS) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
