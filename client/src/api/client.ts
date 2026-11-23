import createClient from 'openapi-fetch';
import type { components, paths } from '../../../api/generated/schema';

/** Typed from the contract. Paths are same-origin: the dev server proxies them to the API. */
export const api = createClient<paths>({ baseUrl: '' });

type ErrorCode = components['schemas']['ErrorCode'];

export type Failure =
  | {
      kind: 'problem';
      status: number;
      code: ErrorCode | undefined;
      /** The server's message per request field, on a 400. */
      fields: Record<string, string>;
      /** Seconds to wait, on a 429. */
      retryAfter: number | null;
    }
  | { kind: 'network' };

export type Result<T> = { ok: true; data: T } | { ok: false; failure: Failure };

type Answer<T> = { data?: T; error?: unknown; response: Response };

function problemFrom(error: unknown, response: Response): Failure {
  const body = (typeof error === 'object' && error !== null ? error : {}) as {
    code?: unknown;
    errors?: unknown;
  };
  const fields: Record<string, string> = {};
  if (Array.isArray(body.errors)) {
    for (const entry of body.errors as { field?: unknown; message?: unknown }[]) {
      if (typeof entry.field === 'string' && typeof entry.message === 'string') {
        fields[entry.field] = entry.message;
      }
    }
  }
  const retryAfter = Number(response.headers.get('Retry-After'));
  return {
    kind: 'problem',
    status: response.status,
    code: typeof body.code === 'string' ? (body.code as ErrorCode) : undefined,
    fields,
    retryAfter: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
  };
}

/** Runs one API call and folds its three outcomes (data, problem, no answer) into one value. */
export async function attempt<T>(call: () => Promise<Answer<T>>): Promise<Result<T>> {
  try {
    const { data, error, response } = await call();
    if (response.ok) return { ok: true, data: data as T };
    return { ok: false, failure: problemFrom(error, response) };
  } catch {
    return { ok: false, failure: { kind: 'network' } };
  }
}

/** The message for a failure no screen handles itself. */
export function failureMessage(failure: Failure): string {
  if (failure.kind === 'network') {
    return "We couldn't reach the bank. Check your connection and try again.";
  }
  if (failure.code === 'RATE_LIMITED') {
    if (failure.retryAfter === null) return 'Too many tries. Wait a few minutes and try again.';
    const minutes = Math.ceil(failure.retryAfter / 60);
    return `Too many tries. Wait ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} and try again.`;
  }
  return 'Something went wrong on our side. Try again in a moment.';
}
