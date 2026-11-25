// Passcode emails go out after the answer (DP-2, docs/decisions/0017). Waiting for the email API
// would make a request for a registered email slower than one for an unknown email, and a failed
// send would answer 500 only for registered ones: both would tell who has an account.
import type { Logger } from 'pino';
import type { Mailer } from './mailer';
import { MailerError } from './resend';

/**
 * `mailer`, started but not awaited. The send begins at once (the outbox stores its message before
 * the request answers); a failure is logged as "passcode email not sent" with the purpose and the
 * email API's status, never the passcode or the address. The user sees no email and asks for a
 * new code after the cooldown.
 */
export function sendAfterAnswer(mailer: Mailer, logger: Logger): Mailer {
  return {
    sendPasscode(message) {
      let sending: Promise<void>;
      try {
        sending = mailer.sendPasscode(message);
      } catch (error) {
        sending = Promise.reject(error);
      }
      sending.catch((error: unknown) => {
        // A MailerError's message holds only the status; any other error's might hold anything.
        const err =
          error instanceof MailerError
            ? { type: error.name, message: error.message, status: error.status }
            : { type: error instanceof Error ? error.name : typeof error };
        logger.error({ purpose: message.purpose, err }, 'passcode email not sent');
      });
      return Promise.resolve();
    },
  };
}
