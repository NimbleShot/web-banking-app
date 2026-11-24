// createTransfer's request (TX-9, docs/decisions/0016). Each transfer the user sends gets a new
// one-time key, so a copy of the request that the browser itself sends again moves no money.

/** The recipient and amount (integer agorot) as the form checked them, under a new key. */
export function transferRequest(toEmail: string, amount: number) {
  return {
    params: { header: { 'Idempotency-Key': crypto.randomUUID() } },
    body: { toEmail, amount },
  };
}
