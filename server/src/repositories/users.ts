// Verified users (docs/decisions/0003, 0007, 0009).
import { randomUUID } from 'node:crypto';

export type User = {
  id: string;
  /** Lowercased. */
  email: string;
  /** E.164. */
  phone: string;
  /** The argon2id hash string; never the password. */
  passwordHash: string;
  /** Integer agorot. */
  balance: number;
  createdAt: Date;
};

/** A user before the store gives it an id. */
export type NewUser = Omit<User, 'id'>;

/** The store already holds a user with this lowercased email (SU-2.d). */
export class DuplicateEmailError extends Error {
  constructor() {
    super('A user with this email already exists');
    this.name = 'DuplicateEmailError';
  }
}

export type UserRepository = {
  findByEmail(email: string): Promise<User | undefined>;
  /**
   * Stores a new user and returns it with its id. The store itself refuses a second user with
   * the same lowercased email by throwing DuplicateEmailError: no look-up first is needed, and
   * none is enough (docs/decisions/0002, 0007).
   */
  insert(user: NewUser): Promise<User>;
};

const copy = (user: User): User => structuredClone(user);

/**
 * Keyed by the lowercased email. `insert` checks and writes with no `await` between them, so of
 * two racing inserts exactly one is stored, like a unique index (MongoDB at P03).
 */
export class InMemoryUserRepository implements UserRepository {
  private readonly byEmail = new Map<string, User>();

  async insert(user: NewUser): Promise<User> {
    // The key and the stored field are the same lowercased value, as a unique index needs.
    const email = user.email.toLowerCase();
    if (this.byEmail.has(email)) throw new DuplicateEmailError();
    const stored: User = { ...structuredClone(user), email, id: randomUUID() };
    this.byEmail.set(email, stored);
    return copy(stored);
  }

  async findByEmail(email: string): Promise<User | undefined> {
    const user = this.byEmail.get(email.toLowerCase());
    return user && copy(user);
  }

  /** Copies of every stored user, for inspection. */
  snapshot(): User[] {
    return [...this.byEmail.values()].map(copy);
  }
}
