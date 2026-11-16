---
status: accepted
date: 2026-11-16
---
# 0012. A test-only route reads the passcode outbox, outside the contract

**Context.** In tests and local development, passcodes go to an in-memory outbox
([0001](0001-otp-by-email-and-passcode-rules.md)). Jest tests run in the server's process and read
it directly. The Postman collection run by newman, and later Cypress, reach a running server only
over HTTP, and can't finish sign-up without the passcode.

**Options.** A guarded test-only route outside the contract · the same route in the contract ·
a fixed passcode whenever a test variable is set.

**Decision.** `GET /__test/outbox?email=…` answers the latest message sent to that email (its
passcode and whether it is for sign-up or reset), or `404 NOT_FOUND`. It is mounted only when the
mailer is the in-memory outbox, and the server refuses to start with the in-memory outbox when
`NODE_ENV` is `production`; tests prove both. It sits outside `/api/v1`, is mounted before the
contract validator, and is documented in the server's README, not in `api/openapi.yaml`.

**Consequences.** newman and Cypress finish sign-up with no inbox. The product contract and the
generated types never describe a route that hands out passcodes. A run of the Postman flow
against production can't use it; deployment decides how that run signs up. A fixed passcode was
rejected: one wrong variable in production would let anyone verify any email.
