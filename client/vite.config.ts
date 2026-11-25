import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { apiOrigin, contentSecurityPolicy } from './src/security-policy.ts';

/** Writes the page's content security policy into the built index.html (DP-4). */
function securityPolicy(api: string | undefined): Plugin {
  return {
    name: 'security-policy',
    apply: 'build',
    transformIndexHtml: () => [
      {
        tag: 'meta',
        attrs: { 'http-equiv': 'Content-Security-Policy', content: contentSecurityPolicy(api) },
        injectTo: 'head-prepend',
      },
    ],
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), securityPolicy(apiOrigin(loadEnv(mode, process.cwd(), 'VITE_').VITE_API_URL))],
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
}));
