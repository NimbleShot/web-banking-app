# Sign-up and passcode verification

Operations `signUp`, `verifyOtp` and `resendOtp` in [`api/openapi.yaml`](../../api/openapi.yaml).
Passcode rules: [ADR-0001](../decisions/0001-otp-by-email-and-passcode-rules.md); pending users:
[ADR-0002](../decisions/0002-pending-users-and-unique-email.md); token:
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
    else
        API->>DB: find user by lowercased email
        alt the email belongs to a verified user
            API-->>C: 409 EMAIL_TAKEN
        else new email, or the email of a pending user
            API->>DB: save pending user (replaces a pending one)<br/>password hash, random balance,<br/>HMAC of the passcode, expires in 10 min
            API->>M: send the 6-digit passcode
            API-->>C: 201 PendingSignUp
        end
    end

    M-->>U: email with the passcode
    U->>C: types the passcode
    C->>API: POST /api/v1/auth/otp/verify
    alt a field is invalid
        API-->>C: 400 VALIDATION_FAILED
    else too many requests from this client
        API-->>C: 429 RATE_LIMITED (Retry-After)
    else wrong passcode, tries left
        API->>DB: count the wrong try
        API-->>C: 401 PASSCODE_INVALID
    else expired (10 min), used up (5 wrong tries), or no pending user
        API-->>C: 401 PASSCODE_INVALID (same answer, reveals nothing)
    else correct passcode
        API->>DB: mark the user verified, delete the passcode
        API-->>C: 200 AccessToken (JWT, 1 hour)
        C->>C: keep the token in sessionStorage
    end

    opt the user asks for a new passcode
        C->>API: POST /api/v1/auth/otp/resend
        alt too many requests from this client
            API-->>C: 429 RATE_LIMITED (Retry-After)
        else a pending user, outside the 60 s cooldown and 5 per hour cap
            API->>DB: replace the passcode HMAC, new 10 min expiry, reset tries
            API->>M: send the new passcode
            API-->>C: 202 Accepted
        else no pending user, or inside the cooldown or the cap
            Note over API: nothing is sent
            API-->>C: 202 Accepted (same answer, reveals nothing)
        end
    end
```
