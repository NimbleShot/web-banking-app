---
status: accepted
date: 2026-11-16
---
# 0009. The server is layered; storage sits behind repository interfaces

**Context.** Phase 2 builds the backend on in-memory storage and phase 3 swaps in MongoDB. Tests
call the app without opening a port, and phase 7 adds Socket.IO to the same server.

**Options.** Layers: routes → services → repositories · handlers that touch storage directly.
Wiring: one dependencies object passed to the app · a DI container · module-level singletons.

**Decision.** `server/src/app.ts` exports `createApp(deps)`; only `server.ts` listens on a port.
Routes speak HTTP, services hold the rules (passcodes, balances, tokens), and repositories store
data behind interfaces. The money move is one repository method that does the recipient look-up,
the conditional debit, the credit and the record as one unit: in memory with no `await` between
the steps, in MongoDB inside one transaction ([0003](0003-money-in-agorot-one-record-per-transfer.md)).
`deps` carries the repositories, the mailer, a clock, the config and the logger, so every test
builds a fresh app with empty stores and a controllable clock. Configuration comes from
environment variables read once at start-up (`node --env-file` in development, listed in
`server/.env.example`); the server refuses to start without its token and passcode secrets.

**Consequences.** Phase 3 adds MongoDB repositories with the same interfaces; routes and services
don't change. Tests share no state and need no port. In-memory data is lost on restart, which
phase 2 accepts.
