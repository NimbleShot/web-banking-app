// Verified users in MongoDB (docs/decisions/0002, 0007, 0013).
import { randomUUID } from 'node:crypto';
import { DuplicateEmailError, type NewUser, type User, type UserRepository } from '../users';
import { isDuplicateKey, type Models, type UserDocument } from './models';

export const toUser = (doc: UserDocument): User => ({
  id: doc._id,
  email: doc.email,
  phone: doc.phone,
  passwordHash: doc.passwordHash,
  balance: doc.balance,
  createdAt: doc.createdAt,
});

/** Each method is one single-document operation; the unique email index refuses a duplicate. */
export class MongoUserRepository implements UserRepository {
  constructor(private readonly models: Models) {}

  async findByEmail(email: string): Promise<User | undefined> {
    const doc = await this.models.users
      .findOne({ email: email.toLowerCase() })
      .lean<UserDocument>();
    return doc ? toUser(doc) : undefined;
  }

  async findById(id: string): Promise<User | undefined> {
    const doc = await this.models.users.findById(id).lean<UserDocument>();
    return doc ? toUser(doc) : undefined;
  }

  async insert(user: NewUser): Promise<User> {
    const doc: UserDocument = {
      _id: randomUUID(),
      email: user.email.toLowerCase(),
      phone: user.phone,
      passwordHash: user.passwordHash,
      balance: user.balance,
      createdAt: new Date(user.createdAt),
    };
    try {
      await this.models.users.insertMany([doc]);
    } catch (error) {
      if (isDuplicateKey(error)) throw new DuplicateEmailError();
      throw error;
    }
    return toUser(doc);
  }

  async updatePasswordHash(email: string, passwordHash: string): Promise<boolean> {
    const result = await this.models.users.updateOne(
      { email: email.toLowerCase() },
      { $set: { passwordHash } },
    );
    return result.matchedCount === 1;
  }
}
