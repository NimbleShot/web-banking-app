# Login

Operations `login` and `getMe` in [`api/openapi.yaml`](../../api/openapi.yaml). Token and its
storage: [ADR-0004](../decisions/0004-bearer-jwt-in-sessionstorage-client-logout.md). A pending
sign-up has no password yet, so login treats it as an unknown email
([ADR-0007](../decisions/0007-sign-up-sets-credentials-at-verification.md)); it is finished with
the passcode flow in [signup-passcode.md](signup-passcode.md). A forgotten password is reset
with [password-reset.md](password-reset.md).

```mermaid
sequenceDiagram
    autonumber
    actor U as User
    participant C as Client (React)
    participant API as API (Express)
    participant DB as MongoDB

    U->>C: email, password
    C->>API: POST /api/v1/auth/login
    alt a field is invalid
        API-->>C: 400 VALIDATION_FAILED
    else too many requests from this client
        API-->>C: 429 RATE_LIMITED (Retry-After)
    else
        API->>DB: find verified user by lowercased email
        alt unknown email, a sign-up still pending, or the password does not match its hash
            API-->>C: 401 INVALID_CREDENTIALS (same answer for all three)
            C->>U: offer "forgot password"
        else right password
            API->>API: sign JWT, sub = user id, expires in 1 hour
            API-->>C: 200 AccessToken
            C->>C: keep the token in sessionStorage
        end
    end

    Note over C,API: Later requests carry Authorization: Bearer token
    C->>API: GET /api/v1/me
    alt token missing, invalid or expired
        API-->>C: 401 UNAUTHORIZED
        C->>U: back to the login page
    else valid token
        API->>DB: find user by the token's sub (never by a request field)
        API-->>C: 200 Account (balance in agorot)
    end
```
