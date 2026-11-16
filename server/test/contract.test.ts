import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from '@jest/globals';
import { Router } from 'express';
import request from 'supertest';
import { contractMiddleware } from '../src/http/contract';
import { fieldOf } from '../src/http/errors';
import { assertNoResponseViolations, buildTestApp, takeResponseViolations } from './support/app';

const PROBLEM_JSON = /^application\/problem\+json/;
const BEARER = { Authorization: 'Bearer any-token' };
const validSignUp = {
  email: 'dana@example.com',
  password: 'correct horse',
  phone: '+972501234567',
};

const fieldsOf = (body: { errors?: { field: string }[] }) =>
  (body.errors ?? []).map((error) => error.field).sort();

describe('CT-4 the server enforces the contract at run time', () => {
  describe('requests that break the contract', () => {
    it('[CT-4.a] an invalid request answers 400 VALIDATION_FAILED as problem+json, one entry per field', async () => {
      const res = await request(buildTestApp())
        .post('/api/v1/auth/signup')
        .send({ email: 'not-an-email', password: 'short', phone: '0501234567', nickname: 'dana' });

      expect(res.status).toBe(400);
      expect(res.headers['content-type']).toMatch(PROBLEM_JSON);
      expect(res.body).toMatchObject({
        type: 'about:blank',
        status: 400,
        code: 'VALIDATION_FAILED',
      });
      expect(fieldsOf(res.body)).toEqual(['email', 'nickname', 'password', 'phone']);
    });

    it('[CT-4.a] a missing field is named', async () => {
      const res = await request(buildTestApp()).post('/api/v1/auth/signup').send({});

      expect(res.status).toBe(400);
      expect(fieldsOf(res.body)).toEqual(['email', 'password', 'phone']);
    });

    it('[CT-4.a] a field that breaks two rules gets one entry', async () => {
      const res = await request(buildTestApp())
        .post('/api/v1/auth/signup')
        .send({ ...validSignUp, email: 'x' });

      expect(res.status).toBe(400);
      expect(fieldsOf(res.body)).toEqual(['email']);
    });

    it.each([12.5, '100', 0])(
      '[CT-4.a] a transfer amount of %p names the field amount',
      async (amount) => {
        const res = await request(buildTestApp())
          .post('/api/v1/transfers')
          .set(BEARER)
          .send({ toEmail: 'noa@example.com', amount });

        expect(res.status).toBe(400);
        expect(res.body.code).toBe('VALIDATION_FAILED');
        expect(fieldsOf(res.body)).toEqual(['amount']);
      },
    );

    it('[CT-4.a] a query parameter out of range is named', async () => {
      const res = await request(buildTestApp()).get('/api/v1/transactions?limit=51').set(BEARER);

      expect(res.status).toBe(400);
      expect(fieldsOf(res.body)).toEqual(['limit']);
    });

    it('[CT-4.a] getMe answers a request that breaks the contract with its documented 400', async () => {
      const app = buildTestApp();

      const unknownParameter = await request(app).get('/api/v1/me?_=123').set(BEARER);
      expect(unknownParameter.status).toBe(400);
      expect(unknownParameter.body.code).toBe('VALIDATION_FAILED');
      expect(fieldsOf(unknownParameter.body)).toEqual(['_']);

      const brokenBody = await request(app)
        .get('/api/v1/me')
        .set(BEARER)
        .set('Content-Type', 'application/json')
        .send('{"a":');
      expect(brokenBody.status).toBe(400);
      expect(fieldsOf(brokenBody.body)).toEqual(['body']);
    });

    it('[CT-4.a] malformed JSON names the body', async () => {
      const res = await request(buildTestApp())
        .post('/api/v1/auth/signup')
        .set('Content-Type', 'application/json')
        .send('{"email": ');

      expect(res.status).toBe(400);
      expect(res.headers['content-type']).toMatch(PROBLEM_JSON);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect(fieldsOf(res.body)).toEqual(['body']);
    });

    it('[CT-4.a] a body that is not JSON names the body', async () => {
      const res = await request(buildTestApp())
        .post('/api/v1/auth/signup')
        .set('Content-Type', 'text/plain')
        .send('email=dana@example.com');

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect(fieldsOf(res.body)).toEqual(['body']);
    });

    it("[CT-4.a] the operation's handler does not run for an invalid request", async () => {
      let calls = 0;
      const routes = Router().post('/api/v1/auth/signup', (req, res) => {
        calls += 1;
        res.status(202).json({ email: req.body.email, status: 'pending' });
      });
      const app = buildTestApp(routes);

      const invalid = await request(app)
        .post('/api/v1/auth/signup')
        .send({ ...validSignUp, phone: 'call me' });
      expect(invalid.status).toBe(400);
      expect(calls).toBe(0);

      const valid = await request(app).post('/api/v1/auth/signup').send(validSignUp);
      expect(valid.status).toBe(202);
      expect(calls).toBe(1);
    });

    it.each([
      ['/body/email', 'email'],
      ['/body/nickname', 'nickname'],
      ['/query/limit', 'limit'],
      ['.query.limit', 'limit'],
      ['/body', 'body'],
      ['/api/v1/me', 'request'],
      ['', 'request'],
    ])("[CT-4.a] the validator's error path %p names the field %p", (path, field) => {
      expect(fieldOf(path)).toBe(field);
    });
  });

  describe('paths and methods the contract does not describe', () => {
    it.each([
      ['GET', '/api/v1/accounts'],
      ['POST', '/api/v1/auth/logout'],
      ['GET', '/'],
    ])('[CT-4.b] %s %s answers 404 NOT_FOUND', async (method, path) => {
      const res = await request(buildTestApp())[method === 'GET' ? 'get' : 'post'](path);

      expect(res.status).toBe(404);
      expect(res.headers['content-type']).toMatch(PROBLEM_JSON);
      expect(res.body).toEqual({
        type: 'about:blank',
        title: 'Not found',
        status: 404,
        code: 'NOT_FOUND',
      });
    });

    it.each([
      ['DELETE', '/api/v1/me'],
      ['GET', '/api/v1/auth/signup'],
      ['PUT', '/api/v1/transfers'],
    ])(
      '[CT-4.b] %s on %s, a method the path does not have, answers 404 NOT_FOUND',
      async (method, path) => {
        const app = buildTestApp();
        const req =
          method === 'DELETE'
            ? request(app).delete(path)
            : method === 'PUT'
              ? request(app).put(path)
              : request(app).get(path);
        const res = await req.set(BEARER);

        expect(res.status).toBe(404);
        expect(res.headers['content-type']).toMatch(PROBLEM_JSON);
        expect(res.body.code).toBe('NOT_FOUND');
      },
    );

    it.each<[string, string, Record<string, string>]>([
      ['/', 'no Origin', {}],
      ['/api/v1/nowhere', 'no Origin', {}],
      ['/api/v1/me', 'no Origin', {}],
      [
        '/api/v1/transfers',
        'the front-end Origin but no Access-Control-Request-Method',
        {
          Origin: 'http://localhost:5173',
        },
      ],
    ])(
      '[CT-4.b] OPTIONS %s with %s is not a preflight and answers 404 NOT_FOUND',
      async (path, _what, headers) => {
        const res = await request(buildTestApp()).options(path).set(headers);

        expect(res.status).toBe(404);
        expect(res.headers['content-type']).toMatch(PROBLEM_JSON);
        expect(res.body.code).toBe('NOT_FOUND');
        expect(res.headers).not.toHaveProperty('access-control-allow-origin');
      },
    );
  });

  describe('responses in the test suite', () => {
    const wrongMe = Router().get('/api/v1/me', (_req, res) => {
      res.json({ id: 'u1', email: 'dana@example.com', phone: '+972501234567', balance: 'lots' });
    });

    it('[CT-4.c] a response with a missing or mistyped field is reported', async () => {
      await request(buildTestApp(wrongMe)).get('/api/v1/me').set(BEARER);

      const [violation, ...more] = takeResponseViolations();
      expect(more).toHaveLength(0);
      expect(violation).toMatchObject({ method: 'GET', path: '/api/v1/me', status: 200 });
      const messages = violation?.errors.map((e) => `${e.path} ${e.message}`).join('\n');
      expect(messages).toMatch(/balance/);
      expect(messages).toMatch(/createdAt/);
    });

    it("[CT-4.c] a status the operation doesn't document is reported", async () => {
      const teapot = Router().get('/api/v1/me', (_req, res) => {
        res.status(418).json({ short: 'and stout' });
      });
      await request(buildTestApp(teapot)).get('/api/v1/me').set(BEARER);

      const violations = takeResponseViolations();
      expect(violations).toHaveLength(1);
      expect(violations[0]?.errors[0]?.message).toMatch(/no schema defined for status code '418'/);
    });

    it('[CT-4.c] a response not sent as JSON, which the check cannot see, is reported', async () => {
      const plain = Router().get('/api/v1/me', (_req, res) => {
        res.status(200).send('ok');
      });
      await request(buildTestApp(plain)).get('/api/v1/me').set(BEARER);

      const violations = takeResponseViolations();
      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({ method: 'GET', path: '/api/v1/me', status: 200 });
      expect(violations[0]?.errors[0]?.message).toMatch(/not sent with res\.json/);
    });

    it('[CT-4.c] a reported violation fails the test that caused it', async () => {
      await request(buildTestApp(wrongMe)).get('/api/v1/me').set(BEARER);

      expect(assertNoResponseViolations).toThrow(
        /broke api\/openapi\.yaml[\s\S]*GET \/api\/v1\/me -> 200/,
      );
    });

    it('[CT-4.c] error answers are checked too: the response check starts before body parsing and request validation', () => {
      const names = contractMiddleware({ onResponseViolation: () => {} }).map((fn) => fn.name);

      expect(names).toEqual([
        'pathParamsMiddleware',
        'metadataMiddleware',
        'responseMiddleware',
        'jsonOnlyGuard',
        'securityMiddleware',
        'jsonParser',
        'requestMiddleware',
      ]);
    });
  });

  describe('the check gate', () => {
    it('[CT-4.d] npm run check runs the server tests and the diagram-vs-contract check, locally and in CI', () => {
      const root = resolve(__dirname, '../..');
      const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
      const ci = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8');

      const steps = String(pkg.scripts.check)
        .split('&&')
        .map((step) => step.trim());
      expect(steps).toEqual(expect.arrayContaining(['npm test', 'npm run lint:diagrams']));
      expect(pkg.scripts['lint:diagrams']).toBe('node scripts/check-diagrams.mjs --no-render');
      expect(pkg.scripts.test).toBe('npm test -w server');
      expect(ci).toMatch(/run: npm run check\b/);
    });
  });
});
