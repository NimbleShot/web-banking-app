// The page's content security policy (DP-4, docs/decisions/0017), written into index.html at build
// time by vite.config.ts. Everything the page loads is its own: scripts, styles, self-hosted fonts
// and images. It may call the API at VITE_API_URL, or its own origin when that is unset. What a
// <meta> policy can't hold (frame-ancestors) is a response header in render.yaml.

/**
 * VITE_API_URL, checked: exactly an origin (`https://api.example.com`), or undefined when unset or
 * empty. The page calls the value as written, so anything else stops the build, a stray space
 * included: it would ship a page that can't reach the API. With `required` (a deploy build, where
 * the pages' own host has no API behind it), unset or empty stops the build too.
 */
export function apiOrigin(raw: string | undefined, required = false): string | undefined {
  if (raw === undefined || raw === '') {
    if (required) throw new Error("VITE_API_URL must be set for this build (the API's origin)");
    return undefined;
  }
  let url: URL | undefined;
  try {
    url = new URL(raw);
  } catch {
    url = undefined;
  }
  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:') || url.origin !== raw) {
    throw new Error(
      `VITE_API_URL must be an origin such as https://api.example.com, no path, trailing slash or space (got "${raw}")`,
    );
  }
  return raw;
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
