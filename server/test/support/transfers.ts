// Shared by the transfer and transaction-list tests.
import { expect } from '@jest/globals';
import type { Express } from 'express';
import request from 'supertest';
import type { TransactionRepository } from '../../src/repositories/transactions';
import type { User } from '../../src/repositories/users';
import { bearer, tokenFor, TRANSACTIONS, TRANSFERS, transferKey } from './auth';
import { aUser, type Harness, SECOND } from './sign-up';

export const DANA = 'dana@example.com';
export const OMER = 'omer@example.com';
export const NOA = 'noa@example.com';

const problem = (status: number, code: string, title: string) => ({
  type: 'about:blank',
  title,
  status,
  code,
});

/** createTransfer's 422 examples in the contract. */
export const SELF_TRANSFER = problem(422, 'SELF_TRANSFER', "You can't send money to yourself");
export const RECIPIENT_NOT_FOUND = problem(422, 'RECIPIENT_NOT_FOUND', 'No user with that email');
export const INSUFFICIENT_FUNDS = problem(422, 'INSUFFICIENT_FUNDS', 'Insufficient funds');
/** The one 500 body (components.responses.InternalError, SEC-5.c). */
export const INTERNAL_ERROR = problem(500, 'INTERNAL_ERROR', 'Internal server error');

export const JSON_TYPE = /^application\/json/;

/** Anything the requests can go to: the harness, or an app built over other stores. */
type Target = { app: Express };

/** A verified user put straight into the store with `balance` agorot, and a token for it. */
export async function account(
  h: Harness,
  email: string,
  balance: number,
): Promise<{ token: string; user: User }> {
  const user = await h.users.insert({ ...aUser(email), balance });
  return { token: await tokenFor(h, user.id), user };
}

/** createTransfer with `token`'s user as the sender, under a new one-time key unless `key` is given. */
export const send = (target: Target, token: string, body: Record<string, unknown>, key?: string) =>
  request(target.app).post(TRANSFERS).set(bearer(token)).set(transferKey(key)).send(body);

/** listTransactions for `token`'s user; `query` is appended as given, e.g. `?limit=5`. */
export const list = (target: Target, token: string, query = '') =>
  request(target.app).get(`${TRANSACTIONS}${query}`).set(bearer(token));

/**
 * Sends each amount to `toEmail` in turn, moving the clock `gap` ms before each, and expects a 201
 * for every one. Returns the transactions' ids in the order sent.
 */
export async function sendEach(
  h: Harness,
  token: string,
  toEmail: string,
  amounts: number[],
  gap = SECOND,
): Promise<string[]> {
  const ids: string[] = [];
  for (const amount of amounts) {
    h.clock.advance(gap);
    const res = await send(h, token, { toEmail, amount });
    expect(res.status).toBe(201);
    ids.push(res.body.transaction.id as string);
  }
  return ids;
}

/** Everything a transfer could change: every user (balances included), record and pending sign-up. */
export const stateOf = (h: Harness) => ({
  users: h.users.snapshot(),
  records: h.transactions.snapshot(),
  pendingSignUps: h.pendingSignUps.snapshot(),
});

/** Each token's whole list (limit 50) as the API shows it, status included. */
export async function listsOf(target: Target, ...tokens: string[]) {
  const lists: { status: number; body: unknown }[] = [];
  for (const token of tokens) {
    const res = await list(target, token, '?limit=50');
    lists.push({ status: res.status, body: res.body as unknown });
  }
  return lists;
}

/** The stored balance of the user with `id`. */
export function balanceOf(h: Harness, id: string): number {
  const user = h.users.snapshot().find((stored) => stored.id === id);
  if (!user) throw new Error(`no user ${id} in the store`);
  return user.balance;
}

export const sumOfBalances = (h: Harness) =>
  h.users.snapshot().reduce((sum, user) => sum + user.balance, 0);

/** How long the door waits for the rest once the first transfer arrives. */
const HOLD_TIMEOUT_MS = 2_000;

/**
 * A transaction store that passes every call on to the harness's, reading the sender's stored
 * balance as each transfer starts and again as it ends: a step that lets the balance dip below 0
 * in between shows in the next transfer's starting reading. With `hold`, each transfer waits at
 * the door until `hold` of them are waiting (or HOLD_TIMEOUT_MS after the first arrived), then all
 * go in together, so racing requests reach the money move at the same moment even over HTTP.
 * `door.arrivedTogether` says how many went in at once.
 */
export function watchedStore(h: Harness, senderId: string, hold?: number) {
  const inner = h.transactions;
  const readings: number[] = [];
  const door = { arrivedTogether: 0 };
  const waiting: (() => void)[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const open = () => {
    clearTimeout(timer);
    door.arrivedTogether = Math.max(door.arrivedTogether, waiting.length);
    for (const release of waiting.splice(0)) release();
  };
  const store: TransactionRepository = {
    async transfer(req) {
      if (hold !== undefined) {
        await new Promise<void>((resolve) => {
          waiting.push(resolve);
          if (waiting.length === 1) timer = setTimeout(open, HOLD_TIMEOUT_MS).unref();
          if (waiting.length === hold) open();
        });
      }
      readings.push(balanceOf(h, senderId));
      try {
        return await inner.transfer(req);
      } finally {
        readings.push(balanceOf(h, senderId));
      }
    },
    listFor: (userId, limit) => inner.listFor(userId, limit),
  };
  return { store, readings, door };
}
