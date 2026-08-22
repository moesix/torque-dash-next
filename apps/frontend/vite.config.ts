import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
  build: {
    rolldownOptions: {
      output: {
        // Vite 8 (Rolldown) dropped object-literal manualChunks; use
        // output.codeSplitting.groups (the native Rolldown API) to keep
        // vendor chunk splitting.
        codeSplitting: {
          groups: [
            {
              name: 'react-markdown',
              test: /node_modules[\\/]react-markdown/,
            },
            {
              name: 'rehype-highlight',
              test: /node_modules[\\/]rehype-highlight/,
            },
            {
              // zrender (echarts' renderer) is only imported by echarts, so
              // it would otherwise be absorbed back into the echarts chunk;
              // minShareCount: 0 keeps it as its own chunk.
              name: 'zrender',
              test: /node_modules[\\/]zrender/,
              minShareCount: 0,
            },
            {
              name: 'echarts',
              test: /node_modules[\\/]echarts/,
            },
            {
              name: 'react',
              test: /node_modules[\\/](react[\\/]|react-dom|scheduler)/,
            },
          ],
        },
      },
    },
  },
});
