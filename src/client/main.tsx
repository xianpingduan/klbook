import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { browserPlatform } from './browser-platform.ts';
import './style.css';

createRoot(document.getElementById('root')!).render(<App platform={browserPlatform()} />);
