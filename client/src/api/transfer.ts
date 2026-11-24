// createTransfer's request (TX-9, docs/decisions/0016). Each transfer the user sends gets a new
// one-time key, so a copy of the request that the browser itself sends again moves no money.

/**
 * A random version 4 UUID (RFC 9562). Built from `getRandomValues` because browsers offer
 * `crypto.randomUUID` only on HTTPS and localhost, and the page is also opened over plain HTTP
 * on a local network.
 */
export function newTransferKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40; // version 4
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // the RFC's variant
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A transfer whose answer was lost: it may have gone through, so its key is kept. */
export type UnsureTransfer = { toEmail: string; amount: number; key: string };

/**
 * The recipient and amount (integer agorot) as the form checked them. Sending again the transfer
 * whose answer was lost (the same recipient in any letter case, the same amount) reuses its key,
 * so the server answers with it if it went through and it can never move money twice. Any other
 * transfer gets a new key.
 */
export function transferRequest(toEmail: string, amount: number, unsure?: UnsureTransfer) {
  const again =
    unsure !== undefined &&
    unsure.toEmail.toLowerCase() === toEmail.toLowerCase() &&
    unsure.amount === amount;
  return {
    params: { header: { 'Idempotency-Key': again ? unsure.key : newTransferKey() } },
    body: { toEmail, amount },
  };
}
