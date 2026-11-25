// DP-3: outside production the server accepts connections from its own machine only.
// DP-5 (its local half): each request's log line names the client the rate limits count.
import { describe, expect, it } from '@jest/globals';
import request from 'supertest';
import { createLogger } from '../src/logger';
import { buildTestHarness, TEST_SECRETS } from './support/app';
import { startServer } from './support/run-server';

describe('DP-3 outside production the server accepts connections from its own machine only', () => {
  it.each(['development', 'test'])(
    '[DP-3] a %s server listens on 127.0.0.1 only',
    async (nodeEnv) => {
      const server = await startServer({ ...TEST_SECRETS, NODE_ENV: nodeEnv });
      try {
        expect(server.listening).toMatchObject({ address: '127.0.0.1', nodeEnv });
        const answer = await fetch(`http://127.0.0.1:${server.listening.port}/api/v1/me`);
        expect(answer.status).toBe(401);
      } finally {
        await server.stop();
      }
    },
    30000,
  );
});

describe('DP-5 the client the rate limits count is in the request log', () => {
  it("[DP-5] each request's log line names the client the limits count: the socket's address, or with TRUST_PROXY=1 the last X-Forwarded-For hop, never an earlier, forgeable one", async () => {
    const clientIpOf = async (trustProxy: number) => {
      const lines: string[] = [];
      const logger = createLogger('info', { write: (line: string) => void lines.push(line) });
      const h = buildTestHarness({ logger, config: { trustProxy } });
      await request(h.app).get('/api/v1/me').set('X-Forwarded-For', '198.51.100.9, 203.0.113.7');
      const line = lines
        .map((text) => JSON.parse(text) as { msg: string; clientIp?: string })
        .find((entry) => entry.msg === 'request completed');
      return line?.clientIp;
    };

    expect(await clientIpOf(0)).toMatch(/^(::ffff:)?127\.0\.0\.1$/);
    expect(await clientIpOf(1)).toBe('203.0.113.7');
  });
});
