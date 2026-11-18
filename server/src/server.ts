// Entry point: read the configuration, build the app, listen.
import { createApp } from './app';
import { systemClock } from './clock';
import { ConfigError, loadConfig } from './config';
import { createLogger } from './logger';
import { OutboxMailer } from './mail/outbox';
import { InMemoryPasswordResetRepository } from './repositories/password-resets';
import { InMemoryPendingSignUpRepository } from './repositories/pending-sign-ups';
import { InMemoryUserRepository } from './repositories/users';

function main(): void {
  const config = loadConfig(process.env);
  const logger = createLogger(config.logLevel);
  const app = createApp({
    config,
    logger,
    clock: systemClock,
    mailer: new OutboxMailer(),
    repositories: {
      users: new InMemoryUserRepository(),
      pendingSignUps: new InMemoryPendingSignUpRepository(),
      passwordResets: new InMemoryPasswordResetRepository(),
    },
  });
  // Express 5 hands a failed bind (port taken, no permission) to this callback.
  const server = app.listen(config.port, (error?: Error) => {
    if (error) {
      logger.fatal({ err: error, port: config.port }, 'server could not listen');
      process.exitCode = 1;
      return;
    }
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : config.port;
    logger.info({ port, nodeEnv: config.nodeEnv }, 'server listening');
  });
}

try {
  main();
} catch (error) {
  console.error(error instanceof ConfigError ? error.message : error);
  process.exitCode = 1;
}
