---
status: accepted
date: 2026-11-19
---
# 0013. MongoDB storage: memory outside production, one transaction per step

**Context.** Phase 3 swaps the in-memory store for MongoDB behind the interfaces of
[0009](0009-server-layers-and-in-memory-repositories.md), where each method is one atomic step
and the passcode rules are shared functions. Transactions need a replica set (Atlas M0 is one).

**Options.** No address: require one · memory outside production. Atomic steps: rules rewritten
as update filters · the shared rules inside one transaction. Ids: UUIDs · MongoDB ids · per need.

**Decision.** With `MONGODB_URI` set, the server stores everything in MongoDB through Mongoose;
without it, the in-memory repositories, refused in production. The address is never logged. The
layout is in `api/openapi.yaml`'s description: users keep UUID ids (the token's `sub`) and a
unique email index, the two passcode collections are keyed by email, and transfer records take
MongoDB's own ids, which sort in creation order. Every method that reads and writes runs in one
transaction (`connection.transaction()`) that applies the same rule functions as the memory
store; MongoDB retries it when a concurrent write conflicts, so concurrent requests act one after
the other. The transfer is one such transaction ([0003](0003-money-in-agorot-one-record-per-transfer.md)).
Expiry indexes only remove, after a margin, what the rules (on the app's clock) already ignore.

**Consequences.** Routes, services and the phase-2 tests keep working unchanged; local runs need
no database. Verification and reset still take two steps: a failure between them costs a new code.
