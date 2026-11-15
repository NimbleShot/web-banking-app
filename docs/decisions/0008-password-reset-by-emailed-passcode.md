---
status: accepted
date: 2026-11-15
---
# 0008. Password reset with an emailed passcode; existing tokens expire on their own

**Context.** A verified user who forgets their password needs a way back in without support.
The reset must not reveal which emails are registered, and our tokens are stateless
([0004](0004-bearer-jwt-in-sessionstorage-client-logout.md)).

**Options.** Channel: a 6-digit passcode by email · a link with a long one-time token. Existing
tokens after a reset: rejected (store "password changed at", refuse older tokens) · left to
expire within their hour.

**Decision.** A 6-digit passcode by email, under every rule of
[0001](0001-otp-by-email-and-passcode-rules.md): `crypto.randomInt`, stored as an HMAC, 10
minutes, 5 wrong tries, 60-second cooldown, 5 per hour. Two operations: asking for a code always
answers 202, and sends one only to a verified user outside the cooldown and cap; resetting takes
the email, the passcode and the new password, and answers 204 or the one `PASSCODE_INVALID` for
every failure. The user then logs in. Tokens issued before the reset stay valid until they
expire (at most one hour).

**Consequences.** The passcode code, outbox and limits are shared by sign-up and reset. A stolen
token outlives a reset by up to an hour; revoking it would need a per-user check on every request.
