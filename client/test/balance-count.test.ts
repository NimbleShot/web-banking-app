import { describe, expect, it } from '@jest/globals';
import { formatRemaining } from '../src/format';
import { COUNT_MS, countFrame } from '../src/motion/balanceCount';

const SIZES = [1, 7, 435, 98_765, 99_999_999, 100_000_000];
const BALANCES = [0, 1, 12_345, 523_400, 900_000_001];

describe('the counting balance', () => {
  it('[UX-10] every frame is whole agorot that adds up to the true balance, never counts back, and ends on the server value', () => {
    for (const balance of BALANCES) {
      for (const size of SIZES) {
        for (const change of [-size, size]) {
          const before = balance - change;
          expect(countFrame(balance, change, -5)).toEqual({ shown: before, remaining: size });
          expect(countFrame(balance, change, 0)).toEqual({ shown: before, remaining: size });

          let last = size;
          for (let elapsed = 0; elapsed <= COUNT_MS; elapsed += 3) {
            const { shown, remaining } = countFrame(balance, change, elapsed);
            expect(Number.isInteger(shown) && Number.isInteger(remaining)).toBe(true);
            expect(shown + Math.sign(change) * remaining).toBe(balance);
            expect(remaining).toBeLessThanOrEqual(last);
            last = remaining;
          }

          expect(countFrame(balance, change, COUNT_MS)).toEqual({ shown: balance, remaining: 0 });
          expect(countFrame(balance, change, COUNT_MS * 9)).toEqual({
            shown: balance,
            remaining: 0,
          });
        }
      }
    }
  });

  it('[UX-10] the amount above the balance keeps its sign, even once it reaches zero', () => {
    expect(formatRemaining(-98_765, 98_765)).toBe('−987.65 ₪');
    expect(formatRemaining(-98_765, 5)).toBe('−0.05 ₪');
    expect(formatRemaining(-98_765, 0)).toBe('−0.00 ₪');
    expect(formatRemaining(125_000, 0)).toBe('+0.00 ₪');
  });
});
