// Pending sign-ups in MongoDB (docs/decisions/0007, 0013), keyed by the lowercased email.
import type { ClientSession, Connection } from 'mongoose';
import {
  hmacsMatch,
  isPasscodeUsable,
  newPasscodeState,
  replacedPasscodeState,
} from '../../services/passcodes';
import { isPendingSignUpLive, type PendingSignUpRepository } from '../pending-sign-ups';
import { isDuplicateKey, type Models, type PendingSignUpDocument } from './models';

/**
 * Each method is one transaction: it reads the record, applies the same rules as the in-memory
 * store and writes. MongoDB re-runs it when a concurrent request wrote the record first, so
 * racing requests act one after the other.
 */
export class MongoPendingSignUpRepository implements PendingSignUpRepository {
  constructor(
    private readonly connection: Connection,
    private readonly models: Models,
  ) {}

  /** The record if it still counts at `now`. */
  private async live(email: string, now: Date, session: ClientSession) {
    const record = await this.models.pendingSignUps
      .findById(email)
      .session(session)
      .lean<PendingSignUpDocument>();
    return record && isPendingSignUpLive(record.createdAt, now) ? record : undefined;
  }

  async create(email: string, hmac: string, now: Date): Promise<boolean> {
    try {
      return await this.connection.transaction(async (session) => {
        if (await this.live(email, now, session)) return false;
        // Replaces an expired record, or inserts the first one.
        await this.models.pendingSignUps.replaceOne(
          { _id: email },
          { _id: email, createdAt: now, passcode: newPasscodeState(hmac, now) },
          { upsert: true, session },
        );
        return true;
      });
    } catch (error) {
      // A racing create stored its record first: there is a live pending sign-up.
      if (isDuplicateKey(error)) return false;
      throw error;
    }
  }

  replacePasscode(email: string, hmac: string, now: Date): Promise<boolean> {
    return this.connection.transaction(async (session) => {
      const record = await this.live(email, now, session);
      if (!record) return false;
      const passcode = replacedPasscodeState(record.passcode, hmac, now);
      if (!passcode) return false;
      await this.models.pendingSignUps.updateOne(
        { _id: email },
        { $set: { passcode } },
        { session },
      );
      return true;
    });
  }

  usePasscode(email: string, hmac: string, now: Date): Promise<boolean> {
    return this.connection.transaction(async (session) => {
      const record = await this.live(email, now, session);
      if (!record || !isPasscodeUsable(record.passcode, now)) return false;
      if (!hmacsMatch(record.passcode.hmac, hmac)) {
        await this.models.pendingSignUps.updateOne(
          { _id: email },
          { $inc: { 'passcode.wrongTries': 1 } },
          { session },
        );
        return false;
      }
      await this.models.pendingSignUps.deleteOne({ _id: email }, { session });
      return true;
    });
  }
}
