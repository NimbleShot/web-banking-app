export const COUNT_MS = 1500;

export type CountFrame = {
  /** The balance on screen, in agorot. */
  shown: number;
  /** How much of the transfer is still to count, in agorot. */
  remaining: number;
};

const easeInOut = (t: number) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);

/**
 * One frame of the count towards `balance`, the server's value, after a signed `change`. Only the
 * remainder is computed: the balance on screen is derived from it, so the two always add up.
 */
export function countFrame(balance: number, change: number, elapsedMs: number): CountFrame {
  const progress = Math.max(0, Math.min(1, elapsedMs / COUNT_MS));
  const remaining = Math.round(Math.abs(change) * (1 - easeInOut(progress)));
  return { remaining, shown: change < 0 ? balance + remaining : balance - remaining };
}
