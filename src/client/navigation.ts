import { useEffect, useState } from 'react';
import { pagePath } from '../shared/app-routes.ts';
import type { PagePath } from '../shared/app-routes.ts';

export function usePage() {
  const [path, setPath] = useState(() => pagePath(window.location.pathname));
  useEffect(() => {
    // The path is the return target. Query strings can never supply an external destination.
    window.history.replaceState(null, '', pagePath(window.location.pathname));
    const restore = () => setPath(pagePath(window.location.pathname));
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, []);
  function navigate(next: PagePath) {
    if (next === path) return;
    window.history.pushState(null, '', next);
    setPath(next);
  }
  return { path, navigate };
}
