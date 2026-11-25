// Emails passcodes through Resend's HTTP API (DP-1, docs/decisions/0017): one POST per email.
// HTTP, not SMTP, because the host blocks outbound SMTP ports.
import { PASSCODE_RULES, type PasscodePurpose } from '../services/passcodes';
import type { Mailer, PasscodeMessage } from './mailer';

export type ResendSettings = {
  apiKey: string;
  /** The sender, `Bank <codes@mail.example.com>`, on a domain verified in Resend. */
  from: string;
  /** The API's origin, `https://api.resend.com` unless a test points it elsewhere. */
  apiUrl: string;
};

/**
 * A send that failed. Its message names only the HTTP status, or the kind of network failure,
 * never the key, the recipient or the passcode: unexpected errors are logged with their message.
 */
export class MailerError extends Error {
  constructor(
    readonly status: number | undefined,
    detail: string,
  ) {
    super(`the email API ${detail}`);
    this.name = 'MailerError';
  }
}

/** How long a send may take; it runs after the answer (DP-2), so it never holds a request. */
const SEND_TIMEOUT_MS = 10_000;

const MINUTES = PASSCODE_RULES.validForMs / 60_000;

const CONTENT: Record<PasscodePurpose, { subject: string; lead: string; otherwise: string }> = {
  signup: {
    subject: 'Your Parsec Bank sign-up code',
    lead: 'Your sign-up code is',
    otherwise: "If you didn't sign up for Parsec Bank, you can ignore this email.",
  },
  reset: {
    subject: 'Your Parsec Bank password reset code',
    lead: 'Your password reset code is',
    otherwise: "If you didn't ask to reset your password, ignore this email: it hasn't changed.",
  },
};

/** The email for a passcode: the code and its expiry in the text, never in the subject. */
export function passcodeEmail({ purpose, passcode }: PasscodeMessage) {
  const content = CONTENT[purpose];
  return {
    subject: content.subject,
    text: `${content.lead} ${passcode}. It expires in ${MINUTES} minutes.\n\n${content.otherwise}\n`,
  };
}

/** The failure's kind (`ECONNREFUSED`, `TimeoutError`), without its message or address. */
function failureKind(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown failure';
  const cause = error.cause as { code?: unknown } | undefined;
  return typeof cause?.code === 'string' ? cause.code : error.name;
}

export class ResendMailer implements Mailer {
  constructor(
    private readonly settings: ResendSettings,
    /** The HTTP client; tests pass a fake, so they never reach the network. */
    private readonly post: typeof fetch = fetch,
  ) {}

  async sendPasscode(message: PasscodeMessage): Promise<void> {
    const { subject, text } = passcodeEmail(message);
    let response: Response;
    try {
      response = await this.post(`${this.settings.apiUrl}/emails`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.settings.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ from: this.settings.from, to: message.to, subject, text }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
    } catch (error) {
      throw new MailerError(undefined, `could not be reached (${failureKind(error)})`);
    }
    // The answer's body is never read into an error: it could echo the request.
    await response.body?.cancel();
    if (!response.ok) throw new MailerError(response.status, `answered ${response.status}`);
  }
}
