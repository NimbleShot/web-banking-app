---
status: accepted
date: 2026-11-24
---
# 0016. A transfer carries a one-time key, and a repeat gets the first answer

**Context.** If a reused connection dies after the server finished a transfer and before any
answer byte, Chrome resends the POST by itself: one `fetch` became three transfers. The
transaction of [0003](0003-money-in-agorot-one-record-per-transfer.md) keeps each transfer whole,
not unique.

**Options.** An optional key (only callers that send one are protected) · a required key · refuse
the same sender, recipient and amount within a time window (that also refuses a real second
payment).

**Decision.** `createTransfer` requires an `Idempotency-Key` header, a UUID the client makes once per
transfer. The key is stored on the transaction record, under a unique index on sender and key
(partial: older records have none). Inside 0003's transaction, before any write, the store looks
for the sender's record with that key. Same recipient and amount: nothing is written and the answer
is 201 with that record and the sender's current balance. Anything else: 422
`IDEMPOTENCY_KEY_REUSED`, nothing changes. Two repeats at once conflict on the sender's balance; the
retried one finds the record. A refused transfer stores no key, so its repeat runs the checks again.

**Consequences.** Every caller sends a key: the front end, the Postman flow, the tests' helper, and
any later tool that starts a transfer. CORS allows the header. Keys never expire. A repeat's balance
is the balance now, which can differ from the first answer's if money moved in between.
