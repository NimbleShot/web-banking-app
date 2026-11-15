---
status: accepted
date: 2026-11-13
---
# 0003. Money is integer agorot; one record per transfer, written in one transaction

**Context.** How money is represented, how a transfer is recorded, and how it stays
all-or-nothing. Settles requirements open decisions 4 and 5.

**Options.** Representation: integer minor units end to end · a decimal string in the API ·
Mongo Decimal128. Records: one shared record per transfer · two ledger entries (debit + credit).

**Decision.** One currency, shekels (ILS). Every amount and balance is an integer number of
agorot in storage and in the API: 12.50 ₪ travels as `1250`. The client converts the form's
`12.50`. The starting balance is `crypto.randomInt(1_000, 10_001) * 100`. A transfer is one record
(sender, receiver, both emails, amount, time) that both sides read. The sign comes from the
reader's side: `-` if they sent it, `+` if they received it. On Mongo one transaction does a
conditional debit (`balance >= amount`, else `INSUFFICIENT_FUNDS`), the credit and the insert;
any failure aborts all three. The in-memory store runs the same steps with no `await` between
them.

**Consequences.** No floating-point value ever touches a balance. TX-6's "at most 2 decimals"
becomes "a positive integer" on the API and a 2-decimal check in the form. The conditional debit
makes concurrent overdrafts impossible (TX-8). A ledger was set aside because transfers are the
only way money moves. If phase 7 needs data for one side only, a superseding ADR moves to a ledger.
