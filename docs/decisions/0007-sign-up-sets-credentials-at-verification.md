---
status: accepted
date: 2026-11-15
supersedes: 0002
---
# 0007. Sign-up saves the password only with the passcode; emails are lowercased, never trimmed

**Context.** Under [0002](0002-pending-users-and-unique-email.md) a pending user held a password
from the moment of sign-up, and a repeat sign-up replaced it. Anyone could sign up with someone
else's email before its owner verified: the owner's passcode then confirmed an account whose
password the other person chose. Keeping the first pending user instead only reverses the order
of the same attack. A repeat sign-up also skipped resend's limits.

**Options.** Replace the pending user (0002) · keep the first one, repeat sign-up resends · save
the password and phone only when they arrive with the correct passcode.

**Decision.** The last. Sign-up validates email, password and phone, then records only a pending
sign-up: the lowercased email and the passcode's HMAC. Signing up again with a pending email is a
resend, under resend's silent cooldown and cap ([0001](0001-otp-by-email-and-passcode-rules.md)),
with the same answer as a first sign-up. Verification takes the passcode with the password and
phone, and only then creates the verified user with its random balance. A pending sign-up has no
password, so login answers it `INVALID_CREDENTIALS` like an unknown email. A verified email still
gets 409 `EMAIL_TAKEN`. Emails are lowercased by the server; surrounding spaces fail validation
(no trimming). The rest of 0002 stands: the 24-hour expiry of a pending sign-up, a pending email
counts as an unknown recipient, and the store's unique index is the only uniqueness guarantee.

**Consequences.** Whoever proves they hold the inbox chooses the password. The client keeps the
sign-up form's values in memory until the passcode screen sends them. A user who leaves before
entering the passcode signs up again. The login error `VERIFICATION_REQUIRED` is gone.
