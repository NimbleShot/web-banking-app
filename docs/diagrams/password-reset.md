# Password reset

Operations `requestPasswordReset` and `resetPassword` in [`api/openapi.yaml`](../../api/openapi.yaml).
The reset passcode follows the sign-up passcode's rules
([ADR-0001](../decisions/0001-otp-by-email-and-passcode-rules.md)); the reset itself:
[ADR-0008](../decisions/0008-password-reset-by-emailed-passcode.md). Neither answer reveals
whether the email is registered.

```mermaid
sequenceDiagram
    autonumber
    actor U as User
    participant C as Client (React)
    participant API as API (Express)
    participant DB as MongoDB
    participant M as Mailer

    U->>C: "forgot password", email
    C->>API: POST /api/v1/auth/password/forgot
    alt a field is invalid
        API-->>C: 400 VALIDATION_FAILED
    else too many requests from this client
        API-->>C: 429 RATE_LIMITED (Retry-After)
    else a verified user, outside the 60 s cooldown and 5 per hour cap
        API->>DB: save the reset passcode's HMAC, expires in 10 min, 5 tries
        API->>M: send the 6-digit reset passcode
        API-->>C: 202 Accepted
    else unknown or pending email, or inside the cooldown or the cap
        Note over API: nothing is sent
        API-->>C: 202 Accepted (same answer, reveals nothing)
    end

    M-->>U: email with the reset passcode
    U->>C: passcode, new password
    C->>API: POST /api/v1/auth/password/reset
    alt a field is invalid (e.g. the new password is too short)
        API-->>C: 400 VALIDATION_FAILED
    else too many requests from this client
        API-->>C: 429 RATE_LIMITED (Retry-After)
    else wrong passcode, tries left
        API->>DB: count the wrong try
        API-->>C: 401 PASSCODE_INVALID
    else expired (10 min), used up (5 wrong tries), or no reset asked for
        API-->>C: 401 PASSCODE_INVALID (same answer, reveals nothing)
    else correct passcode
        API->>DB: replace the password hash, delete the reset passcode
        Note over API: tokens issued earlier stay valid until they expire (1 hour)
        API-->>C: 204 No Content
        C->>U: go to the login page
    end
```
