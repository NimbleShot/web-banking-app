// CORS for the one front-end origin (SEC-3).
import cors from 'cors';
import type { RequestHandler } from 'express';

/**
 * Lets the front end at `origin` call the API from a browser, and no other origin.
 *
 * - `origin` is a list, not a string: cors then sends Access-Control-Allow-Origin only to a
 *   listed origin, while a string would be sent to every caller.
 * - cors on its own answers every OPTIONS request with 204, whatever its path or origin. Only a
 *   real preflight from the front end (its Origin and an Access-Control-Request-Method header)
 *   is answered here; any other OPTIONS request goes on to the contract, which answers
 *   404 NOT_FOUND like any method it doesn't list (CT-4.b). A preflight from the front end to an
 *   unknown path is still answered 2xx; the request that follows it then gets the 404.
 * - Retry-After (on 429) is exposed, since a browser hides response headers outside the
 *   CORS-safelisted few from the page.
 */
export function corsForFrontEnd(origin: string): RequestHandler {
  const allow = cors({
    origin: [origin],
    methods: ['GET', 'POST'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key'],
    exposedHeaders: ['Retry-After'],
  });
  return (req, res, next) => {
    const isFrontEndPreflight =
      req.headers.origin === origin && req.headers['access-control-request-method'] !== undefined;
    if (req.method === 'OPTIONS' && !isFrontEndPreflight) return next();
    allow(req, res, next);
  };
}
