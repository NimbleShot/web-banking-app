# server

The Express 5 API that implements [`api/openapi.yaml`](../api/openapi.yaml). TypeScript, compiled
to CommonJS, tested with Jest and Supertest.

## Run it

```sh
npm ci                        # from the repository root
cp server/.env.example server/.env
# set JWT_SECRET and PASSCODE_SECRET in server/.env, each to the output of:
node -p "require('node:crypto').randomBytes(32).toString('base64')"
npm run dev -w server         # http://127.0.0.1:3000, restarts on change
```

Without `MONGODB_URI` the server keeps its data in memory, lost on every restart; the start-up
log line says which storage it uses (`"storage":"memory"` or `"mongodb"`). Production requires a
MongoDB replica set ([ADR-0013](../docs/decisions/0013-mongodb-storage-layout-and-atomic-steps.md)).

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
| `MAILER` | `outbox` | How passcodes are sent: `outbox` keeps them in memory, and the server refuses to start with it when `NODE_ENV` is `production`; `resend` emails them through Resend's HTTP API, after the answer |
| `RESEND_API_KEY` | none; required with `MAILER=resend` | Resend's API key. Never logged |
| `MAIL_FROM` | none; required with `MAILER=resend` | The sender, on a domain verified in Resend: `Bank <codes@mail.example.com>` |
| `RESEND_API_URL` | `https://api.resend.com` | Resend's API origin; production takes https only, except a loopback address |
| `MONGODB_URI` | none: in-memory storage; required in production | The MongoDB connection string. It needs a replica set (Atlas is one) for the transfer's transaction. Never logged: it can carry a password |
| `JWT_SECRET` | none; required | Signs the access tokens; at least 32 bytes |
| `PASSCODE_SECRET` | none; required | Keys the hashes of the emailed passcodes; at least 32 bytes |

A start-up error names a missing or short secret but never shows its value, and a log line
shows the configuration's secrets as `[Redacted]`. Generate each secret with the command under
[Run it](#run-it), separately for each variable and each environment.

## The test outbox route

`GET /__test/outbox?email=dana@example.com` answers the latest passcode sent to that email, so a
client that only has HTTP (the Postman flow, later Cypress) can finish sign-up with no inbox:

```json
{ "email": "dana@example.com", "purpose": "signup", "passcode": "012345" }
```

`purpose` is `signup` or `reset`. The email is matched in lower case. It is not part of
`api/openapi.yaml` and needs no token.

- It exists only when the mailer is the in-memory outbox and `NODE_ENV` is not `production`
  (`MAILER=outbox`, the default). With anything else it does not exist: the path answers
  `404 NOT_FOUND` like any unknown path. With the outbox, `NODE_ENV=production` is refused at
  start-up.
- No message for the email: `404 NOT_FOUND`, the same answer as an unknown path.
- A missing, empty or repeated `email` is a mistake in the caller: `400 VALIDATION_FAILED` with
  one `errors` entry for `email`.
- Other methods answer `404 NOT_FOUND`; `HEAD` is answered like `GET`, without a body.
- It sits behind the security headers and CORS like every route, and is not rate limited.

## How a request flows

`src/app.ts` builds the app from its dependencies (`createApp(deps)`); only `src/server.ts` opens a
port, so tests call the app directly.

1. A pino request log line (credentials redacted).
2. Security headers (helmet) on every answer, errors included, and CORS: only `CORS_ORIGIN` gets
   `Access-Control-Allow-Origin`, and preflight (`OPTIONS`) requests are answered here.
3. The contract ([`src/http/contract.ts`](src/http/contract.ts)), in this order:
   - The operation is looked up; an unknown path or method answers `404 NOT_FOUND`.
   - On every operation the contract secures, the bearer token is checked before the body is
     read ([`src/http/auth.ts`](src/http/auth.ts)): its signature and expiry, and that its user
     still exists. Any refusal answers `401 UNAUTHORIZED`, so a request with a bad token and an
     invalid body gets the 401. If the check itself fails (a store error), the answer is
     `500 INTERNAL_ERROR`.
   - The JSON body is parsed, and the path, query and body are validated. Any mismatch answers
     `400 VALIDATION_FAILED` with one `errors` entry per field, before a handler runs.
     listTransactions also refuses a non-finite `limit` (`Infinity`, `1e400`) with the same
     400, on its route.
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

Handlers answer with `res.json` or `sendProblem`. An answer with no content (resendOtp's and
requestPasswordReset's 202, resetPassword's 204) is `res.status(n).end()` with no body, which
the check accepts only for a status the operation declares without content.

## The Postman flow

[`postman/`](postman) holds a collection that signs up three users over HTTP (passcodes read
through the test outbox route), signs in, moves money and checks the refusals, and a local
environment (`baseUrl`). From the root:

```sh
npm run test:api                  # stops at the first failed assertion
npm run test:api -- --keep-going  # runs every request and lists every failed assertion
```

`test:api` starts a throwaway MongoDB replica set (`mongodb-memory-server`; the first run downloads
`mongod`), then the server on a free port with fresh secrets, the in-memory outbox and that
database (it fails unless the server reports MongoDB storage), runs the
collection with a pinned `newman@6.2.3` through `npx`, stops the server and the database however the run ends, and
exits 0 when every assertion passed and 1 otherwise. It uses its own server, so it never touches one you started.

To run the collection against a server you started yourself, import `postman/` into Postman or run
`npx newman@6.2.3 run server/postman/flow.postman_collection.json -e
server/postman/local.postman_environment.json`. One run makes 5 email requests and 4 failed credential checks, which the rate limits count (20 email requests per hour, 10 failed checks per 15 minutes), so against one long-lived server run it at most twice in 15 minutes and at most 4 times an hour; restarting the server resets both limits.
