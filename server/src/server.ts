// Entry point: read the configuration, open the storage, build the app, listen.
import { createApp } from './app';
import { systemClock } from './clock';
import { ConfigError, loadConfig } from './config';
import { createLogger } from './logger';
import { createMailer } from './mail/create-mailer';
import { StorageError } from './repositories/mongo/models';
import { openStorage } from './storage';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const logger = createLogger(config.logLevel);
  // The refusals come before any connection: the mailer's (SEC-5.d), then the storage's.
  const mailer = createMailer(config);
  const storage = await openStorage(config);
  let app: ReturnType<typeof createApp>;
  try {
    app = createApp({
      config,
      logger,
      clock: systemClock,
      mailer,
      repositories: storage.repositories,
    });
  } catch (error) {
    // An open database connection would keep the process alive after the failure.
    await storage.close();
    throw error;
  }
  // Express 5 hands a failed bind (port taken, no permission) to this callback.
  const server = app.listen(config.port, (error?: Error) => {
    if (error) {
      logger.fatal({ err: error, port: config.port }, 'server could not listen');
      process.exitCode = 1;
      // An open database connection would keep the process alive.
      void storage.close();
      return;
    }
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : config.port;
    logger.info({ port, nodeEnv: config.nodeEnv, storage: storage.kind }, 'server listening');
  });
}

main().catch((error: unknown) => {
  // These two messages name what to fix and never a secret or the database address.
  const known = error instanceof ConfigError || error instanceof StorageError;
  console.error(known ? error.message : error);
  process.exitCode = 1;
});
