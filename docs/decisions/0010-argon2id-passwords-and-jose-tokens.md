---
status: accepted
date: 2026-11-16
---
# 0010. Passwords are hashed with argon2id; tokens are signed with jose

**Context.** SEC-1 needs a slow, salted password hash. [0004](0004-bearer-jwt-in-sessionstorage-client-logout.md)
fixed an HS256 JWT with a one-hour expiry but not the library that signs it.

**Options.** Hash: argon2id · bcrypt. Tokens: `jose` · `jsonwebtoken`.

**Decision.** `argon2` with argon2id at OWASP's minimum: 19 MiB of memory, 2 iterations,
parallelism 1 (about 35 ms per hash on the development server). The stored string carries its
salt and parameters, so the cost can rise later and old hashes still verify. A password is
hashed only after its passcode has been accepted. Tokens use `jose`: HS256 with a secret of at
least 32 bytes from the environment, `sub` = the user's id, `exp` one hour; verification accepts
HS256 only, never the algorithm a token names. `jose` ships only as an ES module: Node 24 loads
it from the CommonJS server natively, and Jest, which has its own module loader, compiles it
through one `transformIgnorePatterns` exception.

**Consequences.** Guessing on GPUs is costly, since each guess needs 19 MiB. Each concurrent hash
holds that memory, which the rate limits ([0011](0011-per-client-rate-limits.md)) keep bounded.
The same library signs the RS256 tokens the video call needs (phase 11). `argon2` is a native
module, so the Docker image (phase 10) needs a platform it has a prebuilt binary for.
