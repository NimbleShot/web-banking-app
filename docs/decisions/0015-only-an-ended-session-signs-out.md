---
status: accepted
date: 2026-11-23
supersedes: 0004
---
# 0015. Only an ended session signs the client out

**Context.** [0004](0004-bearer-jwt-in-sessionstorage-client-logout.md) says the client clears the
token and goes to login on any 401. But `verifyOtp` and `resetPassword` answer 401
`PASSCODE_INVALID`, and `login` answers 401 `INVALID_CREDENTIALS`. Under that rule one mistyped
passcode would leave its screen and lose the sign-up form's values.

**Options.** Keep the rule · react only to `UNAUTHORIZED`, silently · react only to
`UNAUTHORIZED`, and tell the user.

**Decision.** The last. When a request that carried a token answers 401 with code `UNAUTHORIZED`,
the client clears the token and returns to login with a notice that the session ended. Any other
401 stays on its screen and shows that screen's error. This replaces only 0004's "on any 401"
sentence; the rest of 0004 stands.

**Consequences.** No contract or server change. A session that ends mid-task loses what the form
held, and an unsent transfer is not sent.
