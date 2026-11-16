// The Express app, built from its dependencies; only server.ts opens a port (docs/decisions/0009).
import express, { type Express, type Router } from 'express';
import helmet from 'helmet';
import type { Logger } from 'pino';
import { pinoHttp } from 'pino-http';
import type { AppConfig } from './config';
import { corsForFrontEnd } from './http/cors';
import { contractMiddleware, type ResponseViolation } from './http/contract';
import { errorHandler, notFound } from './http/errors';
import { createRoutes } from './routes';

export type AppDeps = {
  config: AppConfig;
  logger: Logger;
  /** Tests only: validate every response against the contract and report the ones that break it. */
  onResponseViolation?: (violation: ResponseViolation) => void;
};

/**
 * `routes` defaults to the contract's operations; tests pass their own router to put a handler
 * behind the same pipeline.
 */
export function createApp(deps: AppDeps, routes: Router = createRoutes()): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(pinoHttp({ logger: deps.logger }));
  // Ahead of the contract, so error answers carry these headers too and the front end's
  // preflights (OPTIONS, which the contract doesn't list) are answered here (SEC-3).
  app.use(helmet());
  app.use(corsForFrontEnd(deps.config.corsOrigin));
  app.use(contractMiddleware({ onResponseViolation: deps.onResponseViolation }));
  app.use(routes);
  app.use(notFound);
  app.use(errorHandler);
  return app;
}
