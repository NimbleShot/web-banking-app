// The signed-in user's account (DB-3).
import type { User, UserRepository } from '../repositories/users';

/** What the account shows: never the password hash. */
export type Account = Omit<User, 'passwordHash'>;

export type AccountService = {
  /** The account of `userId` as the store holds it now, or undefined if there is none. */
  getAccount(userId: string): Promise<Account | undefined>;
};

export function createAccountService(deps: { users: UserRepository }): AccountService {
  return {
    async getAccount(userId) {
      const user = await deps.users.findById(userId);
      if (!user) return undefined;
      const { id, email, phone, balance, createdAt } = user;
      return { id, email, phone, balance, createdAt };
    },
  };
}
