// Who a bearer token signs in (docs/decisions/0004, 0010, DB-1).
import type { UserRepository } from '../repositories/users';
import type { TokenService } from './tokens';

export type AuthenticationService = {
  /**
   * The user id of a token this server accepts and whose user still exists, or undefined. The id
   * comes only from the verified token's `sub`. A failing store throws.
   */
  authenticate(token: string): Promise<string | undefined>;
};

export function createAuthenticationService(deps: {
  tokens: TokenService;
  users: UserRepository;
}): AuthenticationService {
  return {
    async authenticate(token) {
      const userId = await deps.tokens.verify(token);
      if (userId === undefined) return undefined;
      return (await deps.users.findById(userId)) ? userId : undefined;
    },
  };
}
