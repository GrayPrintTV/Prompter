import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig(({ command }) => ({
  base: command === 'build' ? './' : '/',
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/tests/**/*.test.ts']
  }
}));
