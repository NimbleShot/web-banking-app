import { describe, expect, it } from '@jest/globals';
import { failureMessage, type Failure } from '../src/api/client';

const limited = (retryAfter: number | null): Failure => ({
  kind: 'problem',
  status: 429,
  code: 'RATE_LIMITED',
  fields: {},
  retryAfter,
});

describe('the wait a rate limit shows', () => {
  it('[UX-7] rounds up to whole minutes, and stays honest when the server gave no time', () => {
    expect(failureMessage(limited(1))).toBe('Too many tries. Wait 1 minute and try again.');
    expect(failureMessage(limited(60))).toBe('Too many tries. Wait 1 minute and try again.');
    expect(failureMessage(limited(61))).toBe('Too many tries. Wait 2 minutes and try again.');
    expect(failureMessage(limited(900))).toBe('Too many tries. Wait 15 minutes and try again.');
    expect(failureMessage(limited(null))).toBe('Too many tries. Wait a few minutes and try again.');
  });
});
