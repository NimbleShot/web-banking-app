// Builds the mailer the MAILER setting names (docs/decisions/0001, 0012, 0017).
import { type AppConfig, ConfigError } from '../config';
import type { Mailer } from './mailer';
import { OutboxMailer } from './outbox';
import { ResendMailer } from './resend';

/**
 * The in-memory outbox, refused with NODE_ENV=production so the server never starts with it
 * (SEC-5.d), or Resend's HTTP API (DP-1). The messages name the variables and show no secret.
 * The switch is exhaustive: another MAILER value fails to compile here until it gets its mailer.
 */
export function createMailer(config: Pick<AppConfig, 'mailer' | 'nodeEnv' | 'resend'>): Mailer {
  switch (config.mailer) {
    case 'outbox':
      if (config.nodeEnv === 'production') {
        throw new ConfigError([
          'MAILER=outbox keeps passcodes in memory and is refused when NODE_ENV is production; ' +
            'set MAILER=resend',
        ]);
      }
      return new OutboxMailer();
    case 'resend':
      // loadConfig sets these exactly when MAILER=resend; a config built by hand may not.
      if (!config.resend) {
        throw new ConfigError(['MAILER=resend needs RESEND_API_KEY and MAIL_FROM']);
      }
      return new ResendMailer(config.resend);
    default: {
      const unhandled: never = config.mailer;
      throw new Error(`no mailer is built for MAILER=${String(unhandled)}`);
    }
  }
}
