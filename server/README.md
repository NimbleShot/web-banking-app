# server

The Express 5 API that implements [`api/openapi.yaml`](../api/openapi.yaml). TypeScript, compiled
to CommonJS, tested with Jest and Supertest.

## Run it

```sh
npm ci                        # from the repository root
cp server/.env.example server/.env
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

## How a request flows

`src/app.ts` builds the app from its dependencies (`createApp(deps)`); only `src/server.ts` opens a
port, so tests call the app directly.

1. A pino request log line (credentials redacted).
2. The contract ([`src/http/contract.ts`](src/http/contract.ts)): the operation is looked up (an
   unknown path or method answers `404 NOT_FOUND`), the bearer header is required where the
   contract asks for it, the JSON body is parsed, and the path, query and body are validated. Any
   mismatch answers `400 VALIDATION_FAILED` with one `errors` entry per field, before a handler
   runs.
3. The operation's route.
4. [`src/http/errors.ts`](src/http/errors.ts) turns every error into an
   `application/problem+json` answer whose `code` comes from the contract's `ErrorCode` catalogue.

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
