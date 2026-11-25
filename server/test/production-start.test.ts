// DP-1 and DP-3 together: the real entry point in production, on MongoDB, with Resend's mailer
// pointed at a fake email API on this machine. Nothing leaves the machine.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { TEST_SECRETS } from './support/app';
import { startServer } from './support/run-server';
import { SIGN_UP, validSignUp } from './support/sign-up';

type Received = { method?: string; url?: string; authorization?: string; body: string };

let replSet: MongoMemoryReplSet;
let fakeApi: http.Server;
const received: Received[] = [];

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  fakeApi = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8').on('data', (chunk: string) => (body += chunk));
    req.on('end', () => {
      const { method, url } = req;
      received.push({ method, url, authorization: req.headers.authorization, body });
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"id":"email-id"}');
    });
  });
  await new Promise<void>((done) => fakeApi.listen(0, '127.0.0.1', done));
}, 180_000);

afterAll(async () => {
  await new Promise((done) => fakeApi?.close(done));
  await replSet?.stop();
});

describe('DP-1 production starts with the HTTP email API', () => {
  it('[DP-1] with MAILER=resend the server starts in production, listens on every interface (DP-3), answers a sign-up at once and then emails the code through the API', async () => {
    const { port: apiPort } = fakeApi.address() as AddressInfo;
    const server = await startServer({
      ...TEST_SECRETS,
      NODE_ENV: 'production',
      CORS_ORIGIN: 'https://bank.example.com',
      MONGODB_URI: replSet.getUri('production-start'),
      MAILER: 'resend',
      RESEND_API_KEY: 're_test_only_key_0123456789',
      MAIL_FROM: 'Bank <codes@mail.example.com>',
      RESEND_API_URL: `http://127.0.0.1:${apiPort}`,
    });
    try {
      expect(server.listening).toMatchObject({
        address: '0.0.0.0',
        nodeEnv: 'production',
        storage: 'mongodb',
      });
      const base = `http://127.0.0.1:${server.listening.port}`;

      const signedUp = await fetch(`${base}${SIGN_UP}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(validSignUp),
      });
      for (let waited = 0; received.length === 0 && waited < 5000; waited += 50) await sleep(50);

      expect(signedUp.status).toBe(202);
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        method: 'POST',
        url: '/emails',
        authorization: 'Bearer re_test_only_key_0123456789',
      });
      const email = JSON.parse(received[0]?.body ?? '{}') as Record<string, string>;
      expect(email).toMatchObject({ from: 'Bank <codes@mail.example.com>', to: validSignUp.email });
      expect(email.text).toMatch(/Your sign-up code is \d{6}\./);
      // Production has no test outbox.
      expect((await fetch(`${base}/__test/outbox?email=${validSignUp.email}`)).status).toBe(404);
    } finally {
      await server.stop();
    }
  }, 60_000);
});
