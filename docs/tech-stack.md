# Tech stack and tools

Researched 2026-11-13; every version below matched npm `latest` that day. Re-checked with
`npm outdated` before each phase. "Fixed" means the worksheet requires it. "Recommended" is a
default that a later ADR confirms or overturns; the toolchain and the contract enforcement are
already settled by ADR.

## Installed in this repo

The ledger of what this project actually installs or runs, kept so nothing arrives unrecorded.
**Every install adds a row in the same commit**: npm packages, tools run through a pinned `npx`,
and system packages or binaries the project depends on. A removal deletes the row.

| Package / tool | Kind | Version | Workspace | Phase | Why |
|----------------|------|---------|-----------|-------|-----|
| `typescript` | dev | ~6.0 (6.0.3) | root | P01 | Type-checks every workspace (`tsc --noEmit` in `check`). Pinned below 7 for typescript-eslint |
| `prettier` | dev | ^3.10 (3.10.1) | root | P01 | Formatting of code, JSON and YAML; `format:check` in `check`. Markdown is left as written |
| `eslint` | dev | ^10.14 (10.14.0) | root | P01 | Linting, flat config in `eslint.config.mjs` |
| `@eslint/js` | dev | ^10.0 (10.0.1) | root | P01 | ESLint's recommended JavaScript rules |
| `typescript-eslint` | dev | ^8.72 (8.72.2) | root | P01 | TypeScript parser and rules for ESLint |
| `globals` | dev | ^17.14 (17.14.0) | root | P01 | Node global names for ESLint |
| `@redocly/cli` | dev | ^2.78 (2.78.0) | root | P01 | Lints `api/openapi.yaml` (`lint:api`, `recommended-strict`: warnings fail) |
| `openapi-typescript` | npx | 7.13.0 | root | P01 | `gen:api`: TypeScript types from the contract. Run through `npx` because it peers TS 5 |
| `openapi-to-postmanv2` | npx | 6.4.3 | root | P01 | `check:postman`: imports the contract the way Postman does and counts one request per operation |
| `@mermaid-js/mermaid-cli` | npx | 12.2.0 | root | P01 | `check:diagrams`: renders the sequence diagrams in `docs/diagrams/` (run with `PUPPETEER_SKIP_DOWNLOAD=1`, so it drives the local Chrome) |
| `google-chrome` | system | stable (`/usr/bin/google-chrome` by default) | — | P01 | The headless browser mermaid-cli renders with; another path goes in `PUPPETEER_EXECUTABLE_PATH` |
| `express` | runtime | ^5.3 (5.3.0) | server | P02 | The HTTP server |
| `express-openapi-validator` | runtime | ^5.6 (5.6.2) | server | P02 | Validates every request against `api/openapi.yaml`, and every response in tests ([ADR-0006](decisions/0006-contract-enforcement-and-api-conventions.md)) |
| `pino` | runtime | ^10.4 (10.4.0) | server | P02 | JSON logs, with the Authorization and Cookie headers redacted |
| `pino-http` | runtime | ^11.0 (11.0.0) | server | P02 | One log line per request, through the same logger |
| `jest` | dev | ^30.5 (30.5.2) | server | P02 | Test runner ([ADR-0005](decisions/0005-toolchain-jest-swc-commonjs.md)); `npm test` in `check` |
| `@jest/globals` | dev | ^30.5 (30.5.2) | server | P02 | Typed `describe`/`it`/`expect` imports instead of ambient globals |
| `@swc/jest` | dev | ^0.2.39 (0.2.39) | server | P02 | Strips TypeScript types for Jest; types are checked by `tsc` instead |
| `@swc/core` | dev | ^1.16 (1.16.22) | server | P02 | The compiler `@swc/jest` drives |
| `supertest` | dev | ^7.3 (7.3.2) | server | P02 | Calls the app over HTTP in tests without opening a port |
| `tsx` | dev | ^4.23 (4.23.15) | server | P02 | `npm run dev -w server`: runs the TypeScript server and restarts it on change |
| `@types/express` | dev | ^5.0 (5.0.6) | server | P02 | Express types |
| `@types/node` | dev | ^24.19 (24.19.2) | server | P02 | Node 24 types |
| `@types/supertest` | dev | ^7.2 (7.2.1) | server | P02 | Supertest types |

Kinds: `dev` (devDependency) · `runtime` (dependency) · `npx` (pinned, never installed) ·
`system` (apt package or binary on the server or CI runner).

## At a glance

```
 Browser ──── React SPA (Vite, TS, MUI) ───────────── hosted on Vercel
    │  HTTPS: REST + JSON           │  WebSocket (Socket.IO)
    ▼                               ▼
 Express API (Node, TS) ── Socket.IO server ───────── hosted on Render (Docker)
    │            │             │            │
 MongoDB      Email/SMS      OpenAI via    Langfuse
 (Atlas M0)   (Resend /      LangGraph     (traces)
 via Mongoose  Twilio)       agent
                                   Jitsi (JaaS) video: browser ⇄ 8x8 servers,
                                   room handed out by the API
```

## Layer by layer

### Runtime and language
| Piece | Choice | Version | Notes |
|-------|--------|---------|-------|
| Node.js | **Fixed** | 24 LTS (installed here: 24.13.1), or 26 (LTS since 28 Oct 2026) | Pin it with `.nvmrc` and `engines`, so Render, Docker and your laptop all run the same version. Node 20 reached end of life in April 2026 |
| TypeScript | Worksheet prerequisite | **6.0.x, not 7** | TS 7 (the Go rewrite) is `latest` (7.0.2), but on 13 Nov 2026 `typescript-eslint` accepts `<6.1` and `ts-jest` accepts `<7`, and the TypeScript language server needs TS 6. Pin `typescript@~6.0` (6.0.3) until they catch up |
| Running TS in dev | Recommended: `tsx watch` | 4.23 | Node 24+ can also run `.ts` directly (type stripping), but only with erasable syntax: no `enum`, explicit `.ts` import extensions. `tsx` has fewer surprises. Type-check with `tsc --noEmit` |
| Monorepo | Recommended: **npm workspaces** (`api`, `server`, `client`), no Turborepo | npm 11.8 | pnpm 11+ blocks dependency install scripts by default (breaks Cypress, mongodb-memory-server, argon2 until allow-listed) and ignores the `pnpm` field most tutorials use |

### Backend
| Piece | Choice | Version | Notes |
|-------|--------|---------|-------|
| Express | **Fixed** | 5.3 | Express 5: a rejected promise in an async handler goes to your error middleware by itself (no try/catch wrapper needed). Wildcard routes changed syntax (`/*splat`). Most tutorials online are still Express 4 |
| Validation | Requests validated against `openapi.yaml` by `express-openapi-validator` ([ADR-0006](decisions/0006-contract-enforcement-and-api-conventions.md)); **Zod** for env config and client forms | 4.6 | Zod covers email format (`z.email()`). For phone numbers, add `libphonenumber-js` and store E.164 (`+972…`) |
| Passwords | Decided ([ADR-0010](decisions/0010-argon2id-passwords-and-jose-tokens.md)): `argon2`, argon2id at OWASP's minimum (19 MiB, 2 iterations) | 0.45 | Hash, never encrypt. bcrypt (6.0), set aside, silently uses only the first 72 bytes of a password |
| JWT | Decided ([ADR-0010](decisions/0010-argon2id-passwords-and-jose-tokens.md)): `jose` (typed, no dependencies, also does RS256 for Jitsi) | 6.2 | ESM-only: see gotcha 14. `jsonwebtoken` (9.0) was set aside |
| Security middleware | `helmet`, `cors`, `express-rate-limit` | 8.3 / 2.8 / 8.7 | Rate limits per client IP: [ADR-0011](decisions/0011-per-client-rate-limits.md) |
| Logging | `pino` + `pino-http` | 10.4 / 11.0 | JSON request logs with the `Authorization` header and every password, passcode and token field redacted (SEC-5) |
| API docs | Hand-written `openapi.yaml` (OpenAPI 3.1, not 3.2) served by `swagger-ui-express` | 5.0 | Phase 1 asks for the API in Swagger before any code, so write the spec by hand ("design-first"). `zod-to-openapi` would be "code-first", the opposite of what phase 1 teaches |
| Contract checks | Decided ([ADR-0006](decisions/0006-contract-enforcement-and-api-conventions.md)): `@redocly/cli` (lint), `express-openapi-validator` (requests always, responses in tests), `openapi-typescript` + `openapi-fetch` (client types) | 2.78 / 5.6 / 7.13 / 0.17 | express-openapi-validator supports OAS 3.1 and Express 5. `openapi-typescript` peers TS `^5`, so run it through a pinned `npx` instead of a workspace devDependency. `jest-openapi` is abandoned (last release 2022) |
| API client | **Postman** (fixed), run headless with **newman** | newman 6.2 | Import `openapi.yaml` → Postman generates the whole collection. Use an environment variable for the base URL and a script that stores the JWT after login. `newman run` runs the collection from the command line and in CI |

### Data
| Piece | Choice | Version | Notes |
|-------|--------|---------|-------|
| MongoDB | **Fixed**, hosted on **Atlas M0** (free) | server 8.x/9.x, driver 7.9 | M0 is a 3-node replica set, so **multi-document transactions work**. Free limits: 512 MB, 100 ops/sec, idle clusters can be paused |
| Mongoose | **Fixed** | 9.12 | Use `connection.transaction()` for the transfer. Has TypeScript support (`InferSchemaType`) |
| Local DB | Docker `mongo` image **started as a single-node replica set** | — | A plain `mongo` container is a standalone server, and **transactions fail on standalone**. Needs `--replSet rs0` plus `rs.initiate()`, or use Atlas for dev too |

### Verification messages (OTP)
| Option | Cost | Gotcha |
|--------|------|--------|
| **Email via an HTTP API: Resend** (`resend` 6.38) or Brevo | Free tier | **Recommended if deploying to Render free.** Render's free web services block outbound SMTP ports 25/465/587 since Sept 2025 (Railway's free/hobby plans too). So Nodemailer + Gmail works on your laptop and then times out in production |
| Email via **Nodemailer** + SMTP (`nodemailer` 10.5) | Free (Gmail app password, or Ethereal for fake test inboxes) | Fine locally. In production it needs a paid Render instance or an SMTP provider over HTTP. Worth learning anyway: it's in the keywords |
| **SMS via Twilio** (`twilio` 6.3) | Trial credit | A trial account can only text numbers you verified in the Twilio console (up to 5). Messages carry a "Sent from a Twilio trial account" prefix. Verify API adds ~$0.05 per verification on top of SMS cost. Twilio Verify can generate and check the code itself, but the worksheet says *you* send 6 random digits |

Whichever channel you pick: generate the code with `crypto.randomInt` (not `Math.random`), store
only a **hash** of it with an expiry, count wrong attempts, and limit re-sends.

### Front end
| Piece | Choice | Version | Notes |
|-------|--------|---------|-------|
| React | **Fixed** | 19.3 | — |
| Build tool | **Vite** (`npm create vite@latest client -- --template react-ts --eslint`) | 8.3 | Without `--eslint`, create-vite 9 scaffolds TS 7 with Oxlint. Create React App is dead. Use a dev proxy (`server.proxy`) so `/api` calls go to Express without CORS during development. To reach the dev server from another machine, set `server.host` and add that host name to `server.allowedHosts` |
| UI kit | **Material UI** (fixed) | 9.5 | `@mui/material` + Emotion + `@mui/icons-material`. Set one theme (colours, typography) from the Figma design |
| Routing | **React Router** | 8.5 | Install `react-router@8`. **Never `react-router-dom`**: it still exists on npm and resolves to v7 (7.18). "Data mode" (`createBrowserRouter`) suits a Vite SPA. Protected routes = a layout route that redirects when not logged in |
| Server state | Recommended: **TanStack Query** | 5.107 | Caching, loading and error states, refetch after a transfer. Optional. Plain `fetch` + `useEffect` works but gets messy |
| Forms | Recommended: **React Hook Form** + Zod resolver | 7.92 | The same Zod rules on client and server |
| Design | **Figma** (fixed) | — | The free plan is enough to design 5 screens. The official remote Figma MCP server works on every plan, but the free Starter plan allows only 20 tool calls a month; paid or Education seats get 200 a day. Community servers (e.g. Framelink) are bound by Figma's REST rate limits too |

### Realtime and video
| Piece | Choice | Version | Notes |
|-------|--------|---------|-------|
| Notifications | **Socket.IO** (fixed) | 4.8 | Authenticate the socket with the same JWT in the handshake (`auth: { token }`, checked in `io.use`). Each user joins a room named after their user id. A transfer emits to the receiver's room. Render keeps WebSockets open; free instances still sleep after 15 idle minutes |
| Video | **Jitsi** (fixed), via **JaaS** (8x8) or test on meet.jit.si | `@jitsi/react-sdk` 1.4 | Jitsi's own docs say meet.jit.si is fine to *test* an integration on, but "not meant for use in production". JaaS's free developer tier covers **25 monthly active users**, enough for a course demo. It needs a JWT signed with your JaaS private key (RS256), issued by your API, which reuses the JWT lesson |

### AI assistant
| Piece | Choice | Version | Notes |
|-------|--------|---------|-------|
| LLM API | **OpenAI** (fixed) | `openai` 7.56 | Phase 8: the plain SDK, chat completion with a system prompt, streamed. Pick the cheapest current tool-calling model from OpenAI's models page when you build. Model names change too often to pin here |
| Agent framework | **LangGraph.js** (fixed) + **LangChain.js** | `@langchain/langgraph` 1.7, `langchain` 1.6, `@langchain/openai` 1.8 | Both are 1.x (stable since late 2025). Many tutorials still show pre-1.0 APIs such as `createReactAgent`. Today's shortcut is `createAgent` from `langchain`, which runs on LangGraph. Building the graph by hand (`StateGraph`) teaches more |
| Memory | `@langchain/langgraph-checkpoint-mongodb` (`MongoDBSaver`) | 1.5 | Saves the conversation state in your own Mongo, keyed by `thread_id`. This is what the two LangGraph questions on the worksheet are about |
| Observability | **Langfuse** (fixed) | `@langfuse/tracing` + `@langfuse/otel` + `@langfuse/langchain` 6.1 | The current SDK is built on OpenTelemetry. Register `LangfuseSpanProcessor` in a NodeSDK, then pass `CallbackHandler` to the graph. **The plain `langfuse` package is the legacy v3 SDK (3.39)**: don't install it. Langfuse Cloud has a free tier |

### Infrastructure and deployment
| Piece | Choice | Notes |
|-------|--------|-------|
| Docker | **Fixed** (phase 10) | Multi-stage Dockerfile for the API, plus `docker compose` with Mongo as a replica set. `.dockerignore` keeps `node_modules` and `.env` out of the image. Developed against Docker 29 |
| Front-end host | **Vercel** (Hobby, free) | Static Vite build. Add a rewrite of all paths to `index.html`, or deep links 404 on refresh |
| Back-end host | **Render** free web service | Sleeps after 15 min idle, ~1 min cold start, no outbound SMTP, files on disk are lost on restart (fine; data lives in Atlas). Deploys from GitHub/GitLab.com or a Dockerfile. Vercel can now hold WebSockets (beta), but a long-lived Express + Socket.IO server is a better fit for Render |
| Railway | Listed in the keywords | No longer really free: a one-time $5 trial, then $1/month credit. Fine to *know*, not the default |
| CI | GitHub Actions (or GitLab CI) | On every push: lint, type-check, backend tests. Cypress in CI later |

### Testing
| Piece | Choice | Version | Notes |
|-------|--------|---------|-------|
| Backend tests | **Jest** + **Supertest** (fixed) | 30.5 / 7.3 | Export the Express `app` separately from `app.listen()` so Supertest can call it without a port. **Jest's ESM support is still experimental**, so decided ([ADR-0005](decisions/0005-toolchain-jest-swc-commonjs.md)): a CommonJS server with `@swc/jest`, types checked by `tsc` as a separate step. Plain Node ≥24.9 `require()`s ESM-only dependencies such as `jose` 6, but Jest has its own module loader and does so only under `--experimental-vm-modules`; without it, see gotcha 14 (24.13.1 is installed; pin `>=24.9 <25` in `.nvmrc`, `engines`, Docker and CI). In CommonJS use `__dirname`, not `import.meta.dirname`. The worksheet names Jest, so Vitest is not the plan |
| Test database | `mongodb-memory-server` | 11.3 | A real `mongod` in memory per test run. Use `MongoMemoryReplSet` so transfer transactions work in tests |
| E2E | **Cypress** (fixed) | 16.3 | Cypress 16 removed `Cypress.env()` (use `cy.env()` / `Cypress.expose()`) and `cy.exec()` (use `cy.task()`). On a headless Ubuntu 24.04 machine it needs apt packages (`xvfb xauth libgtk-3-0t64 libgbm-dev libnotify-dev libnss3 libxss1 libasound2t64 libxtst6`). Needs a way to read the OTP in tests: the server's test-mode outbox. For quick ad-hoc UI checks a headless Playwright browser is lighter; Cypress stays the test suite the course asks for |

## Shortlist of gotchas

1. Render free blocks SMTP → send email over an HTTP API (Resend/Brevo), or Nodemailer stays local.
2. Mongo transactions need a replica set → Atlas works; a local Docker Mongo needs `--replSet`.
3. TypeScript 7 breaks `typescript-eslint` and `ts-jest` today → pin TS 6.0.
4. Jest + ESM + TS is fiddly → CommonJS server with ts-jest/swc, or ask about Vitest.
5. meet.jit.si is for testing only → JaaS free tier (25 MAU) for the demo.
6. `vercel.app` and `onrender.com` are different sites → httpOnly cookies become third-party
   cookies (Safari blocks them). Token transport is settled in [ADR-0004](decisions/0004-bearer-jwt-in-sessionstorage-client-logout.md).
7. Twilio trial texts only verified numbers → fine for a demo to yourself, not for classmates.
8. Most online tutorials predate Express 5, React Router 8, MUI 9, LangChain/LangGraph 1.x and
   Langfuse's OpenTelemetry SDK → check the version the tutorial was written for.
9. `create-vite` without `--eslint` scaffolds TS 7 + Oxlint → always pass `--eslint`.
10. `react-router-dom` and `langfuse` are live npm packages from older majors → never install them.
11. Cypress 16 removed `Cypress.env()` and `cy.exec()`, and needs apt packages on a headless Linux machine.
12. `openapi-typescript` peers TS 5 → run it with a pinned `npx`, not as a workspace devDependency.
13. `openapi-typescript` 7 lints with its own older Redocly core and reads `redocly.yaml` → a
    built-in rule can pass `lint:api` and still fail `gen:api` (`operation-4xx-problem-details-rfc7807`
    misreads `allOf`). Run both after changing `redocly.yaml`.
14. `jose` 6 is ESM-only → Jest 30 fails with "Must use import to load ES Module" even on Node
    24.13. Add `transformIgnorePatterns: ["/node_modules/(?!jose/)"]` and let `@swc/jest`
    transform `.js` too ([ADR-0010](decisions/0010-argon2id-passwords-and-jose-tokens.md)). Plain
    Node and `tsc` (`module: node20`) load it from CommonJS unaided. Checked 2026-11-16.
15. `express-openapi-validator` reports only the first invalid field → pass
    `validateRequests: { allErrors: true }` for one error per field (SU-3). It answers an
    undocumented path 404 and a wrong method 405. Checked 2026-11-16 (5.6.2).
16. `express-openapi-validator` installs response validation *after* request validation, and a body
    parser mounted before it fails before the operation is known → the 400s and 401s it raises
    itself, and malformed-JSON 400s, are never checked against the contract. `server/src/http/contract.ts`
    reorders its middleware (by function name, failing at start-up if they change) so the
    response check starts right after the operation look-up. Checked 2026-11-16 (5.6.2).

## Sources for these claims

Render SMTP block: <https://render.com/changelog/free-web-services-will-no-longer-allow-outbound-traffic-to-smtp-ports> ·
Render free tier: <https://render.com/docs/free> · Atlas free limits:
<https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/> · Mongoose transactions:
<https://mongoosejs.com/docs/transactions.html> · Jitsi on meet.jit.si vs production:
<https://jitsi.org/api/> · JaaS 25 MAU: <https://developer.8x8.com/jaas/docs/faq/> · Twilio trial:
<https://www.twilio.com/docs/usage/trials> · Vercel WebSockets:
<https://vercel.com/kb/guide/do-vercel-serverless-functions-support-websocket-connections> ·
Jest ESM: <https://jestjs.io/docs/ecmascript-modules> · Langfuse + LangChain:
<https://langfuse.com/integrations/frameworks/langchain> · LangGraph persistence:
<https://docs.langchain.com/oss/javascript/langgraph/persistence> · React Router v8:
<https://remix.run/blog/react-router-v8> · TS peer ranges: `npm view ts-jest peerDependencies`,
`npm view typescript-eslint peerDependencies`.
