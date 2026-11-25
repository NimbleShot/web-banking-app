---
status: accepted
date: 2026-11-25
supersedes: 0004
---
# 0017. Render hosts both halves, Resend sends after the answer, the page has its own CSP

**Context.** The app goes online on free tiers. Render's free web services block outbound SMTP.
Waiting for an email API makes a request for a registered email slower than for an unknown one,
and a failed send would answer 500 for registered emails only. A host started without
`NODE_ENV=production` would serve the test outbox ([0012](0012-test-only-passcode-outbox-route.md)).
helmet's CSP covers the API's answers, not the page.

**Options.** Pages on Vercel or Render · email by SMTP or an HTTP API · send before or after the
answer · for a forgotten `NODE_ENV`: require it everywhere, or listen on loopback outside
production · the page's CSP as a host header or a tag built into the page.

**Decision.** [`render.yaml`](../../render.yaml) describes both: the API as a free Node web
service started from a compiled build, the pages as a static site with a deep-link rewrite. The
pages call the API at its own address (`VITE_API_URL`, allowed by `CORS_ORIGIN`), with no proxy
in between. `MAILER=resend` posts each passcode to Resend from a verified subdomain, after the
answer; a failure is logged with its status only. Outside production the server listens on
127.0.0.1, so a misconfigured deploy finds no port and fails. The page's CSP is a `<meta>` tag
built from the `VITE_API_URL` the bundle gets: everything from its own origin, plus the API for
`connect-src`; a deploy build without the address fails. Assets are never inlined, and
`frame-ancestors` comes as a header. This replaces only 0004's "a strict
CSP from helmet" mitigation. `TRUST_PROXY` stays 0 until it is measured on the live service.

**Consequences.** A failed email is silent: the user asks for a new code after the cooldown.
Changing the API's address means rebuilding the pages. A free web service sleeps after 15 idle
minutes. Atlas admits Render's shared outbound ranges, which change. A container (phase 10) must
set `NODE_ENV=production`.
