// Password hashing (docs/decisions/0010): argon2id at OWASP's minimum.
import { argon2id, hash, verify } from 'argon2';

/** 19 MiB of memory, 2 passes, 1 lane: `$argon2id$v=19$m=19456,t=2,p=1$…`. */
export const ARGON2_OPTIONS = {
  type: argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export type PasswordHasher = {
  /** The argon2id hash string, with its own random salt and parameters. */
  hash(password: string): Promise<string>;
};

export type PasswordVerifier = {
  /** Whether `password` is the one `passwordHash` was made from; the hash carries its own salt. */
  verify(password: string, passwordHash: string): Promise<boolean>;
};

export const argon2PasswordHasher: PasswordHasher & PasswordVerifier = {
  hash: (password) => hash(password, ARGON2_OPTIONS),
  async verify(password, passwordHash) {
    try {
      return await verify(passwordHash, password);
    } catch (error) {
      // A stored value that isn't a hash string (argon2 rejects its format with a TypeError)
      // matches no password. Any other failure is a real one and still answers 500.
      if (error instanceof TypeError) return false;
      throw error;
    }
  },
};
