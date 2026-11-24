// How money and dates read on screen. Money stays integer agorot: these functions work on its
// digits and never divide it into a float.

const MINUS_SIGN = '−';

function amountText(agorot: number): string {
  const digits = String(Math.abs(agorot)).padStart(3, '0');
  const whole = digits.slice(0, -2).replace(/\B(?=(\d{3})+$)/g, ',');
  return `${whole}.${digits.slice(-2)}`;
}

/** `5,234.00`: the currency sign is drawn apart from the number. */
export function formatBalance(agorot: number): string {
  return amountText(agorot);
}

/** `−180.50 ₪` or `+1,250.00 ₪`, signed from the reader's side. */
export function formatTransfer(agorot: number): string {
  return `${agorot < 0 ? MINUS_SIGN : '+'}${amountText(agorot)} ₪`;
}

/** The part of a transfer still counting. It keeps the transfer's sign when it reaches zero. */
export function formatRemaining(change: number, remaining: number): string {
  return `${change < 0 ? MINUS_SIGN : '+'}${amountText(remaining)} ₪`;
}

const TIME = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
const DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });
const DAY_AND_YEAR = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** `Today, 09:42`, `Yesterday, 18:05` or `21 Nov, 12:30`, in the browser's time zone. */
export function formatWhen(iso: string, now: Date): string {
  const date = new Date(iso);
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  let day: string;
  if (isSameDay(date, now)) day = 'Today';
  else if (isSameDay(date, yesterday)) day = 'Yesterday';
  else if (date.getFullYear() === now.getFullYear()) day = DAY.format(date);
  else day = DAY_AND_YEAR.format(date);
  return `${day}, ${TIME.format(date)}`;
}
