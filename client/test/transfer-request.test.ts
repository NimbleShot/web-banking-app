import { describe, expect, it } from '@jest/globals';
import { transferRequest } from '../src/api/transfer';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('the transfer request the page sends', () => {
  it('[TX-9] carries the checked recipient and amount, under a one-time key that is a UUID', () => {
    const request = transferRequest('omer@example.com', 1250);

    expect(request.body).toEqual({ toEmail: 'omer@example.com', amount: 1250 });
    expect(request.params.header['Idempotency-Key']).toMatch(UUID);
  });

  it('[TX-9] each transfer gets a new key, even with the same recipient and amount', () => {
    const keys = Array.from(
      { length: 20 },
      () => transferRequest('omer@example.com', 1250).params.header['Idempotency-Key'],
    );

    expect(new Set(keys).size).toBe(20);
  });
});
