import { describe, expect, it } from '@jest/globals';
import { apiOrigin, contentSecurityPolicy } from '../src/security-policy';

/** The policy as directive → sources. */
const directives = (policy: string) =>
  Object.fromEntries(
    policy.split('; ').map((directive) => {
      const [name = '', ...sources] = directive.split(' ');
      return [name, sources];
    }),
  );

describe("the page's content security policy", () => {
  it('[DP-4] the page loads only its own files and calls only its own origin and the API at VITE_API_URL', () => {
    expect(directives(contentSecurityPolicy('https://api.example.com'))).toEqual({
      'default-src': ["'none'"],
      'script-src': ["'self'"],
      'style-src': ["'self'"],
      'font-src': ["'self'"],
      'img-src': ["'self'"],
      'connect-src': ["'self'", 'https://api.example.com'],
      'base-uri': ["'none'"],
      'form-action': ["'self'"],
    });
    expect(directives(contentSecurityPolicy(undefined))['connect-src']).toEqual(["'self'"]);
  });

  it('[DP-4] VITE_API_URL must be an origin: blank means the page’s own origin; a path, a trailing slash or another scheme stops the build', () => {
    expect(apiOrigin('https://api.example.com')).toBe('https://api.example.com');
    expect(apiOrigin('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000');
    expect(apiOrigin(undefined)).toBeUndefined();
    expect(apiOrigin('  ')).toBeUndefined();
    for (const wrong of [
      'https://api.example.com/',
      'https://api.example.com/api',
      'ftp://api.example.com',
      'api.example.com',
    ]) {
      expect(() => apiOrigin(wrong)).toThrow('VITE_API_URL must be an origin');
    }
  });
});
