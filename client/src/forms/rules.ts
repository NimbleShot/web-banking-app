// The form rules. They mirror the contract so mistakes show at once; the server has the final say.

export type Check = { ok: true; value: string } | { ok: false; message: string };

const EMAIL_MAX_LENGTH = 254;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Also shown for an email the server refuses, so its validator's wording never reaches the user. */
export const EMAIL_MESSAGE = 'Enter a valid email address.';

export function checkEmail(text: string): Check {
  if (text.length > EMAIL_MAX_LENGTH || !EMAIL_SHAPE.test(text)) {
    return { ok: false, message: EMAIL_MESSAGE };
  }
  return { ok: true, value: text };
}

/** Israeli mobile numbers only: 5 and eight more digits after the country code or leading 0. */
export function checkPhone(text: string): Check {
  const national = text.replace(/[\s()-]/g, '').replace(/^(?:\+972|00972|972)?0?/, '');
  if (!/^5\d{8}$/.test(national)) {
    return { ok: false, message: 'Enter the full number, like 50 123 4567.' };
  }
  return { ok: true, value: `+972${national}` };
}

const PASSWORD_MIN = 8;
const PASSWORD_MAX = 72;

export function checkPassword(text: string): Check {
  const characters = [...text].length;
  if (characters < PASSWORD_MIN) return { ok: false, message: 'Use at least 8 characters.' };
  if (characters > PASSWORD_MAX) return { ok: false, message: 'Use at most 72 characters.' };
  if (new TextEncoder().encode(text).length > PASSWORD_MAX) {
    return { ok: false, message: 'That password is too long. Use fewer special characters.' };
  }
  return { ok: true, value: text };
}
