// DP-1: in production, passcodes are emailed through Resend's HTTP API. Every send here goes to a
// fake `fetch`, never the network.
import { describe, expect, it } from '@jest/globals';
import { ConfigError, loadConfig, RESEND_API_URL } from '../src/config';
import { createLogger } from '../src/logger';
import { MailerError, ResendMailer } from '../src/mail/resend';
import { TEST_SECRETS } from './support/app';

const KEY = TEST_SECRETS.RESEND_API_KEY;
const FROM = 'Parsec Bank <codes@mail.example.com>';
const SETTINGS = { apiKey: KEY, from: FROM, apiUrl: RESEND_API_URL };

/** A fake fetch that answers `answer` and keeps every request it was given. */
function fakeFetch(answer: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const post = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return answer();
  }) as typeof fetch;
  return { post, calls };
}

/** MAILER=resend with the server's secrets; each test adds the Resend key when it wants one. */
const env = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  JWT_SECRET: TEST_SECRETS.JWT_SECRET,
  PASSCODE_SECRET: TEST_SECRETS.PASSCODE_SECRET,
  MAILER: 'resend',
  ...overrides,
});

function problemsOf(variables: NodeJS.ProcessEnv): string[] {
  try {
    loadConfig(variables);
    return [];
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
}

describe('DP-1 in production, passcodes are emailed through an HTTP email API', () => {
  it("[DP-1] each passcode is one POST to Resend's /emails with the key, the sender, the recipient, a subject and the code with its expiry", async () => {
    const { post, calls } = fakeFetch(() => Response.json({ id: 'email-id' }));
    const mailer = new ResendMailer(SETTINGS, post);

    await mailer.sendPasscode({ to: 'dana@example.com', purpose: 'signup', passcode: '042137' });
    await mailer.sendPasscode({ to: 'omer@example.com', purpose: 'reset', passcode: '908172' });

    expect(calls.map((call) => [call.url, call.init.method])).toEqual([
      ['https://api.resend.com/emails', 'POST'],
      ['https://api.resend.com/emails', 'POST'],
    ]);
    const sent = calls.map((call) => ({
      headers: call.init.headers,
      body: JSON.parse(String(call.init.body)) as Record<string, string>,
    }));
    for (const { headers } of sent) {
      expect(headers).toEqual({
        Authorization: `Bearer ${KEY}`,
        'Content-Type': 'application/json',
      });
    }
    expect(sent.map(({ body }) => [body.from, body.to])).toEqual([
      [FROM, 'dana@example.com'],
      [FROM, 'omer@example.com'],
    ]);
    const [signUp, reset] = sent.map(({ body }) => body);
    expect(signUp?.subject).toBe('Your Parsec Bank sign-up code');
    expect(signUp?.text).toContain('Your sign-up code is 042137. It expires in 10 minutes.');
    expect(reset?.subject).toBe('Your Parsec Bank password reset code');
    expect(reset?.text).toContain('Your password reset code is 908172. It expires in 10 minutes.');
    // The code stays out of the subject, which a phone shows on a locked screen.
    for (const { body } of sent) expect(body.subject).not.toMatch(/\d{6}/);
  });

  it('[DP-1] MAILER=resend without RESEND_API_KEY or MAIL_FROM, or with a malformed sender or API address, is refused at start-up, naming the variable and never the key', () => {
    expect(problemsOf(env())).toEqual([
      expect.stringContaining('RESEND_API_KEY'),
      expect.stringContaining('MAIL_FROM'),
    ]);
    const secretKey = KEY;
    const refused = [
      env({ RESEND_API_KEY: secretKey, MAIL_FROM: 'codes at example.com' }),
      env({ RESEND_API_KEY: secretKey, MAIL_FROM: FROM, RESEND_API_URL: 'https://a.example/v1' }),
      env({ RESEND_API_KEY: secretKey, MAIL_FROM: FROM, RESEND_API_URL: 'https://a.example//' }),
      env({ RESEND_API_KEY: secretKey, MAIL_FROM: FROM, RESEND_API_URL: 'https://a.example?x' }),
      env({
        RESEND_API_KEY: secretKey,
        MAIL_FROM: FROM,
        RESEND_API_URL: 'http://mail.example.com',
        NODE_ENV: 'production',
        CORS_ORIGIN: 'https://bank.example.com',
      }),
    ];
    const problems = refused.map(problemsOf);
    expect(problems.map((list) => list.length)).toEqual([1, 1, 1, 1, 1]);
    expect(problems[0]?.[0]).toContain('MAIL_FROM');
    for (const list of problems.slice(1, 4)) expect(list[0]).toContain('RESEND_API_URL must be');
    expect(problems[4]?.[0]).toBe('RESEND_API_URL must use https in production');
    for (const list of problems) expect(list.join('\n')).not.toContain(secretKey);

    const config = loadConfig(
      env({ RESEND_API_KEY: secretKey, MAIL_FROM: 'codes@mail.example.com' }),
    );
    expect(config.resend).toEqual({
      apiKey: secretKey,
      from: 'codes@mail.example.com',
      apiUrl: 'https://api.resend.com',
    });
    // A loopback address is the one plain-http API production accepts: a local rehearsal.
    const local = env({
      RESEND_API_KEY: secretKey,
      MAIL_FROM: FROM,
      RESEND_API_URL: 'http://127.0.0.1:4010/',
      NODE_ENV: 'production',
      CORS_ORIGIN: 'https://bank.example.com',
    });
    expect(loadConfig(local).resend?.apiUrl).toBe('http://127.0.0.1:4010');
  });

  it('[DP-1] a failed send names only the HTTP status or the kind of failure, never the key, the recipient or the passcode; log lines redact the key', async () => {
    const message = { to: 'dana@example.com', purpose: 'signup' as const, passcode: '042137' };
    // An answer whose body echoes the request, as an error page might.
    const echoed = `${KEY} ${message.to} ${message.passcode}`;
    const refused = new ResendMailer(
      SETTINGS,
      fakeFetch(() => new Response(echoed, { status: 422 })).post,
    );
    const unreachable = new ResendMailer(
      SETTINGS,
      fakeFetch(() => {
        throw new TypeError('fetch failed', {
          cause: { code: 'ECONNREFUSED', message: `connect ECONNREFUSED ${echoed}` },
        });
      }).post,
    );

    const errors = await Promise.all(
      [refused, unreachable].map((mailer) => mailer.sendPasscode(message).catch((e: unknown) => e)),
    );

    expect(errors.map((error) => (error as Error).message)).toEqual([
      'the email API answered 422',
      'the email API could not be reached (ECONNREFUSED)',
    ]);
    for (const error of errors) {
      expect(error).toBeInstanceOf(MailerError);
      expect((error as Error).cause).toBeUndefined();
      for (const secret of [KEY, message.to, message.passcode]) {
        expect(JSON.stringify(error)).not.toContain(secret);
        expect(String(error)).not.toContain(secret);
      }
    }

    const lines: string[] = [];
    const logger = createLogger('info', { write: (line: string) => void lines.push(line) });
    const config = loadConfig(env({ RESEND_API_KEY: KEY, MAIL_FROM: FROM }));
    logger.info({ config }, 'the configuration');
    expect(lines.join('')).not.toContain(KEY);
    expect(JSON.parse(lines[0] ?? '{}').config.resend.apiKey).toBe('[Redacted]');
  });
});
