// Verified users (docs/decisions/0007, 0009).

export type User = {
  id: string;
  /** Lowercased. */
  email: string;
};

export type UserRepository = {
  findByEmail(email: string): Promise<User | undefined>;
};

export class InMemoryUserRepository implements UserRepository {
  private readonly byEmail = new Map<string, User>();

  /** Stores a user; a second user with the same email is refused. */
  async insert(user: User): Promise<void> {
    if (this.byEmail.has(user.email)) throw new Error('A user with this email already exists');
    this.byEmail.set(user.email, { ...user });
  }

  async findByEmail(email: string): Promise<User | undefined> {
    const user = this.byEmail.get(email);
    return user && { ...user };
  }
}
