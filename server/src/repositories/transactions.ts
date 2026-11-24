// Transfers and their records (docs/decisions/0003, 0009): one record per transfer, read by both
// sides, and the money move as one step.
import { randomUUID } from 'node:crypto';
import type { InMemoryUserRepository, User } from './users';

/** One transfer, as both sides read it (docs/decisions/0003). */
export type TransactionRecord = {
  id: string;
  fromUserId: string;
  toUserId: string;
  /** The sender's stored (lowercased) email. */
  fromEmail: string;
  /** The recipient's stored (lowercased) email. */
  toEmail: string;
  /** Positive integer agorot. */
  amount: number;
  createdAt: Date;
};

export type TransferRequest = {
  /** The token's user, never a request field. */
  fromUserId: string;
  /** As the sender typed it, in any letter case. */
  toEmail: string;
  /** Positive integer agorot. */
  amount: number;
  /** The record's time, from the app's clock. */
  at: Date;
  /**
   * The request's one-time key (docs/decisions/0016), kept with the record. The contract requires
   * it on every request; a transfer stored without one is never matched as a repeat.
   */
  idempotencyKey?: string;
};

export type TransferOutcome =
  /** Also a repeat of an earlier transfer: its record, the balance now, and nothing written. */
  | { result: 'done'; record: TransactionRecord; balance: number }
  /** The sender is no longer in the store (it was there at the token check). */
  | { result: 'unknown-sender' }
  /** The sender's key belongs to a transfer with another recipient or amount. */
  | { result: 'key-reused' }
  | { result: 'self-transfer' }
  | { result: 'recipient-not-found' }
  | { result: 'insufficient-funds' };

/** A repeat names the earlier transfer's recipient (in any letter case) and amount. */
export function isRepeatOf(record: TransactionRecord, toEmail: string, amount: number): boolean {
  return record.toEmail === toEmail.toLowerCase() && record.amount === amount;
}

export type TransactionRepository = {
  /**
   * The whole money move as one step: the sender's key, the checks, the conditional debit, the
   * credit and the record, all or nothing. A key the sender already used writes nothing.
   */
  transfer(request: TransferRequest): Promise<TransferOutcome>;
  /**
   * The user's records, sent and received, newest first, at most `limit`; undefined when the user
   * is no longer in the store.
   */
  listFor(userId: string, limit: number): Promise<TransactionRecord[] | undefined>;
};

const copy = (record: TransactionRecord): TransactionRecord => structuredClone(record);

/**
 * Records in the order they were stored. Each method is one step with no `await` inside, so
 * concurrent transfers run one after another: the funds check and the debit always see the same
 * balance (TX-8.a). The balances are the user store's own records, changed in place.
 */
export class InMemoryTransactionRepository implements TransactionRepository {
  private readonly records: TransactionRecord[] = [];
  /** Each stored key's record, by sender and key; MongoDB keeps the key on the record itself. */
  private readonly byKey = new Map<string, TransactionRecord>();

  constructor(private readonly users: InMemoryUserRepository) {}

  async transfer({
    fromUserId,
    toEmail,
    amount,
    at,
    idempotencyKey,
  }: TransferRequest): Promise<TransferOutcome> {
    const sender = this.users.storedById(fromUserId);
    if (!sender) return { result: 'unknown-sender' };
    // A key the sender already used: its transfer happened, so nothing is checked or written.
    const keyOf = idempotencyKey === undefined ? undefined : `${sender.id}\n${idempotencyKey}`;
    const earlier = keyOf === undefined ? undefined : this.byKey.get(keyOf);
    if (earlier) {
      if (!isRepeatOf(earlier, toEmail, amount)) return { result: 'key-reused' };
      return { result: 'done', record: copy(earlier), balance: sender.balance };
    }
    // The contract's checks (400) came first; then self, recipient and funds, in that order.
    const recipient = this.users.storedByEmail(toEmail);
    if (recipient?.id === sender.id) return { result: 'self-transfer' };
    if (!recipient) return { result: 'recipient-not-found' };
    // From here the step writes. If any write throws, everything it changed is put back before
    // the error goes on, as a MongoDB transaction aborts (TX-8.b).
    const start = {
      senderBalance: sender.balance,
      recipientBalance: recipient.balance,
      records: this.records.length,
    };
    try {
      if (!this.debit(sender, amount)) return { result: 'insufficient-funds' };
      this.credit(recipient, amount);
      const record: TransactionRecord = {
        id: randomUUID(),
        fromUserId: sender.id,
        toUserId: recipient.id,
        fromEmail: sender.email,
        toEmail: recipient.email,
        amount,
        createdAt: new Date(at),
      };
      this.insertRecord(record);
      if (keyOf !== undefined) this.byKey.set(keyOf, record);
      return { result: 'done', record: copy(record), balance: sender.balance };
    } catch (error) {
      sender.balance = start.senderBalance;
      recipient.balance = start.recipientBalance;
      // Records are only ever appended, and nothing else ran during the step.
      this.records.length = start.records;
      if (keyOf !== undefined) this.byKey.delete(keyOf);
      throw error;
    }
  }

  async listFor(userId: string, limit: number): Promise<TransactionRecord[] | undefined> {
    if (!this.users.storedById(userId)) return undefined;
    // Newest first: the later creation time first and, at the same instant, the later-stored one
    // (the sort is stable over the records taken newest-stored first).
    return this.records
      .filter((record) => record.fromUserId === userId || record.toUserId === userId)
      .reverse()
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit)
      .map(copy);
  }

  // The step's three writes, each its own method so a test can make one of them fail.

  /** The conditional debit: false, and nothing changes, when the balance does not cover it. */
  protected debit(sender: User, amount: number): boolean {
    if (sender.balance < amount) return false;
    sender.balance -= amount;
    return true;
  }

  protected credit(recipient: User, amount: number): void {
    recipient.balance += amount;
  }

  protected insertRecord(record: TransactionRecord): void {
    this.records.push(record);
  }

  /** Copies of every stored record, oldest first, for inspection. */
  snapshot(): TransactionRecord[] {
    return this.records.map(copy);
  }
}
