# Web banking app

A full-stack web bank. Users sign up with email, password and phone, verify their email with a
one-time passcode, see a protected dashboard with their balance and recent transactions, and send
money to other users by email. Planned next: live transfer notifications, a customer-service
chatbot, a banking assistant that answers questions about the user's own account, video calls
between sender and receiver, Docker and deployment.

**Stack:** React + TypeScript (Vite) · Node.js + Express 5 + TypeScript · MongoDB
(Mongoose) · Socket.IO · LangGraph + LangChain + OpenAI + Langfuse · Jitsi · Docker · Vercel /
Render · Jest + Supertest · Cypress.

## Status

The API ([`api/openapi.yaml`](api/openapi.yaml), OpenAPI 3.1), the server on MongoDB and the web
front end are built and tested; [`render.yaml`](render.yaml) deploys them to Render
([`docs/deploy.md`](docs/deploy.md)).

## Development

Needs Node 24 (`.nvmrc`).

```sh
nvm use            # or any Node >=24.9 <25
npm ci
npm run check          # format, contract lint, type drift, lint, typecheck, builds, tests; CI too
npm run dev -w server  # the API on http://127.0.0.1:3000
npm run dev -w client  # the front end on http://localhost:5173, calling that API
npm run test:e2e       # browser tests against a fresh server for each spec file
npm run format         # fix formatting
npm run gen:api        # regenerate api/generated/schema.d.ts after changing the contract
npm run check:postman  # import the contract as a Postman collection: one request per operation
```

## Docs

| File | What it is |
|------|------------|
| [`docs/requirements.md`](docs/requirements.md) | What the app does: requirement IDs and acceptance checks |
| [`docs/decisions/`](docs/decisions/) | Architecture decision records: OTP, sign-up, money, sessions, toolchain, API conventions, password reset |
| [`docs/deploy.md`](docs/deploy.md) | The first deploy to Render, Atlas and Resend, and the checks after it |
| [`docs/tech-stack.md`](docs/tech-stack.md) | Tools per layer, versions, known pitfalls, and the ledger of installed dependencies |
