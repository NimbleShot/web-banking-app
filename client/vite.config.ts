import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { apiOrigin, contentSecurityPolicy } from './src/security-policy.ts';

/** Writes the page's content security policy into the built index.html (DP-4). */
function securityPolicy(): Plugin {
  let policy = '';
  return {
    name: 'security-policy',
    apply: 'build',
    // config.env is what the bundle gets as import.meta.env (client/.env* files and the
    // environment, wherever the build runs from), so the policy allows exactly the address the
    // page calls. REQUIRE_API_URL=1 (render.yaml) refuses a deploy build without one.
    configResolved(config) {
      const api = apiOrigin(config.env.VITE_API_URL, process.env.REQUIRE_API_URL === '1');
      policy = contentSecurityPolicy(api);
    },
    transformIndexHtml: () => [
      {
        tag: 'meta',
        attrs: { 'http-equiv': 'Content-Security-Policy', content: policy },
        injectTo: 'head-prepend',
      },
    ],
  };
}

export default defineConfig({
  plugins: [react(), securityPolicy()],
  // Every asset ships as its own file: an inlined data: font would break the CSP's font-src 'self'.
  build: { assetsInlineLimit: 0 },
  server: {
    // The API's default CORS origin is this port, so a busy port fails instead of moving.
    port: 5173,
    strictPort: true,
    // Same-origin calls in development: only the API's paths reach the Express server, which
    // outside production listens on 127.0.0.1 only.
    proxy: { '/api': 'http://127.0.0.1:3000' },
  },
});
