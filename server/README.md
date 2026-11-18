# server

The Express 5 API that implements [`api/openapi.yaml`](../api/openapi.yaml). TypeScript, compiled
to CommonJS, tested with Jest and Supertest.

## Run it

```sh
npm ci                        # from the repository root
cp server/.env.example server/.env
# set JWT_SECRET and PASSCODE_SECRET in server/.env, each to the output of:
node -p "require('node:crypto').randomBytes(32).toString('base64')"
npm run dev -w server         # http://localhost:3000, restarts on change
```

## Configuration

Read once from environment variables at start-up; the server refuses to start with an invalid
value and lists every problem. [`.env.example`](.env.example) lists them all.

| Variable | Default | Meaning |
|----------|---------|---------|
| `PORT` | `3000` | Port to listen on |
| `NODE_ENV` | `development` | `development`, `test` or `production` |
| `LOG_LEVEL` | `info` | pino level, or `silent` |
| `CORS_ORIGIN` | `http://localhost:5173`; required in production | The front end's origin, the only one a browser may call the API from: `http(s)://host[:port]`, no path or trailing slash |
| `TRUST_PROXY` | `0` (no proxy) | How many proxies sit in front of the server, a whole number; the rate limits tell clients apart by `X-Forwarded-For` only when it is 1 or more |
| `JWT_SECRET` | none; required | Signs the access tokens; at least 32 bytes |
| `PASSCODE_SECRET` | none; required | Keys the hashes of the emailed passcodes; at least 32 bytes |

A start-up error names a missing or short secret but never shows its value, and a log line
shows the configuration's secrets as `[Redacted]`. Generate each secret with the command under
[Run it](#run-it), separately for each variable and each environment.

## How a request flows

`src/app.ts` builds the app from its dependencies (`createApp(deps)`); only `src/server.ts` opens a
port, so tests call the app directly.

1. A pino request log line (credentials redacted).
2. Security headers (helmet) on every answer, errors included, and CORS: only `CORS_ORIGIN` gets
   `Access-Control-Allow-Origin`, and preflight (`OPTIONS`) requests are answered here.
3. The contract ([`src/http/contract.ts`](src/http/contract.ts)): the operation is looked up (an
   unknown path or method answers `404 NOT_FOUND`), the bearer header is required where the
   contract asks for it, the JSON body is parsed, and the path, query and body are validated. Any
   mismatch answers `400 VALIDATION_FAILED` with one `errors` entry per field, before a handler
   runs.
4. The operation's route. Six routes first pass a per-client-address rate limit
   ([`src/http/rate-limits.ts`](src/http/rate-limits.ts), SEC-2): login, verifyOtp and resetPassword
   share one limit of 10 failed attempts per 15 minutes; signUp, resendOtp and requestPasswordReset
   share one of 20 requests per hour. Both are sliding windows on the server's clock. Over a limit the answer is `429 RATE_LIMITED` with `Retry-After`.
5. [`src/http/errors.ts`](src/http/errors.ts) turns every error into an
   `application/problem+json` answer whose `code` comes from the contract's `ErrorCode` catalogue.
   An unexpected error answers `500 INTERNAL_ERROR` with no message or stack trace; the error is
   logged on the server.

## Tests

```sh
npm test                      # from the root: every server test
npm test -w server -- -t "CT-4"   # the tests of one requirement
```

Test titles start with the requirement criterion they prove, e.g. `[CT-4.a] …`. Every test builds
a fresh app (`test/support/app.ts`). In tests, every answer to a contract operation is also
validated against the contract: a response that breaks it, or that bypasses the check by not
being sent with `res.json`, fails the test that caused it, even if its assertions pass. The one
exception is a 5xx answer, which the validator never checks; the error handler builds it from
the typed `problem()` helper.

Handlers answer with `res.json` or `sendProblem` only.
