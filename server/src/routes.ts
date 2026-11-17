import { Router } from 'express';
import type { AppDeps } from './app';
import type { components } from '../../api/generated/schema';
import { problem, sendProblem } from './http/problem';
import { createPasscodeService } from './services/passcodes';
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

  return router;
}
