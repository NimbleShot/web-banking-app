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

Design stage: the requirements and the design decisions are written; the API contract
(`api/openapi.yaml`) comes next, then the server.

## Docs

| File | What it is |
|------|------------|
| [`docs/requirements.md`](docs/requirements.md) | What the app does: requirement IDs and acceptance checks |
| [`docs/decisions/`](docs/decisions/) | Architecture decision records: OTP, sign-up, money, sessions, toolchain, API conventions |
| [`docs/tech-stack.md`](docs/tech-stack.md) | Tools per layer, versions, known pitfalls, and the ledger of installed dependencies |
