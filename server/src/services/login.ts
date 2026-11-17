// Login (LG-1, LG-2): email and password in, the verified user out.
import type { User, UserRepository } from '../repositories/users';
import type { PasswordVerifier } from './passwords';

export type LoginOutcome = { result: 'ok'; user: User } | { result: 'invalid' };

export type LoginService = {
  login(email: string, password: string): Promise<LoginOutcome>;
};

/**
 * An unknown email, a wrong password and an email whose sign-up is still pending (it has no user
 * and no password yet, docs/decisions/0007) are the same `invalid`. An unknown email costs no
 * hash, so it answers sooner; that timing difference is accepted until deployment
 * (docs/decisions/0011).
 */
export function createLoginService(deps: {
  users: UserRepository;
  passwords: PasswordVerifier;
}): LoginService {
  return {
    async login(email, password) {
      const user = await deps.users.findByEmail(email);
      if (!user) return { result: 'invalid' };
      if (!(await deps.passwords.verify(password, user.passwordHash))) return { result: 'invalid' };
      return { result: 'ok', user };
    },
  };
}
