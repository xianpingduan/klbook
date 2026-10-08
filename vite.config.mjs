import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { offlineShell } from './scripts/offline-shell-plugin.mjs';

export default defineConfig({
  plugins: [react(), offlineShell()],
  build: { outDir: 'dist/client' },
  server: { proxy: { '/api': 'http://127.0.0.1:8787' } }
});
