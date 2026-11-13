# Web banking app

A full-stack web bank. Users sign up with email, password and phone, verify their email with a
one-time passcode, see a protected dashboard with their balance and recent transactions, and send
money to other users by email. Planned next: live transfer notifications, a customer-service
chatbot, a banking assistant that answers questions about the user's own account, video calls
between sender and receiver, Docker and deployment.

**Stack:** React + TypeScript + Material UI (Vite) · Node.js + Express 5 + TypeScript · MongoDB
(Mongoose) · Socket.IO · LangGraph + LangChain + OpenAI + Langfuse · Jitsi · Docker · Vercel /
Render · Jest + Supertest · Cypress.

## Status

Design stage: the requirements, the design decisions and the API contract
([`api/openapi.yaml`](api/openapi.yaml), OpenAPI 3.1) are written; the server comes next.

## Development

Needs Node 24 (`.nvmrc`).

```sh
nvm use            # or any Node >=24.9 <25
npm ci
npm run check          # format, contract lint, generated-type drift, lint, typecheck; CI runs the same
npm run format         # fix formatting
npm run gen:api        # regenerate api/generated/schema.d.ts after changing the contract
npm run check:postman  # import the contract as a Postman collection: one request per operation
```

## Docs

| File | What it is |
|------|------------|
| [`docs/requirements.md`](docs/requirements.md) | What the app does: requirement IDs and acceptance checks |
| [`docs/decisions/`](docs/decisions/) | Architecture decision records: OTP, sign-up, money, sessions, toolchain, API conventions |
| [`docs/tech-stack.md`](docs/tech-stack.md) | Tools per layer, versions, known pitfalls, and the ledger of installed dependencies |
