// The MongoDB storage (docs/decisions/0013) on a throwaway replica set: transactions need one.
// Each test gets its own empty database. Clocks start at the real now, so the database's expiry
// indexes, which use its own clock, never remove a record a test still uses.
import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { connectMongo, type MongoStore } from '../src/repositories/mongo/models';
import { MongoPasswordResetRepository } from '../src/repositories/mongo/password-resets';
import { MongoPendingSignUpRepository } from '../src/repositories/mongo/pending-sign-ups';
import { MongoUserRepository } from '../src/repositories/mongo/users';
import { PENDING_SIGN_UP_TTL_MS } from '../src/repositories/pending-sign-ups';
import { DuplicateEmailError, type NewUser } from '../src/repositories/users';
import { createPasscodeService, PASSCODE_RULES } from '../src/services/passcodes';
import { TEST_SECRETS } from './support/app';
import { ManualClock } from './support/clock';

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

describe('DM-4 the passcode rules hold on MongoDB under concurrent requests', () => {
  const email = 'dana@example.com';
  const passcodes = createPasscodeService({ secret: TEST_SECRETS.PASSCODE_SECRET });
  const signUpHmac = (code: string) => passcodes.hmac('signup', email, code);
  const resetHmac = (code: string) => passcodes.hmac('reset', email, code);
  const afterCooldown = PASSCODE_RULES.resendCooldownMs + 1;

  async function pendingSignUps() {
    const store = await freshStore();
    return { store, repo: new MongoPendingSignUpRepository(store.connection, store.models) };
  }

  it('[DM-4] ten wrong passcodes sent at once: exactly five are checked and counted, and the right one is then refused', async () => {
    const { store, repo } = await pendingSignUps();
    const clock = new ManualClock(new Date());
    expect(await repo.create(email, signUpHmac('123456'), clock.now())).toBe(true);

    const wrong = Array.from({ length: 10 }, (_, i) => signUpHmac(String(i).padStart(6, '0')));
    const results = await Promise.all(
      wrong.map((hmac) => repo.usePasscode(email, hmac, clock.now())),
    );

    expect(results.every((used) => !used)).toBe(true);
    // Fewer would mean lost counts; more would mean guesses checked past the limit.
    const stored = await store.models.pendingSignUps.findById(email).lean();
    expect(stored?.passcode.wrongTries).toBe(PASSCODE_RULES.maxWrongTries);
    expect(await repo.usePasscode(email, signUpHmac('123456'), clock.now())).toBe(false);
  });

  it('[DM-4] four resends sent at once store one passcode: one is accepted, the others held by the cooldown', async () => {
    const { store, repo } = await pendingSignUps();
    const clock = new ManualClock(new Date());
    await repo.create(email, signUpHmac('111111'), clock.now());
    clock.advance(afterCooldown);

    const codes = ['222222', '333333', '444444', '555555'];
    const results = await Promise.all(
      codes.map((code) => repo.replacePasscode(email, signUpHmac(code), clock.now())),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
    const stored = await store.models.pendingSignUps.findById(email).lean();
    expect(stored?.passcode.sentAt).toHaveLength(2);
    expect(stored?.passcode.hmac).toBe(signUpHmac(codes[results.indexOf(true)] ?? ''));
  });

  it('[DM-4] a pending sign-up exactly 24 hours old still counts; a millisecond later a new sign-up replaces it', async () => {
    const { repo } = await pendingSignUps();
    const clock = new ManualClock(new Date());
    await repo.create(email, signUpHmac('111111'), clock.now());

    clock.advance(PENDING_SIGN_UP_TTL_MS);
    expect(await repo.create(email, signUpHmac('222222'), clock.now())).toBe(false);
    clock.advance(1);
    expect(await repo.create(email, signUpHmac('333333'), clock.now())).toBe(true);
    expect(await repo.usePasscode(email, signUpHmac('333333'), clock.now())).toBe(true);
  });

  it('[DM-4] a reset passcode works once, and the send history outlasts its use', async () => {
    const store = await freshStore();
    const repo = new MongoPasswordResetRepository(store.connection, store.models);
    const clock = new ManualClock(new Date());

    expect(await repo.issue(email, resetHmac('111111'), clock.now())).toBe(true);
    expect(await repo.usePasscode(email, resetHmac('111111'), clock.now())).toBe(true);
    expect(await repo.usePasscode(email, resetHmac('111111'), clock.now())).toBe(false);
    // Still within the cooldown of the first send, though that passcode is used up.
    expect(await repo.issue(email, resetHmac('222222'), clock.now())).toBe(false);
    clock.advance(afterCooldown);
    expect(await repo.issue(email, resetHmac('333333'), clock.now())).toBe(true);
    expect(await repo.usePasscode(email, resetHmac('333333'), clock.now())).toBe(true);
  });
});
