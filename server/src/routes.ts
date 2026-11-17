import { Router } from 'express';
import type { AppDeps } from './app';
import type { components } from '../../api/generated/schema';
import { authenticatedUserId } from './http/auth';
import { problem, sendProblem } from './http/problem';
import { createAccountService } from './services/accounts';
import { createLoginService } from './services/login';
import { createPasscodeService } from './services/passcodes';
import { argon2PasswordHasher } from './services/passwords';
import { ACCESS_TOKEN_TTL_SECONDS, type TokenService } from './services/tokens';
import { createSignUpService } from './services/sign-up';

type Schemas = components['schemas'];

export type RouteDeps = Pick<AppDeps, 'config' | 'clock' | 'mailer' | 'repositories'> & {
  /** The app's one token service, shared with the token check. */
  tokens: TokenService;
};

/**
 * The contract's operations. The contract chain has validated every request body before a
 * handler runs, so handlers read `req.body` as the contract's request type.
 */
export function createRoutes(deps: RouteDeps): Router {
  const signUps = createSignUpService({
    ...deps.repositories,
    mailer: deps.mailer,
    clock: deps.clock,
    passcodes: createPasscodeService({ secret: deps.config.passcodeSecret }),
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
  const router = Router();

  // SU-1, SU-2, SU-3, OTP-1
  router.post('/api/v1/auth/signup', async (req, res) => {
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
  router.post('/api/v1/auth/otp/resend', async (req, res) => {
    const { email } = req.body as Schemas['ResendOtpRequest'];
    await signUps.resend(email);
    res.status(202).end();
  });

  // OTP-2, OTP-3, SU-2, DB-2, SEC-1: every failure is the same 401, so the answer never tells a
  // wrong passcode from an unknown, expired or already verified email.
  router.post('/api/v1/auth/otp/verify', async (req, res) => {
    const outcome = await signUps.verify(req.body as Schemas['VerifyOtpRequest']);
    if (outcome.result === 'invalid') {
      sendProblem(res, problem(401, 'PASSCODE_INVALID', 'Wrong or expired passcode'));
      return;
    }
    res.json(await accessToken(outcome.user.id));
  });

  // LG-1, LG-2, SEC-4: a wrong password, an unknown email and a pending sign-up get one answer.
  router.post('/api/v1/auth/login', async (req, res) => {
    const { email, password } = req.body as Schemas['LoginRequest'];
    const outcome = await logins.login(email, password);
    if (outcome.result === 'invalid') {
      sendProblem(res, problem(401, 'INVALID_CREDENTIALS', 'Wrong email or password'));
      return;
    }
    res.json(await accessToken(outcome.user.id));
  });

  // DB-1, DB-3: the token check has already run; the account is the token's user, nobody else's.
  router.get('/api/v1/me', async (_req, res) => {
    const user = await accounts.getAccount(authenticatedUserId(res));
    if (!user) {
      // The token's user was there at the token check and is gone now: the same 401.
      sendProblem(res, problem(401, 'UNAUTHORIZED', 'Sign in required'));
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

  return router;
}
