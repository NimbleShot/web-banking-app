import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    // The API's default CORS origin is this port, so a busy port fails instead of moving.
    port: 5173,
    strictPort: true,
    // Same-origin calls in development: only the API's paths reach the Express server.
    proxy: { '/api': 'http://localhost:3000' },
  },
});
