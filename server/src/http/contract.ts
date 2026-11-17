// Run-time enforcement of api/openapi.yaml (docs/decisions/0006, CT-4).
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import express, { type Request, type RequestHandler, type Response } from 'express';
import * as OpenApiValidator from 'express-openapi-validator';

/** The most UTF-8 bytes a password may have; the contract's maxLength counts characters. */
export const MAX_PASSWORD_BYTES = 72;

export const CONTRACT_PATH = resolve(__dirname, '../../../api/openapi.yaml');

/** A response that broke the contract, reported in tests (CT-4.c). */
export type ResponseViolation = {
  method: string;
  path: string;
  status: number;
  errors: { path: string; message: string }[];
};

export type ContractOptions = {
  /** When set, responses are validated against the contract and violations go here. */
  onResponseViolation?: (violation: ResponseViolation) => void;
};

/** The part of the validator's request metadata the guard reads: the matched operation. */
type MatchedOperation = { schema: { responses?: Record<string, unknown> } };

/** The contract declares `status` for this operation with no content, e.g. a bodiless 202. */
function declaresNoContent(operation: MatchedOperation, status: number): boolean {
  const response = operation.schema.responses?.[String(status)];
  if (typeof response !== 'object' || response === null) return false;
  return !('$ref' in response) && !('content' in response);
}

/**
 * Tests only. The library checks a response only when it is sent with `res.json`, and never
 * checks a 5xx. Every answer with a body is JSON, so one sent any other way (`res.send`,
 * `res.end` with a body, `sendStatus`) is reported instead of passing unchecked. The one
 * exception is `res.status(n).end()` with no body, for a status the contract declares with no
 * content.
 */
function jsonOnlyGuard(report: (violation: ResponseViolation) => void): RequestHandler {
  return function jsonOnlyGuard(req, res, next) {
    // The validator sets `openapi` on requests that matched an operation.
    const operation = (req as Request & { openapi?: MatchedOperation }).openapi;
    if (!operation) return next();
    let sentAsJson = false;
    const json = res.json;
    res.json = function (this: Response, body?: unknown) {
      sentAsJson = true;
      return json.call(this, body);
    };
    const end = res.end as (...args: unknown[]) => Response;
    res.end = function (this: Response, ...args: unknown[]) {
      const noBody = args[0] === undefined || typeof args[0] === 'function';
      if (!sentAsJson && !(noBody && declaresNoContent(operation, res.statusCode))) {
        report({
          method: req.method,
          path: req.originalUrl,
          status: res.statusCode,
          errors: [
            { path: '/response', message: 'was not sent with res.json, so it went unchecked' },
          ],
        });
      }
      return end.apply(this, args);
    } as Response['end'];
    next();
  };
}

/**
 * The request pipeline that enforces the contract, in this order:
 *  1. look up the operation; an unknown path or method fails here (404/405)
 *  2. (tests only) start watching the response, so error answers are checked too, and report
 *     an answer that bypasses the check
 *  3. require the bearer header on operations that need one
 *  4. parse the JSON body
 *  5. validate path, query, headers and body; every invalid field is reported
 *
 * The library installs response validation after request validation, which would leave its own
 * 400s and 401s, and malformed-JSON 400s, unchecked; and a body parser mounted ahead of it
 * would fail before the operation is known. So the chain is taken apart by function name and
 * put back in the order above. A library upgrade that renames them fails at start-up.
 * Answers with a 5xx status are never checked (the library skips them); the error handler builds
 * the only one, from the typed `problem()`.
 */
export function contractMiddleware(options: ContractOptions = {}): RequestHandler[] {
  const { onResponseViolation } = options;
  // The library reads the contract on the first request; a missing file would turn every
  // request into a 500 instead of stopping the start.
  if (!existsSync(CONTRACT_PATH)) throw new Error(`The API contract is missing: ${CONTRACT_PATH}`);
  const chain = OpenApiValidator.middleware({
    apiSpec: CONTRACT_PATH,
    validateRequests: { allErrors: true },
    validateResponses: onResponseViolation
      ? {
          allErrors: true,
          onError: (error, _body, req) => {
            onResponseViolation({
              method: req.method,
              path: req.originalUrl,
              status: req.res?.statusCode ?? 0,
              errors: error.errors.map(({ path, message }) => ({ path, message })),
            });
          },
        }
      : false,
    // `format: password` also limits the UTF-8 bytes, so an over-long password is reported in
    // the same 400 as every other invalid field (SU-3.c, SU-3.d).
    formats: {
      password: (value: string) => Buffer.byteLength(value, 'utf8') <= MAX_PASSWORD_BYTES,
    },
    // The contract has no file uploads: don't install the multipart parser.
    fileUploader: false,
  }) as RequestHandler[];

  const known = [
    'pathParamsMiddleware',
    'metadataMiddleware',
    'securityMiddleware',
    'requestMiddleware',
    'responseMiddleware',
  ];
  const unknown = chain.map((fn) => fn.name).filter((name) => !known.includes(name));
  if (unknown.length > 0) {
    throw new Error(`express-openapi-validator added ${unknown.join(', ')}; re-check the chain`);
  }
  const named = (name: string): RequestHandler => {
    const handler = chain.find((fn) => fn.name === name);
    if (!handler) throw new Error(`express-openapi-validator has no ${name}; re-check the chain`);
    return handler;
  };

  return [
    named('pathParamsMiddleware'),
    named('metadataMiddleware'),
    ...(onResponseViolation
      ? [named('responseMiddleware'), jsonOnlyGuard(onResponseViolation)]
      : []),
    named('securityMiddleware'),
    express.json(),
    named('requestMiddleware'),
  ];
}
