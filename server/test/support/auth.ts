// Shared by the login and token-guard tests.
import crypto from 'node:crypto';
import { expect } from '@jest/globals';
import request from 'supertest';
import type { User } from '../../src/repositories/users';
import { buildTestHarness, type TestAppOptions } from './app';
import { aUser, type Harness, signUpForPasscode, validSignUp, verify } from './sign-up';

export const LOGIN = '/api/v1/auth/login';
export const ME = '/api/v1/me';
export const TRANSACTIONS = '/api/v1/transactions';
export const TRANSFERS = '/api/v1/transfers';

/** The contract's Unauthorized answer (components.responses.Unauthorized). */
export const UNAUTHORIZED = {
  type: 'about:blank',
  title: 'Sign in required',
  status: 401,
  code: 'UNAUTHORIZED',
};

/** login's 401 (its INVALID_CREDENTIALS example). */
export const INVALID_CREDENTIALS = {
  type: 'about:blank',
  title: 'Wrong email or password',
  status: 401,
  code: 'INVALID_CREDENTIALS',
};

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/** createTransfer's required one-time key (TX-9), a new one unless `key` is given. */
export const transferKey = (key: string = crypto.randomUUID()) => ({ 'Idempotency-Key': key });

export const login = (h: Harness, email: string, password: string) =>
  request(h.app).post(LOGIN).send({ email, password });

/** getMe with the given Authorization header value, or with none. */
export const getMe = (h: Harness, authorization?: string) => {
  const req = request(h.app).get(ME);
  return authorization === undefined ? req : req.set('Authorization', authorization);
};

/** Everything a client can tell two answers apart by, except the Date header. */
export const answerOf = (res: request.Response) => {
  const headers: Record<string, unknown> = { ...res.headers };
  delete headers.date;
  return { status: res.status, headers, body: res.body as unknown };
};

/**
 * A verified user made the way a person makes one: sign-up, then verifyOtp with the passcode
 * that was emailed. Returns verifyOtp's token and the stored user.
 */
export async function registerUser(
  h: Harness,
  email = validSignUp.email,
  password = validSignUp.password,
): Promise<{ token: string; user: User }> {
  const passcode = await signUpForPasscode(h, email);
  const res = await verify(h, passcode, { email, password });
  expect(res.status).toBe(200);
  const user = await h.users.findByEmail(email);
  if (!user) throw new Error(`no user was stored for ${email}`);
  return { token: (res.body as { accessToken: string }).accessToken, user };
}

/**
 * An HS256 token for `userId`, signed by hand with the app's token secret and clock, the way the
 * server's tokens are shaped. Built without the app's token service, so a guard test does not
 * lean on the code that issues tokens.
 */
export const tokenFor = async (h: Harness, userId: string) =>
  handMadeToken(
    { alg: 'HS256', typ: 'JWT' },
    claimsFor(h, userId),
    hmacSigner('sha256', h.deps.config.jwtSecret),
  );

/**
 * A user put straight into the store (its password hash is a placeholder, so it cannot log in)
 * and a token for it: for tests about the token, not the password.
 */
export async function storedUserWithToken(
  h: Harness,
  email = validSignUp.email,
): Promise<{ token: string; user: User }> {
  const user = await h.users.insert(aUser(email));
  return { token: await tokenFor(h, user.id), user };
}

const segment = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

/**
 * A JWT built by hand, `header.payload.signature` in base64url, so a test can write headers a
 * signing library would refuse to produce (`alg: none`, another algorithm).
 */
export function handMadeToken(
  header: object,
  payload: object,
  sign: (signingInput: string) => string,
): string {
  const signingInput = `${segment(header)}.${segment(payload)}`;
  return `${signingInput}.${sign(signingInput)}`;
}

/** An HMAC signature over the signing input, as HS256 (sha256) or HS384 (sha384) make it. */
export const hmacSigner = (hash: 'sha256' | 'sha384', secret: string) => (input: string) =>
  crypto.createHmac(hash, secret).update(input).digest('base64url');

/** `sub` = the user, issued now by the harness clock, expiring an hour later. */
export const claimsFor = (h: Harness, userId: string) => {
  const iat = Math.floor(h.clock.now().getTime() / 1000);
  return { sub: userId, iat, exp: iat + 3600 };
};

/**
 * A test app with one stored user and a valid token for it: for tests that need to get past the
 * token check to reach validation or a handler of a secured operation.
 */
export async function signedInApp(options: TestAppOptions = {}) {
  const h = buildTestHarness(options);
  const { token } = await storedUserWithToken(h);
  return { app: h.app, auth: bearer(token) };
}
