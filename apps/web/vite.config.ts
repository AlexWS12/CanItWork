import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // API_PORT lets a second dev server run beside the usual one
  server: { port: 5173, proxy: { '/api': `http://localhost:${process.env.API_PORT ?? 8787}` } },
});
