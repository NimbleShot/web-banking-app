import { describe, expect, it } from '@jest/globals';
import { Router } from 'express';
import request, { type Response } from 'supertest';
import { ConfigError, loadConfig } from '../src/config';
import { buildTestApp, TEST_SECRETS } from './support/app';

const FRONT_END = 'https://bank.example.com';
const validSignUp = {
  email: 'dana@example.com',
  password: 'correct horse',
  phone: '+972501234567',
};

/** An operation that succeeds, behind the real pipeline. */
const acceptingSignUp = () =>
  Router().post('/api/v1/auth/signup', (req, res) => {
    res.status(202).json({ email: req.body.email, status: 'pending' });
  });

/** An operation whose handler fails, so the error handler answers 500. */
const failingSignUp = () =>
  Router().post('/api/v1/auth/signup', () => {
    throw new Error('boom');
  });

/** The development default for CORS_ORIGIN (the Vite dev server). */
const DEV_DEFAULT = 'http://localhost:5173';

/**
 * A valid environment for loadConfig; each test adds or overrides what it is about. Variables
 * every environment must set go here.
 */
const BASE_ENV: NodeJS.ProcessEnv = { ...TEST_SECRETS };
const env = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  ...BASE_ENV,
  ...overrides,
});

const appFor = (corsOrigin: string, routes = acceptingSignUp()) =>
  buildTestApp({ routes, config: { corsOrigin } });

/** A header that lists names or methods, split and lower-cased: `"Authorization, content-type"`. */
const listed = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

const preflight = (origin: string, path: string, method: string, headers: string) =>
  request(appFor(FRONT_END))
    .options(path)
    .set('Origin', origin)
    .set('Access-Control-Request-Method', method)
    .set('Access-Control-Request-Headers', headers);

describe('SEC-3 CORS allows only the front-end origin; security headers are set', () => {
  describe('the configured front-end origin', () => {
    it('[SEC-3.a] a successful answer to the front-end origin carries Access-Control-Allow-Origin with that origin', async () => {
      const res = await request(appFor(FRONT_END))
        .post('/api/v1/auth/signup')
        .set('Origin', FRONT_END)
        .send(validSignUp);

      expect(res.status).toBe(202);
      expect(res.headers['access-control-allow-origin']).toBe(FRONT_END);
    });

    it('[SEC-3.a] error answers to the front-end origin carry it too, so the page can read them', async () => {
      const app = appFor(FRONT_END);

      const invalid = await request(app)
        .post('/api/v1/auth/signup')
        .set('Origin', FRONT_END)
        .send({ ...validSignUp, email: 'not-an-email' });
      expect(invalid.status).toBe(400);
      expect(invalid.headers['access-control-allow-origin']).toBe(FRONT_END);

      const unauthenticated = await request(app).get('/api/v1/me').set('Origin', FRONT_END);
      expect(unauthenticated.status).toBe(401);
      expect(unauthenticated.headers['access-control-allow-origin']).toBe(FRONT_END);

      const unknown = await request(app).get('/api/v1/nowhere').set('Origin', FRONT_END);
      expect(unknown.status).toBe(404);
      expect(unknown.headers['access-control-allow-origin']).toBe(FRONT_END);
    });

    it.each([
      ['POST', '/api/v1/transfers'],
      ['GET', '/api/v1/me'],
      ['POST', '/api/v1/auth/signup'],
    ])(
      '[SEC-3.a] a preflight for %s %s allows the Authorization and Content-Type headers',
      async (method, path) => {
        const res = await preflight(FRONT_END, path, method, 'authorization, content-type');

        expect(res.status).toBeGreaterThanOrEqual(200);
        expect(res.status).toBeLessThan(300);
        expect(res.headers['access-control-allow-origin']).toBe(FRONT_END);
        expect(listed(res.headers['access-control-allow-headers'])).toEqual(
          expect.arrayContaining(['authorization', 'content-type']),
        );
        expect(listed(res.headers['access-control-allow-methods'])).toContain(method.toLowerCase());
      },
    );

    it('[SEC-3.a] answers to the front-end origin let the page read Retry-After', async () => {
      const res = await request(appFor(FRONT_END))
        .post('/api/v1/auth/signup')
        .set('Origin', FRONT_END)
        .send(validSignUp);

      expect(listed(res.headers['access-control-expose-headers'])).toContain('retry-after');
    });

    it('[SEC-3.a] the allowed origin is the one configured, not a fixed one', async () => {
      const other = 'http://localhost:4173';
      const res = await request(appFor(other))
        .post('/api/v1/auth/signup')
        .set('Origin', other)
        .send(validSignUp);

      expect(res.headers['access-control-allow-origin']).toBe(other);
    });
  });

  describe('any other origin', () => {
    const OTHER_ORIGINS = [
      'https://evil.example',
      'http://bank.example.com', // same host, other scheme
      'https://bank.example.com:8443', // same host, other port
      'https://bank.example.com.evil.example', // starts with the front end's origin
      'https://evil.example?https://bank.example.com', // contains it
      'null', // a sandboxed frame or a file: page
      DEV_DEFAULT, // the development default is not allowed once another origin is configured
    ];

    it.each(OTHER_ORIGINS)(
      '[SEC-3.b] an answer to origin %s carries no Access-Control-Allow-Origin',
      async (origin) => {
        const res = await request(appFor(FRONT_END))
          .post('/api/v1/auth/signup')
          .set('Origin', origin)
          .send(validSignUp);

        expect(res.status).toBe(202);
        expect(res.headers).not.toHaveProperty('access-control-allow-origin');
      },
    );

    it.each(OTHER_ORIGINS)(
      '[SEC-3.b] a preflight from origin %s is not allowed: 404 NOT_FOUND, no CORS headers',
      async (origin) => {
        const res = await preflight(
          origin,
          '/api/v1/transfers',
          'POST',
          'authorization, content-type',
        );

        expect(res.status).toBe(404);
        expect(res.body.code).toBe('NOT_FOUND');
        expect(res.headers).not.toHaveProperty('access-control-allow-origin');
        expect(res.headers).not.toHaveProperty('access-control-allow-methods');
        expect(res.headers).not.toHaveProperty('access-control-allow-headers');
      },
    );

    it('[SEC-3.b] an error answer to another origin carries no Access-Control-Allow-Origin', async () => {
      const res = await request(appFor(FRONT_END))
        .get('/api/v1/nowhere')
        .set('Origin', 'https://evil.example');

      expect(res.status).toBe(404);
      expect(res.headers).not.toHaveProperty('access-control-allow-origin');
    });

    it('[SEC-3.b] a 500 answer to another origin carries no Access-Control-Allow-Origin', async () => {
      const res = await request(appFor(FRONT_END, failingSignUp()))
        .post('/api/v1/auth/signup')
        .set('Origin', 'https://evil.example')
        .send(validSignUp);

      expect(res.status).toBe(500);
      expect(res.headers).not.toHaveProperty('access-control-allow-origin');
    });
  });

  describe('security headers', () => {
    const expectHelmetHeaders = (res: Response) => {
      expect(res.headers['content-security-policy']).toMatch(/default-src 'self'/);
      expect(res.headers['strict-transport-security']).toMatch(/max-age=[1-9]\d*/);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
      expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
      expect(res.headers).not.toHaveProperty('x-powered-by');
    };

    // `status` is the expected status, or 'ok' for any 2xx (a preflight's status is the library's).
    it.each<[string, () => request.Test, number | 'ok']>([
      [
        'a successful answer',
        () => request(appFor(FRONT_END)).post('/api/v1/auth/signup').send(validSignUp),
        202,
      ],
      [
        'a 400 for an invalid request',
        () => request(appFor(FRONT_END)).post('/api/v1/auth/signup').send({}),
        400,
      ],
      ['a 401 for a missing token', () => request(appFor(FRONT_END)).get('/api/v1/me'), 401],
      ['a 404 for an unknown path', () => request(appFor(FRONT_END)).get('/api/v1/nowhere'), 404],
      ['a 404 for an unknown method', () => request(appFor(FRONT_END)).delete('/api/v1/me'), 404],
      [
        'a 500 from a failing handler',
        () =>
          request(appFor(FRONT_END, failingSignUp())).post('/api/v1/auth/signup').send(validSignUp),
        500,
      ],
      [
        'a preflight answer',
        () => preflight(FRONT_END, '/api/v1/transfers', 'POST', 'authorization, content-type'),
        'ok',
      ],
      [
        'a refused preflight from another origin',
        () => preflight('https://evil.example', '/api/v1/transfers', 'POST', 'authorization'),
        404,
      ],
      [
        'an answer to another origin',
        () =>
          request(appFor(FRONT_END)).get('/api/v1/nowhere').set('Origin', 'https://evil.example'),
        404,
      ],
    ])('[SEC-3.c] %s carries helmet headers and no X-Powered-By', async (_name, send, status) => {
      const res = await send();

      if (status === 'ok') {
        expect(res.status).toBeGreaterThanOrEqual(200);
        expect(res.status).toBeLessThan(300);
      } else {
        expect(res.status).toBe(status);
      }
      expectHelmetHeaders(res);
    });
  });

  describe('SEC-3 start-up guard: CORS_ORIGIN', () => {
    it('[SEC-3.a] CORS_ORIGIN sets the front-end origin', () => {
      const config = loadConfig(env({ CORS_ORIGIN: FRONT_END, NODE_ENV: 'production' }));

      expect(config.corsOrigin).toBe(FRONT_END);
    });

    it('[SEC-3.a] a blank CORS_ORIGIN counts as unset', () => {
      const config = loadConfig(env({ CORS_ORIGIN: '  ', NODE_ENV: 'development' }));

      expect(config.corsOrigin).toBe(DEV_DEFAULT);
    });

    it('[SEC-3.a] without CORS_ORIGIN, development allows the Vite dev server', () => {
      expect(loadConfig(env({ NODE_ENV: 'development' })).corsOrigin).toBe(DEV_DEFAULT);
      expect(loadConfig(env()).corsOrigin).toBe(DEV_DEFAULT);
    });

    it('[SEC-3.b] production refuses to start without CORS_ORIGIN', () => {
      const unset = () => loadConfig(env({ NODE_ENV: 'production' }));
      expect(unset).toThrow(ConfigError);
      expect(unset).toThrow(/CORS_ORIGIN/);
      expect(() => loadConfig(env({ NODE_ENV: 'production', CORS_ORIGIN: ' ' }))).toThrow(
        /CORS_ORIGIN/,
      );
    });

    it.each([
      ['https://Bank.example.com', 'https://bank.example.com'],
      ['https://bank.example.com:443', 'https://bank.example.com'],
      ['https://bank.example.com/', 'https://bank.example.com'],
    ])('[SEC-3.b] a CORS_ORIGIN of %p is refused, naming the origin it meant', (value, meant) => {
      expect(() => loadConfig(env({ CORS_ORIGIN: value }))).toThrow(
        `CORS_ORIGIN must be exactly an origin such as https://bank.example.com (got "${value}"; did you mean "${meant}"?)`,
      );
    });

    it.each([
      'https://bank.example.com/', // a trailing slash never matches a browser's Origin
      'https://bank.example.com/app',
      'bank.example.com',
      '*',
      'https://a.example,https://b.example',
      'ftp://bank.example.com',
    ])('[SEC-3.b] a CORS_ORIGIN of %p is refused at start-up', (value) => {
      expect(() => loadConfig(env({ CORS_ORIGIN: value }))).toThrow(/CORS_ORIGIN/);
    });
  });
});
