import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { offlineShell } from './scripts/offline-shell-plugin.mjs';

export default defineConfig({
  plugins: [react(), offlineShell()],
  build: {
    outDir: 'dist/client',
    // Keep mobile breakpoints in syntax understood by the family's iOS 16.3.
    // The default Safari 16.4 target rewrites max-width into unsupported ranges.
    cssTarget: ['chrome111', 'edge111', 'firefox114', 'safari16.3', 'ios16.3']
  },
  server: { proxy: { '/api': 'http://127.0.0.1:8787' } }
});
