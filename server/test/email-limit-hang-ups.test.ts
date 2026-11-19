// SEC-6: a client that hangs up before the answer still counts against the email limit. Once a
// handler waits on the database or the email API, a hang-up given back would let one client send
// passcodes to any number of addresses. The give-back of the limiter's own 429 is SEC-2.c's
// ("hammering while limited does not extend the wait").
import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from '@jest/globals';
import request from 'supertest';
import { createApp } from '../src/app';
import { EMAIL_REQUEST_LIMIT } from '../src/http/rate-limits';
import type { Mailer } from '../src/mail/mailer';
import { buildTestHarness } from './support/app';
import { SIGN_UP, validSignUp } from './support/sign-up';

/**
 * A mailer whose sends wait until `releaseAll`, which also ends the holding: later sends finish at
 * once. `called` resolves at the next send.
 */
function heldMailer() {
  const waiting: (() => void)[] = [];
  let holding = true;
  let onCall: (() => void) | undefined;
  const mailer: Mailer & { called(): Promise<void>; releaseAll(): void } = {
    sendPasscode: () =>
      new Promise<void>((resolve) => {
        if (holding) waiting.push(resolve);
        else resolve();
        onCall?.();
      }),
    called: () => new Promise<void>((resolve) => (onCall = resolve)),
    releaseAll: () => {
      holding = false;
      waiting.splice(0).forEach((release) => release());
    },
  };
  return mailer;
}

describe('SEC-6 a client that hangs up before the answer still counts against the email limit', () => {
  it('[SEC-6] 20 sign-ups abandoned while their passcodes are being sent count: the 21st request is 429', async () => {
    const mailer = heldMailer();
    const app = createApp({ ...buildTestHarness().deps, mailer });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    try {
      for (let i = 0; i < EMAIL_REQUEST_LIMIT; i += 1) {
        const body = JSON.stringify({ ...validSignUp, email: `user${i}@example.com` });
        const sending = mailer.called();
        // The server side of the request, closed once the client hangs up.
        const closed = once(server, 'request').then(([, res]) =>
          once(res as http.ServerResponse, 'close'),
        );
        const req = http.request({
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: SIGN_UP,
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
          },
        });
        req.on('error', () => undefined); // the hang-up itself
        req.end(body);
        await sending;
        req.destroy();
        await closed;
      }
      mailer.releaseAll();

      const res = await request(server)
        .post(SIGN_UP)
        .send({ ...validSignUp, email: 'one-more@example.com' });

      expect(res.status).toBe(429);
    } finally {
      mailer.releaseAll();
      server.close();
    }
  });
});
