// Access tokens (docs/decisions/0004, 0010): HS256 JWTs signed with jose.
import { SignJWT } from 'jose';
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
  };
}
