// Builds the mailer the MAILER setting names (docs/decisions/0001, 0012).
import { type AppConfig, ConfigError } from '../config';
import type { Mailer } from './mailer';
import { OutboxMailer } from './outbox';

/**
 * Only the in-memory outbox exists until a real email API is added, so with NODE_ENV=production
 * this refuses to build it: the server never starts (SEC-5.d). The message names the variable
 * and shows no secret. The switch is exhaustive: a second MAILER value fails to compile here
 * until it gets its own mailer.
 */
export function createMailer(config: Pick<AppConfig, 'mailer' | 'nodeEnv'>): Mailer {
  switch (config.mailer) {
    case 'outbox':
      if (config.nodeEnv === 'production') {
        throw new ConfigError([
          'MAILER=outbox keeps passcodes in memory and is refused when NODE_ENV is production; ' +
            'no other mailer exists yet',
        ]);
      }
      return new OutboxMailer();
    default: {
      const unhandled: never = config.mailer;
      throw new Error(`no mailer is built for MAILER=${String(unhandled)}`);
    }
  }
}
