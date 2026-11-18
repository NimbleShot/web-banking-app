import { describe, expect, it } from '@jest/globals';
import request from 'supertest';
import { createApp } from '../src/app';
import { InMemoryTransactionRepository } from '../src/repositories/transactions';
import { InMemoryUserRepository } from '../src/repositories/users';
import { buildTestHarness } from './support/app';
import { answerOf, bearer, ME, registerUser, TRANSACTIONS } from './support/auth';
import { aUser, fieldsOf, type Harness, MINUTE } from './support/sign-up';
import { account, DANA, JSON_TYPE, list, NOA, OMER, send, sendEach } from './support/transfers';

const PROBLEM_JSON = /^application\/problem\+json/;

type Item = { id: string; counterpartyEmail: string; amount: number; createdAt: string };

/** Dana, Omer and Noa, each with 1,000,000 agorot, stored as verified users with tokens. */
async function threeUsers(h: Harness = buildTestHarness()) {
  const dana = await account(h, DANA, 1_000_000);
  const omer = await account(h, OMER, 1_000_000);
  const noa = await account(h, NOA, 1_000_000);
  return { h, dana, omer, noa };
}

/** The items of `token`'s list, after checking the answer is a 200 list. */
async function itemsOf(h: Harness, token: string, query = ''): Promise<Item[]> {
  const res = await list(h, token, query);
  expect(res.status).toBe(200);
  return res.body.items as Item[];
}

/** 1, 2, ..., n */
const upTo = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

describe('TX-4 the sender sees the transfer with the recipient’s email and a negative amount', () => {
  it("[TX-4.a] after a transfer, the sender's list starts with an item whose counterpartyEmail is the recipient's and whose amount is minus the amount sent", async () => {
    const { h, dana, omer } = await threeUsers();
    await sendEach(h, dana.token, NOA, [300], MINUTE);
    await sendEach(h, omer.token, DANA, [200], MINUTE);
    h.clock.advance(MINUTE);

    const res = await send(h, dana.token, { toEmail: 'Omer@Example.com', amount: 1_250 });
    const items = await itemsOf(h, dana.token);

    expect(res.status).toBe(201);
    expect(items).toHaveLength(3);
    expect(items[0]).toEqual({
      id: res.body.transaction.id,
      counterpartyEmail: OMER,
      amount: -1_250,
      createdAt: h.clock.now().toISOString(),
    });
    expect(items[0]).toEqual(res.body.transaction);
  });
});

describe('TX-5 the recipient sees the transfer with the sender’s email and a positive amount', () => {
  it("[TX-5.a] after a transfer, the recipient's list starts with an item whose counterpartyEmail is the sender's, whose amount is plus the amount sent, and whose id is the sender's item id", async () => {
    const { h, dana, omer, noa } = await threeUsers();
    await sendEach(h, noa.token, OMER, [700], MINUTE);
    await sendEach(h, omer.token, NOA, [50], MINUTE);
    h.clock.advance(MINUTE);

    const res = await send(h, dana.token, { toEmail: OMER, amount: 1_250 });
    const senderItems = await itemsOf(h, dana.token);
    const recipientItems = await itemsOf(h, omer.token);

    expect(res.status).toBe(201);
    expect(recipientItems).toHaveLength(3);
    expect(recipientItems[0]).toEqual({
      id: res.body.transaction.id,
      counterpartyEmail: DANA,
      amount: 1_250,
      createdAt: h.clock.now().toISOString(),
    });
    expect(recipientItems[0]?.id).toBe(senderItems[0]?.id);
  });

  it('[TX-5.a] one transfer is one record: the store gains exactly one, holding the sender, the receiver, both emails, the amount and the time', async () => {
    const { h, dana, omer } = await threeUsers();
    await sendEach(h, omer.token, NOA, [50]);
    const before = h.transactions.snapshot();
    h.clock.advance(MINUTE);

    const res = await send(h, dana.token, { toEmail: 'OMER@example.com', amount: 1_250 });

    expect(res.status).toBe(201);
    const after = h.transactions.snapshot();
    expect(after).toHaveLength(before.length + 1);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.at(-1)).toEqual({
      id: res.body.transaction.id,
      fromUserId: dana.user.id,
      toUserId: omer.user.id,
      fromEmail: DANA,
      toEmail: OMER,
      amount: 1_250,
      createdAt: h.clock.now(),
    });
  });
});

describe('DB-3 the user sees their recent transactions', () => {
  it('[DB-3.b] a new user gets 200 {items: []}, even while other users have transfers', async () => {
    const h = buildTestHarness();
    const { dana } = await threeUsers(h);
    await sendEach(h, dana.token, OMER, [1_000]);
    const { token } = await registerUser(h, 'new.user@example.com');

    const res = await list(h, token);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(JSON_TYPE);
    expect(res.body).toEqual({ items: [] });
  });

  it("[DB-3.b] the list holds the user's transfers, sent and received, newest first, each with exactly id, counterpartyEmail, a signed amount and createdAt", async () => {
    const { h, dana, omer, noa } = await threeUsers();
    const start = h.clock.now().getTime();
    const at = (minutes: number) => new Date(start + minutes * MINUTE).toISOString();
    const [toOmer] = await sendEach(h, dana.token, OMER, [100], MINUTE); // minute 1
    const [fromOmer] = await sendEach(h, omer.token, DANA, [200], MINUTE); // minute 2
    const [toNoa] = await sendEach(h, dana.token, NOA, [300], MINUTE); // minute 3
    await sendEach(h, noa.token, OMER, [400], MINUTE); // minute 4: not Dana's

    const res = await list(h, dana.token);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(JSON_TYPE);
    expect(Object.keys(res.body)).toEqual(['items']);
    for (const item of res.body.items as Item[]) {
      expect(Object.keys(item).sort()).toEqual(['amount', 'counterpartyEmail', 'createdAt', 'id']);
    }
    expect(res.body.items).toEqual([
      { id: toNoa, counterpartyEmail: NOA, amount: -300, createdAt: at(3) },
      { id: fromOmer, counterpartyEmail: OMER, amount: 200, createdAt: at(2) },
      { id: toOmer, counterpartyEmail: OMER, amount: -100, createdAt: at(1) },
    ]);
  });

  it('[DB-3.b] transfers made at the same instant still list newest first', async () => {
    const { h, dana, omer } = await threeUsers();
    const ids = [
      ...(await sendEach(h, dana.token, OMER, [1, 2], 0)),
      ...(await sendEach(h, omer.token, DANA, [3], 0)),
      ...(await sendEach(h, dana.token, OMER, [4], 0)),
    ];

    const items = await itemsOf(h, dana.token);

    expect(new Set(items.map((item) => item.createdAt)).size).toBe(1);
    expect(new Set(ids).size).toBe(4);
    expect(items.map((item) => [item.id, item.amount])).toEqual([
      [ids[3], -4],
      [ids[2], 3],
      [ids[1], -2],
      [ids[0], -1],
    ]);
  });

  it('[DB-3.b] newest means latest created: a transfer stored later but created a minute earlier lists second', async () => {
    const { h, dana } = await threeUsers();
    const [createdLater] = await sendEach(h, dana.token, OMER, [1], 2 * MINUTE);
    // The clock goes back a minute between the two, so the second one is stored after the first
    // but created before it.
    const [createdEarlier] = await sendEach(h, dana.token, OMER, [2], -MINUTE);

    const items = await itemsOf(h, dana.token);

    expect(items.map((item) => [item.id, item.amount])).toEqual([
      [createdLater, -1],
      [createdEarlier, -2],
    ]);
    expect(items[0]!.createdAt > items[1]!.createdAt).toBe(true);
  });

  it('[DB-3.c] with more than 20 transfers and no limit, the list holds exactly the 20 newest', async () => {
    const { h, dana, omer } = await threeUsers();
    await sendEach(h, dana.token, OMER, upTo(25));

    const danaItems = await itemsOf(h, dana.token);
    const omerItems = await itemsOf(h, omer.token);

    expect(danaItems.map((item) => item.amount)).toEqual(
      upTo(25)
        .reverse()
        .slice(0, 20)
        .map((n) => -n),
    );
    expect(omerItems.map((item) => item.amount)).toEqual(upTo(25).reverse().slice(0, 20));
  });

  it('[DB-3.c] limit 1, 7 and 50 return exactly that many of 55 transfers, the newest ones', async () => {
    const { h, dana } = await threeUsers();
    await sendEach(h, dana.token, OMER, upTo(55));
    const newest = (n: number) =>
      upTo(55)
        .reverse()
        .slice(0, n)
        .map((amount) => -amount);

    for (const limit of [1, 7, 50]) {
      const items = await itemsOf(h, dana.token, `?limit=${limit}`);
      expect(items.map((item) => item.amount)).toEqual(newest(limit));
    }
  });

  it('[DB-3.c] a limit above the number of transfers returns them all', async () => {
    const { h, dana } = await threeUsers();
    await sendEach(h, dana.token, OMER, upTo(3));

    const items = await itemsOf(h, dana.token, '?limit=50');

    expect(items.map((item) => item.amount)).toEqual([-3, -2, -1]);
  });

  it.each([
    ['0', '?limit=0'],
    ['51', '?limit=51'],
    ['-1', '?limit=-1'],
    ['1.5', '?limit=1.5'],
    ['abc', '?limit=abc'],
    ['empty', '?limit='],
    ['true', '?limit=true'],
    ['NaN', '?limit=NaN'],
    ['+5 with an unencoded plus sign', '?limit=+5'],
    ['given twice', '?limit=5&limit=5'],
    ['given as a list', '?limit[]=5'],
  ])(
    '[DB-3.c] limit %s answers 400 VALIDATION_FAILED naming the field limit',
    async (_what, query) => {
      const { h, dana } = await threeUsers();
      await sendEach(h, dana.token, OMER, upTo(3));

      const res = await list(h, dana.token, query);

      expect(res.status).toBe(400);
      expect(res.headers['content-type']).toMatch(PROBLEM_JSON);
      expect(res.body).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
      expect(fieldsOf(res.body)).toEqual(['limit']);
    },
  );

  // The validator reads each of these as Infinity, which slips past both of its bounds; the
  // contract layer refuses a query number that isn't finite.
  it.each([
    ['Infinity', '?limit=Infinity'],
    ['-Infinity', '?limit=-Infinity'],
    ['1e400 (Infinity once read as a number)', '?limit=1e400'],
  ])(
    '[DB-3.c] limit %s answers 400 VALIDATION_FAILED naming the field limit, not every transfer',
    async (_what, query) => {
      const { h, dana } = await threeUsers();
      await sendEach(h, dana.token, OMER, upTo(3));

      const res = await list(h, dana.token, query);

      expect(res.status).toBe(400);
      expect(res.headers['content-type']).toMatch(PROBLEM_JSON);
      expect(res.body).toEqual({
        type: 'about:blank',
        title: 'Invalid request',
        status: 400,
        code: 'VALIDATION_FAILED',
        errors: [{ field: 'limit', message: 'must be a finite number' }],
      });
    },
  );

  it('[DB-3.d] a user never sees a transfer between two other users, even when theirs is older than the newest 20 overall', async () => {
    const { h, dana, omer, noa } = await threeUsers();
    const [danaToOmer] = await sendEach(h, dana.token, OMER, [1_000]);
    const between = [
      ...(await sendEach(h, omer.token, NOA, upTo(13))),
      ...(await sendEach(h, noa.token, OMER, upTo(12))),
    ];

    // No limit: the default 20 is fewer than the 25 newer transfers between Omer and Noa.
    const danaItems = await itemsOf(h, dana.token);
    const noaItems = await itemsOf(h, noa.token, '?limit=50');

    expect(danaItems).toEqual([
      expect.objectContaining({ id: danaToOmer, counterpartyEmail: OMER, amount: -1_000 }),
    ]);
    expect(noaItems.map((item) => item.id).sort()).toEqual([...between].sort());
    expect(noaItems.map((item) => item.id)).not.toContain(danaToOmer);
  });

  it("[DB-3.d] limit 2 gives exactly the user's own 2 newest of 3 transfers spread among 25 between others", async () => {
    const { h, dana, omer, noa } = await threeUsers();
    await sendEach(h, dana.token, OMER, [1]);
    await sendEach(h, omer.token, NOA, upTo(10));
    const [second] = await sendEach(h, dana.token, NOA, [2]);
    await sendEach(h, noa.token, OMER, upTo(10));
    const [third] = await sendEach(h, dana.token, OMER, [3]);
    await sendEach(h, omer.token, NOA, upTo(5));

    const items = await itemsOf(h, dana.token, '?limit=2');

    expect(items.map((item) => [item.id, item.amount])).toEqual([
      [third, -3],
      [second, -2],
    ]);
  });
});

describe('DB-1 the transactions are the token user’s, never another’s', () => {
  it("[DB-1.c] each user's token gets that user's own transactions, never another's", async () => {
    const { h, dana, omer, noa } = await threeUsers();
    const [danaToOmer] = await sendEach(h, dana.token, OMER, [100]);
    const [omerToNoa] = await sendEach(h, omer.token, NOA, [200]);
    const [noaToDana] = await sendEach(h, noa.token, DANA, [300]);

    const ids = async (token: string) => (await itemsOf(h, token)).map((item) => item.id);

    expect(await ids(dana.token)).toEqual([noaToDana, danaToOmer]);
    expect(await ids(omer.token)).toEqual([omerToNoa, danaToOmer]);
    expect(await ids(noa.token)).toEqual([noaToDana, omerToNoa]);
  });

  it("[DB-1.c] user A's token with headers naming user B still gets A's transactions", async () => {
    const { h, dana, omer } = await threeUsers();
    const [danaToNoa] = await sendEach(h, dana.token, NOA, [100]);
    await sendEach(h, omer.token, NOA, [200]);

    const res = await list(h, dana.token).set('X-User-Id', omer.user.id).set('X-User-Email', OMER);

    expect(res.status).toBe(200);
    expect((res.body.items as Item[]).map((item) => item.id)).toEqual([danaToNoa]);
  });

  it('[DB-1.c] listTransactions takes no user from the query: a userId parameter answers 400 naming it', async () => {
    const { h, dana, omer } = await threeUsers();
    await sendEach(h, omer.token, NOA, [200]);

    const res = await list(h, dana.token, `?userId=${omer.user.id}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(fieldsOf(res.body)).toEqual(['userId']);
  });

  it('[DB-1.b] listTransactions answers 401 like a missing token when the token’s user is no longer in the store by the time the list is read', async () => {
    const h = buildTestHarness();
    const { dana } = await threeUsers(h);
    await sendEach(h, dana.token, OMER, [100]);
    // The token check reads the harness's user store, where Dana is; the list reads one that has
    // Omer and Noa (and a transfer between them) but no longer has Dana.
    const later = new InMemoryUserRepository();
    const omer = await later.insert({ ...aUser(OMER), balance: 40_000 });
    await later.insert({ ...aUser(NOA), balance: 70_000 });
    const store = new InMemoryTransactionRepository(later);
    await store.transfer({ fromUserId: omer.id, toEmail: NOA, amount: 500, at: h.clock.now() });
    const app = createApp({
      ...h.deps,
      repositories: { ...h.deps.repositories, transactions: store },
    });
    const missing = await request(app).get(TRANSACTIONS);
    // Control: Dana's token passes the token check of this app, so the 401 comes from the list.
    expect((await request(app).get(ME).set(bearer(dana.token))).status).toBe(200);
    const before = { users: later.snapshot(), records: store.snapshot() };

    const res = await list({ app }, dana.token);

    expect(res.status).toBe(401);
    expect(answerOf(res)).toEqual(answerOf(missing));
    expect({ users: later.snapshot(), records: store.snapshot() }).toEqual(before);
    expect(before.records).toHaveLength(1);
    expect(later.snapshot().map((user) => user.balance)).toEqual([39_500, 70_500]);
  });
});
