// RFC 9457 problem documents with the contract's error `code` (docs/decisions/0006).
import type { Response } from 'express';
import type { components } from '../../../api/generated/schema';

export type ErrorCode = components['schemas']['ErrorCode'];
export type FieldError = components['schemas']['FieldError'];
export type Problem = components['schemas']['Problem'];
export type ValidationProblem = components['schemas']['ValidationProblem'];

export const PROBLEM_JSON = 'application/problem+json';

export function problem(status: number, code: ErrorCode, title: string): Problem {
  return { type: 'about:blank', title, status, code };
}

export function validationProblem(errors: FieldError[]): ValidationProblem {
  return { ...problem(400, 'VALIDATION_FAILED', 'Invalid request'), errors };
}

export function sendProblem(res: Response, body: Problem): void {
  res.status(body.status).type(PROBLEM_JSON).json(body);
}
