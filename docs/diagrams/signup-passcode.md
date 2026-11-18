# Sign-up and passcode verification

Operations `signUp`, `verifyOtp` and `resendOtp` in [`api/openapi.yaml`](../../api/openapi.yaml).
Passcode rules: [ADR-0001](../decisions/0001-otp-by-email-and-passcode-rules.md); pending
sign-ups and why the password is saved only with the passcode:
[ADR-0007](../decisions/0007-sign-up-sets-credentials-at-verification.md); token:
[ADR-0004](../decisions/0004-bearer-jwt-in-sessionstorage-client-logout.md). Every answer
names its status and, for errors, the `code` of the problem document.

```mermaid
sequenceDiagram
    autonumber
    actor U as User
    participant C as Client (React)
    participant API as API (Express)
    participant DB as MongoDB
    participant M as Mailer

    U->>C: email, password, phone
    C->>API: POST /api/v1/auth/signup
    alt a field is invalid
        API-->>C: 400 VALIDATION_FAILED (errors per field)
    else too many requests from this client
        API-->>C: 429 RATE_LIMITED (Retry-After)
    else
        API->>DB: look up a verified user with the lowercased email
        alt the email belongs to a verified user
            API-->>C: 409 EMAIL_TAKEN
        else a sign-up is already pending (less than 24 h old)
            Note over API,M: a resend: new passcode only outside<br/>the 60 s cooldown and 5 per hour cap
            API-->>C: 202 PendingSignUp (same answer as a new sign-up)
        else
            API->>DB: insert pending sign-up: lowercased email,<br/>HMAC of the passcode (valid 10 min), kept 24 h<br/>(no password or phone yet)
            API->>M: send the 6-digit passcode
            API-->>C: 202 PendingSignUp
        end
        C->>C: keep password and phone in memory<br/>for the passcode screen
    end

    M-->>U: email with the passcode
    U->>C: types the passcode
    C->>API: POST /api/v1/auth/otp/verify (email, passcode, password, phone)
    alt a field is invalid
        API-->>C: 400 VALIDATION_FAILED
    else too many requests from this client
        API-->>C: 429 RATE_LIMITED (Retry-After)
    else wrong passcode, tries left
        API->>DB: count the wrong try
        API-->>C: 401 PASSCODE_INVALID
    else expired (10 min), used up (5 wrong tries), or no pending sign-up
        API-->>C: 401 PASSCODE_INVALID (same answer, reveals nothing)
    else correct passcode
        API->>DB: use up the passcode: delete the pending sign-up<br/>(a second request with it gets 401 PASSCODE_INVALID)
        API->>API: hash the password (argon2id)
        API->>DB: create the verified user: password hash, phone,<br/>random balance (the unique index refuses a second one)
        API-->>C: 200 AccessToken (JWT, 1 hour)
        C->>C: keep the token in sessionStorage
    end

    opt the user asks for a new passcode
        C->>API: POST /api/v1/auth/otp/resend
        alt too many requests from this client
            API-->>C: 429 RATE_LIMITED (Retry-After)
        else a pending sign-up, outside the 60 s cooldown and 5 per hour cap
            API->>DB: replace the passcode HMAC, new 10 min expiry, reset tries
            API->>M: send the new passcode
            API-->>C: 202 Accepted
        else no pending sign-up, or inside the cooldown or the cap
            Note over API: nothing is sent
            API-->>C: 202 Accepted (same answer, reveals nothing)
        end
    end
```
