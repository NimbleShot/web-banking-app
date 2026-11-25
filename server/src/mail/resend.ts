// Emails passcodes through Resend's HTTP API (DP-1, docs/decisions/0017): one POST per email,
// tried twice more when the API is busy or failing. HTTP, not SMTP, because the host blocks
// outbound SMTP ports.
import { setTimeout as sleep } from 'node:timers/promises';
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

/**
 * A send the API refused as busy (429) or failed (5xx, no answer) is tried again, up to twice:
 * 1 s and then 2 s later, or after the API's Retry-After, at most 10 s. A repeat whose first try
 * did get through sends the same code twice, which is harmless. Any other refusal (a 4xx: a bad
 * key or sender) would fail the same way again, so it is not retried.
 */
const RETRIES = 2;
const MAX_RETRY_WAIT_MS = 10_000;

const retriable = (error: MailerError) =>
  error.status === undefined || error.status === 429 || error.status >= 500;

/** The wait before retry `n` (1-based): Retry-After in seconds when the API gives one. */
function retryWait(n: number, retryAfter: string | null): number {
  const seconds = retryAfter === null ? Number.NaN : Number(retryAfter);
  const asked = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : n * 1000;
  return Math.min(asked, MAX_RETRY_WAIT_MS);
}

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
    /** Waits between tries; tests pass a fake, so they never wait on the clock. */
    private readonly wait: (ms: number) => Promise<unknown> = sleep,
  ) {}

  async sendPasscode(message: PasscodeMessage): Promise<void> {
    const { subject, text } = passcodeEmail(message);
    const body = JSON.stringify({ from: this.settings.from, to: message.to, subject, text });
    for (let retry = 1; ; retry += 1) {
      const { error, retryAfter } = await this.tryOnce(body);
      if (!error) return;
      if (retry > RETRIES || !retriable(error)) throw error;
      await this.wait(retryWait(retry, retryAfter));
    }
  }

  /** One POST: no error, or the MailerError and the answer's Retry-After. */
  private async tryOnce(body: string): Promise<{ error?: MailerError; retryAfter: string | null }> {
    let response: Response;
    try {
      response = await this.post(`${this.settings.apiUrl}/emails`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.settings.apiKey}`,
          'Content-Type': 'application/json',
        },
        body,
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
    } catch (error) {
      const failure = new MailerError(undefined, `could not be reached (${failureKind(error)})`);
      return { error: failure, retryAfter: null };
    }
    // The answer's body is never read: it could echo the request. Dropping it frees the connection,
    // and a body that fails mid-stream changes nothing about a status that has already arrived.
    void response.body?.cancel().catch(() => undefined);
    if (response.ok) return { retryAfter: null };
    return {
      error: new MailerError(response.status, `answered ${response.status}`),
      retryAfter: response.headers.get('retry-after'),
    };
  }
}
