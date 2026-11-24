// TX-9: a repeated transfer request moves money once (docs/decisions/0016). The key's lookup runs
// inside the store's one step, on memory and on MongoDB.
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import request from 'supertest';
import { createApp } from '../src/app';
import { connectMongo } from '../src/repositories/mongo/models';
import { mongoStorage } from '../src/storage';
import { buildTestHarness } from './support/app';
import { tokenFor, TRANSFERS } from './support/auth';
import { aUser, fieldsOf } from './support/sign-up';
import {
  account,
  balanceOf,
  DANA,
  INSUFFICIENT_FUNDS,
  NOA,
  OMER,
  send,
  stateOf,
} from './support/transfers';

const KEY_REUSED = {
  type: 'about:blank',
  title: 'This key belongs to another transfer',
  status: 422,
  code: 'IDEMPOTENCY_KEY_REUSED',
};

describe('TX-9 a repeated transfer request moves money once', () => {
  it('[TX-9] a transfer without an Idempotency-Key, or with one that is not a UUID, is refused with 400 naming the header, and nothing changes', async () => {
    const h = buildTestHarness();
    const dana = await account(h, DANA, 100_000);
    await account(h, OMER, 0);
    const before = stateOf(h);

    const missing = await request(h.app)
      .post(TRANSFERS)
      .set('Authorization', `Bearer ${dana.token}`)
      .send({ toEmail: OMER, amount: 1_000 });
    const malformed = await send(h, dana.token, { toEmail: OMER, amount: 1_000 }, 'not-a-uuid');

    for (const res of [missing, malformed]) {
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect(fieldsOf(res.body)).toEqual(['idempotency-key']);
    }
    expect(stateOf(h)).toEqual(before);
  });

  it('[TX-9] a repeat with the same key moves nothing and answers 201 with the first transfer and the balance now; another sender may use the same key', async () => {
    const h = buildTestHarness();
    const dana = await account(h, DANA, 100_000);
    const omer = await account(h, OMER, 50_000);
    const key = randomUUID();

    const first = await send(h, dana.token, { toEmail: OMER, amount: 1_250 }, key);
    const afterFirst = stateOf(h);
    // The recipient in another letter case is the same transfer.
    const repeat = await send(h, dana.token, { toEmail: 'Omer@Example.com', amount: 1_250 }, key);

    expect(first.status).toBe(201);
    expect(repeat.status).toBe(201);
    expect(repeat.body).toEqual(first.body);
    expect(stateOf(h)).toEqual(afterFirst);
    expect(balanceOf(h, dana.user.id)).toBe(98_750);
    expect(balanceOf(h, omer.user.id)).toBe(51_250);

    // Money that moved since then shows in the repeat's balance, not in its record.
    await send(h, omer.token, { toEmail: DANA, amount: 250 });
    const later = await send(h, dana.token, { toEmail: OMER, amount: 1_250 }, key);
    expect(later.status).toBe(201);
    expect(later.body).toEqual({ transaction: first.body.transaction, balance: 99_000 });

    // Keys belong to their sender: Omer's transfer under Dana's key is his own.
    const omers = await send(h, omer.token, { toEmail: DANA, amount: 500 }, key);
    expect(omers.status).toBe(201);
    expect(omers.body.transaction.id).not.toBe(first.body.transaction.id);
    expect(h.transactions.snapshot()).toHaveLength(3);
  });

  it('[TX-9] five copies of one transfer sent at once move the money once, and every copy answers 201 with the same record', async () => {
    const h = buildTestHarness();
    const dana = await account(h, DANA, 100_000);
    const omer = await account(h, OMER, 0);
    const key = randomUUID();

    const answers = await Promise.all(
      Array.from({ length: 5 }, () => send(h, dana.token, { toEmail: OMER, amount: 4_000 }, key)),
    );

    expect(answers.map((res) => res.status)).toEqual([201, 201, 201, 201, 201]);
    for (const res of answers) expect(res.body).toEqual(answers[0]?.body);
    expect(h.transactions.snapshot()).toHaveLength(1);
    expect(balanceOf(h, dana.user.id)).toBe(96_000);
    expect(balanceOf(h, omer.user.id)).toBe(4_000);
  });

  it('[TX-9] the same key with another amount or recipient answers 422 IDEMPOTENCY_KEY_REUSED and changes nothing', async () => {
    const h = buildTestHarness();
    const dana = await account(h, DANA, 100_000);
    await account(h, OMER, 0);
    await account(h, NOA, 0);
    const key = randomUUID();
    expect((await send(h, dana.token, { toEmail: OMER, amount: 1_000 }, key)).status).toBe(201);
    const before = stateOf(h);

    const otherAmount = await send(h, dana.token, { toEmail: OMER, amount: 1_001 }, key);
    const otherRecipient = await send(h, dana.token, { toEmail: NOA, amount: 1_000 }, key);
    // The key's check comes first, so even a request that would be refused for funds gets it.
    const tooMuch = await send(h, dana.token, { toEmail: OMER, amount: 999_999 }, key);

    for (const res of [otherAmount, otherRecipient, tooMuch]) {
      expect(res.status).toBe(422);
      expect(res.body).toEqual(KEY_REUSED);
    }
    expect(stateOf(h)).toEqual(before);
  });

  it('[TX-9] a refused transfer keeps no key: once the funds are there, its repeat is sent', async () => {
    const h = buildTestHarness();
    const dana = await account(h, DANA, 1_000);
    const omer = await account(h, OMER, 10_000);
    const key = randomUUID();

    const refused = await send(h, dana.token, { toEmail: OMER, amount: 5_000 }, key);
    expect(refused.status).toBe(422);
    expect(refused.body).toEqual(INSUFFICIENT_FUNDS);
    await send(h, omer.token, { toEmail: DANA, amount: 4_000 });

    const repeat = await send(h, dana.token, { toEmail: OMER, amount: 5_000 }, key);
    expect(repeat.status).toBe(201);
    expect(repeat.body.balance).toBe(0);
  });

  it('[TX-9] a preflight from the front end allows the Idempotency-Key header', async () => {
    const frontEnd = 'https://bank.example.com';
    const h = buildTestHarness({ config: { corsOrigin: frontEnd } });

    const res = await request(h.app)
      .options(TRANSFERS)
      .set('Origin', frontEnd)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'authorization, content-type, idempotency-key');

    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
    const allowed = String(res.headers['access-control-allow-headers']).toLowerCase().split(/,\s*/);
    expect(allowed).toEqual(expect.arrayContaining(['idempotency-key']));
  });
});

describe('TX-9 on MongoDB', () => {
  let replSet: MongoMemoryReplSet;
  let databases = 0;
  const toClose: (() => Promise<void>)[] = [];
  const freshUri = () => replSet.getUri(`bank-key-test-${++databases}`);

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: 'wiredTiger' },
    });
  }, 180_000);

  afterEach(async () => {
    await Promise.all(toClose.splice(0).map((close) => close()));
  });

  afterAll(async () => {
    await replSet?.stop();
  });

  it('[TX-9] on MongoDB a repeat and three copies sent at once move the money once; the same key with another amount is refused', async () => {
    const storage = await mongoStorage(freshUri());
    toClose.push(() => storage.close());
    const h = buildTestHarness();
    const target = { app: createApp({ ...h.deps, repositories: storage.repositories }) };
    const { users, transactions } = storage.repositories;
    const dana = await users.insert({ ...aUser(DANA), balance: 100_000 });
    const omer = await users.insert({ ...aUser(OMER), balance: 0 });
    const token = await tokenFor(h, dana.id);
    const balances = async () => [
      (await users.findById(dana.id))?.balance,
      (await users.findById(omer.id))?.balance,
    ];
    const key = randomUUID();

    const answers = await Promise.all(
      Array.from({ length: 3 }, () => send(target, token, { toEmail: OMER, amount: 4_000 }, key)),
    );
    const repeat = await send(target, token, { toEmail: OMER, amount: 4_000 }, key);
    const otherAmount = await send(target, token, { toEmail: OMER, amount: 4_001 }, key);

    expect([...answers, repeat].map((res) => res.status)).toEqual([201, 201, 201, 201]);
    for (const res of [...answers, repeat]) expect(res.body).toEqual(answers[0]?.body);
    expect(otherAmount.status).toBe(422);
    expect(otherAmount.body).toEqual(KEY_REUSED);
    expect(await balances()).toEqual([96_000, 4_000]);
    expect(await transactions.listFor(dana.id, 50)).toHaveLength(1);
  });

  it("[TX-9] on MongoDB the index refuses a second record with a sender's key, while records without a key and another sender's same key are stored", async () => {
    const store = await connectMongo(freshUri());
    toClose.push(() => store.connection.close());
    const record = (fromUserId: string, idempotencyKey?: string) => ({
      fromUserId,
      toUserId: 'someone',
      fromEmail: 'a@example.com',
      toEmail: 'b@example.com',
      amount: 1,
      createdAt: new Date(),
      ...(idempotencyKey !== undefined && { idempotencyKey }),
    });
    const key = randomUUID();

    await store.models.transactions.create(record('dana', key));
    await store.models.transactions.create(record('omer', key));
    await store.models.transactions.create(record('dana'));
    await store.models.transactions.create(record('dana'));

    await expect(store.models.transactions.create(record('dana', key))).rejects.toMatchObject({
      code: 11000,
    });
    expect(await store.models.transactions.countDocuments()).toBe(4);
  });
});
