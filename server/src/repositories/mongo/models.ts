// The MongoDB collections (docs/decisions/0013). The layout is documented in api/openapi.yaml's
// description; keep the two in step.
import mongoose, { type Connection, Schema, type Types } from 'mongoose';
import { HOUR_MS, type PasscodeState } from '../../services/passcodes';
import { PENDING_SIGN_UP_TTL_MS } from '../pending-sign-ups';

export type UserDocument = {
  /** A random UUID, the token's `sub`. */
  _id: string;
  /** Lowercased; unique. */
  email: string;
  phone: string;
  passwordHash: string;
  /** Integer agorot. */
  balance: number;
  createdAt: Date;
};

export type PendingSignUpDocument = {
  /** The lowercased email. */
  _id: string;
  createdAt: Date;
  passcode: PasscodeState;
};

export type PasswordResetDocument = {
  /** The lowercased email. */
  _id: string;
  passcode: PasscodeState;
  used: boolean;
};

export type TransactionDocument = {
  /** MongoDB's own id: same-instant records sort in the order they were stored. */
  _id: Types.ObjectId;
  fromUserId: string;
  toUserId: string;
  fromEmail: string;
  toEmail: string;
  /** Positive integer agorot. */
  amount: number;
  createdAt: Date;
  /** The request's one-time key (docs/decisions/0016); absent on a transfer stored without one. */
  idempotencyKey?: string;
};

/**
 * How long after the rules stop counting a record an expiry index may remove it. The rules
 * compare times with the app's clock and the index uses the database's, so the margin absorbs
 * any difference: the index only ever removes what the rules already treat as absent.
 */
const EXPIRY_MARGIN_S = 60 * 60;

const options = { versionKey: false } as const;

const passcodeSchema = new Schema<PasscodeState>(
  {
    hmac: { type: String, required: true },
    issuedAt: { type: Date, required: true },
    wrongTries: { type: Number, required: true },
    sentAt: { type: [Date], required: true },
  },
  { _id: false },
);

const userSchema = new Schema<UserDocument>(
  {
    _id: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    phone: { type: String, required: true },
    passwordHash: { type: String, required: true },
    balance: { type: Number, required: true },
    createdAt: { type: Date, required: true },
  },
  { ...options, collection: 'users' },
);

const pendingSignUpSchema = new Schema<PendingSignUpDocument>(
  {
    _id: { type: String, required: true },
    createdAt: { type: Date, required: true },
    passcode: { type: passcodeSchema, required: true },
  },
  { ...options, collection: 'pendingSignUps' },
);
pendingSignUpSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: PENDING_SIGN_UP_TTL_MS / 1000 + EXPIRY_MARGIN_S },
);

const passwordResetSchema = new Schema<PasswordResetDocument>(
  {
    _id: { type: String, required: true },
    passcode: { type: passcodeSchema, required: true },
    used: { type: Boolean, required: true },
  },
  { ...options, collection: 'passwordResets' },
);
// An hour after the last send, a reset record affects no rule: its code expired and the cooldown
// and the cap count no send of it.
passwordResetSchema.index(
  { 'passcode.issuedAt': 1 },
  { expireAfterSeconds: HOUR_MS / 1000 + EXPIRY_MARGIN_S },
);

const transactionSchema = new Schema<TransactionDocument>(
  {
    fromUserId: { type: String, required: true },
    toUserId: { type: String, required: true },
    fromEmail: { type: String, required: true },
    toEmail: { type: String, required: true },
    amount: { type: Number, required: true },
    createdAt: { type: Date, required: true },
    idempotencyKey: { type: String },
  },
  { ...options, collection: 'transactions' },
);
// Each side's list, newest first.
transactionSchema.index({ fromUserId: 1, createdAt: -1 });
transactionSchema.index({ toUserId: 1, createdAt: -1 });
// One record per sender and key (docs/decisions/0016). Partial: records stored without a key don't
// collide with each other.
transactionSchema.index(
  { fromUserId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } },
);

function createModels(connection: Connection) {
  return {
    users: connection.model('User', userSchema),
    pendingSignUps: connection.model('PendingSignUp', pendingSignUpSchema),
    passwordResets: connection.model('PasswordReset', passwordResetSchema),
    transactions: connection.model('Transaction', transactionSchema),
  };
}

export type Models = ReturnType<typeof createModels>;

/** An open connection and its models, with every collection and index in place. */
export type MongoStore = { connection: Connection; models: Models };

/**
 * Thrown when the database can't be reached or prepared. The message names the variable and the
 * driver's error class, never the address: it can carry a password.
 */
export class StorageError extends Error {
  constructor(cause: unknown) {
    const kind = cause instanceof Error ? cause.name : 'unknown error';
    super(`Could not open the MongoDB database at MONGODB_URI (${kind})`);
    this.name = 'StorageError';
  }
}

/**
 * Connects and waits until every collection and index exists, so the unique email index refuses
 * a duplicate from the first request and no transaction has to create a collection.
 */
export async function connectMongo(uri: string): Promise<MongoStore> {
  const connection = mongoose.createConnection(uri);
  try {
    await connection.asPromise();
    const models = createModels(connection);
    await Promise.all(Object.values(models).map((model) => model.init()));
    return { connection, models };
  } catch (error) {
    await connection.close().catch(() => undefined);
    throw new StorageError(error);
  }
}

/** True for MongoDB's duplicate-key error (code 11000): a unique key or `_id` already exists. */
export function isDuplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;
}
