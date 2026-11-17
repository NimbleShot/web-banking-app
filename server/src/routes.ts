import { Router } from 'express';
import type { AppDeps } from './app';
import type { components } from '../../api/generated/schema';
import { problem, sendProblem } from './http/problem';
import { createPasscodeService } from './services/passcodes';
import { argon2PasswordHasher } from './services/passwords';
import { ACCESS_TOKEN_TTL_SECONDS, createTokenService } from './services/tokens';
import { createSignUpService } from './services/sign-up';

type Schemas = components['schemas'];

export type RouteDeps = Pick<AppDeps, 'config' | 'clock' | 'mailer' | 'repositories'>;

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
  const tokens = createTokenService({ secret: deps.config.jwtSecret, clock: deps.clock });
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
    const body: Schemas['AccessToken'] = {
      accessToken: await tokens.sign(outcome.user.id),
      tokenType: 'Bearer',
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    };
    res.json(body);
  });

  return router;
}
