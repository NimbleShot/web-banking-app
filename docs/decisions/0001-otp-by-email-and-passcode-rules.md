---
status: accepted
date: 2026-11-13
---
# 0005. Passcodes go by email; fixed passcode rules

**Context.** The worksheet allows SMS or email for the 6-digit passcode and leaves its rules open.
Settles requirements open decisions 1 and 8.

**Options.** Channel: email · SMS via Twilio (a trial texts only up to 5 hand-verified numbers)
· both, user's choice. Rules: as below · stricter (5 min, 3 tries) · looser (15 min, 10 tries).

**Decision.** Email only, behind one `Mailer` interface. An in-memory outbox implements it in tests
and local dev; production uses an HTTP email API (Resend, unless deployment finds a reason not to),
because Render's free tier blocks SMTP. The code is `crypto.randomInt(0, 1_000_000)`, zero-padded
to 6 digits. Only an HMAC-SHA256 of it, keyed by a server secret, is stored, and it's compared in
constant time. A code is valid for 10 minutes, and after 5 wrong tries it's burned. Resend has a
60-second cooldown and a cap of 5 per hour per user. A new code replaces the old one.

**Consequences.** Anyone can receive a code, classmates included, at no cost. Tests and Cypress
finish sign-up by reading the outbox, never a real inbox. Twilio is not used. The secret joins
`.env` with the server (phase 2). Codes and their hashes never reach logs or responses (SEC-5).
