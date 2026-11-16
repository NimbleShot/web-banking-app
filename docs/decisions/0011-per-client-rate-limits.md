---
status: accepted
date: 2026-11-16
---
# 0011. Rate limits count failed checks and sent emails per client address

**Context.** SEC-2. Passwords and passcodes can be guessed; each sent passcode costs email quota
and can spam a stranger. The per-email limits of [0001](0001-otp-by-email-and-passcode-rules.md)
don't stop one client trying many emails. A classroom demo may share one network address.

**Options.** Key: client IP · email · both. Counted: every request · failures only. Store:
process memory · a shared store such as Redis.

**Decision.** `express-rate-limit`, keyed by client IP, in process memory. Two limits, both
configuration: credential checks (login, passcode verify, password reset) allow 10 failed
attempts per 15 minutes, and successes don't count; operations that send email (sign-up, resend,
forgot password) allow 20 requests per hour. Over a limit the answer is `429 RATE_LIMITED` with
`Retry-After`. The per-email limits of 0001 still apply. Account and transfer operations, which
need a token, are not limited.

**Consequences.** It holds for one server process; a second instance needs a shared store. Behind
a hosting proxy the client address comes from `X-Forwarded-For`, so deployment must set Express's
`trust proxy` to the real number of proxy hops, or all clients share one counter. Response time
still differs when a passcode is really sent or a registered email's password is checked; that
is accepted until deployment, where a real email service makes it measurable.
