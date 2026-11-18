// The MongoDB storage (docs/decisions/0013) on a throwaway replica set: transactions need one.
// Each test gets its own empty database. Clocks start at the real now, so the database's expiry
// indexes, which use its own clock, never remove a record a test still uses.
import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { connectMongo, type MongoStore } from '../src/repositories/mongo/models';
import { MongoUserRepository } from '../src/repositories/mongo/users';
import { DuplicateEmailError, type NewUser } from '../src/repositories/users';

let replSet: MongoMemoryReplSet;
let databases = 0;
const opened: MongoStore[] = [];

beforeAll(async () => {
  // The first run on a machine downloads the database binary (about 120 MB).
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
}, 180_000);

afterEach(async () => {
  await Promise.all(opened.splice(0).map((store) => store.connection.close()));
});

afterAll(async () => {
  await replSet?.stop();
});

/** The address of a new, empty database on the shared replica set. */
const freshUri = () => replSet.getUri(`bank-test-${++databases}`);

/** A connection to a new, empty database, its collections and indexes in place. */
async function freshStore(uri = freshUri()): Promise<MongoStore> {
  const store = await connectMongo(uri);
  opened.push(store);
  return store;
}

const newUser = (email: string, balance = 1_000_000): NewUser => ({
  email,
  phone: '+972501234567',
  passwordHash: 'not-a-real-hash',
  balance,
  createdAt: new Date(),
});

describe('DM-2 the database refuses a second user for one email', () => {
  it('[DM-2] two inserts racing for one email, in different letter case, leave one user; the other rejects with DuplicateEmailError', async () => {
    const { models } = await freshStore();
    const users = new MongoUserRepository(models);

    const results = await Promise.allSettled([
      users.insert(newUser('Dana@Example.com')),
      users.insert(newUser('dana@example.com')),
    ]);

    const stored = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    const refused = results.flatMap((r) => (r.status === 'rejected' ? [r.reason] : []));
    expect(stored).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toBeInstanceOf(DuplicateEmailError);
    expect(await models.users.countDocuments()).toBe(1);
    expect(await users.findByEmail('DANA@example.COM')).toEqual(stored[0]);
  });
});
