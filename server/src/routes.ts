import { Router } from 'express';
import type { AppDeps } from './app';
import type { components } from '../../api/generated/schema';
import { authenticatedUserId } from './http/auth';
import { finiteQueryNumbers } from './http/contract';
import { unauthorizedProblem } from './http/errors';
import { type Problem, problem, sendProblem } from './http/problem';
import { createRateLimiters } from './http/rate-limits';
import { createAccountService } from './services/accounts';
import { createLoginService } from './services/login';
import { createPasscodeService } from './services/passcodes';
import { createPasswordResetService } from './services/password-resets';
import { argon2PasswordHasher } from './services/passwords';
import { ACCESS_TOKEN_TTL_SECONDS, type TokenService } from './services/tokens';
import { createSignUpService } from './services/sign-up';
import { type SendOutcome, type Transaction, createTransferService } from './services/transfers';

type Schemas = components['schemas'];

/** createTransfer's refusals: the contract's 422 examples, and a 401 if the sender is gone. */
function refusal(result: Exclude<SendOutcome['result'], 'sent'>): Problem {
  switch (result) {
    case 'unknown-sender':
      // The token's user was there at the token check and is gone now: the same 401.
      return unauthorizedProblem();
    case 'key-reused':
      return problem(422, 'IDEMPOTENCY_KEY_REUSED', 'This key belongs to another transfer');
    case 'self-transfer':
      return problem(422, 'SELF_TRANSFER', "You can't send money to yourself");
    case 'recipient-not-found':
      return problem(422, 'RECIPIENT_NOT_FOUND', 'No user with that email');
    case 'insufficient-funds':
      return problem(422, 'INSUFFICIENT_FUNDS', 'Insufficient funds');
  }
}

const transactionBody = (transaction: Transaction): Schemas['Transaction'] => ({
  ...transaction,
  createdAt: transaction.createdAt.toISOString(),
});

export type RouteDeps = Pick<AppDeps, 'config' | 'clock' | 'logger' | 'mailer' | 'repositories'> & {
  /** The app's one token service, shared with the token check. */
  tokens: TokenService;
};

/**
 * The contract's operations. The contract chain has validated every request body before a
 * handler runs, so handlers read `req.body` as the contract's request type.
 */
export function createRoutes(deps: RouteDeps): Router {
  const passcodes = createPasscodeService({ secret: deps.config.passcodeSecret });
  const signUps = createSignUpService({
    ...deps.repositories,
    mailer: deps.mailer,
    clock: deps.clock,
    passcodes,
    passwords: argon2PasswordHasher,
  });
  const passwordResets = createPasswordResetService({
    users: deps.repositories.users,
    passwordResets: deps.repositories.passwordResets,
    mailer: deps.mailer,
    clock: deps.clock,
    passcodes,
    passwords: argon2PasswordHasher,
  });
  const { tokens } = deps;
  const accounts = createAccountService({ users: deps.repositories.users });
  const logins = createLoginService({
    users: deps.repositories.users,
    passwords: argon2PasswordHasher,
  });
  const accessToken = async (userId: string): Promise<Schemas['AccessToken']> => ({
    accessToken: await tokens.sign(userId),
    tokenType: 'Bearer',
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
  });
  const transfers = createTransferService({
    transactions: deps.repositories.transactions,
    clock: deps.clock,
  });
  const limits = createRateLimiters({ clock: deps.clock, logger: deps.logger });
  const router = Router();

  // SU-1, SU-2, SU-3, OTP-1
  router.post('/api/v1/auth/signup', limits.email, async (req, res) => {
    const { email } = req.body as Schemas['SignUpRequest'];
    const outcome = await signUps.signUp(email);
    if (outcome.result === 'taken') {
      sendProblem(res, problem(409, 'EMAIL_TAKEN', 'Email already registered'));
      return;
    }
    const body: Schemas['PendingSignUp'] = { email: outcome.email, status: 'pending' };
    res.status(202).json(body);
  });

  // OTP-1, SEC-4: the same bodiless 202 whether or not anything was sent (the contract declares
  // no content for it).
  router.post('/api/v1/auth/otp/resend', limits.email, async (req, res) => {
    const { email } = req.body as Schemas['ResendOtpRequest'];
    await signUps.resend(email);
    res.status(202).end();
  });

  // OTP-2, OTP-3, SU-2, DB-2, SEC-1: every failure is the same 401, so the answer never tells a
  // wrong passcode from an unknown, expired or already verified email.
  router.post('/api/v1/auth/otp/verify', limits.credentials, async (req, res) => {
    const outcome = await signUps.verify(req.body as Schemas['VerifyOtpRequest']);
    if (outcome.result === 'invalid') {
      sendProblem(res, problem(401, 'PASSCODE_INVALID', 'Wrong or expired passcode'));
      return;
    }
    res.json(await accessToken(outcome.user.id));
  });

  // LG-1, LG-2, SEC-4: a wrong password, an unknown email and a pending sign-up get one answer.
  router.post('/api/v1/auth/login', limits.credentials, async (req, res) => {
    const { email, password } = req.body as Schemas['LoginRequest'];
    const outcome = await logins.login(email, password);
    if (outcome.result === 'invalid') {
      sendProblem(res, problem(401, 'INVALID_CREDENTIALS', 'Wrong email or password'));
      return;
    }
    res.json(await accessToken(outcome.user.id));
  });

  // PW-1, SEC-4: the same bodiless 202 whether or not anything was sent.
  router.post('/api/v1/auth/password/forgot', limits.email, async (req, res) => {
    const { email } = req.body as Schemas['PasswordResetRequest'];
    await passwordResets.request(email);
    res.status(202).end();
  });

  // PW-1, SEC-4, SU-3: the contract has checked the password rules before this runs, so a bad
  // password never uses up the passcode. Every failure is the same 401 as verifyOtp's.
  router.post('/api/v1/auth/password/reset', limits.credentials, async (req, res) => {
    const outcome = await passwordResets.reset(req.body as Schemas['ResetPasswordRequest']);
    if (outcome.result === 'invalid') {
      sendProblem(res, problem(401, 'PASSCODE_INVALID', 'Wrong or expired passcode'));
      return;
    }
    res.status(204).end();
  });

  // DB-1, DB-3: the token check has already run; the account is the token's user, nobody else's.
  router.get('/api/v1/me', async (_req, res) => {
    const user = await accounts.getAccount(authenticatedUserId(res));
    if (!user) {
      // The token's user was there at the token check and is gone now: the same 401.
      sendProblem(res, unauthorizedProblem());
      return;
    }
    const body: Schemas['Account'] = {
      id: user.id,
      email: user.email,
      phone: user.phone,
      balance: user.balance,
      createdAt: user.createdAt.toISOString(),
    };
    res.json(body);
  });

  // DB-3, TX-4, TX-5, DB-1: the token user's transfers, sent and received, newest first, each
  // amount signed from their side. Not rate-limited (docs/decisions/0011).
  router.get('/api/v1/transactions', finiteQueryNumbers, async (req, res) => {
    // The contract has checked 1 to 50, finiteQueryNumbers that it is finite, and the default 20
    // is filled in.
    const { limit } = req.query as { limit?: unknown };
    if (typeof limit !== 'number') throw new Error('The contract did not fill in limit');
    const items = await transfers.list(authenticatedUserId(res), limit);
    if (!items) {
      // The token's user was there at the token check and is gone now: the same 401.
      sendProblem(res, unauthorizedProblem());
      return;
    }
    const body: Schemas['TransactionList'] = { items: items.map(transactionBody) };
    res.json(body);
  });

  // TX-1..TX-9, DB-1: the sender is the token's user; the body names only the recipient and the
  // amount (the contract refuses any other field), and the contract requires the one-time key.
  // The store's one step checks the key, self, recipient and funds in that order and moves the
  // money. Not rate-limited (docs/decisions/0011).
  router.post('/api/v1/transfers', async (req, res) => {
    const { toEmail, amount } = req.body as Schemas['CreateTransferRequest'];
    // The contract's validator has already refused a missing or malformed key.
    const idempotencyKey = req.get('Idempotency-Key') as string;
    const outcome = await transfers.send(authenticatedUserId(res), toEmail, amount, idempotencyKey);
    if (outcome.result !== 'sent') {
      sendProblem(res, refusal(outcome.result));
      return;
    }
    const body: Schemas['TransferResult'] = {
      transaction: transactionBody(outcome.transaction),
      balance: outcome.balance,
    };
    res.status(201).json(body);
  });

  return router;
}
