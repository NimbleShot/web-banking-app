# Requirements: Web Banking Application

The authoritative restatement of the course worksheet this app is built from. It says **what**
to build; why each design choice was made is in [`decisions/`](decisions/).

**ID rules:** IDs are append-only, never renumbered or reused. `DB-` means Dashboard, not database.
Each ID gets testable criteria with sub-IDs (`TX-2.a`) before it is built, and test titles start
with the criterion ID.

## 1. The goal in one paragraph

A full-stack web bank. A user signs up with email, password and phone. They prove they own the
email or phone with a 6-digit one-time passcode, then land on a protected dashboard. The dashboard
shows a random starting balance and their recent transactions. They can send money to another
registered user by email. Later phases add a live "you received money" notification, an AI
assistant that answers questions about the user's own account, a video call between sender and
receiver, Docker, deployment and tests.

Fixed by the worksheet: **React** front end, **Node.js** server, **MongoDB**. UI built from
**Figma** designs. **Twilio** for SMS *or* email validation. Hosted on a platform of your choice.

## 2. Functional requirements (worksheet §1–5)

### Sign up (worksheet §1)
| ID | Requirement | Acceptance check |
|----|-------------|------------------|
| SU-1 | Sign up with email, password and phone number | Form takes all three; server creates a pending user |
| SU-2 | An email can be registered only once | Second sign-up with the same email gives a clear error. It must hold even if two requests race (see "Open decisions") |
| SU-3 | Email format and phone format are validated | Bad formats are rejected on the client *and* the server, with a message per field |

### Phone / email verification (§2)
| ID | Requirement | Acceptance check |
|----|-------------|------------------|
| OTP-1 | During sign-up a 6-random-digit passcode is sent by SMS or email | The code arrives; it is random, not sequential or guessable |
| OTP-2 | Correct passcode → registration succeeds → redirect to dashboard | User becomes verified and is logged in |
| OTP-3 | Wrong passcode → error message | User stays unverified; message shown |

### Dashboard (§3)
| ID | Requirement | Acceptance check |
|----|-------------|------------------|
| DB-1 | Dashboard is protected: reachable only after sign-up or sign-in | Visiting it logged out redirects to login; the API also refuses without a valid token |
| DB-2 | A random balance is set once, at sign-up | Balance appears on first login and doesn't change on refresh |
| DB-3 | User sees balance and recent transactions | List shows counterparty email and signed amount |
| DB-4 | Sign Out button → back to login page | Token or session is gone; Back button doesn't reopen the dashboard |

### Login (§4)
| ID | Requirement | Acceptance check |
|----|-------------|------------------|
| LG-1 | Sign in with correct email and password | Redirect to dashboard |
| LG-2 | Wrong credentials → error message | Generic message. It doesn't reveal whether the email exists |

### Transaction (§5)
| ID | Requirement | Acceptance check |
|----|-------------|------------------|
| TX-1 | Send money by typing recipient email and amount, then Submit | Transfer happens; both balances change |
| TX-2 | Insufficient balance → error | Nothing changes for either user |
| TX-3 | Recipient email doesn't exist → error | Nothing changes |
| TX-4 | Sender sees a new record: receiver email and amount with `-` | Appears in sender's list |
| TX-5 | Receiver sees a new record: sender email and amount with `+` | Appears in receiver's list (and, in phase 7, live) |
| TX-6 | The amount is positive and has at most 2 decimal places | Zero, negative, non-numeric or over-precise amounts are rejected; nothing changes |
| TX-7 | A user can't send money to themselves | Rejected with an error; nothing changes |
| TX-8 | A transfer is all-or-nothing, even under concurrent requests | Both balances and the record(s) change together or not at all; two simultaneous transfers can't overdraw |

TX-6..8 are implied by the worksheet rather than written in it.

### Security (implied by the worksheet's keywords; phase 2 on)
| ID | Requirement | Acceptance check |
|----|-------------|------------------|
| SEC-1 | Passwords are stored only as a slow, salted hash | No plaintext or reversible password anywhere in storage or logs |
| SEC-2 | Login, OTP verify and OTP resend are rate-limited | Repeated attempts beyond the limit get 429 |
| SEC-3 | CORS allows only the app's own front-end origin; security headers are set | A request from another origin is refused; helmet headers present |
| SEC-4 | Errors don't reveal whether an email is registered (login, resend) | Same response for unknown email and wrong password |
| SEC-5 | Secrets, passwords, OTPs and tokens never appear in logs or responses | Log and response review in tests finds none |

### Contract (phase 1)
| ID | Requirement | Acceptance check |
|----|-------------|------------------|
| CT-1 | The REST API is defined in Swagger (OpenAPI) before implementation | `api/openapi.yaml` lints clean, opens in Swagger UI and imports into Postman; covers every phase-2 operation, error shapes and the auth scheme |
| CT-2 | Sequence diagrams for the main flows | Mermaid diagrams for sign-up + OTP, login and transfer render on GitHub |
| CT-3 | The phase-1 product decisions are recorded | An accepted ADR for each open decision 1–8 (§4) |

### Reserved prefixes (minted when their phase is specified)
`DM` Mongo (phase 3) · `DP` deployment (6) · `UX` Figma and theme (4, 5) · `RT` realtime (7) ·
`CB` chatbot (8) · `AI` assistant (9) · `DK` Docker (10) · `VC` video call (11) · `QA` tests
(12, 13). The table below is the worksheet's description they start from.

### Later-phase features
| Phase | Feature | What "done" looks like |
|-------|---------|------------------------|
| 7 | Transfer notification (WebSocket / Socket.IO) | Receiver's open dashboard shows the incoming transfer without a refresh |
| 8 | Customer-service chatbot (OpenAI package) | A chat widget answers general banking questions with an LLM |
| 9 | AI Banking Assistant (LangGraph + LangChain + OpenAI + JWT + MongoDB + Langfuse) | Explains the user's balance and recent transactions, guides them through a transfer, and answers banking questions, all from **that user's** data only. Conversation memory persists. Runs are traced in Langfuse |
| 10 | Backend in Docker | `docker compose up` runs the API (and a local Mongo) |
| 11 | Video call (Jitsi) between sender and receiver | One of them starts a call from a transfer; the other gets an invite and joins |
| 12 | Backend tests (Jest + Supertest) | Auth, OTP and transfer endpoints covered, including the error cases above |
| 13 | Front-end tests (Cypress) | E2E: sign up → verify → dashboard → transfer → sign out |

## 3. Phases (from the worksheet)

| # | Days | Prerequisites (study) | Deliverable |
|---|------|-----------------------|-------------|
| 1 | 2 | HTTP, REST + CRUD, Postman, Swagger, JWT theory | REST API defined in Swagger (OpenAPI); sequence diagrams |
| 2 | 2 | JS, TypeScript, Node.js, Express, JWT | Backend with **in-memory** storage (no DB); tested with Postman |
| 3 | 1 | MongoDB, Mongoose | DB schema (documented in Swagger); swap memory for Mongo |
| 4 | 0.5 | Figma (basic understanding) | Designs for 5 pages: Registration, Login, Logout, Money Transfer, Dashboard |
| 5 | 2 | HTML, CSS, JS, TypeScript, React, Material UI | Front end |
| 6 | (none given) | Render / Vercel | Deploy BE and FE |
| 7 | 2 | WebSocket, Socket.IO | Transfer notification between customers |
| 8 | 1 | OpenAI package | Customer-service chatbot using an LLM |
| 9 | 3 | LangGraph, LangChain, OpenAI API, Node.js API, JWT, MongoDB, Langfuse | AI Banking Assistant |
| 10 | 1 | Docker | Backend runs in Docker |
| 11 | 2 | Jitsi | Video call sender ↔ receiver |
| 12 | 1 | Jest + Supertest | Backend tests |
| 13 | 1 | Cypress | Front-end tests |

About **18.5 working days** plus deployment. The colours in the worksheet group the phases:
backend 1–3, front end 4–5, deploy 6, realtime and AI 7–9, infrastructure and video 10–11,
testing 12–13.

## 4. Open decisions

The design choices the worksheet leaves open, and where each is settled.

| # | Decision | Settled in |
|---|----------|------------|
| 1 | Verify by SMS or by email? (Email is free and testable; a Twilio trial texts only verified numbers) | [ADR-0001](decisions/0001-otp-by-email-and-passcode-rules.md) |
| 2 | When does the user record exist: unverified user, or separate pending sign-up? What happens to sign-ups never verified? | [ADR-0002](decisions/0002-pending-users-and-unique-email.md) |
| 3 | What stops a duplicate email: a pre-check, a unique index, or both? What happens when two sign-ups race? | [ADR-0002](decisions/0002-pending-users-and-unique-email.md) |
| 4 | How is money represented (float, integer minor units, Decimal128)? What range is the random balance? | [ADR-0003](decisions/0003-money-in-agorot-one-record-per-transfer.md) |
| 5 | Transfer records: one per transfer read by both sides, or one per side? How is it made all-or-nothing? | [ADR-0003](decisions/0003-money-in-agorot-one-record-per-transfer.md) |
| 6 | Where does the browser keep the login: a header token in memory/localStorage, or an httpOnly cookie (cross-site between `vercel.app` and `onrender.com`)? | [ADR-0004](decisions/0004-bearer-jwt-in-sessionstorage-client-logout.md) |
| 7 | What does logout mean on the server, given a JWT stays valid until it expires? | [ADR-0004](decisions/0004-bearer-jwt-in-sessionstorage-client-logout.md) |
| 8 | Passcode rules: validity, wrong-try limit, resend rate | [ADR-0001](decisions/0001-otp-by-email-and-passcode-rules.md) |
| 9 | Who starts the video call, and how does the other side find out? | an ADR at phase 11 |
| 10 | What may the banking assistant do: read-only, or start a transfer behind a human confirmation? | an ADR at phase 9 |
