import { describe, expect, it, jest } from '@jest/globals';
import { transferRequest } from '../src/api/transfer';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('the transfer request the page sends', () => {
  it('[TX-9] carries the checked recipient and amount, under a one-time key that is a UUID', () => {
    const request = transferRequest('omer@example.com', 1250);

    expect(request.body).toEqual({ toEmail: 'omer@example.com', amount: 1250 });
    expect(request.params.header['Idempotency-Key']).toMatch(UUID_V4);
  });

  it('[TX-9] each transfer gets a new key, even with the same recipient and amount, without crypto.randomUUID (missing on plain HTTP)', () => {
    const randomUUID = jest.spyOn(crypto, 'randomUUID').mockImplementation(() => {
      throw new TypeError('crypto.randomUUID is not available outside a secure context');
    });
    try {
      const keys = Array.from(
        { length: 20 },
        () => transferRequest('omer@example.com', 1250).params.header['Idempotency-Key'],
      );

      expect(new Set(keys).size).toBe(20);
      for (const key of keys) expect(key).toMatch(UUID_V4);
    } finally {
      randomUUID.mockRestore();
    }
  });
});
