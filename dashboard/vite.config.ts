import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Some wallet dependencies read process.env (e.g. @near-js/accounts'
  // DEFAULT_FINALITY), which doesn't exist in the browser.
  define: { global: 'globalThis', 'process.env': '{}' },
  resolve: { alias: { buffer: 'buffer/' } },
  server: { port: 5173 },
});
