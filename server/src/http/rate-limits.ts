// Per-client-address limits on the operations that test credentials or send email
// (SEC-2, docs/decisions/0011).
import type { Request, RequestHandler, Response } from 'express';
import {
  type AugmentedRequest,
  type ClientRateLimitInfo,
  ipKeyGenerator,
  type Options,
  rateLimit,
  type Store,
} from 'express-rate-limit';
import type { Logger } from 'pino';
import type { Clock } from '../clock';
import { problem, sendProblem } from './problem';

/** Failed credential checks (login, verifyOtp, resetPassword) allowed per window. */
export const CREDENTIAL_FAILURE_LIMIT = 10;
export const CREDENTIAL_WINDOW_MS = 15 * 60 * 1000;
/** Requests that send email (signUp, resendOtp, requestPasswordReset) allowed per window. */
export const EMAIL_REQUEST_LIMIT = 20;
export const EMAIL_WINDOW_MS = 60 * 60 * 1000;

/**
 * A sliding window kept in memory, read from the app's clock: per client, the times of the hits
 * that count. A hit counts for exactly `windowMs` (still counted at the very instant the window
 * is over), so "N within 15 minutes" holds for any 15 minutes, not just from a client's first
 * request. The library's own memory store resets a client's whole count at once instead.
 */
export class SlidingWindowStore implements Store {
  readonly localKeys = true;
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly clock: Clock,
    private readonly windowMs: number,
  ) {}

  /** Drops the hits that have left the window; forgets a client with none left. */
  private live(key: string, now: number): number[] {
    const times = (this.hits.get(key) ?? []).filter((time) => now - time <= this.windowMs);
    if (times.length > 0) this.hits.set(key, times);
    else this.hits.delete(key);
    return times;
  }

  private info(times: number[]): ClientRateLimitInfo {
    const oldest = times[0];
    return {
      totalHits: times.length,
      resetTime: oldest === undefined ? undefined : new Date(oldest + this.windowMs),
    };
  }

  increment(key: string): ClientRateLimitInfo {
    const now = this.clock.now().getTime();
    const times = this.live(key, now);
    times.push(now);
    this.hits.set(key, times);
    // No resetTime here on purpose: with it, the library's give-back compares it with the real
    // `Date.now()` and skips giving back when the app's clock is behind the real one (tests).
    // The 429 handler reads the reset time from `get` instead.
    return { totalHits: times.length, resetTime: undefined };
  }

  /** Gives back the newest hit (the request that is being given back made it). */
  decrement(key: string): void {
    const times = this.hits.get(key);
    if (!times) return;
    times.pop();
    if (times.length === 0) this.hits.delete(key);
  }

  get(key: string): ClientRateLimitInfo | undefined {
    const times = this.live(key, this.clock.now().getTime());
    return times.length > 0 ? this.info(times) : undefined;
  }

  resetKey(key: string): void {
    this.hits.delete(key);
  }

  resetAll(): void {
    this.hits.clear();
  }
}

export type RateLimiters = {
  /** Counts only the answers that failed a credential check (401); everything else is given back. */
  credentials: RequestHandler;
  /**
   * Counts every request that reaches it, a client that hangs up before the answer included
   * (SEC-6), except the 429s it answers itself.
   */
  email: RequestHandler;
};

/**
 * The 429 problem, with Retry-After as whole seconds until the oldest counted hit leaves the
 * window (at least 1). With `giveBack`, the refused request's own hit is taken back first, so
 * hammering while limited can't extend the wait.
 */
function tooManyRequests(clock: Clock, store: Store, { giveBack = false } = {}) {
  return async (req: Request, res: Response, _next: unknown, options: Options): Promise<void> => {
    const key = (req as AugmentedRequest)[options.requestPropertyName]?.key;
    if (giveBack && key !== undefined) await store.decrement(key);
    const resetTime = key === undefined ? undefined : (await store.get?.(key))?.resetTime;
    const seconds = resetTime ? Math.ceil((resetTime.getTime() - clock.now().getTime()) / 1000) : 1;
    res.setHeader('Retry-After', String(Math.max(1, seconds)));
    sendProblem(res, problem(429, 'RATE_LIMITED', 'Too many requests'));
  };
}

/**
 * Two limiters, each with its own store, so build them once per app: the credential limiter is
 * shared by its three operations, the email limiter by its three. The client is `req.ip`, which
 * is the socket's address unless the app was told how many proxies to trust.
 */
export function createRateLimiters({
  clock,
  logger,
}: {
  clock: Clock;
  logger: Logger;
}): RateLimiters {
  const shared = {
    standardHeaders: false,
    legacyHeaders: false,
    keyGenerator: (req: Request) => ipKeyGenerator(req.ip ?? ''),
    logger: {
      error: (error: unknown, message?: string) => logger.error({ err: error }, message),
      warn: (error: unknown, message?: string) => logger.warn({ err: error }, message),
    },
  };
  const credentialStore = new SlidingWindowStore(clock, CREDENTIAL_WINDOW_MS);
  const emailStore = new SlidingWindowStore(clock, EMAIL_WINDOW_MS);
  return {
    credentials: rateLimit({
      ...shared,
      store: credentialStore,
      handler: tooManyRequests(clock, credentialStore),
      windowMs: CREDENTIAL_WINDOW_MS,
      limit: CREDENTIAL_FAILURE_LIMIT,
      skipSuccessfulRequests: true,
      requestWasSuccessful: (_req, res) => res.statusCode !== 401,
    }),
    email: rateLimit({
      ...shared,
      store: emailStore,
      // Only the limiter's own 429 is given back, by its handler. The library's
      // `skipFailedRequests` would also give back a request whose client hung up before the
      // answer, while its handler goes on to send the passcode (SEC-6).
      handler: tooManyRequests(clock, emailStore, { giveBack: true }),
      windowMs: EMAIL_WINDOW_MS,
      limit: EMAIL_REQUEST_LIMIT,
    }),
  };
}
