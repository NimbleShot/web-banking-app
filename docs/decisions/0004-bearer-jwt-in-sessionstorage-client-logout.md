---
status: accepted
date: 2026-11-13
---
# 0004. Bearer JWT kept in sessionStorage; logout is client-side

**Context.** Where the browser keeps the login, and what logout means on the server while a JWT
stays valid until it expires. The front end (`vercel.app`) and the API (`onrender.com`) are
different sites. Settles requirements open decisions 6 and 7.

**Options.** Storage: a Bearer token in sessionStorage · in memory only (a refresh logs you out)
· an httpOnly cookie (third-party across the two sites unless Vercel proxies the API, which
breaks Socket.IO). Logout: client-only · a server revocation list · a per-user token version.

**Decision.** Successful OTP verification and login return an HS256 JWT with `sub` = userId and a
1-hour expiry. There are no refresh tokens. The client sends it as `Authorization: Bearer`, keeps
it in sessionStorage, and on any 401 clears it and goes to login. Logout means the client deletes
the token. The API has no logout operation and keeps no session state.

**Consequences.** One mechanism serves REST, Postman/newman and the Socket.IO handshake (phase 7).
Accepted risk: a copied token works until it expires (≤ 1 hour), and a script injected into the
page could read it. Mitigations: React's escaping, no `dangerouslySetInnerHTML`, a strict CSP from
helmet (SEC-3), and the short expiry. DB-4 is verified on the UI side (phase 5): the token is gone and
Back doesn't reopen the dashboard. Its API side is DB-1's 401.
