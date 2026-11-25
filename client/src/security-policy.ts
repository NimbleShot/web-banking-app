// The page's content security policy (DP-4, docs/decisions/0017), written into index.html at build
// time by vite.config.ts. Everything the page loads is its own: scripts, styles, self-hosted fonts
// and images. It may call the API at VITE_API_URL, or its own origin when that is unset. What a
// <meta> policy can't hold (frame-ancestors) is a response header in render.yaml.

/**
 * VITE_API_URL as an origin (`https://api.example.com`), or undefined when unset or blank. Anything
 * else stops the build: a wrong address would ship a page that can't reach the API.
 */
export function apiOrigin(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  let url: URL | undefined;
  try {
    url = new URL(value);
  } catch {
    url = undefined;
  }
  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:') || url.origin !== value) {
    throw new Error(
      `VITE_API_URL must be an origin such as https://api.example.com, no path or trailing slash (got "${value}")`,
    );
  }
  return url.origin;
}

/** The policy for a page whose API is at `api` (an origin), or at its own origin. */
export function contentSecurityPolicy(api: string | undefined): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "font-src 'self'",
    "img-src 'self'",
    `connect-src 'self'${api ? ` ${api}` : ''}`,
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ');
}
