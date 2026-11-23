// Turns the amount a user typed into integer agorot. It joins the digits as text and never
// multiplies a decimal: 4.35 * 100 is 434.99999999999994 in floating point.

export const MAX_TRANSFER_AGOROT = 100_000_000;

export type AmountCheck = { ok: true; agorot: number } | { ok: false; message: string };

// A comma only ever separates thousands. "12,50" is refused rather than read as 1,250.
const AMOUNT = /^(\d+|\d{1,3}(?:,\d{3})+)(?:\.(\d{1,2}))?$/;

export function checkAmount(text: string): AmountCheck {
  const match = AMOUNT.exec(text.trim());
  if (!match) return { ok: false, message: 'Enter an amount like 250 or 12.50.' };

  const whole = (match[1] ?? '').replace(/,/g, '').replace(/^0+(?=\d)/, '');
  const digits = `${whole}${(match[2] ?? '').padEnd(2, '0')}`;
  // By length first, so a very long number is refused without ever being converted.
  if (digits.length > String(MAX_TRANSFER_AGOROT).length || Number(digits) > MAX_TRANSFER_AGOROT) {
    return { ok: false, message: 'You can send up to 1,000,000.00 ₪ at a time.' };
  }
  const agorot = Number(digits);
  if (agorot < 1) return { ok: false, message: 'Enter an amount above zero.' };
  return { ok: true, agorot };
}
