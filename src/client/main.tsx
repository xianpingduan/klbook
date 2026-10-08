/// <reference types="vite/client" />
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { browserPlatform } from './browser-platform.ts';
import './style.css';

createRoot(document.getElementById('root')!).render(<App platform={browserPlatform()} />);
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  void navigator.serviceWorker.register('/offline-worker.js', { updateViaCache: 'none' }).catch(() => {
    // The Mine page reports preparation separately from successfully saved drafts.
  });
}
