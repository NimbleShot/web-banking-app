# Transfer

Operation `createTransfer` in [`api/openapi.yaml`](../../api/openapi.yaml). Money in agorot, one
record per transfer and the conditional debit:
[ADR-0003](../decisions/0003-money-in-agorot-one-record-per-transfer.md). The debit, the credit
and the record are one MongoDB transaction: either all three are committed, or the transaction
is aborted and nothing changed (rollback). The one-time key that makes a repeated request move
money once: [ADR-0016](../decisions/0016-transfer-idempotency-key.md).

```mermaid
sequenceDiagram
    autonumber
    actor U as User
    participant C as Client (React)
    participant API as API (Express)
    participant DB as MongoDB

    U->>C: recipient email, amount in shekels
    C->>C: 12.50 becomes 1250 agorot, and a new one-time key
    C->>API: POST /api/v1/transfers
    Note over C,API: Authorization: Bearer token, Idempotency-Key: a UUID per transfer
    alt token missing, invalid or expired
        API-->>C: 401 UNAUTHORIZED
    else a field is invalid (amount not a positive integer, bad email, no UUID key)
        API-->>C: 400 VALIDATION_FAILED
    else
        Note over API: sender = the token's sub, never a request field
        API->>DB: startTransaction
        API->>DB: find the sender by the token's sub
        alt the sender is gone since the token check
            API->>DB: abortTransaction
            API-->>C: 401 UNAUTHORIZED
        else the sender has a record with this key, same recipient and amount
            Note over API,DB: a repeat (e.g. resent by the browser): nothing is written
            API->>DB: commitTransaction
            API-->>C: 201 TransferResult (the first record, the balance now)
        else the sender has a record with this key, another recipient or amount
            API->>DB: abortTransaction
            API-->>C: 422 IDEMPOTENCY_KEY_REUSED
        else
            API->>DB: find verified user by toEmail (any letter case)
            alt that user is the sender
                API->>DB: abortTransaction
                API-->>C: 422 SELF_TRANSFER
            else no such user, or the user is pending
                API->>DB: abortTransaction
                API-->>C: 422 RECIPIENT_NOT_FOUND
            else
                API->>DB: debit sender only if balance >= amount
                alt no document matched (balance too low)
                    API->>DB: abortTransaction (rollback)
                    API-->>C: 422 INSUFFICIENT_FUNDS
                else debited
                    API->>DB: credit the recipient
                    API->>DB: insert the transaction record, with the key
                    alt any write fails
                        API->>DB: abortTransaction (rollback: debit, credit and record undone)
                        API-->>C: 500 INTERNAL_ERROR
                    else all three written
                        API->>DB: commitTransaction
                        API-->>C: 201 TransferResult (record, new balance)
                        C->>U: show the new balance
                    end
                end
            end
        end
    end
```
