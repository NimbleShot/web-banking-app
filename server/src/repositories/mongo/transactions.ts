// Transfers and their records in MongoDB (docs/decisions/0003, 0013): one record per transfer,
// read by both sides, and the money move as one transaction.
import { type ClientSession, type Connection, Types } from 'mongoose';
import type {
  TransactionRecord,
  TransactionRepository,
  TransferOutcome,
  TransferRequest,
} from '../transactions';
import type { Models, TransactionDocument, UserDocument } from './models';

const toRecord = (doc: TransactionDocument): TransactionRecord => ({
  id: doc._id.toHexString(),
  fromUserId: doc.fromUserId,
  toUserId: doc.toUserId,
  fromEmail: doc.fromEmail,
  toEmail: doc.toEmail,
  amount: doc.amount,
  createdAt: doc.createdAt,
});

/**
 * The transfer is one transaction: the checks, the conditional debit, the credit and the record
 * commit together or not at all (TX-8). Two transfers that touch the same balance conflict, and
 * MongoDB re-runs the later one, which then sees the new balance.
 */
export class MongoTransactionRepository implements TransactionRepository {
  constructor(
    protected readonly connection: Connection,
    protected readonly models: Models,
  ) {}

  transfer({ fromUserId, toEmail, amount, at }: TransferRequest): Promise<TransferOutcome> {
    return this.connection.transaction(async (session): Promise<TransferOutcome> => {
      const { users } = this.models;
      const sender = await users.findById(fromUserId).session(session).lean<UserDocument>();
      if (!sender) return { result: 'unknown-sender' };
      // The contract's checks (400) came first; then self, recipient and funds, in that order.
      const recipient = await users
        .findOne({ email: toEmail.toLowerCase() })
        .session(session)
        .lean<UserDocument>();
      if (recipient?._id === sender._id) return { result: 'self-transfer' };
      if (!recipient) return { result: 'recipient-not-found' };
      const balance = await this.debit(session, sender._id, amount);
      if (balance === undefined) return { result: 'insufficient-funds' };
      await this.credit(session, recipient._id, amount);
      const record = await this.insertRecord(session, {
        _id: new Types.ObjectId(),
        fromUserId: sender._id,
        toUserId: recipient._id,
        fromEmail: sender.email,
        toEmail: recipient.email,
        amount,
        createdAt: new Date(at),
      });
      return { result: 'done', record, balance };
    });
  }

  async listFor(userId: string, limit: number): Promise<TransactionRecord[] | undefined> {
    if (!(await this.models.users.exists({ _id: userId }))) return undefined;
    // Newest first: the later creation time first and, at the same instant, the later-stored one.
    const docs = await this.models.transactions
      .find({ $or: [{ fromUserId: userId }, { toUserId: userId }] })
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit)
      .lean<TransactionDocument[]>();
    return docs.map(toRecord);
  }

  // The transaction's three writes, each its own method so a test can make one of them fail.
  // Each must pass `session`: a write without it would happen outside the transaction.

  /** The conditional debit: the new balance, or undefined (nothing changes) when it doesn't cover `amount`. */
  protected async debit(
    session: ClientSession,
    userId: string,
    amount: number,
  ): Promise<number | undefined> {
    const updated = await this.models.users
      .findOneAndUpdate(
        { _id: userId, balance: { $gte: amount } },
        { $inc: { balance: -amount } },
        { session, returnDocument: 'after' },
      )
      .lean<UserDocument>();
    return updated?.balance;
  }

  protected async credit(session: ClientSession, userId: string, amount: number): Promise<void> {
    await this.models.users.updateOne({ _id: userId }, { $inc: { balance: amount } }, { session });
  }

  protected async insertRecord(
    session: ClientSession,
    record: TransactionDocument,
  ): Promise<TransactionRecord> {
    await this.models.transactions.insertMany([record], { session });
    return toRecord(record);
  }
}
