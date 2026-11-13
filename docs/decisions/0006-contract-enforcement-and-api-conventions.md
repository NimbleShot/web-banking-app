---
status: accepted
date: 2026-11-13
---
# 0006. The OpenAPI contract is enforced three ways; API conventions

**Context.** `api/openapi.yaml` is written by hand before any code (worksheet phase 1). Nothing
keeps code and contract together unless something checks it. The API's shape conventions bind
every later phase.

**Options.** Enforcement: lint + runtime validation + generated types · lint + generated types
with validation written by hand per route. Errors: RFC 9457 problem JSON · a custom
`{ error: { code, message } }`.

**Decision.** OpenAPI 3.1, kept honest three ways: `@redocly/cli` lints it;
`express-openapi-validator` validates every request (400 on mismatch) and, in tests, every
response; `openapi-typescript` (pinned `npx`) generates `api/generated/schema.d.ts`, and
`npm run check` fails when the committed file is stale. Every operation has an `operationId` and `x-requirements` (its IDs). All paths start with
`/api/v1`. Errors are `application/problem+json` (RFC 9457) with a machine `code` (e.g.
`EMAIL_TAKEN`) and, for form errors, `errors: [{ field, message }]`. The contract's `code` enum is
the error catalogue. Lists are newest first: `limit` defaults to 20, max 50.

**Consequences.** Contract-first is checked by machine: a route the yaml doesn't describe fails
in tests. Client and server compile against the same types. `jest-openapi` is not used (abandoned).
