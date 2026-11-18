import { describe, expect, it } from '@jest/globals';
import request from 'supertest';
import { createApp } from '../src/app';
import {
  InMemoryTransactionRepository,
  type TransactionRecord,
} from '../src/repositories/transactions';
import { InMemoryUserRepository, type User } from '../src/repositories/users';
import { createTransferService } from '../src/services/transfers';
import { buildTestHarness } from './support/app';
import { answerOf, bearer, getMe, login, ME, registerUser, TRANSFERS } from './support/auth';
import {
  latestResetPasscode,
  NEW_PASSWORD,
  requestReset,
  resetPassword,
} from './support/password-reset';
import { aUser, fieldsOf, type Harness, MINUTE, signUp, validSignUp } from './support/sign-up';
import {
  account,
  balanceOf,
  DANA,
  INSUFFICIENT_FUNDS,
  INTERNAL_ERROR,
  JSON_TYPE,
  list,
  listsOf,
  NOA,
  OMER,
  RECIPIENT_NOT_FOUND,
  SELF_TRANSFER,
  send,
  sendEach,
  stateOf,
  sumOfBalances,
  watchedStore,
} from './support/transfers';

const PROBLEM_JSON = /^application\/problem\+json/;

/**
 * Dana (100,000 agorot), Omer (40,000) and Noa (70,000), stored as verified users with tokens.
 * Different balances, so a debit or credit landing on the wrong user shows.
 */
async function threeUsers(h: Harness = buildTestHarness()) {
  const dana = await account(h, DANA, 100_000);
  const omer = await account(h, OMER, 40_000);
  const noa = await account(h, NOA, 70_000);
  return { h, dana, omer, noa };
}

/**
 * Three users with some history: Dana sent Omer 1,000 and Omer sent Dana 500, so both lists
 * and the record store already hold something a refused transfer could disturb. Dana then has
 * 99,500 and Omer 40,500.
 */
async function threeUsersWithHistory() {
  const users = await threeUsers();
  await sendEach(users.h, users.dana.token, OMER, [1_000]);
  await sendEach(users.h, users.omer.token, DANA, [500]);
  return users;
}

/** Everything a refused transfer must leave alone: the stores and both parties' lists. */
async function everything(h: Harness, ...tokens: string[]) {
  return { state: stateOf(h), lists: await listsOf(h, ...tokens) };
}

describe('TX-1 send money by recipient email and amount', () => {
  it("[TX-1.a] a transfer to another verified user answers 201 with the transaction (the recipient's email, minus the amount) and the sender's new balance", async () => {
    const { h, dana } = await threeUsers();
    h.clock.advance(5 * MINUTE);

    const res = await send(h, dana.token, { toEmail: OMER, amount: 1_250 });

    expect(res.status).toBe(201);
    expect(res.headers['content-type']).toMatch(JSON_TYPE);
    expect(Object.keys(res.body).sort()).toEqual(['balance', 'transaction']);
    expect(Object.keys(res.body.transaction).sort()).toEqual([
      'amount',
      'counterpartyEmail',
      'createdAt',
      'id',
    ]);
    expect(res.body).toEqual({
      transaction: {
        id: expect.any(String),
        counterpartyEmail: OMER,
        amount: -1_250,
        createdAt: h.clock.now().toISOString(),
      },
      balance: 98_750,
    });
  });

  it("[TX-1.a] the sender's balance drops and the recipient's rises by exactly the amount; no other balance moves", async () => {
    const { h, dana, omer, noa } = await threeUsers();

    const res = await send(h, dana.token, { toEmail: OMER, amount: 1_250 });

    expect(res.status).toBe(201);
    expect(balanceOf(h, dana.user.id)).toBe(98_750);
    expect(balanceOf(h, omer.user.id)).toBe(41_250);
    expect(balanceOf(h, noa.user.id)).toBe(70_000);
    expect((await getMe(h, bearer(dana.token).Authorization)).body.balance).toBe(98_750);
    expect((await getMe(h, bearer(omer.token).Authorization)).body.balance).toBe(41_250);
  });

  it.each(['OMER@EXAMPLE.COM', 'Omer@Example.com'])(
    "[TX-1.a] the recipient's email typed as %s reaches that user, and the answer shows their stored lowercased email",
    async (typed) => {
      const { h, dana, omer } = await threeUsers();

      const res = await send(h, dana.token, { toEmail: typed, amount: 1_250 });

      expect(res.status).toBe(201);
      expect(res.body.transaction.counterpartyEmail).toBe(OMER);
      expect(balanceOf(h, omer.user.id)).toBe(41_250);
    },
  );

  it('[TX-1.a] two transfers in a row each answer with the balance left after them', async () => {
    const { h, dana } = await threeUsers();

    const first = await send(h, dana.token, { toEmail: OMER, amount: 1_000 });
    const second = await send(h, dana.token, { toEmail: NOA, amount: 2_000 });

    expect(first.status).toBe(201);
    expect(first.body.balance).toBe(99_000);
    expect(second.status).toBe(201);
    expect(second.body.balance).toBe(97_000);
  });

  it('[TX-1.a] between two users who signed up and verified through the API, with their drawn starting balances', async () => {
    const h = buildTestHarness();
    const dana = await registerUser(h);
    const omer = await registerUser(h, OMER);

    const res = await send(h, dana.token, { toEmail: OMER, amount: 1_250 });

    expect(res.status).toBe(201);
    expect(res.body.balance).toBe(dana.user.balance - 1_250);
    const danaMe = await getMe(h, bearer(dana.token).Authorization);
    const omerMe = await getMe(h, bearer(omer.token).Authorization);
    expect(danaMe.body.balance).toBe(dana.user.balance - 1_250);
    expect(omerMe.body.balance).toBe(omer.user.balance + 1_250);
  });

  it('[TX-1.b] a transfer of the whole balance succeeds and leaves the sender at 0', async () => {
    const { h, dana, omer } = await threeUsers();

    const res = await send(h, dana.token, { toEmail: OMER, amount: 100_000 });

    expect(res.status).toBe(201);
    expect(res.body.balance).toBe(0);
    expect(balanceOf(h, dana.user.id)).toBe(0);
    expect(balanceOf(h, omer.user.id)).toBe(140_000);
    expect((await getMe(h, bearer(dana.token).Authorization)).body.balance).toBe(0);
  });
});

describe('TX-2 an amount above the balance is refused and nothing changes', () => {
  it('[TX-2.a] one agora more than the balance answers 422 INSUFFICIENT_FUNDS, and neither balance, either list nor the record store changes', async () => {
    const { h, dana, omer } = await threeUsersWithHistory();
    const before = await everything(h, dana.token, omer.token);

    const res = await send(h, dana.token, { toEmail: OMER, amount: 99_501 });

    expect(res.status).toBe(422);
    expect(res.headers['content-type']).toMatch(PROBLEM_JSON);
    expect(res.body).toEqual(INSUFFICIENT_FUNDS);
    expect(await everything(h, dana.token, omer.token)).toEqual(before);
  });

  it.each([
    ['twice the balance', 199_000],
    ['the largest amount the contract allows', 100_000_000],
  ])('[TX-2.a] %s answers 422 INSUFFICIENT_FUNDS and nothing changes', async (_what, amount) => {
    const { h, dana, omer } = await threeUsersWithHistory();
    const before = await everything(h, dana.token, omer.token);

    const res = await send(h, dana.token, { toEmail: OMER, amount });

    expect(res.status).toBe(422);
    expect(res.body).toEqual(INSUFFICIENT_FUNDS);
    expect(await everything(h, dana.token, omer.token)).toEqual(before);
  });

  it('[TX-2.a] a sender who sent the whole balance cannot send 1 agora more', async () => {
    const { h, dana, omer } = await threeUsers();
    expect((await send(h, dana.token, { toEmail: OMER, amount: 100_000 })).status).toBe(201);
    const before = await everything(h, dana.token, omer.token);

    const res = await send(h, dana.token, { toEmail: OMER, amount: 1 });

    expect(res.status).toBe(422);
    expect(res.body).toEqual(INSUFFICIENT_FUNDS);
    expect(await everything(h, dana.token, omer.token)).toEqual(before);
  });
});

describe('TX-3 an unknown recipient is refused and nothing changes', () => {
  it('[TX-3.a] an email no user has answers 422 RECIPIENT_NOT_FOUND and nothing changes', async () => {
    const { h, dana, omer } = await threeUsersWithHistory();
    const before = await everything(h, dana.token, omer.token);

    const res = await send(h, dana.token, { toEmail: 'nobody@example.com', amount: 1_000 });

    expect(res.status).toBe(422);
    expect(res.headers['content-type']).toMatch(PROBLEM_JSON);
    expect(res.body).toEqual(RECIPIENT_NOT_FOUND);
    expect(await everything(h, dana.token, omer.token)).toEqual(before);
  });

  /** Dana (100,000) has sent Omer 1,000; Noa has signed up but not verified. */
  async function withPendingNoa() {
    const h = buildTestHarness();
    const dana = await account(h, DANA, 100_000);
    const omer = await account(h, OMER, 40_000);
    await sendEach(h, dana.token, OMER, [1_000]);
    expect((await signUp(h, { ...validSignUp, email: NOA })).status).toBe(202);
    return { h, dana, omer };
  }

  it.each([NOA, 'Noa@Example.COM'])(
    '[TX-3.a] an email with only a pending sign-up (signed up, not verified), typed as %s, answers 422 RECIPIENT_NOT_FOUND and nothing changes',
    async (typed) => {
      const { h, dana, omer } = await withPendingNoa();
      const before = await everything(h, dana.token, omer.token);

      const res = await send(h, dana.token, { toEmail: typed, amount: 1_000 });

      expect(res.status).toBe(422);
      expect(res.body).toEqual(RECIPIENT_NOT_FOUND);
      expect(await everything(h, dana.token, omer.token)).toEqual(before);
    },
  );

  it('[TX-3.a] an email no user has, with an amount above the balance, answers RECIPIENT_NOT_FOUND: the recipient is checked before the funds', async () => {
    const { h, dana, omer } = await threeUsersWithHistory();
    const before = await everything(h, dana.token, omer.token);

    const res = await send(h, dana.token, { toEmail: 'nobody@example.com', amount: 100_000_000 });

    expect(res.status).toBe(422);
    expect(res.body).toEqual(RECIPIENT_NOT_FOUND);
    expect(await everything(h, dana.token, omer.token)).toEqual(before);
  });

  it("[TX-3.a] a pending sign-up's email, with an amount above the balance, answers RECIPIENT_NOT_FOUND: the recipient is checked before the funds", async () => {
    const { h, dana, omer } = await withPendingNoa();
    const before = await everything(h, dana.token, omer.token);

    const res = await send(h, dana.token, { toEmail: NOA, amount: 100_000_000 });

    expect(res.status).toBe(422);
    expect(res.body).toEqual(RECIPIENT_NOT_FOUND);
    expect(await everything(h, dana.token, omer.token)).toEqual(before);
  });
});

describe('TX-6 the amount is a positive whole number of agorot, at most 100,000,000', () => {
  const refused: [string, unknown][] = [
    ['0', 0],
    ['-1', -1],
    ['-1250', -1_250],
    ['12.5 (not a whole number of agorot)', 12.5],
    ['0.01', 0.01],
    ['the string "1250"', '1250'],
    ['null', null],
    ['true', true],
    ['an array', [1_250]],
    ['an object', { agorot: 1_250 }],
    ['100,000,001 (one above the maximum)', 100_000_001],
    ['missing', undefined],
  ];

  it.each(refused)(
    '[TX-6.a] an amount of %s answers 400 VALIDATION_FAILED naming the field amount, and nothing changes',
    async (_what, amount) => {
      const h = buildTestHarness();
      // Enough money that any of these amounts, if it got through, would move some.
      const dana = await account(h, DANA, 200_000_000);
      const omer = await account(h, OMER, 40_000);
      await sendEach(h, dana.token, OMER, [1_000]);
      const before = await everything(h, dana.token, omer.token);
      const body: Record<string, unknown> = { toEmail: OMER };
      if (amount !== undefined) body.amount = amount;

      const res = await send(h, dana.token, body);

      expect(res.status).toBe(400);
      expect(res.headers['content-type']).toMatch(PROBLEM_JSON);
      expect(res.body).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
      expect(fieldsOf(res.body)).toEqual(['amount']);
      expect(await everything(h, dana.token, omer.token)).toEqual(before);
    },
  );

  it('[TX-6.a] the smallest amount, 1 agora, is accepted', async () => {
    const { h, dana, omer } = await threeUsers();

    const res = await send(h, dana.token, { toEmail: OMER, amount: 1 });

    expect(res.status).toBe(201);
    expect(res.body.balance).toBe(99_999);
    expect(balanceOf(h, omer.user.id)).toBe(40_001);
  });

  it('[TX-6.a] the largest amount, 100,000,000 agorot, is accepted: a sender who has exactly that ends at 0', async () => {
    const h = buildTestHarness();
    const dana = await account(h, DANA, 100_000_000);
    const omer = await account(h, OMER, 40_000);

    const res = await send(h, dana.token, { toEmail: OMER, amount: 100_000_000 });

    expect(res.status).toBe(201);
    expect(res.body.balance).toBe(0);
    expect(balanceOf(h, omer.user.id)).toBe(100_040_000);
  });
});

describe('TX-7 a user cannot send money to themselves', () => {
  it.each([DANA, 'DANA@EXAMPLE.COM', 'Dana@Example.Com'])(
    '[TX-7.a] sending to your own email typed as %s answers 422 SELF_TRANSFER and nothing changes',
    async (typed) => {
      const { h, dana, omer } = await threeUsersWithHistory();
      const before = await everything(h, dana.token, omer.token);

      const res = await send(h, dana.token, { toEmail: typed, amount: 1_000 });

      expect(res.status).toBe(422);
      expect(res.headers['content-type']).toMatch(PROBLEM_JSON);
      expect(res.body).toEqual(SELF_TRANSFER);
      expect(await everything(h, dana.token, omer.token)).toEqual(before);
    },
  );

  it('[TX-7.a] sending yourself more than your balance answers SELF_TRANSFER, not INSUFFICIENT_FUNDS: self is checked before the funds', async () => {
    const { h, dana, omer } = await threeUsersWithHistory();
    const before = await everything(h, dana.token, omer.token);

    const res = await send(h, dana.token, { toEmail: DANA, amount: 100_000_000 });

    expect(res.status).toBe(422);
    expect(res.body).toEqual(SELF_TRANSFER);
    expect(await everything(h, dana.token, omer.token)).toEqual(before);
  });

  it('[TX-7.a] an invalid amount to yourself answers 400, not 422: the contract is checked before anything else', async () => {
    const { h, dana } = await threeUsers();

    const res = await send(h, dana.token, { toEmail: DANA, amount: 0 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(fieldsOf(res.body)).toEqual(['amount']);
  });
});

describe('TX-8 a transfer is all or nothing, even under concurrent requests', () => {
  /** Dana (100,000), Omer (40,000) and Noa (70,000); 30% of Dana's balance is 30,000. */
  const THIRTY_PERCENT = 30_000;

  it('[TX-8.a] 10 concurrent transfers of 30% of the balance over HTTP: exactly 3 answer 201 and 7 answer 422 INSUFFICIENT_FUNDS, the balance never goes negative and the sum of all balances does not change', async () => {
    const { h, dana, omer } = await threeUsers();
    const sum = sumOfBalances(h);
    // All 10 reach the money move together; a check-then-write with a pause between would let
    // every one of them through.
    const watched = watchedStore(h, dana.user.id, 10);
    const app = createApp({
      ...h.deps,
      repositories: { ...h.deps.repositories, transactions: watched.store },
    });

    const answers = await Promise.all(
      Array.from({ length: 10 }, () =>
        send({ app }, dana.token, { toEmail: OMER, amount: THIRTY_PERCENT }),
      ),
    );

    expect({ reachedTheStoreTogether: watched.door.arrivedTogether }).toEqual({
      reachedTheStoreTogether: 10,
    });
    const sent = answers.filter((res) => res.status === 201);
    const refused = answers.filter((res) => res.status === 422);
    expect(sent).toHaveLength(3);
    expect(refused).toHaveLength(7);
    for (const res of refused) expect(res.body).toEqual(INSUFFICIENT_FUNDS);
    // Read as every transfer started and as it ended.
    expect(watched.readings).toHaveLength(20);
    for (const balance of watched.readings) expect(balance).toBeGreaterThanOrEqual(0);
    expect(sent.map((res) => res.body.balance as number).sort((a, b) => b - a)).toEqual([
      70_000, 40_000, 10_000,
    ]);
    expect(balanceOf(h, dana.user.id)).toBe(10_000);
    expect(balanceOf(h, omer.user.id)).toBe(130_000);
    expect(sumOfBalances(h)).toBe(sum);
    expect(h.transactions.snapshot()).toHaveLength(3);
  });

  it('[TX-8.a] the same race at the service level (10 sends at once with Promise.all): 3 sent, 7 refused for funds, the balance never goes negative and the sum does not change', async () => {
    const { h, dana, omer } = await threeUsers();
    const sum = sumOfBalances(h);
    const watched = watchedStore(h, dana.user.id);
    const service = createTransferService({ transactions: watched.store, clock: h.clock });

    const outcomes = await Promise.all(
      Array.from({ length: 10 }, () => service.send(dana.user.id, OMER, THIRTY_PERCENT)),
    );

    const sent = outcomes.filter((outcome) => outcome.result === 'sent');
    expect(sent).toHaveLength(3);
    expect(outcomes.filter((outcome) => outcome.result === 'insufficient-funds')).toHaveLength(7);
    expect(watched.readings).toHaveLength(20);
    for (const balance of watched.readings) expect(balance).toBeGreaterThanOrEqual(0);
    expect(
      sent
        .map((outcome) => (outcome.result === 'sent' ? outcome.balance : -1))
        .sort((a, b) => b - a),
    ).toEqual([70_000, 40_000, 10_000]);
    expect(balanceOf(h, dana.user.id)).toBe(10_000);
    expect(balanceOf(h, omer.user.id)).toBe(130_000);
    expect(sumOfBalances(h)).toBe(sum);
    expect(h.transactions.snapshot()).toHaveLength(3);
  });

  const FAULT = 'the record store went away in the middle of a transfer';

  /**
   * The app over a transaction store whose credit throws (after the debit happened), or whose
   * record insert throws (after the debit, the credit and the insert itself happened), on the
   * transfers `failsOn` picks (1 = the first transfer to reach that step). `seen` holds the user
   * and record stores as they were at the moment of the fault.
   */
  function appWithFault(h: Harness, where: 'credit' | 'insert', failsOn: (n: number) => boolean) {
    const seen: { users?: User[]; records?: TransactionRecord[] } = {};
    const users = h.users;
    let calls = 0;
    const fault = (store: InMemoryTransactionRepository) => {
      calls += 1;
      if (!failsOn(calls)) return;
      seen.users = users.snapshot();
      seen.records = store.snapshot();
      throw new Error(FAULT);
    };
    class FaultyStore extends InMemoryTransactionRepository {
      protected override credit(recipient: User, amount: number): void {
        if (where === 'credit') fault(this);
        super.credit(recipient, amount);
      }

      protected override insertRecord(record: TransactionRecord): void {
        super.insertRecord(record);
        if (where === 'insert') fault(this);
      }
    }
    const store = new FaultyStore(users);
    const app = createApp({
      ...h.deps,
      repositories: { ...h.deps.repositories, transactions: store },
    });
    return { target: { app }, store, seen };
  }

  /** Dana's and Omer's balances, the records and both lists, as the app over `store` holds them. */
  async function everythingIn(
    h: Harness,
    target: { app: ReturnType<typeof createApp> },
    store: InMemoryTransactionRepository,
    ...tokens: string[]
  ) {
    return {
      users: h.users.snapshot(),
      records: store.snapshot(),
      lists: await listsOf(target, ...tokens),
    };
  }

  const balanceIn = (users: User[] | undefined, id: string) =>
    users?.find((user) => user.id === id)?.balance;

  it('[TX-8.b] a credit that fails after the debit happened answers 500 INTERNAL_ERROR, and the debit is undone and no record is written', async () => {
    const h = buildTestHarness();
    const dana = await account(h, DANA, 100_000);
    const omer = await account(h, OMER, 40_000);
    // The first transfer goes through, so the lists and the record store hold something.
    const { target, store, seen } = appWithFault(h, 'credit', (n) => n === 2);
    expect((await send(target, dana.token, { toEmail: OMER, amount: 1_000 })).status).toBe(201);
    const before = await everythingIn(h, target, store, dana.token, omer.token);

    const res = await send(target, dana.token, { toEmail: OMER, amount: 1_250 });

    expect(res.status).toBe(500);
    expect(res.headers['content-type']).toMatch(PROBLEM_JSON);
    expect(res.body).toEqual(INTERNAL_ERROR);
    expect(res.text).not.toContain(FAULT);
    // At the fault the debit had happened: Dana's money had left her account.
    expect(balanceIn(seen.users, dana.user.id)).toBe(99_000 - 1_250);
    expect(balanceIn(seen.users, omer.user.id)).toBe(41_000);
    // And now it is back, and no record was written.
    expect(await everythingIn(h, target, store, dana.token, omer.token)).toEqual(before);
    expect(balanceOf(h, dana.user.id)).toBe(99_000);
    expect(store.snapshot()).toHaveLength(1);
  });

  it('[TX-8.b] a failure after the debit, the credit and the record were all written answers 500, and all three are undone', async () => {
    const h = buildTestHarness();
    const dana = await account(h, DANA, 100_000);
    const omer = await account(h, OMER, 40_000);
    const { target, store, seen } = appWithFault(h, 'insert', (n) => n === 2);
    expect((await send(target, dana.token, { toEmail: OMER, amount: 1_000 })).status).toBe(201);
    const before = await everythingIn(h, target, store, dana.token, omer.token);

    const res = await send(target, dana.token, { toEmail: OMER, amount: 1_250 });

    expect(res.status).toBe(500);
    expect(res.headers['content-type']).toMatch(PROBLEM_JSON);
    expect(res.body).toEqual(INTERNAL_ERROR);
    expect(balanceIn(seen.users, dana.user.id)).toBe(99_000 - 1_250);
    expect(balanceIn(seen.users, omer.user.id)).toBe(41_000 + 1_250);
    expect(seen.records).toHaveLength(2);
    expect(await everythingIn(h, target, store, dana.token, omer.token)).toEqual(before);
    expect(store.snapshot()).toHaveLength(1);
  });

  it('[TX-8.b] after a failed transfer the store works as before: the next one moves the money once', async () => {
    const h = buildTestHarness();
    const dana = await account(h, DANA, 100_000);
    const omer = await account(h, OMER, 40_000);
    const { target, store } = appWithFault(h, 'credit', (n) => n === 1);

    const failed = await send(target, dana.token, { toEmail: OMER, amount: 1_250 });
    const next = await send(target, dana.token, { toEmail: OMER, amount: 1_250 });

    expect(failed.status).toBe(500);
    expect(next.status).toBe(201);
    expect(next.body.balance).toBe(98_750);
    expect(balanceOf(h, dana.user.id)).toBe(98_750);
    expect(balanceOf(h, omer.user.id)).toBe(41_250);
    expect(store.snapshot()).toHaveLength(1);
  });
});

describe('DB-1 the sender is the token user, never one named in the request', () => {
  it.each([
    ['fromEmail', (other: User) => other.email],
    ['fromUserId', (other: User) => other.id],
    ['userId', (other: User) => other.id],
  ])(
    '[DB-1.c] createTransfer refuses a body that names a sender in %s with 400 VALIDATION_FAILED naming that field, and nothing changes',
    async (field, value) => {
      const { h, dana, omer } = await threeUsersWithHistory();
      const before = await everything(h, dana.token, omer.token);

      const res = await send(h, dana.token, {
        toEmail: NOA,
        amount: 1_000,
        [field]: value(omer.user),
      });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect(fieldsOf(res.body)).toEqual([field]);
      expect(await everything(h, dana.token, omer.token)).toEqual(before);
    },
  );

  it('[DB-1.c] createTransfer takes no user from the query: a fromUserId parameter answers 400 naming it, and nothing changes', async () => {
    const { h, dana, omer } = await threeUsersWithHistory();
    const before = await everything(h, dana.token, omer.token);

    const res = await request(h.app)
      .post(`${TRANSFERS}?fromUserId=${omer.user.id}`)
      .set(bearer(dana.token))
      .send({ toEmail: NOA, amount: 1_000 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(fieldsOf(res.body)).toEqual(['fromUserId']);
    expect(await everything(h, dana.token, omer.token)).toEqual(before);
  });

  it("[DB-1.c] createTransfer moves the token user's money even when headers name another user", async () => {
    const { h, dana, omer, noa } = await threeUsers();

    const res = await send(h, dana.token, { toEmail: NOA, amount: 1_000 })
      .set('X-User-Id', omer.user.id)
      .set('X-User-Email', OMER);

    expect(res.status).toBe(201);
    expect(res.body.balance).toBe(99_000);
    expect(balanceOf(h, dana.user.id)).toBe(99_000);
    expect(balanceOf(h, omer.user.id)).toBe(40_000);
    expect(balanceOf(h, noa.user.id)).toBe(71_000);
  });
});

describe('DB-2 the balance changes only through transfers', () => {
  it('[DB-2.b] getMe, login, listTransactions, refused transfers and a password reset leave the balance as it was; a transfer moves it by exactly the amount', async () => {
    const h = buildTestHarness();
    const dana = await registerUser(h);
    const omer = await registerUser(h, OMER);
    const balances = async () => [
      (await getMe(h, bearer(dana.token).Authorization)).body.balance,
      (await getMe(h, bearer(omer.token).Authorization)).body.balance,
    ];
    const [danaStart, omerStart] = [dana.user.balance, omer.user.balance];

    expect(await balances()).toEqual([danaStart, omerStart]);
    expect((await login(h, DANA, validSignUp.password)).status).toBe(200);
    expect((await list(h, dana.token)).status).toBe(200);
    expect((await send(h, dana.token, { toEmail: DANA, amount: 100 })).status).toBe(422);
    expect((await send(h, dana.token, { toEmail: 'nobody@example.com', amount: 100 })).status).toBe(
      422,
    );
    expect(
      (await send(h, dana.token, { toEmail: OMER, amount: dana.user.balance + 1 })).status,
    ).toBe(422);
    expect((await send(h, dana.token, { toEmail: OMER, amount: 0 })).status).toBe(400);
    expect((await requestReset(h)).status).toBe(202);
    expect((await resetPassword(h, latestResetPasscode(h))).status).toBe(204);
    expect((await login(h, DANA, NEW_PASSWORD)).status).toBe(200);
    expect(await balances()).toEqual([danaStart, omerStart]);
    expect([balanceOf(h, dana.user.id), balanceOf(h, omer.user.id)]).toEqual([
      danaStart,
      omerStart,
    ]);

    expect((await send(h, dana.token, { toEmail: OMER, amount: 1_250 })).status).toBe(201);

    expect(await balances()).toEqual([danaStart - 1_250, omerStart + 1_250]);
  });
});

describe('DB-1 a token whose user is gone by the time the transfer runs', () => {
  it('[DB-1.b] createTransfer answers 401 like a missing token, and nothing changes, when the sender is no longer in the store', async () => {
    const h = buildTestHarness();
    const dana = await account(h, DANA, 100_000);
    await account(h, OMER, 40_000);
    // The token check reads the harness's user store, where Dana is; the money move reads one
    // that has Omer but no longer has Dana, as if she had been removed in between.
    const later = new InMemoryUserRepository();
    await later.insert({ ...aUser(OMER), balance: 40_000 });
    const store = new InMemoryTransactionRepository(later);
    const app = createApp({
      ...h.deps,
      repositories: { ...h.deps.repositories, transactions: store },
    });
    const missing = await request(app).post(TRANSFERS).send({ toEmail: OMER, amount: 1_000 });
    // Control: Dana's token passes the token check of this app, so the 401 comes from the step.
    expect((await request(app).get(ME).set(bearer(dana.token))).status).toBe(200);
    const before = { users: h.users.snapshot(), later: later.snapshot() };

    const res = await send({ app }, dana.token, { toEmail: OMER, amount: 1_000 });

    expect(res.status).toBe(401);
    expect(answerOf(res)).toEqual(answerOf(missing));
    expect({ users: h.users.snapshot(), later: later.snapshot() }).toEqual(before);
    expect(later.snapshot()[0]?.balance).toBe(40_000);
    expect(store.snapshot()).toEqual([]);
  });
});
