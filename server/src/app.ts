// The Express app, built from its dependencies; only server.ts opens a port (docs/decisions/0009).
import express, { type Express, type Router } from 'express';
import helmet from 'helmet';
import type { Logger } from 'pino';
import { pinoHttp } from 'pino-http';
import type { Clock } from './clock';
import type { AppConfig } from './config';
import { bearerAuthHandler } from './http/auth';
import { corsForFrontEnd } from './http/cors';
import { contractMiddleware, type ResponseViolation } from './http/contract';
import { errorHandler, notFound } from './http/errors';
import type { Mailer } from './mail/mailer';
import type { PasswordResetRepository } from './repositories/password-resets';
import type { PendingSignUpRepository } from './repositories/pending-sign-ups';
import type { UserRepository } from './repositories/users';
import { createRoutes } from './routes';
import { createAuthenticationService } from './services/authentication';
import { createTokenService } from './services/tokens';

export type Repositories = {
  users: UserRepository;
  pendingSignUps: PendingSignUpRepository;
  passwordResets: PasswordResetRepository;
};

export type AppDeps = {
  config: AppConfig;
  logger: Logger;
  clock: Clock;
  mailer: Mailer;
  repositories: Repositories;
  /** Tests only: validate every response against the contract and report the ones that break it. */
  onResponseViolation?: (violation: ResponseViolation) => void;
};

/**
 * `routes` defaults to the contract's operations; tests pass their own router to put a handler
 * behind the same pipeline.
 */
export function createApp(deps: AppDeps, routes?: Router): Express {
  // One token service signs (routes) and verifies (the token check).
  const tokens = createTokenService({ secret: deps.config.jwtSecret, clock: deps.clock });
  const app = express();
  app.disable('x-powered-by');
  app.use(pinoHttp({ logger: deps.logger }));
  // Ahead of the contract, so error answers carry these headers too and the front end's
  // preflights (OPTIONS, which the contract doesn't list) are answered here (SEC-3).
  app.use(helmet());
  app.use(corsForFrontEnd(deps.config.corsOrigin));
  const bearerAuth = bearerAuthHandler(
    createAuthenticationService({ tokens, users: deps.repositories.users }),
  );
  app.use(contractMiddleware({ bearerAuth, onResponseViolation: deps.onResponseViolation }));
  app.use(routes ?? createRoutes({ ...deps, tokens }));
  app.use(notFound);
  app.use(errorHandler);
  return app;
}
