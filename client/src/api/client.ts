import createClient from 'openapi-fetch';
import type { paths } from '../../../api/generated/schema';

/**
 * Typed from the contract. The API is at VITE_API_URL, set when the page is built for a host where
 * the API has its own address (DP-4); unset, calls are same-origin and the dev server proxies them.
 */
export const api = createClient<paths>({ baseUrl: import.meta.env.VITE_API_URL ?? '' });

export { attempt, failureMessage, type Failure, type Result } from './outcome';
