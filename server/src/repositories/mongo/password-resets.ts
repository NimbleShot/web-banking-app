// Pending password resets in MongoDB (docs/decisions/0008, 0013), keyed by the lowercased email.
import type { ClientSession, Connection } from 'mongoose';
import {
  hmacsMatch,
  isPasscodeUsable,
  newPasscodeState,
  replacedPasscodeState,
} from '../../services/passcodes';
import type { PasswordResetRepository } from '../password-resets';
import { isDuplicateKey, type Models, type PasswordResetDocument } from './models';

/**
 * Each method is one transaction: it reads the record, applies the same rules as the in-memory
 * store and writes. MongoDB re-runs it when a concurrent request wrote the record first, so
 * racing requests act one after the other.
 */
export class MongoPasswordResetRepository implements PasswordResetRepository {
  constructor(
    private readonly connection: Connection,
    private readonly models: Models,
  ) {}

  private find(email: string, session: ClientSession) {
    return this.models.passwordResets
      .findById(email)
      .session(session)
      .lean<PasswordResetDocument>();
  }

  async issue(email: string, hmac: string, now: Date): Promise<boolean> {
    try {
      return await this.connection.transaction(async (session) => {
        const record = await this.find(email, session);
        if (!record) {
          await this.models.passwordResets.insertMany(
            [{ _id: email, passcode: newPasscodeState(hmac, now), used: false }],
            { session },
          );
          return true;
        }
        // The send history counts even after a reset used the passcode up.
        const passcode = replacedPasscodeState(record.passcode, hmac, now);
        if (!passcode) return false;
        await this.models.passwordResets.updateOne(
          { _id: email },
          { $set: { passcode, used: false } },
          { session },
        );
        return true;
      });
    } catch (error) {
      // A racing first request stored its passcode first: this one is within the cooldown.
      if (isDuplicateKey(error)) return false;
      throw error;
    }
  }

  usePasscode(email: string, hmac: string, now: Date): Promise<boolean> {
    return this.connection.transaction(async (session) => {
      const record = await this.find(email, session);
      if (!record || record.used || !isPasscodeUsable(record.passcode, now)) return false;
      if (!hmacsMatch(record.passcode.hmac, hmac)) {
        await this.models.passwordResets.updateOne(
          { _id: email },
          { $inc: { 'passcode.wrongTries': 1 } },
          { session },
        );
        return false;
      }
      await this.models.passwordResets.updateOne(
        { _id: email },
        { $set: { used: true } },
        { session },
      );
      return true;
    });
  }
}
