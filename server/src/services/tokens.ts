// Access tokens (docs/decisions/0004, 0010): HS256 JWTs signed with jose.
import { errors, jwtVerify, SignJWT } from 'jose';
import type { Clock } from '../clock';

/** How long an access token is valid: one hour. */
export const ACCESS_TOKEN_TTL_SECONDS = 3600;

export type TokenServiceOptions = {
  /** config.jwtSecret. */
  secret: string;
  clock: Clock;
};

export type TokenService = {
  /** An HS256 JWT with `sub` = the user's id, issued now by the clock, expiring an hour later. */
  sign(userId: string): Promise<string>;
  /**
   * The user id a token names, or undefined when the token is not one this server would accept:
   * not an HS256 JWT signed with the secret, expired by the clock, or without `sub` or `exp`.
   */
  verify(token: string): Promise<string | undefined>;
};

export function createTokenService({ secret, clock }: TokenServiceOptions): TokenService {
  const key = new TextEncoder().encode(secret);
  return {
    sign(userId) {
      // Times come from the injected clock, never from jose's own reading of Date.now().
      const issuedAt = Math.floor(clock.now().getTime() / 1000);
      return new SignJWT()
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(userId)
        .setIssuedAt(issuedAt)
        .setExpirationTime(issuedAt + ACCESS_TOKEN_TTL_SECONDS)
        .sign(key);
    },
    async verify(token) {
      try {
        const { payload } = await jwtVerify(token, key, {
          // Only HS256, whatever the token's header claims (alg: none, HS384, RS256...).
          algorithms: ['HS256'],
          currentDate: clock.now(),
          // Every token this server signs has both; one without them is not one of ours.
          requiredClaims: ['sub', 'exp'],
        });
        return typeof payload.sub === 'string' && payload.sub !== '' ? payload.sub : undefined;
      } catch (error) {
        // A token that fails a check is refused; anything else is a real failure.
        if (error instanceof errors.JOSEError) return undefined;
        throw error;
      }
    },
  };
}
