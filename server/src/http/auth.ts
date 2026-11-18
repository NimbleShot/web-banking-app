// The bearer token check (docs/decisions/0004, 0010) and the one place handlers read its user.
import type { Request, Response } from 'express';
import type { AuthenticationService } from '../services/authentication';

/** The validator's security handler: true lets the request through, false answers 401. */
export type BearerAuthHandler = (req: Request) => Promise<boolean>;

const LOCALS_KEY = 'authenticatedUserId';

/** `Bearer <token>` (RFC 6750: one or more spaces); the scheme name is case-insensitive. */
const BEARER = /^Bearer +(\S+)$/i;

/**
 * Runs for every operation the contract secures (`security: bearerAuth`), after the operation
 * is known and before the body is parsed. It keeps only the user id from the verified token. A
 * refused token answers false (401 UNAUTHORIZED). An unexpected failure, such as the store being
 * down, is logged here with its cause and answers 500 rather than passing for a 401.
 */
export function bearerAuthHandler(auth: AuthenticationService): BearerAuthHandler {
  return async (req) => {
    const token = BEARER.exec(req.headers.authorization ?? '')?.[1];
    if (token === undefined) return false;
    let userId: string | undefined;
    try {
      userId = await auth.authenticate(token);
    } catch (error) {
      // The validator rebuilds the error from its message alone, so the cause and stack are
      // logged now. The line holds the error, never the token (and request logs redact it).
      req.log.error({ err: error }, 'token check failed');
      // Without a status the validator would answer 401; this is a 500.
      throw Object.assign(new Error('token check failed'), { status: 500 });
    }
    if (userId === undefined) return false;
    (req.res as Response).locals[LOCALS_KEY] = userId;
    return true;
  };
}

/**
 * The id of the user the token check let through. Handlers of secured operations read the
 * acting user only from here; reaching this without the check is a server bug (500).
 */
export function authenticatedUserId(res: Response): string {
  const userId = res.locals[LOCALS_KEY] as string | undefined;
  if (userId === undefined) throw new Error('No authenticated user: the token check did not run');
  return userId;
}
