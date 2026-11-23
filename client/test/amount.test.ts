import { describe, expect, it } from '@jest/globals';
import { checkAmount } from '../src/forms/amount';

describe('the amount a user types', () => {
  it.each([
    ['12.50', 1250],
    ['250', 25000],
    ['0.07', 7],
    ['0.01', 1],
    ['19.99', 1999],
    // 4.35 * 100 and 1.15 * 100 both come out wrong in floating point.
    ['4.35', 435],
    ['1.15', 115],
    ['1.1', 110],
    ['007.5', 750],
    [' 12.50 ', 1250],
    ['1,234.56', 123456],
    ['1,000,000', 100000000],
    ['1000000.00', 100000000],
  ])('[UX-6] %j becomes exactly %i agorot', (text, agorot) => {
    expect(checkAmount(text)).toEqual({ ok: true, agorot });
  });

  it.each([
    ['', 'Enter an amount like 250 or 12.50.'],
    ['abc', 'Enter an amount like 250 or 12.50.'],
    ['-5', 'Enter an amount like 250 or 12.50.'],
    ['1e3', 'Enter an amount like 250 or 12.50.'],
    ['12.345', 'Enter an amount like 250 or 12.50.'],
    ['.5', 'Enter an amount like 250 or 12.50.'],
    ['5.', 'Enter an amount like 250 or 12.50.'],
    // A decimal comma must never be read as thousands: this would send 1,250.00.
    ['12,50', 'Enter an amount like 250 or 12.50.'],
    ['1,23,456', 'Enter an amount like 250 or 12.50.'],
    ['0', 'Enter an amount above zero.'],
    ['0.00', 'Enter an amount above zero.'],
    ['1000000.01', 'You can send up to 1,000,000.00 ₪ at a time.'],
    ['99999999999999999999', 'You can send up to 1,000,000.00 ₪ at a time.'],
  ])('[UX-6] %j is refused with its message', (text, message) => {
    expect(checkAmount(text)).toEqual({ ok: false, message });
  });
});
