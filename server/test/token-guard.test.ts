import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from '@jest/globals';
import { Router } from 'express';
import request from 'supertest';
import { createApp } from '../src/app';
import { CONTRACT_PATH } from '../src/http/contract';
import { problem, sendProblem } from '../src/http/problem';
import { createLogger } from '../src/logger';
import { buildTestHarness, TEST_SECRETS } from './support/app';
import {
  answerOf,
  claimsFor,
  getMe,
  handMadeToken,
  hmacSigner,
  login,
  ME,
  registerUser,
  storedUserWithToken,
  tokenFor,
  TRANSACTIONS,
  TRANSFERS,
  UNAUTHORIZED,
} from './support/auth';
import { type Harness, MINUTE, SECOND, validSignUp } from './support/sign-up';

const PROBLEM_JSON = /^application\/problem\+json/;
const HOUR_IN_SECONDS = 3600;
const HS256 = { alg: 'HS256', typ: 'JWT' };
const transfer = { toEmail: 'omer@example.com', amount: 1250 };
/** What a failing user store knows and the caller must never see. */
const STORE_FAILURE = 'connection to mongodb://admin:hunter2@db.internal refused';

/** The three operations the contract secures, sent with `headers`. */
const securedOperations: [string, (h: Harness, headers: Record<string, string>) => request.Test][] =
  [
    ['getMe', (h, headers) => request(h.app).get(ME).set(headers)],
    ['listTransactions', (h, headers) => request(h.app).get(TRANSACTIONS).set(headers)],
    ['createTransfer', (h, headers) => request(h.app).post(TRANSFERS).set(headers).send(transfer)],
  ];

/** The same token with its payload swapped for `payload`, keeping the original signature. */
function withPayload(token: string, payload: object): string {
  const [header, , signature] = token.split('.');
  return `${header}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${signature}`;
}

/** An RS256 signature made with a fresh RSA key pair. */
function rs256Signer(): (input: string) => string {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return (input) => crypto.sign('sha256', Buffer.from(input), privateKey).toString('base64url');
}

/**
 * Stand-ins for the three secured operations' handlers that count how often they run. Each
 * answers like a missing token, so only the count tells a handler that ran from one that didn't.
 */
function spyRoutes() {
  const calls = { count: 0 };
  const spy = (_req: unknown, res: Parameters<typeof sendProblem>[0]) => {
    calls.count += 1;
    sendProblem(res, problem(401, 'UNAUTHORIZED', 'Sign in required'));
  };
  const routes = Router().get(ME, spy).get(TRANSACTIONS, spy).post(TRANSFERS, spy);
  return { routes, calls };
}

/** An HS256 token with these claims, signed with the token secret: only its claims are wrong. */
const signedClaims = (claims: object) =>
  `Bearer ${handMadeToken(HS256, claims, hmacSigner('sha256', TEST_SECRETS.JWT_SECRET))}`;

type AuthorizationFor = (h: Harness, userId: string) => Promise<string>;

/**
 * Authorization header values that must all be refused, each built for a user that exists in
 * the store, so the token, not the user, is what fails.
 */
const refusedAuthorizations: [string, AuthorizationFor][] = [
  ['Bearer with no token', async () => 'Bearer'],
  ['a malformed token', async () => 'Bearer not-a-jwt'],
  ['three segments that are not a JWT', async () => 'Bearer a.b.c'],
  [
    'a token signed with another secret',
    async (h, id) =>
      `Bearer ${handMadeToken(HS256, claimsFor(h, id), hmacSigner('sha256', TEST_SECRETS.PASSCODE_SECRET))}`,
  ],
  [
    'a token that declares alg none and has no signature',
    async (h, id) =>
      `Bearer ${handMadeToken({ alg: 'none', typ: 'JWT' }, claimsFor(h, id), () => '')}`,
  ],
  [
    'an HS384 token signed with the token secret',
    async (h, id) =>
      `Bearer ${handMadeToken({ alg: 'HS384', typ: 'JWT' }, claimsFor(h, id), hmacSigner('sha384', TEST_SECRETS.JWT_SECRET))}`,
  ],
  [
    'an RS256 token',
    async (h, id) =>
      `Bearer ${handMadeToken({ alg: 'RS256', typ: 'JWT' }, claimsFor(h, id), rs256Signer())}`,
  ],
  [
    'a token whose payload was changed after signing to name another user',
    async (h, id) => {
      const other = await h.users.insert({
        email: 'omer@example.com',
        phone: validSignUp.phone,
        passwordHash: 'placeholder-not-a-hash',
        balance: 100_000,
        createdAt: h.clock.now(),
      });
      return `Bearer ${withPayload(await tokenFor(h, id), claimsFor(h, other.id))}`;
    },
  ],
  [
    'a token signed with the token secret but with no expiry',
    async (h, id) => {
      const { sub, iat } = claimsFor(h, id);
      return `Bearer ${handMadeToken(HS256, { sub, iat }, hmacSigner('sha256', TEST_SECRETS.JWT_SECRET))}`;
    },
  ],
  [
    'a token signed with the token secret but naming no user',
    async (h, id) => {
      const { iat, exp } = claimsFor(h, id);
      return `Bearer ${handMadeToken(HS256, { iat, exp }, hmacSigner('sha256', TEST_SECRETS.JWT_SECRET))}`;
    },
  ],
  [
    'a token at exactly its expiry instant',
    async (h, id) => {
      const token = await tokenFor(h, id);
      h.clock.advance(HOUR_IN_SECONDS * SECOND);
      return `Bearer ${token}`;
    },
  ],
  ...(
    [
      ['a number', 123],
      ['an empty string', ''],
      ['an object', {}],
      ['an array', ['x']],
    ] as [string, unknown][]
  ).map(([what, sub]): [string, AuthorizationFor] => [
    `a token whose sub is ${what}`,
    async (h) => {
      const { iat, exp } = claimsFor(h, 'unused');
      return signedClaims({ sub, iat, exp });
    },
  ]),
  ...(
    [
      ['a string of digits', '9999999999'],
      ['null', null],
    ] as [string, unknown][]
  ).map(([what, exp]): [string, AuthorizationFor] => [
    `a token whose exp is ${what}`,
    async (h, id) => {
      const { sub, iat } = claimsFor(h, id);
      return signedClaims({ sub, iat, exp });
    },
  ]),
  [
    'a token for a user that does not exist',
    async (h) => `Bearer ${await tokenFor(h, crypto.randomUUID())}`,
  ],
  [
    'Basic credentials',
    async () =>
      `Basic ${Buffer.from(`${validSignUp.email}:${validSignUp.password}`).toString('base64')}`,
  ],
  ['a valid token under another scheme', async (h, id) => `Token ${await tokenFor(h, id)}`],
  ['a valid token with no scheme', async (h, id) => tokenFor(h, id)],
  [
    'a valid token under a scheme that only contains the word Bearer',
    async (h, id) => `XBearer ${await tokenFor(h, id)}`,
  ],
];

describe('DB-1 the account is protected: no access without a valid token', () => {
  describe('no Authorization header', () => {
    it.each(securedOperations)(
      '[DB-1.a] %s without an Authorization header answers 401 UNAUTHORIZED and changes nothing',
      async (_name, send) => {
        const h = buildTestHarness();
        await storedUserWithToken(h);
        await storedUserWithToken(h, 'omer@example.com');
        const before = h.users.snapshot();

        const res = await send(h, {});

        expect(res.status).toBe(401);
        expect(res.headers['content-type']).toMatch(PROBLEM_JSON);
        expect(res.body).toEqual(UNAUTHORIZED);
        expect(h.users.snapshot()).toEqual(before);
      },
    );

    it.each(securedOperations)(
      '[DB-1.a] control: with a valid token, %s reaches its handler once',
      async (_name, send) => {
        const { routes, calls } = spyRoutes();
        const h = buildTestHarness({ routes });
        const { token } = await storedUserWithToken(h);

        await send(h, { Authorization: `Bearer ${token}` });

        expect(calls.count).toBe(1);
      },
    );
  });

  describe('what the token check sits behind and in front of', () => {
    it.each<[string, string]>([
      ['GET', '/api/v1/accounts'],
      ['POST', '/api/v1/auth/logout'],
      ['DELETE', '/api/v1/me'],
      ['PUT', '/api/v1/transfers'],
    ])(
      '[DB-1.a] %s %s, which no operation describes, answers 404 NOT_FOUND with no token, an invalid one or a valid one',
      async (method, path) => {
        const h = buildTestHarness();
        const { token } = await storedUserWithToken(h);
        const send = (headers: Record<string, string>) => {
          const agent = request(h.app);
          const req =
            method === 'GET'
              ? agent.get(path)
              : method === 'POST'
                ? agent.post(path)
                : method === 'DELETE'
                  ? agent.delete(path)
                  : agent.put(path);
          return req.set(headers);
        };

        for (const headers of <Record<string, string>[]>[
          {},
          { Authorization: 'Bearer not-a-jwt' },
          { Authorization: `Bearer ${token}` },
        ]) {
          const res = await send(headers);
          expect(res.status).toBe(404);
          expect(res.headers['content-type']).toMatch(PROBLEM_JSON);
          expect(res.body.code).toBe('NOT_FOUND');
        }
      },
    );

    it('[DB-1.a] a request that breaks the contract and has no token answers 401, not 400: an unauthenticated body is never parsed', async () => {
      const h = buildTestHarness();
      await storedUserWithToken(h);

      const unknownParameter = await request(h.app).get(`${ME}?_=1`);
      const malformedJson = await request(h.app)
        .post(TRANSFERS)
        .set('Content-Type', 'application/json')
        .send('{"toEmail": ');
      const extraField = await request(h.app)
        .post(TRANSFERS)
        .send({ ...transfer, userId: 'someone-else' });

      for (const res of [unknownParameter, malformedJson, extraField]) {
        expect(res.status).toBe(401);
        expect(res.body).toEqual(UNAUTHORIZED);
      }
    });

    it('[DB-1.a] with a valid token, the same request that breaks the contract answers 400: validation runs after the token check', async () => {
      const h = buildTestHarness();
      const { token } = await storedUserWithToken(h);

      const res = await request(h.app).get(`${ME}?_=1`).set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    });

    it('[DB-1.a] operations the contract leaves open take no token and ignore an invalid one', async () => {
      const h = buildTestHarness();
      await registerUser(h);

      const noHeader = await login(h, validSignUp.email, validSignUp.password);
      const invalidHeader = await login(h, validSignUp.email, validSignUp.password).set(
        'Authorization',
        'Bearer not-a-jwt',
      );
      const signUpWithInvalidHeader = await request(h.app)
        .post('/api/v1/auth/signup')
        .set('Authorization', 'Bearer not-a-jwt')
        .send({ ...validSignUp, email: 'omer@example.com' });

      expect(noHeader.status).toBe(200);
      expect(invalidHeader.status).toBe(200);
      expect(signUpWithInvalidHeader.status).toBe(202);
    });
  });

  describe('tokens that are refused', () => {
    it('[DB-1.b] a valid token after two spaces is accepted (one or more spaces follow Bearer)', async () => {
      const h = buildTestHarness();
      const { token, user } = await storedUserWithToken(h);

      const res = await getMe(h, `Bearer  ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(user.id);
    });

    it('[DB-1.b] control: a hand-made HS256 token signed with the token secret is accepted', async () => {
      const h = buildTestHarness();
      const { user } = await storedUserWithToken(h);
      const token = handMadeToken(
        HS256,
        claimsFor(h, user.id),
        hmacSigner('sha256', TEST_SECRETS.JWT_SECRET),
      );

      const res = await getMe(h, `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(user.id);
    });

    it.each(
      refusedAuthorizations.flatMap(([what, authorizationFor]) =>
        securedOperations.map(([name, send]) => [name, what, authorizationFor, send] as const),
      ),
    )(
      '[DB-1.b] %s with %s answers 401 UNAUTHORIZED like a missing token, and no handler runs',
      async (_name, _what, authorizationFor, send) => {
        const { routes, calls } = spyRoutes();
        const h = buildTestHarness({ routes });
        const { user } = await storedUserWithToken(h);
        const authorization = await authorizationFor(h, user.id);
        const missing = await send(h, {});

        const res = await send(h, { Authorization: authorization });

        expect(res.status).toBe(401);
        expect(res.body).toEqual(UNAUTHORIZED);
        expect(answerOf(res)).toEqual(answerOf(missing));
        expect(calls.count).toBe(0);
      },
    );

    it('[DB-1.b] a token one second before its expiry still works', async () => {
      const h = buildTestHarness();
      const { token } = await storedUserWithToken(h);

      h.clock.advance((HOUR_IN_SECONDS - 1) * SECOND);
      const res = await getMe(h, `Bearer ${token}`);

      expect(res.status).toBe(200);
    });

    it('[DB-1.b] a token at exactly its expiry instant (one hour after issue, by the injected clock) answers 401 like a missing token', async () => {
      const h = buildTestHarness();
      const { token } = await storedUserWithToken(h);
      const missing = await getMe(h);

      h.clock.advance(HOUR_IN_SECONDS * SECOND);
      const res = await getMe(h, `Bearer ${token}`);

      expect(res.status).toBe(401);
      expect(answerOf(res)).toEqual(answerOf(missing));
    });

    it('[DB-1.b] a token one second past its expiry answers 401 like a missing token', async () => {
      const h = buildTestHarness();
      const { token } = await storedUserWithToken(h);
      const missing = await getMe(h);

      h.clock.advance((HOUR_IN_SECONDS + 1) * SECOND);
      const res = await getMe(h, `Bearer ${token}`);

      expect(res.status).toBe(401);
      expect(answerOf(res)).toEqual(answerOf(missing));
    });
  });

  describe('the acting user comes from the token', () => {
    it("[DB-1.c] with two users, each one's token gets that user's own account", async () => {
      const h = buildTestHarness();
      const dana = await storedUserWithToken(h, 'dana@example.com');
      const omer = await storedUserWithToken(h, 'omer@example.com');

      const danaMe = await getMe(h, `Bearer ${dana.token}`);
      const omerMe = await getMe(h, `Bearer ${omer.token}`);

      expect(danaMe.status).toBe(200);
      expect(danaMe.body).toMatchObject({ id: dana.user.id, email: 'dana@example.com' });
      expect(omerMe.status).toBe(200);
      expect(omerMe.body).toMatchObject({ id: omer.user.id, email: 'omer@example.com' });
    });
  });
});

describe('DB-1 the acting user is never taken from the request', () => {
  it("[DB-1.c] user A's token with headers naming user B still gets A's account", async () => {
    const h = buildTestHarness();
    const dana = await storedUserWithToken(h, 'dana@example.com');
    const omer = await storedUserWithToken(h, 'omer@example.com');

    const res = await getMe(h, `Bearer ${dana.token}`)
      .set('X-User-Id', omer.user.id)
      .set('X-User-Email', omer.user.email);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: dana.user.id, email: 'dana@example.com' });
  });
});

describe('DB-3 getMe shows the account', () => {
  it("[DB-3.a] getMe answers 200 with exactly the token user's id, email, phone, integer balance and createdAt", async () => {
    const h = buildTestHarness();
    const { token, user } = await registerUser(h);

    const res = await getMe(h, `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(Object.keys(res.body).sort()).toEqual(['balance', 'createdAt', 'email', 'id', 'phone']);
    expect(res.body).toEqual({
      id: user.id,
      email: 'dana@example.com',
      phone: validSignUp.phone,
      balance: user.balance,
      createdAt: user.createdAt.toISOString(),
    });
    expect(Number.isInteger(res.body.balance)).toBe(true);
    expect(res.text).not.toContain(user.passwordHash);
  });
});

describe('DB-4 signing out is the client dropping the token', () => {
  it('[DB-4.a] right after a 200 getMe with a token, the same request without it answers 401 UNAUTHORIZED', async () => {
    const h = buildTestHarness();
    const { token } = await registerUser(h);

    const withToken = await getMe(h, `Bearer ${token}`);
    const withoutToken = await getMe(h);

    expect(withToken.status).toBe(200);
    expect(withoutToken.status).toBe(401);
    expect(withoutToken.body).toEqual(UNAUTHORIZED);
  });

  it('[DB-4.a] a request without the token changes nothing for the token, and a second login leaves the first token working', async () => {
    const h = buildTestHarness();
    const { token: first } = await registerUser(h);

    await getMe(h);
    const second = await login(h, validSignUp.email, validSignUp.password);
    expect(second.status).toBe(200);
    h.clock.advance(MINUTE);

    expect((await getMe(h, `Bearer ${first}`)).status).toBe(200);
    expect((await getMe(h, `Bearer ${second.body.accessToken}`)).status).toBe(200);
  });

  it('[DB-4.a] the server keeps no record of the tokens it issued: one it never issued, signed with its secret, is accepted', async () => {
    const h = buildTestHarness();
    const { user } = await registerUser(h);
    const neverIssued = handMadeToken(
      HS256,
      claimsFor(h, user.id),
      hmacSigner('sha256', TEST_SECRETS.JWT_SECRET),
    );

    const res = await getMe(h, `Bearer ${neverIssued}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(user.id);
  });

  it('[DB-4.a] a second app on the same stores and secret accepts a token the first one issued', async () => {
    const h = buildTestHarness();
    const { token, user } = await registerUser(h);
    const secondApp = createApp(h.deps);

    const res = await request(secondApp).get(ME).set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(user.id);
  });

  it('[DB-4.a] the contract has no logout or sign-out operation', () => {
    const contract = readFileSync(CONTRACT_PATH, 'utf8');
    const paths = [...contract.matchAll(/^ {2}(\/\S*):\s*$/gm)].map((match) => match[1]);
    const operationIds = [...contract.matchAll(/^\s+operationId:\s*(\S+)\s*$/gm)].map(
      (match) => match[1],
    );

    expect(paths).toContain('/api/v1/me');
    expect(operationIds).toContain('getMe');
    for (const name of [...paths, ...operationIds]) {
      expect(name).not.toMatch(/log-?out|sign-?out/i);
    }
  });
});

describe('OTP-2 the token verifyOtp issues opens the new account', () => {
  it('[OTP-2.b] getMe with verifyOtp’s token returns the new account', async () => {
    const h = buildTestHarness();
    h.clock.advance(3 * MINUTE);
    const createdAt = h.clock.now().toISOString();

    const { token, user } = await registerUser(h, 'Dana@Example.com');
    const res = await getMe(h, `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: user.id,
      email: 'dana@example.com',
      phone: validSignUp.phone,
      balance: user.balance,
      createdAt,
    });
  });
});

describe('SEC-5 the token stays out of the logs and a failing check does not pass for a 401', () => {
  it("[SEC-5.a] request logs show a real token's Authorization header as [Redacted], and no line of the flow contains a token, valid or not", async () => {
    const lines: string[] = [];
    const logger = createLogger('info', { write: (line: string) => void lines.push(line) });
    const h = buildTestHarness({ logger });
    const { token: verifyToken, user } = await registerUser(h);
    const loginRes = await login(h, validSignUp.email, validSignUp.password);
    const loginToken = loginRes.body.accessToken as string;
    const invalidToken = 'not-a-jwt-but-a-secret-looking-string-7f3a9c';
    const wrongSecretToken = handMadeToken(
      HS256,
      claimsFor(h, user.id),
      hmacSigner('sha256', TEST_SECRETS.PASSCODE_SECRET),
    );

    expect((await getMe(h, `Bearer ${loginToken}`)).status).toBe(200);
    expect((await getMe(h, `Bearer ${invalidToken}`)).status).toBe(401);
    expect((await getMe(h, `Bearer ${wrongSecretToken}`)).status).toBe(401);

    const requestLines = lines
      .map(
        (line) => JSON.parse(line) as { req?: { url?: string; headers?: Record<string, unknown> } },
      )
      .filter((line) => line.req?.url === ME);
    expect(requestLines.length).toBeGreaterThanOrEqual(3);
    for (const line of requestLines) expect(line.req?.headers?.authorization).toBe('[Redacted]');
    for (const line of lines) {
      for (const token of [verifyToken, loginToken, invalidToken, wrongSecretToken]) {
        expect(line).not.toContain(token);
      }
    }
  });

  it('[SEC-5.c] a user store that fails during the token check answers 500 INTERNAL_ERROR, not 401, with no detail; the server log keeps the cause and not the token', async () => {
    const lines: string[] = [];
    const logger = createLogger('info', { write: (line: string) => void lines.push(line) });
    const h = buildTestHarness({ logger });
    const { token } = await storedUserWithToken(h);
    // The guard looks the token's user up in the store on every request, so replacing the
    // store's look-up after the app is built still reaches it.
    h.users.findById = async () => {
      throw new Error(STORE_FAILURE);
    };

    const res = await getMe(h, `Bearer ${token}`);

    expect(res.status).toBe(500);
    expect(res.headers['content-type']).toMatch(PROBLEM_JSON);
    expect(res.body).toEqual({
      type: 'about:blank',
      title: 'Internal server error',
      status: 500,
      code: 'INTERNAL_ERROR',
    });
    expect(res.text).not.toContain(STORE_FAILURE);
    const errorLines = lines.filter((line) => Number(JSON.parse(line).level) >= 50);
    const withCause = errorLines.filter((line) => line.includes(STORE_FAILURE));
    expect(withCause).toHaveLength(1);
    expect(withCause[0]).toMatch(/"stack":/);
    for (const line of lines) expect(line).not.toContain(token);
  });
});
