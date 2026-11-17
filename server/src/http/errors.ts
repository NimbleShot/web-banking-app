// Turns every error into an application/problem+json answer from the contract's catalogue.
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { error as ValidatorError } from 'express-openapi-validator';
import { MAX_PASSWORD_BYTES } from './contract';
import { type FieldError, type Problem, problem, sendProblem, validationProblem } from './problem';

const notFoundProblem = (): Problem => problem(404, 'NOT_FOUND', 'Not found');

/** Last route: nothing answered the request. */
export const notFound: RequestHandler = (_req, res) => {
  sendProblem(res, notFoundProblem());
};

const LOCATIONS = new Set(['body', 'query', 'path', 'params', 'headers', 'cookies']);

/**
 * The validator names a field by its location and property: `/body/email`, `/query/limit`, and
 * in a few errors `.query.limit`. The answer names the property alone (`email`), or the location
 * when the whole of it is wrong (`body`). A path that names no location (some errors carry the
 * request URL instead) becomes `request`, never a piece of the URL.
 */
export function fieldOf(path: string): string {
  const [location, ...property] = path.split(/[/.]/).filter(Boolean);
  if (location === undefined || !LOCATIONS.has(location)) return 'request';
  return property.length > 0 ? property.join('.') : location;
}

/** The validator names the format a value broke; the password format is the byte limit. */
const READABLE_MESSAGES: Record<string, string> = {
  'must match format "password"': `must be at most ${MAX_PASSWORD_BYTES} bytes in UTF-8`,
};

/** One entry per field: the first message wins (an email can break its format and its length). */
function fieldErrors(items: { path: string; message: string }[]): FieldError[] {
  const byField = new Map<string, string>();
  for (const { path, message } of items) {
    const field = fieldOf(path);
    if (!byField.has(field)) byField.set(field, READABLE_MESSAGES[message] ?? message);
  }
  return [...byField].map(([field, message]) => ({ field, message }));
}

/** body-parser's errors (malformed JSON, a body too large) carry a `type` and a 4xx `status`. */
function isBodyError(error: unknown): error is { type: string; status: number } {
  if (typeof error !== 'object' || error === null) return false;
  const { type, status } = error as { type?: unknown; status?: unknown };
  return typeof type === 'string' && typeof status === 'number' && status >= 400 && status < 500;
}

function toProblem(error: unknown): Problem {
  if (error instanceof ValidatorError.BadRequest)
    return validationProblem(fieldErrors(error.errors));
  if (error instanceof ValidatorError.UnsupportedMediaType) {
    return validationProblem([{ field: 'body', message: 'must be application/json' }]);
  }
  if (error instanceof ValidatorError.Unauthorized) {
    return problem(401, 'UNAUTHORIZED', 'Sign in required');
  }
  if (
    error instanceof ValidatorError.NotFound ||
    error instanceof ValidatorError.MethodNotAllowed
  ) {
    return notFoundProblem();
  }
  if (isBodyError(error)) {
    const message =
      error.type === 'entity.parse.failed' ? 'must be valid JSON' : 'could not be read';
    return validationProblem([{ field: 'body', message }]);
  }
  return problem(500, 'INTERNAL_ERROR', 'Internal server error');
}

export const errorHandler: ErrorRequestHandler = (error, req, res, next) => {
  if (res.headersSent) return next(error);
  const body = toProblem(error);
  if (body.status >= 500) req.log.error({ err: error }, 'request failed');
  sendProblem(res, body);
};
