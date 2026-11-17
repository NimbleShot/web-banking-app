// Password hashing (docs/decisions/0010): argon2id at OWASP's minimum.
import { argon2id, hash } from 'argon2';

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

export const argon2PasswordHasher: PasswordHasher = {
  hash: (password) => hash(password, ARGON2_OPTIONS),
};
