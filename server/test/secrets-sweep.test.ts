// SEC-5.a and SEC-5.b: the whole flow runs once in one app with every log line captured, and the
// lines and the responses are searched for every secret the flow used.
import { readdirSync, readFileSync } from 'node:fs';
import { STATUS_CODES } from 'node:http';
import { resolve } from 'node:path';
import { format, inspect } from 'node:util';
import { beforeAll, describe, expect, it, jest } from '@jest/globals';
import { Router } from 'express';
import request from 'supertest';
import { CONTRACT_PATH } from '../src/http/contract';
import { TEST_OUTBOX_PATH } from '../src/http/test-outbox';
import { createLogger } from '../src/logger';
import { buildTestHarness, takeResponseViolations, TEST_SECRETS } from './support/app';
import { bearer, getMe, LOGIN, login, ME, TRANSACTIONS, TRANSFERS } from './support/auth';
import { FORGOT, hmacOf, requestReset, RESET, resetPassword } from './support/password-reset';
import {
  findSecrets,
  jwtsIn,
  MIN_SECRET_LENGTH,
  type Secret,
  sweep,
  variantsOf,
} from './support/secret-sweep';
import {
  AFTER_COOLDOWN,
  fieldsOf,
  latestPasscode,
  RESEND,
  resend,
  SIGN_UP,
  signUp,
  VERIFY,
  validSignUp,
  verify,
  wrongPasscode,
} from './support/sign-up';
import { INTERNAL_ERROR, list, send } from './support/transfers';

// --- What the flow uses -------------------------------------------------------------------------

const DANA = 'dana@example.com';
const ELI = 'eli@example.com';

// Passwords with characters that get escaped or encoded on the way out (quote, backslash, a
// non-ASCII letter, space, plus, ampersand, percent), so the encoded forms are really searched.
const PASSWORDS = {
  dana: 'Alpha "quoted" back\\slash é 1 >>>???',
  eli: 'bravo-sweep-passw0rd',
  danaNew: 'Reset p@ss+word & 100% sure',
  wrongLogin: 'definitely-the-wrong-one-X7',
  badBody: 'bad-body-password-Q9',
  // Inputs the contract rejects with a 400: over 72 bytes (verifyOtp, resetPassword) and in a
  // body that is not JSON (login).
  tooLongVerify: `long-verify-password-${'abcdefghij'.repeat(6)}`,
  tooLongReset: `long-reset-password-${'klmnopqrst'.repeat(6)}`,
  malformedJson: 'malformed-json-password-K4',
};
/** A passcode the contract rejects (not six digits). */
const BAD_PASSCODE = '12345x';
/** A transfer amount at which the transaction store is made to fail (an unexpected error). */
const FAILING_AMOUNT = 777;

/** The operations of the flow: the contract's method and path for each operationId. */
const OPERATIONS = {
  signUp: ['POST', SIGN_UP],
  resendOtp: ['POST', RESEND],
  verifyOtp: ['POST', VERIFY],
  login: ['POST', LOGIN],
  requestPasswordReset: ['POST', FORGOT],
  resetPassword: ['POST', RESET],
  getMe: ['GET', ME],
  listTransactions: ['GET', TRANSACTIONS],
  createTransfer: ['POST', TRANSFERS],
} as const;

/**
 * The test-only route that answers the latest passcode sent to an email (ADR-0012). It is not in
 * the contract, so the contract check ignores it; the flow calls it all the same: its request
 * line is logged like any other and its answer holds a passcode by design.
 */
const TEST_OUTBOX = ['GET', TEST_OUTBOX_PATH] as const;
const ROUTES = { ...OPERATIONS, testOutbox: TEST_OUTBOX };
type RouteName = keyof typeof ROUTES;

type Step = {
  name: string;
  operationId: RouteName;
  method: string;
  path: string;
  authorization: boolean;
  status: number;
  /** The one passcode this answer gives by design (the test outbox's); no other secret is allowed. */
  passcodeAnswered?: string;
  /** Status line, headers and body as the client received them. */
  text: string;
  body: unknown;
  headers: Record<string, unknown>;
};

type FlowRun = {
  /** Every line the logger wrote, at trace level, in order. */
  lines: string[];
  steps: Step[];
  /** Every secret except the access tokens. */
  secrets: Secret[];
  /** The access tokens issued, each whole, and the parts of it (payload and signature). */
  tokens: Secret[];
  /** Which steps answered an AccessToken, and the token each one issued. */
  issued: { step: string; token: string }[];
  /** The token a request carried that the server refused. */
  refusedToken: Secret;
  /** What the flow wrote through console.log, info, warn, error and debug. */
  console: string[];
};

/** The response as a client received it: status, headers and body in one text to search. */
function responseText(res: request.Response): string {
  const headers = Object.entries(res.headers).map(([name, value]) => `${name}: ${String(value)}`);
  const body = res.text ?? '';
  return [`HTTP ${res.status} ${STATUS_CODES[res.status] ?? ''}`, ...headers, '', body].join('\n');
}

const parts = (secret: string) => secret.split('.');

/** The expectation fails by name at the step that went wrong, not later with a confusing error. */
function expectStatus(name: string, expected: number, res: request.Response): void {
  if (res.status === expected) return;
  const code = (res.body as { code?: string }).code ?? '-';
  throw new Error(
    `[SEC-5] the flow stopped at "${name}": it answered ${res.status} ${code}, expected ${expected}`,
  );
}

/** A 400 names the fields it refused: the flow must have refused the ones it meant to. */
function expectFields(name: string, expected: string[], res: request.Response): void {
  const fields = fieldsOf(res.body as { errors?: { field: string }[] });
  if (JSON.stringify(fields) === JSON.stringify([...expected].sort())) return;
  throw new Error(`[SEC-5] "${name}" refused fields [${fields}], expected [${expected}]`);
}

/** The test outbox answers the passcode it was asked for, and nothing else. */
function expectOutboxAnswer(name: string, expected: object, res: request.Response): void {
  if (JSON.stringify(res.body) === JSON.stringify(expected)) return;
  throw new Error(`[SEC-5] "${name}" did not answer exactly the passcode sent`);
}

/** Runs `run` with the console's output kept, and the console as it was afterwards. */
async function captureConsole<T>(run: () => Promise<T>): Promise<{ result: T; output: string[] }> {
  const output: string[] = [];
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
    jest.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      output.push(format(...args));
    }),
  );
  try {
    return { result: await run(), output };
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}

/** The flow runs once, for every test below (it is long): a step that fails fails them all, by name. */
async function runFlow(): Promise<FlowRun> {
  let outcome: Awaited<ReturnType<typeof captureConsole<Omit<FlowRun, 'console'>>>> | undefined;
  let failure: unknown;
  try {
    outcome = await captureConsole(flowSteps);
  } catch (error) {
    failure = error;
  }
  // Always taken, so a broken answer is never reported by some other test.
  const violations = takeResponseViolations();
  if (failure) throw failure;
  if (violations.length > 0) {
    const where = violations.map((v) => `${v.method} ${v.path} -> ${v.status}`).join(', ');
    throw new Error(`[SEC-5] the flow broke the contract at ${where}`);
  }
  return { ...outcome!.result, console: outcome!.output };
}

async function flowSteps(): Promise<Omit<FlowRun, 'console'>> {
  const lines: string[] = [];
  const logger = createLogger('trace', { write: (line: string) => void lines.push(line) });
  const h = buildTestHarness({ logger });
  const steps: Step[] = [];

  // Two unexpected failures, injected through the stores the app already holds (no server
  // change), so the two places that log an Error are reached: the token check (a user look-up
  // that throws, once, on demand) and the error handler (a transfer of FAILING_AMOUNT throws).
  let failNextLookUp = false;
  const findById = h.users.findById.bind(h.users);
  h.users.findById = async (id) => {
    if (!failNextLookUp) return findById(id);
    failNextLookUp = false;
    throw new Error('user store unavailable');
  };
  const transfer = h.transactions.transfer.bind(h.transactions);
  h.transactions.transfer = async (transferRequest) => {
    if (transferRequest.amount === FAILING_AMOUNT) throw new Error('transaction store unavailable');
    return transfer(transferRequest);
  };

  async function step(
    name: string,
    operationId: RouteName,
    expected: number,
    sendRequest: () => request.Test,
    {
      authorization = false,
      passcodeAnswered,
    }: { authorization?: boolean; passcodeAnswered?: string } = {},
  ): Promise<request.Response> {
    const res = await sendRequest();
    expectStatus(name, expected, res);
    const [method, path] = ROUTES[operationId];
    steps.push({
      name,
      operationId,
      method,
      path,
      authorization,
      status: res.status,
      passcodeAnswered,
      text: responseText(res),
      body: res.body as unknown,
      headers: { ...res.headers },
    });
    return res;
  }
  const signUpAs = (email: string, password: string) => () =>
    signUp(h, { ...validSignUp, email, password });
  const tokenOf = (res: request.Response) => (res.body as { accessToken: string }).accessToken;
  const storedHash = async (email: string) =>
    (await h.users.findByEmail(email))?.passwordHash ?? '';

  const issued: FlowRun['issued'] = [];
  const hmacs: Secret[] = [];
  const passcodes: Secret[] = [];
  const hashes: Secret[] = [];
  const keepPasscode = (label: string, code: string) =>
    passcodes.push({ label, value: code, kind: 'passcode' });
  /** The HMAC the store holds, which must be the one computed independently from the passcode. */
  const keepHmac = (label: string, stored: string | undefined, expected: string) => {
    expect(stored).toBe(expected);
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    hmacs.push({ label, value: expected, kind: 'hmac' });
  };
  /** The server computes the HMAC of a wrong passcode too: searched for, though no store keeps it. */
  const keepComputedHmac = (label: string, hmac: string) => {
    expect(hmac).toMatch(/^[0-9a-f]{64}$/);
    hmacs.push({ label, value: hmac, kind: 'hmac' });
  };
  const keepHash = (label: string, hash: string) => {
    expect(hash).toMatch(/^\$argon2id\$/);
    hashes.push({ label, value: hash });
    // The salt and the digest on their own, in case a log call writes only a part of it.
    for (const piece of hash.split('$').filter((p) => p.length >= 16)) {
      hashes.push({ label: `${label}, a part`, value: piece });
    }
  };

  // Sign-up, a refused sign-up body, a resend, a wrong passcode, verification.
  await step('signUp: Dana', 'signUp', 202, signUpAs(DANA, PASSWORDS.dana));
  const danaFirst = latestPasscode(h, DANA);
  keepPasscode("Dana's first sign-up passcode", danaFirst);
  keepHmac(
    "Dana's first sign-up HMAC",
    h.pendingSignUps.snapshot().find((p) => p.email === DANA)?.passcode.hmac,
    hmacOf('signup', DANA, danaFirst),
  );
  expectOutboxAnswer(
    'testOutbox: the sign-up passcode',
    { email: DANA, purpose: 'signup', passcode: danaFirst },
    await step(
      'testOutbox: the sign-up passcode',
      'testOutbox',
      200,
      // No helper for this test-only route.
      () => request(h.app).get(TEST_OUTBOX_PATH).query({ email: DANA }),
      { passcodeAnswered: danaFirst },
    ),
  );

  await step(
    'signUp: refused body (400)',
    'signUp',
    400,
    signUpAs('not-an-email', PASSWORDS.badBody),
  );
  // Refused inputs that ARE secrets: a password over 72 bytes and a passcode that is not 6 digits.
  expectFields(
    'verifyOtp: a password over 72 bytes and a bad passcode (400)',
    ['passcode', 'password'],
    await step(
      'verifyOtp: a password over 72 bytes and a bad passcode (400)',
      'verifyOtp',
      400,
      () => verify(h, BAD_PASSCODE, { email: DANA, password: PASSWORDS.tooLongVerify }),
    ),
  );

  h.clock.advance(AFTER_COOLDOWN);
  await step('resendOtp: Dana', 'resendOtp', 202, () => resend(h, DANA));
  const danaSecond = latestPasscode(h, DANA);
  keepPasscode("Dana's second sign-up passcode", danaSecond);
  keepHmac(
    "Dana's second sign-up HMAC",
    h.pendingSignUps.snapshot().find((p) => p.email === DANA)?.passcode.hmac,
    hmacOf('signup', DANA, danaSecond),
  );

  const wrongVerify = wrongPasscode(danaSecond);
  keepPasscode('a wrong sign-up passcode', wrongVerify);
  keepComputedHmac('the HMAC of a wrong sign-up passcode', hmacOf('signup', DANA, wrongVerify));
  await step('verifyOtp: wrong passcode (401)', 'verifyOtp', 401, () =>
    verify(h, wrongVerify, { email: DANA, password: PASSWORDS.dana }),
  );
  const danaVerified = await step('verifyOtp: Dana', 'verifyOtp', 200, () =>
    verify(h, danaSecond, { email: DANA, password: PASSWORDS.dana }),
  );
  issued.push({ step: 'verifyOtp: Dana', token: tokenOf(danaVerified) });
  keepHash("Dana's password hash from sign-up", await storedHash(DANA));

  await step('signUp: Eli', 'signUp', 202, signUpAs(ELI, PASSWORDS.eli));
  const eliCode = latestPasscode(h, ELI);
  keepPasscode("Eli's sign-up passcode", eliCode);
  keepHmac(
    "Eli's sign-up HMAC",
    h.pendingSignUps.snapshot().find((p) => p.email === ELI)?.passcode.hmac,
    hmacOf('signup', ELI, eliCode),
  );
  const eliVerified = await step('verifyOtp: Eli', 'verifyOtp', 200, () =>
    verify(h, eliCode, { email: ELI, password: PASSWORDS.eli }),
  );
  issued.push({ step: 'verifyOtp: Eli', token: tokenOf(eliVerified) });
  keepHash("Eli's password hash from sign-up", await storedHash(ELI));

  // Login, the account, a transfer, both lists, and the answers that could echo input. The clock
  // moves first: a token carries only its user and its times, so two issued in the same second
  // would be the same token.
  h.clock.advance(5_000);
  const danaLogin = await step('login: Dana', 'login', 200, () => login(h, DANA, PASSWORDS.dana));
  const danaToken = tokenOf(danaLogin);
  issued.push({ step: 'login: Dana', token: danaToken });
  const eliToken = tokenOf(eliVerified);

  await step('getMe: Dana', 'getMe', 200, () => getMe(h, `Bearer ${danaToken}`), {
    authorization: true,
  });
  await step('getMe: no token (401)', 'getMe', 401, () => getMe(h));
  const refused = `${danaToken.slice(0, -4)}AAAA`;
  await step(
    'getMe: a token with a wrong signature (401)',
    'getMe',
    401,
    () => getMe(h, `Bearer ${refused}`),
    { authorization: true },
  );
  // An unexpected failure inside the token check: the user look-up throws once.
  failNextLookUp = true;
  await step(
    'getMe: the user store fails during the token check (500)',
    'getMe',
    500,
    () => getMe(h, `Bearer ${danaToken}`),
    { authorization: true },
  );
  if (failNextLookUp) throw new Error('[SEC-5] the token check never reached the user look-up');
  await step(
    'createTransfer: Dana pays Eli',
    'createTransfer',
    201,
    () => send(h, danaToken, { toEmail: ELI, amount: 2500 }),
    { authorization: true },
  );
  await step(
    'createTransfer: more than Dana has (422)',
    'createTransfer',
    422,
    () => send(h, danaToken, { toEmail: ELI, amount: 100_000_000 }),
    { authorization: true },
  );
  // An unexpected failure inside the transfer: the error handler logs it and answers 500.
  await step(
    'createTransfer: the transaction store fails (500)',
    'createTransfer',
    500,
    () => send(h, danaToken, { toEmail: ELI, amount: FAILING_AMOUNT }),
    { authorization: true },
  );
  await step('listTransactions: Dana', 'listTransactions', 200, () => list(h, danaToken), {
    authorization: true,
  });
  await step('listTransactions: Eli', 'listTransactions', 200, () => list(h, eliToken), {
    authorization: true,
  });
  expectFields(
    'login: a body that is not JSON, holding a password (400)',
    ['body'],
    await step(
      'login: a body that is not JSON, holding a password (400)',
      'login',
      400,
      // Raw text: the helpers always send valid JSON.
      () =>
        request(h.app)
          .post(LOGIN)
          .set('Content-Type', 'application/json')
          .send(`{"email": "${DANA}", "password": "${PASSWORDS.malformedJson}"`),
    ),
  );
  await step('login: wrong password (401)', 'login', 401, () =>
    login(h, DANA, PASSWORDS.wrongLogin),
  );

  // Forgot password, a wrong passcode, the reset, and the new and the old password.
  await step('requestPasswordReset: Dana', 'requestPasswordReset', 202, () =>
    requestReset(h, DANA),
  );
  const resetCode = latestPasscode(h, DANA);
  keepPasscode("Dana's reset passcode", resetCode);
  // The same route, with the token in the request: its request line must redact it.
  expectOutboxAnswer(
    'testOutbox: the reset passcode',
    { email: DANA, purpose: 'reset', passcode: resetCode },
    await step(
      'testOutbox: the reset passcode',
      'testOutbox',
      200,
      () => request(h.app).get(TEST_OUTBOX_PATH).query({ email: DANA }).set(bearer(danaToken)),
      { authorization: true, passcodeAnswered: resetCode },
    ),
  );
  keepHmac(
    "Dana's reset HMAC",
    h.passwordResets.snapshot().find((p) => p.email === DANA)?.passcode.hmac,
    hmacOf('reset', DANA, resetCode),
  );
  // Not the wrong sign-up passcode, so the two wrong values are two different secrets.
  const wrongReset = [wrongVerify, resetCode].includes('111111') ? '222222' : '111111';
  keepPasscode('a wrong reset passcode', wrongReset);
  keepComputedHmac('the HMAC of a wrong reset passcode', hmacOf('reset', DANA, wrongReset));
  expectFields(
    'resetPassword: a password over 72 bytes (400)',
    ['password'],
    await step('resetPassword: a password over 72 bytes (400)', 'resetPassword', 400, () =>
      resetPassword(h, resetCode, { password: PASSWORDS.tooLongReset }),
    ),
  );
  await step('resetPassword: wrong passcode (401)', 'resetPassword', 401, () =>
    resetPassword(h, wrongReset, { password: PASSWORDS.danaNew }),
  );
  await step('resetPassword: Dana', 'resetPassword', 204, () =>
    resetPassword(h, resetCode, { password: PASSWORDS.danaNew }),
  );
  keepHash("Dana's password hash after the reset", await storedHash(DANA));
  h.clock.advance(5_000);
  const danaAgain = await step('login: Dana with the new password', 'login', 200, () =>
    login(h, DANA, PASSWORDS.danaNew),
  );
  issued.push({ step: 'login: Dana with the new password', token: tokenOf(danaAgain) });
  await step('login: Dana with the old password (401)', 'login', 401, () =>
    login(h, DANA, PASSWORDS.dana),
  );

  const secrets: Secret[] = [
    { label: "Dana's password", value: PASSWORDS.dana },
    { label: "Eli's password", value: PASSWORDS.eli },
    { label: "Dana's new password", value: PASSWORDS.danaNew },
    { label: 'a wrong login password', value: PASSWORDS.wrongLogin },
    { label: "the refused sign-up's password", value: PASSWORDS.badBody },
    { label: 'a password over 72 bytes (verifyOtp)', value: PASSWORDS.tooLongVerify },
    { label: 'a password over 72 bytes (resetPassword)', value: PASSWORDS.tooLongReset },
    { label: 'a password in a body that is not JSON', value: PASSWORDS.malformedJson },
    { label: 'a passcode that is not six digits', value: BAD_PASSCODE },
    ...passcodes,
    ...hmacs,
    ...hashes,
    { label: 'JWT_SECRET', value: TEST_SECRETS.JWT_SECRET },
    { label: 'PASSCODE_SECRET', value: TEST_SECRETS.PASSCODE_SECRET },
  ];
  const tokens: Secret[] = issued.flatMap(({ step: name, token }) => [
    { label: `the access token of "${name}"`, value: token },
    // The payload and the signature; the header is the same in every token.
    { label: `the payload of the token of "${name}"`, value: parts(token)[1] ?? '' },
    { label: `the signature of the token of "${name}"`, value: parts(token)[2] ?? '' },
  ]);
  return {
    lines,
    steps,
    secrets,
    tokens,
    issued,
    refusedToken: { label: 'a refused access token', value: refused },
  };
}

type LogLine = {
  level?: number;
  msg?: string;
  req?: { method: string; url: string; headers: Record<string, unknown> };
  res?: { statusCode: number; headers: Record<string, unknown> };
  err?: { message?: string; stack?: string };
  headers?: Record<string, unknown>;
};

/**
 * The operations the contract lists, read from the file. Paths are compared literally: the
 * contract has no path parameters today, so a `{id}` path would need template matching here.
 */
function contractOperations(): { method: string; path: string }[] {
  const text = readFileSync(CONTRACT_PATH, 'utf8');
  const found: { method: string; path: string }[] = [];
  let path = '';
  for (const line of text.split('\n')) {
    const pathMatch = /^ {2}(\/\S*):\s*$/.exec(line);
    if (pathMatch) path = pathMatch[1] ?? '';
    const methodMatch = /^ {4}(get|post|put|patch|delete):\s*$/.exec(line);
    if (methodMatch && path) found.push({ method: (methodMatch[1] ?? '').toUpperCase(), path });
  }
  return found;
}

const onlyPath = (url: string) => url.split('?')[0];

describe('SEC-5 no secret reaches a log line or a response, over the whole flow', () => {
  let run: FlowRun;
  beforeAll(async () => {
    run = await runFlow();
  }, 60_000);

  const logLines = () => run.lines.map((line) => JSON.parse(line) as LogLine);
  const requestLines = () =>
    logLines().filter((line) => line.req !== undefined && line.res !== undefined);

  describe('the logs (SEC-5.a)', () => {
    it('[SEC-5.a] no log line of the whole flow holds a password, a passcode, a passcode HMAC, a password hash, an access token or a server secret', () => {
      const lines = run.lines.map((text, index) => ({ where: `log line ${index + 1}`, text }));

      const findings = sweep(lines, [...run.secrets, ...run.tokens, run.refusedToken]);

      expect(findings).toEqual([]);
    });

    it('[SEC-5.a] no log line holds anything shaped like an access token, whoever issued it', () => {
      const tokens = run.lines.flatMap((line, index) =>
        jwtsIn(line).map(() => `log line ${index + 1}`),
      );

      expect(tokens).toEqual([]);
    });

    it('[SEC-5.a] the two unexpected failures of the flow were logged with their errors, and those lines were searched', () => {
      // The token check that throws (auth.ts) and a 5xx (errors.ts) log an Error: its message and
      // stack are where a token or request data could end up.
      const errors = logLines().filter(
        (line) => line.msg === 'token check failed' || line.msg === 'request failed',
      );

      expect(errors.map((line) => [line.msg, line.err?.message])).toEqual([
        ['token check failed', 'user store unavailable'],
        ['request failed', 'token check failed'],
        ['request failed', 'transaction store unavailable'],
      ]);
      for (const line of errors) expect(typeof line.err?.stack).toBe('string');
    });

    it('[SEC-5.a] nothing the flow wrote to the console holds a password, a passcode, a passcode HMAC, a password hash, an access token or a server secret', () => {
      const output = run.console.map((text, index) => ({
        where: `console call ${index + 1}`,
        text,
      }));

      const findings = sweep(output, [...run.secrets, ...run.tokens, run.refusedToken]);

      expect(findings).toEqual([]);
      expect(output.flatMap(({ where, text }) => jwtsIn(text).map(() => where))).toEqual([]);
    });

    it('[SEC-5.a] every request line shows the Authorization header as [Redacted] when the request sent one, and none shows a bearer token', () => {
      const logged = requestLines();
      // One request line per request, in the order the requests were answered.
      expect(logged.map((line) => `${line.req?.method} ${onlyPath(line.req?.url ?? '')}`)).toEqual(
        run.steps.map((s) => `${s.method} ${s.path}`),
      );

      logged.forEach((line, index) => {
        const sent = run.steps[index]?.authorization;
        const header = line.req?.headers.authorization;
        if (sent)
          expect([run.steps[index]?.name, header]).toEqual([run.steps[index]?.name, '[Redacted]']);
        else expect([run.steps[index]?.name, header]).toEqual([run.steps[index]?.name, undefined]);
      });
      // The redaction is really exercised: several requests carried a token.
      expect(run.steps.filter((s) => s.authorization).length).toBeGreaterThanOrEqual(5);
      expect(JSON.stringify(logged)).not.toMatch(/bearer\s+[A-Za-z0-9._-]{10,}/i);
    });

    it('[SEC-5.a] the flow called every operation of the contract, and the log has a request line for each', () => {
      const logged = new Set(
        requestLines().map((line) => `${line.req?.method} ${onlyPath(line.req?.url ?? '')}`),
      );

      const operations = contractOperations().map(({ method, path }) => `${method} ${path}`);
      const operationIds = readFileSync(CONTRACT_PATH, 'utf8').match(/^\s+operationId:/gm) ?? [];

      // The contract was read in full (a parse that finds nothing would pass the check below).
      expect(operations).toHaveLength(operationIds.length);
      expect([...operations].sort()).toEqual(
        Object.values(OPERATIONS)
          .map(([method, path]) => `${method} ${path}`)
          .sort(),
      );
      expect(operations.filter((operation) => !logged.has(operation))).toEqual([]);
    });

    it('[SEC-5.a] the log records the error answers too, so what an error line holds was searched', () => {
      const statuses = requestLines().map((line) => line.res?.statusCode);

      expect(statuses).toEqual(run.steps.map((s) => s.status));
      expect(statuses).toEqual(expect.arrayContaining([400, 401, 422, 500]));
    });
  });

  describe('the responses (SEC-5.b)', () => {
    it('[SEC-5.b] no response of the whole flow holds a password, a passcode, a passcode HMAC, a password hash or a server secret', () => {
      // The test outbox answers a passcode by design (ADR-0012): that one value is allowed in
      // that one answer; every other secret, and every other passcode, is still searched for.
      const findings = run.steps.flatMap((s) =>
        sweep(
          [{ where: `the answer of "${s.name}"`, text: s.text }],
          run.secrets.filter((x) => !(x.kind === 'passcode' && x.value === s.passcodeAnswered)),
        ),
      );

      expect(findings).toEqual([]);
    });

    it('[SEC-5.b] the test outbox is the only answer with a passcode, and the sweep does see it there', () => {
      const outbox = run.steps.filter((s) => s.operationId === 'testOutbox');
      const passcodes = run.secrets.filter((x) => x.kind === 'passcode');

      expect(outbox.map((s) => s.status)).toEqual([200, 200]);
      for (const s of outbox) {
        expect(findSecrets(s.text, passcodes).map((f) => f.secret)).toHaveLength(1);
      }
      for (const s of run.steps.filter((x) => x.operationId !== 'testOutbox')) {
        expect([s.name, findSecrets(s.text, passcodes)]).toEqual([s.name, []]);
      }
    });

    it('[SEC-5.b] an access token appears only in an AccessToken body, once, as its accessToken, and never in a header or another answer', () => {
      const accessTokenSteps = new Set(run.issued.map((i) => i.step));
      expect(accessTokenSteps.size).toBe(run.issued.length);
      // Four different tokens, or one answer could hold another's without the sweep noticing.
      expect(new Set(run.issued.map((i) => i.token)).size).toBe(run.issued.length);

      for (const s of run.steps) {
        const issuedHere = run.issued.find((i) => i.step === s.name);
        // Anything shaped like a token, not only the ones this test knows: exactly the issued one
        // in an AccessToken answer, nothing in any other answer.
        expect([s.name, jwtsIn(s.text)]).toEqual([s.name, issuedHere ? [issuedHere.token] : []]);
        if (issuedHere) {
          // An AccessToken body: nothing but the three fields, the token once, no token in a header.
          expect(Object.keys(s.body as object).sort()).toEqual([
            'accessToken',
            'expiresIn',
            'tokenType',
          ]);
          expect((s.body as { accessToken: string }).accessToken).toBe(issuedHere.token);
          expect(s.text.split(issuedHere.token)).toHaveLength(2);
          expect(JSON.stringify(s.headers)).not.toContain(issuedHere.token);
        }
        // No token other than the one this answer issued, in any form the sweep covers.
        const foreign = sweep(
          [{ where: s.name, text: s.text }],
          [...run.tokens, run.refusedToken].filter(
            (t) => !issuedHere || !t.label.includes(`"${issuedHere.step}"`),
          ),
        );
        expect(foreign).toEqual([]);
      }
      expect(run.issued.map((i) => i.step)).toEqual([
        'verifyOtp: Dana',
        'verifyOtp: Eli',
        'login: Dana',
        'login: Dana with the new password',
      ]);
    });

    it("[SEC-5.b] (a guard on the flow's shape) the flow sent the inputs that could be echoed back: refused secret fields, wrong passcodes and passwords, a refused transfer, two unexpected failures", () => {
      const answered = (status: number) =>
        run.steps.filter((s) => s.status === status).map((s) => s.name);

      expect(answered(400)).toEqual([
        'signUp: refused body (400)',
        'verifyOtp: a password over 72 bytes and a bad passcode (400)',
        'login: a body that is not JSON, holding a password (400)',
        'resetPassword: a password over 72 bytes (400)',
      ]);
      expect(answered(401)).toHaveLength(6);
      expect(answered(422)).toEqual(['createTransfer: more than Dana has (422)']);
      expect(answered(500)).toEqual([
        'getMe: the user store fails during the token check (500)',
        'createTransfer: the transaction store fails (500)',
      ]);
      // The 500 answers carry the contract's one INTERNAL_ERROR body and nothing of the error.
      for (const s of run.steps.filter((x) => x.status === 500)) {
        expect([s.name, s.body]).toEqual([s.name, INTERNAL_ERROR]);
      }
      // The sweep read the bodies: each answer's text ends with the body the client parsed.
      for (const s of run.steps) {
        if (Object.keys(s.body as object).length > 0) {
          expect([s.name, s.text.endsWith(JSON.stringify(s.body))]).toEqual([s.name, true]);
        }
      }
    });

    it("[SEC-5.b] a bodiless answer (resendOtp's 202, requestPasswordReset's 202, resetPassword's 204) was swept with an empty body, not skipped", () => {
      const bodiless = run.steps.filter((s) =>
        ['resendOtp: Dana', 'requestPasswordReset: Dana', 'resetPassword: Dana'].includes(s.name),
      );

      expect(bodiless.map((s) => s.status)).toEqual([202, 202, 204]);
      for (const s of bodiless) {
        // Status line, headers, a blank line, and nothing after it.
        expect([s.name, s.text.slice(s.text.lastIndexOf('\n\n') + 2)]).toEqual([s.name, '']);
        expect([s.name, s.body]).toEqual([s.name, {}]);
      }
    });
  });

  describe('what the sweep searches for', () => {
    it('[SEC-5.a] what the sweep searches for is not trivial: every secret is long enough, the passcodes, both server secrets and a hash are in it', () => {
      for (const s of [...run.secrets, ...run.tokens]) {
        expect(s.value.length).toBeGreaterThanOrEqual(6);
      }
      expect(run.secrets.filter((s) => s.kind === 'passcode').length).toBeGreaterThanOrEqual(5);
      expect(run.secrets.map((s) => s.label)).toEqual(
        expect.arrayContaining([
          'JWT_SECRET',
          'PASSCODE_SECRET',
          "Dana's password hash after the reset",
        ]),
      );
    });
  });
});

// These need no flow: they show the search finds a secret, so that finding nothing means something.
describe('SEC-5 the sweep can fail', () => {
  const PASSWORD = PASSWORDS.dana;
  const secret: Secret = { label: 'password', value: PASSWORD };
  const found = (text: string, of: Secret = secret) => findSecrets(text, [of]).map((f) => f.form);
  const alignments = (bytes: string) =>
    ['', 'a', 'ab'].map((prefix) => Buffer.from(prefix + bytes));

  it('[SEC-5.a] the forms a password is searched in are these, and no others', () => {
    expect(variantsOf(PASSWORD).map(({ form }) => form)).toEqual([
      'plain',
      'JSON-escaped',
      'JSON-escaped twice',
      'inspected',
      'percent-encoded',
      'percent-encoded, lowercase hex',
      'form-encoded',
      'base64',
      'base64',
      'base64',
      'base64url',
      'base64url',
      'base64url',
      'hex',
      'byte list',
      'Buffer print',
      'base64 of the JSON-escaped',
      'base64 of the JSON-escaped',
      'base64 of the JSON-escaped',
      'base64url of the JSON-escaped',
      'base64url of the JSON-escaped',
      'base64url of the JSON-escaped',
    ]);
  });

  // Each haystack is built here with an encoder of its own, not with the sweep's: the sweep and
  // its test must not share a mistake.
  const lowerPercent = (text: string) =>
    text.replace(/%(..)/g, (_, hex: string) => `%${hex.toLowerCase()}`);
  const withPrefixes = (encode: (bytes: Buffer) => string) =>
    alignments(PASSWORD).map((bytes) => `x${encode(bytes)}x`);
  it.each([
    ['plain', [`x ${PASSWORD} x`]],
    ['JSON-escaped', [JSON.stringify({ p: PASSWORD })]],
    ['JSON-escaped twice', [JSON.stringify(JSON.stringify({ p: PASSWORD }))]],
    ['inspected', [`console ${inspect({ p: PASSWORD })}`]],
    ['percent-encoded', [`?p=${encodeURIComponent(PASSWORD)}`]],
    ['percent-encoded, lowercase hex', [`?p=${lowerPercent(encodeURIComponent(PASSWORD))}`]],
    ['form-encoded', [new URLSearchParams({ p: PASSWORD }).toString()]],
    ['base64', withPrefixes((b) => b.toString('base64'))],
    ['base64url', withPrefixes((b) => b.toString('base64url'))],
    [
      'hex',
      [Buffer.from(PASSWORD).toString('hex'), Buffer.from(PASSWORD).toString('hex').toUpperCase()],
    ],
    ['byte list', [JSON.stringify({ b: Buffer.from(PASSWORD) })]],
    [
      'Buffer print',
      [inspect(Buffer.from(PASSWORD)), `console.log: ${inspect({ b: Buffer.from(PASSWORD) })}`],
    ],
    [
      'base64 of the JSON-escaped',
      ['', 'a', 'ab'].map((prefix) =>
        Buffer.from(`${prefix}${JSON.stringify({ password: PASSWORD })}`).toString('base64'),
      ),
    ],
    [
      'base64url of the JSON-escaped',
      ['', 'a', 'ab'].map((prefix) =>
        Buffer.from(`${prefix}${JSON.stringify({ password: PASSWORD })}`).toString('base64url'),
      ),
    ],
  ] as [string, string[]][])('[SEC-5.a] a password written %s is found', (form, haystacks) => {
    for (const haystack of haystacks) expect(found(haystack)).toContain(form);
  });

  it('[SEC-5.b] a secret inside a base64 text (a token payload) is found at any alignment', () => {
    for (const prefix of ['', 'a', 'ab']) {
      const payload = Buffer.from(`${prefix}${JSON.stringify({ password: PASSWORD })}`).toString(
        'base64url',
      );

      expect(found(`eyJhbGciOiJIUzI1NiJ9.${payload}.sig`)).toEqual(
        expect.arrayContaining([expect.stringContaining('base64url')]),
      );
    }
  });

  it('[SEC-5.a] an HMAC is found in hex, in either case, and as the base64 or the byte list of its raw bytes', () => {
    const hmac = 'f3a1b2c4d5e60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
    const raw = Buffer.from(hmac, 'hex');
    const digest: Secret = { label: 'hmac', value: hmac, kind: 'hmac' };

    expect(found(`"hmac":"${hmac}"`, digest)).toEqual(['plain']);
    expect(found(hmac.toUpperCase(), digest)).toContain('plain');
    expect(found(`x${raw.toString('base64')}x`, digest)).toContain('base64 of the raw bytes');
    expect(found(`x${raw.toString('base64url')}x`, digest)).toContain('base64url of the raw bytes');
    expect(found(JSON.stringify({ b: raw }), digest)).toContain('byte list of the raw bytes');
    expect(found(inspect(raw), digest)).toContain('Buffer print of the raw bytes');
  });

  it('[SEC-5.a] a long secret printed as a Buffer is found by the first 50 bytes, all the console shows', () => {
    const hash = `$argon2id$v=19$m=19456,t=2,p=1$${'c2FsdHNhbHRzYWx0'}$${'ZGlnZXN0ZGlnZXN0ZGlnZXN0ZGlnZXN0ZGlnZXN0'}`;
    const printed = inspect(Buffer.from(hash));

    expect(printed).toContain('more bytes');
    expect(found(printed, { label: 'hash', value: hash })).toContain('Buffer print');
  });

  it('[SEC-5.a] a passcode is found next to letters and symbols, but not inside a longer number', () => {
    const code: Secret = { label: 'passcode', value: '123456', kind: 'passcode' };

    for (const text of [
      '{"passcode":"123456"}',
      '{"passcode":123456}',
      'passcode=123456&x=1',
      'otp123456',
      '123456abc',
      'code-123456-end',
    ]) {
      expect([text, found(text, code)]).toEqual([text, ['plain']]);
    }
    for (const text of [
      '{"time":1731912345678}',
      '{"iat":1234567890,"exp":1234571490}',
      'order 1234567',
      '9123456',
      '{"balance":123456,"amount":-123456}',
    ]) {
      expect([text, found(text, code)]).toEqual([text, []]);
    }
  });

  it('[SEC-5.a] a passcode that lost its leading zeros as a number is found, when four digits or more are left', () => {
    const code: Secret = { label: 'passcode', value: '012345', kind: 'passcode' };
    const longZeros: Secret = { label: 'passcode', value: '000042', kind: 'passcode' };
    const form = ['number without its leading zeros'];

    for (const text of [
      '{"code":12345}',
      '{"code":12345,"x":1}',
      '{"codes":[1,12345]}',
      '{"code": 12345 }',
    ]) {
      expect([text, found(text, code)]).toEqual([text, form]);
    }
    for (const text of [
      '{"code":123456}',
      '{"code":"12345"}',
      '{"code":112345}',
      '{"code":12345.5}',
    ]) {
      expect([text, found(text, code)]).toEqual([text, []]);
    }
    // The legitimate numbers stay out of it, and so do the short ones (too common to mean anything).
    expect(found('{"balance":12345,"amount":12345,"expiresIn":12345}', code)).toEqual([]);
    expect(found('{"code":42}', longZeros)).toEqual([]);
  });

  it('[SEC-5.a] a passcode is not found inside a uuid, a long hex text or a token, where its digits are chance', () => {
    const code: Secret = { label: 'passcode', value: '123456', kind: 'passcode' };
    const hex = `a${'0f'.repeat(15)}f123456a${'3c'.repeat(8)}`;
    const payload = Buffer.from(
      JSON.stringify({ sub: 'u-1', iat: 1_234_567_890, exp: 1_234_571_490 }),
    ).toString('base64url');
    const token = `eyJhbGciOiJIUzI1NiJ9.${payload}.sig-123456-x`;

    expect(found('{"id":"3f123456-e89b-4d3c-a456-426614174000"}', code)).toEqual([]);
    expect(found(`{"hmac":"${hex}"}`, code)).toEqual([]);
    expect(found(`{"accessToken":"${token}"}`, code)).toEqual([]);
    // Outside those, the same digits are a hit.
    expect(found('{"id":"x-f123456a"}', code)).toEqual(['plain']);
  });

  it('[SEC-5.a] a secret of 5 characters is refused, since it would match by accident, and one of 6 is searched', () => {
    expect(MIN_SECRET_LENGTH).toBe(6);
    expect(() => findSecrets('anything', [{ label: 'five', value: '12345' }])).toThrow(/too short/);
    expect(() => findSecrets('anything', [{ label: 'empty', value: '' }])).toThrow(/too short/);
    expect(findSecrets('has abcdef in it', [{ label: 'six', value: 'abcdef' }])).toHaveLength(1);
  });

  it('[SEC-5.b] anything shaped like a token is found, whoever issued it', () => {
    const token = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from('{"sub":"u"}').toString('base64url')}.c2ln-_x`;

    expect(jwtsIn(`{"a":"${token}","b":"Bearer ${token}"}`)).toEqual([token, token]);
    expect(jwtsIn('{"email":"dana@example.com","status":"pending"}')).toEqual([]);
  });

  it('[SEC-5.a] a handler that logs the request body, or the request headers under another key, is caught in the real pipeline', async () => {
    const lines: string[] = [];
    const logger = createLogger('trace', { write: (line: string) => void lines.push(line) });
    const routes = Router();
    routes.post(SIGN_UP, (req, res) => {
      req.log.info({ body: req.body }, 'got a sign-up');
      req.log.info({ headers: req.headers }, 'got headers');
      res.status(202).json({ email: (req.body as { email: string }).email, status: 'pending' });
    });
    const h = buildTestHarness({ logger, routes });
    const token = 'header.payload.signature-for-the-planted-test';

    await signUp(h, { ...validSignUp, email: DANA, password: PASSWORDS.dana })
      .set(bearer(token))
      .expect(202);

    const hits = sweep(
      lines.map((text, index) => ({ where: `line ${index + 1}`, text })),
      [
        { label: 'password', value: PASSWORDS.dana },
        { label: 'token', value: token },
      ],
    );
    expect(hits.map((f) => f.secret).sort()).toEqual(expect.arrayContaining(['password', 'token']));
    // The redaction is path-specific: `req.headers.authorization` is redacted (the line's own
    // request, and the one the logger carries), a copy under another key is not.
    const parsed = lines.map((line) => JSON.parse(line) as LogLine);
    const copied = parsed.find((line) => line.msg === 'got headers');
    expect(copied?.headers?.authorization).toBe(`Bearer ${token}`);
    expect(copied?.req?.headers.authorization).toBe('[Redacted]');
    expect(
      parsed.find((line) => line.msg === 'request completed')?.req?.headers.authorization,
    ).toBe('[Redacted]');
  });

  it('[SEC-5.a] a handler that writes a secret to the console is caught', async () => {
    const routes = Router();
    routes.post(SIGN_UP, (req, res) => {
      console.warn('sign-up', req.body);
      res.status(202).json({ email: (req.body as { email: string }).email, status: 'pending' });
    });
    const h = buildTestHarness({ routes });

    const { output } = await captureConsole(() =>
      signUp(h, { ...validSignUp, email: DANA, password: PASSWORDS.dana }).then(
        (res) => res.status,
      ),
    );

    expect(
      sweep(
        output.map((text) => ({ where: 'console', text })),
        [secret],
      ),
    ).not.toEqual([]);
  });

  it('[SEC-5.a] only server/src/logger.ts makes a logger, and the one pinoHttp call is app.ts handing it deps.logger', () => {
    const src = resolve(__dirname, '../src');
    const files = Object.fromEntries(
      (readdirSync(src, { recursive: true }) as string[])
        .filter((name) => name.endsWith('.ts'))
        .map((name) => [name, readFileSync(resolve(src, name), 'utf8')]),
    );

    expect(Object.keys(files)).toEqual(expect.arrayContaining(['logger.ts', 'app.ts']));
    expect(loggerProblems(files)).toEqual([]);
  });

  it('[SEC-5.a] the logger check finds a second logger, a pinoHttp of its own, a second or a missing call', () => {
    const good = {
      'logger.ts': "import pino from 'pino';",
      'app.ts': 'app.use(pinoHttp({ logger: deps.logger, serializers: { req: (r) => r } }));',
      'types.ts': "import type { Logger } from 'pino';",
    };
    const bad = (extra: Record<string, string>, without: string[] = []) =>
      loggerProblems({
        ...Object.fromEntries(Object.entries(good).filter(([name]) => !without.includes(name))),
        ...extra,
      });

    expect(loggerProblems(good)).toEqual([]);
    expect(bad({ 'a.ts': "import pino from 'pino';" })).toEqual(['a.ts imports pino']);
    expect(bad({ 'a.ts': "import { pino } from 'pino';" })).toEqual(['a.ts imports pino']);
    expect(bad({ 'a.ts': "import pino, { type Logger } from 'pino';" })).toEqual([
      'a.ts imports pino',
    ]);
    expect(bad({ 'a.ts': "const p = require('pino');" })).toEqual(['a.ts imports pino']);
    expect(bad({ 'a.ts': "const p = await import('pino');" })).toEqual(['a.ts imports pino']);
    expect(bad({ 'app.ts': 'app.use(pinoHttp(options));' })).toEqual([
      'pinoHttp in app.ts is not given deps.logger',
    ]);
    expect(bad({ 'app.ts': 'app.use(pinoHttp({ serializers: { req: (r) => r } }));' })).toEqual([
      'pinoHttp in app.ts is not given deps.logger',
    ]);
    expect(bad({ 'app.ts': 'app.use(pinoHttp({ logger: other }));' })).toEqual([
      'pinoHttp in app.ts is not given deps.logger',
    ]);
    expect(bad({ 'b.ts': 'x(pinoHttp({ logger: deps.logger }));' })).toEqual([
      '2 pinoHttp calls, expected 1',
      'pinoHttp called in b.ts',
    ]);
    expect(bad({ 'routes.ts': 'x(pinoHttp({ logger: deps.logger }));' }, ['app.ts'])).toEqual([
      'pinoHttp called in routes.ts',
    ]);
    expect(bad({}, ['app.ts'])).toEqual(['0 pinoHttp calls, expected 1']);
  });

  it('[SEC-5.b] a response that holds a token where it should not is caught', async () => {
    const token = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from('{"sub":"u"}').toString('base64url')}.c2ln`;
    const routes = Router();
    routes.post(SIGN_UP, (req, res) => {
      res.status(202).json({
        email: (req.body as { email: string }).email,
        status: 'pending',
        accessToken: token,
      });
    });
    const h = buildTestHarness({ routes });

    const res = await signUp(h, { ...validSignUp, email: DANA, password: PASSWORDS.dana });

    expect(jwtsIn(responseText(res))).toEqual([token]);
  });

  it('[SEC-5.b] a response that echoes a secret in a header is caught', async () => {
    const routes = Router();
    routes.post(SIGN_UP, (req, res) => {
      res.set('X-Debug', (req.body as { password: string }).password);
      res.status(202).json({ email: (req.body as { email: string }).email, status: 'pending' });
    });
    const h = buildTestHarness({ routes });

    const res = await signUp(h, { ...validSignUp, email: DANA, password: 'plain-echo-password-1' });

    expect(
      findSecrets(responseText(res), [{ label: 'password', value: 'plain-echo-password-1' }]),
    ).toEqual([{ secret: 'password', form: 'plain' }]);
  });
});

/** The text between the parenthesis opened at `open` and its match (strings are not parsed). */
function argumentsAt(code: string, open: number): string {
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === '(') depth += 1;
    if (code[i] === ')' && (depth -= 1) === 0) return code.slice(open + 1, i);
  }
  return code.slice(open + 1);
}

/**
 * What is wrong with how the server's source makes loggers. A second logger would not pass through
 * the injected one that the flow captures, nor through its redaction, so: only `logger.ts` imports
 * pino (type-only imports are fine), and `pinoHttp` is called exactly once, in `app.ts`, with the
 * injected `deps.logger`.
 */
function loggerProblems(files: Record<string, string>): string[] {
  const importsPino = (code: string) =>
    /^\s*import\s+(?!type\b)[^;]*from\s+['"]pino['"]/m.test(code) ||
    /\brequire\(\s*['"]pino['"]\s*\)|\bimport\(\s*['"]pino['"]\s*\)/.test(code);
  const problems = Object.entries(files)
    .filter(([name, code]) => name !== 'logger.ts' && importsPino(code))
    .map(([name]) => `${name} imports pino`);
  const calls = Object.entries(files).flatMap(([name, code]) =>
    [...code.matchAll(/\bpinoHttp\(/g)].map((match) => ({
      name,
      args: argumentsAt(code, match.index + match[0].length - 1),
    })),
  );
  if (calls.length !== 1) problems.push(`${calls.length} pinoHttp calls, expected 1`);
  for (const { name, args } of calls) {
    if (name !== 'app.ts') problems.push(`pinoHttp called in ${name}`);
    else if (!args.includes('logger: deps.logger')) {
      problems.push(`pinoHttp in ${name} is not given deps.logger`);
    }
  }
  return problems;
}
