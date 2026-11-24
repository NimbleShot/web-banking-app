import { describe, expect, it, jest } from '@jest/globals';
import { transferRequest } from '../src/api/transfer';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('the transfer request the page sends', () => {
  it('[TX-9] carries the checked recipient and amount, under a one-time key that is a UUID', () => {
    const request = transferRequest('omer@example.com', 1250);

    expect(request.body).toEqual({ toEmail: 'omer@example.com', amount: 1250 });
    expect(request.params.header['Idempotency-Key']).toMatch(UUID_V4);
  });

  it('[TX-9] after a lost answer, the same recipient (any letter case) and amount reuse its key; another recipient or amount gets a new one', () => {
    const lost = transferRequest('omer@example.com', 1250);
    const unsure = { ...lost.body, key: lost.params.header['Idempotency-Key'] };
    const keyOf = (toEmail: string, amount: number) =>
      transferRequest(toEmail, amount, unsure).params.header['Idempotency-Key'];

    expect(keyOf('omer@example.com', 1250)).toBe(unsure.key);
    expect(keyOf('Omer@Example.com', 1250)).toBe(unsure.key);
    expect(keyOf('omer@example.com', 1251)).not.toBe(unsure.key);
    expect(keyOf('noa@example.com', 1250)).not.toBe(unsure.key);
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
