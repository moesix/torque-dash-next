import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// Vite dev server proxies /api (including the native /api/upload ingestion
// endpoint) to the Express backend on :3000. Because the browser talks to the
// same origin, the session cookie is first-party and works with Lax in dev;
// in production the backend serves the SPA and sets sameSite:none; secure.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
