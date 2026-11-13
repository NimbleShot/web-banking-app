---
status: accepted
date: 2026-11-13
---
# 0002. Sign-up creates a pending user; the store alone keeps emails unique

**Context.** When does a user exist before verifying, and what stops two racing sign-ups from
duplicating an email? Settles open decisions 2 and 3.

**Options.** Lifecycle: a pending user · a separate pending collection · never-expiring pending.
Uniqueness: the store's constraint only · a look-up first as well · also unique phones.

**Decision.** Sign-up creates the user at once, with `status: pending` and its random balance
(DB-2). A correct code flips it to `verified`. A pending user can't receive transfers (treated as
an unknown recipient). Logging in with the right password returns "verification required"
instead of a token. A pending user older than 24 hours counts as absent: a Mongo TTL index
deletes it from phase 3, and before that it is replaced on the next sign-up. Signing up again with a
pending email replaces that user and sends a new code. A verified email gets 409 `EMAIL_TAKEN`.
Emails are trimmed and lowercased. The store's uniqueness is the only guarantee: a unique index in
Mongo, an atomic insert in the in-memory store. There is no look-up first. Phones are stored in
E.164 and are not unique.

**Consequences.** Two racing sign-ups leave exactly one user (SU-2's test). A stranger can't
squat on an email they don't own. The sign-up response reveals that a verified email exists, as
SU-2 requires; login and resend still don't (SEC-4).
