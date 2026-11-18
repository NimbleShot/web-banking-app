// Sending money and reading the transaction list (TX-1..TX-8, DB-3).
import type { Clock } from '../clock';
import type { TransactionRecord, TransactionRepository } from '../repositories/transactions';

/** One transfer as one user reads it: the other side's email and the amount signed from theirs. */
export type Transaction = {
  id: string;
  counterpartyEmail: string;
  /** Negative when the reader sent it, positive when they received it. */
  amount: number;
  createdAt: Date;
};

export type SendOutcome =
  | { result: 'sent'; transaction: Transaction; balance: number }
  | { result: 'unknown-sender' | 'self-transfer' | 'recipient-not-found' | 'insufficient-funds' };

export type TransferService = {
  /** Moves `amount` agorot from the user to the verified user with `toEmail`, or says why not. */
  send(userId: string, toEmail: string, amount: number): Promise<SendOutcome>;
  /** The user's transactions, newest first, at most `limit`; undefined when the user is gone. */
  list(userId: string, limit: number): Promise<Transaction[] | undefined>;
};

/** The record as `readerId` reads it: the other side's email, the amount signed from theirs. */
function asReadBy(record: TransactionRecord, readerId: string): Transaction {
  const sent = record.fromUserId === readerId;
  return {
    id: record.id,
    counterpartyEmail: sent ? record.toEmail : record.fromEmail,
    amount: sent ? -record.amount : record.amount,
    createdAt: record.createdAt,
  };
}

export function createTransferService(deps: {
  transactions: TransactionRepository;
  clock: Clock;
}): TransferService {
  return {
    async send(userId, toEmail, amount) {
      // Every check and the balances are read inside the store's one step, never before it.
      const outcome = await deps.transactions.transfer({
        fromUserId: userId,
        toEmail,
        amount,
        at: deps.clock.now(),
      });
      if (outcome.result !== 'done') return { result: outcome.result };
      return {
        result: 'sent',
        transaction: asReadBy(outcome.record, userId),
        balance: outcome.balance,
      };
    },

    async list(userId, limit) {
      const records = await deps.transactions.listFor(userId, limit);
      return records?.map((record) => asReadBy(record, userId));
    },
  };
}
