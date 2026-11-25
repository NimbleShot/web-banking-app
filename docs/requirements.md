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

### Password reset (added; not in the worksheet)
| ID | Requirement | Acceptance check |
|----|-------------|------------------|
| PW-1 | A verified user who forgot their password sets a new one with a 6-digit passcode sent to their email | The new password logs in and the old one doesn't. Asking for a code gives the same answer whether or not the email is registered |

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
| TX-9 | A repeated transfer request moves money once (phase 6) | Every transfer carries a one-time key, or is refused. A repeat with the same key, even two sent at once, moves nothing and answers with the first transfer's record and the balance now; the same key with another recipient or amount is refused. The front end sends a new key per transfer |

TX-6..8 are implied by the worksheet rather than written in it. TX-9 was added in phase 6: a
browser can resend a request whose answer was lost.

### Security (implied by the worksheet's keywords; phase 2 on)
| ID | Requirement | Acceptance check |
|----|-------------|------------------|
| SEC-1 | Passwords are stored only as a slow, salted hash | No plaintext or reversible password anywhere in storage or logs |
| SEC-2 | Sign-up, login, OTP verify and resend, and password reset are rate-limited | Repeated attempts beyond the limit get 429 |
| SEC-3 | CORS allows only the app's own front-end origin; security headers are set | A request from another origin is refused; helmet headers present |
| SEC-4 | Errors don't reveal whether an email is registered (login, resend) | Same response for unknown email and wrong password |
| SEC-5 | Secrets, passwords, OTPs and tokens never appear in logs or responses | Log and response review in tests finds none |
| SEC-6 | A client that hangs up before the answer still counts against the email limit (phase 3) | Requests abandoned mid-way count like answered ones; only the limiter's own 429 is given back |

### Contract (phases 1–2)
| ID | Requirement | Acceptance check |
|----|-------------|------------------|
| CT-1 | The REST API is defined in Swagger (OpenAPI) before implementation | `api/openapi.yaml` lints clean, opens in Swagger UI and imports into Postman; covers every phase-2 operation, error shapes and the auth scheme |
| CT-2 | Sequence diagrams for the main flows | Mermaid diagrams for sign-up + OTP, login and transfer render on GitHub |
| CT-3 | The phase-1 product decisions are recorded | An accepted ADR for each open decision 1–8 (§4) |
| CT-4 | The server enforces the contract at run time (phase 2) | A request that breaks it gets 400 with an error per field; an unknown path or method gets 404 `NOT_FOUND`; every response in the tests is validated against it |

### MongoDB (phase 3)
| ID | Requirement | Acceptance check |
|----|-------------|------------------|
| DM-1 | With a database address set, the app keeps its data in MongoDB | The flow from sign-up to transfer works on the database, and a restarted server still knows the users and their transfers |
| DM-2 | The database refuses a second user for one email | Two inserts racing for one email leave one user; the other gets the duplicate-email error |
| DM-3 | A transfer on MongoDB is one transaction | A write that fails midway leaves both balances and the records unchanged; two simultaneous transfers can't overdraw |
| DM-4 | The passcode rules hold on MongoDB under concurrent requests | Wrong tries sent at once all count; resends sent at once store one passcode; a pending sign-up older than 24 hours counts as absent; a reset passcode works once |
| DM-5 | The storage layout is documented in Swagger | The contract's description lists the collections, their keys, fields and indexes, and lints clean |
| DM-6 | Without a database address the server runs on in-memory storage, never in production | Development starts on memory; production without an address is refused, naming the variable; an unreachable database stops start-up with an error that never shows the address's password |

### User interface (phase 5)
| ID | Requirement | Acceptance check |
|----|-------------|------------------|
| UX-1 | The front end runs on the API in the app's visual design | The client builds and is part of the repo's checks; every screen uses the design's colours, fonts, glass card and background |
| UX-2 | Sign-up and passcode screens | Valid details and the right code reach the dashboard. Each bad field, a taken email and a wrong code show their error. Tries left are shown; at zero the field locks and offers a new code. Israeli mobile numbers only. The password and phone are never written to browser storage |
| UX-3 | Sign-in and sign-out screens | Correct details reach the dashboard; wrong ones show one message that marks both fields. Sign-out removes the token, shows a notice at login, and Back doesn't reopen the dashboard |
| UX-4 | Password reset screens | Any well-formed email gets the same wording. A correct code with a matching new password ends at sign-in with a success notice. A wrong code shows tries left and locks at zero; a retype mismatch costs no try |
| UX-5 | Dashboard screen | Signed-out visitors go to login. The balance and the newest 20 transactions show counterparty, signed amount and date. A new account shows the empty state |
| UX-6 | Send-money screen | A valid transfer returns to the dashboard with the server's balance and record. Amounts become integer agorot without floating point. Each named error shows on its field and moves nothing |
| UX-7 | Failure and session states | An ended session returns to login with a notice; a wrong code or password stays on its screen. Rate limits and server or connection failures show a message. A transfer whose answer was lost asks the user to check their transactions and is never retried automatically |
| UX-8 | A browser test covers the main journey | Against a real server: sign up, read the code, reach the dashboard, send money, sign out |
| UX-9 | Animated screen changes | Between sign-in, sign-up, code and reset screens the card slides and reshapes while the hero fades. The new form takes keyboard focus. With reduced motion, screens switch at once |
| UX-10 | Animated balance after a transfer | The signed amount appears above the balance and both count until it is used up. Every frame adds up to the true balance in agorot and ends on the server's value. With reduced motion, the new balance appears at once |

### Deployment (phase 6)
| ID | Requirement | Acceptance check |
|----|-------------|------------------|
| DP-1 | In production, passcodes are emailed through an HTTP email API | With the API's mailer the server starts in production and sends each passcode through the API. A missing key or sender address stops start-up, naming the variable. A failed send is logged with its status only |
| DP-2 | Passcode emails are sent after the answer | Sign-up, resend and password-reset requests answer without waiting for the email. A registered and an unknown email get the same answer to a reset request, even when the send fails |
| DP-3 | Outside production the server accepts connections from its own machine only | A development or test server listens on the loopback address; a production server listens on every interface |
| DP-4 | The API and the front end deploy from the repository | A deploy file describes both services. The server runs from a compiled build. The built front end finds the API by its address, serves deep links, and sends a content security policy |
| DP-5 | The deployed app works end to end | On the deployed app, accounts signed up with emailed codes log in and transfer money, and each side sees the record. The page's security policy blocks nothing the app needs. A forged `X-Forwarded-For` doesn't change the client the rate limits count |

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
| 2 | When does the user record exist: unverified user, or separate pending sign-up? What happens to sign-ups never verified? | [ADR-0002](decisions/0002-pending-users-and-unique-email.md), superseded in part by [ADR-0007](decisions/0007-sign-up-sets-credentials-at-verification.md) |
| 3 | What stops a duplicate email: a pre-check, a unique index, or both? What happens when two sign-ups race? | [ADR-0002](decisions/0002-pending-users-and-unique-email.md), superseded in part by [ADR-0007](decisions/0007-sign-up-sets-credentials-at-verification.md) |
| 4 | How is money represented (float, integer minor units, Decimal128)? What range is the random balance? | [ADR-0003](decisions/0003-money-in-agorot-one-record-per-transfer.md) |
| 5 | Transfer records: one per transfer read by both sides, or one per side? How is it made all-or-nothing? | [ADR-0003](decisions/0003-money-in-agorot-one-record-per-transfer.md) |
| 6 | Where does the browser keep the login: a header token in memory/localStorage, or an httpOnly cookie (cross-site between `vercel.app` and `onrender.com`)? | [ADR-0004](decisions/0004-bearer-jwt-in-sessionstorage-client-logout.md), its 401 handling narrowed by [ADR-0015](decisions/0015-only-an-ended-session-signs-out.md) |
| 7 | What does logout mean on the server, given a JWT stays valid until it expires? | [ADR-0004](decisions/0004-bearer-jwt-in-sessionstorage-client-logout.md) |
| 8 | Passcode rules: validity, wrong-try limit, resend rate | [ADR-0001](decisions/0001-otp-by-email-and-passcode-rules.md) |
| 9 | Who starts the video call, and how does the other side find out? | an ADR at phase 11 |
| 10 | What may the banking assistant do: read-only, or start a transfer behind a human confirmation? | an ADR at phase 9 |
