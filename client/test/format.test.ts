import { describe, expect, it } from '@jest/globals';
import { formatBalance, formatTransfer, formatWhen } from '../src/format';

describe('how money and dates read', () => {
  it("[UX-5] integer agorot show exactly, signed from the reader's side, and dates by the local day", () => {
    expect(formatBalance(523400)).toBe('5,234.00');
    expect(formatBalance(0)).toBe('0.00');
    expect(formatBalance(5)).toBe('0.05');
    expect(formatBalance(100000000)).toBe('1,000,000.00');
    expect(formatTransfer(-18050)).toBe('−180.50 ₪');
    expect(formatTransfer(125000)).toBe('+1,250.00 ₪');
    expect(formatTransfer(1)).toBe('+0.01 ₪');

    const at = (...parts: [number, number, number, number, number]) =>
      new Date(...parts).toISOString();
    const now = new Date(2026, 11, 1, 12, 0);
    expect(formatWhen(at(2026, 11, 1, 9, 42), now)).toBe('Today, 09:42');
    expect(formatWhen(at(2026, 10, 30, 18, 5), now)).toBe('Yesterday, 18:05');
    expect(formatWhen(at(2026, 10, 21, 12, 30), now)).toBe('21 Nov, 12:30');
    expect(formatWhen(at(2025, 10, 21, 0, 7), now)).toBe('21 Nov 2025, 00:07');
  });
});
