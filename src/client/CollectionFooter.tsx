import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

/** Keep the primary action above the on-screen keyboard and device safe area. */
export function CollectionFooter({ children }: { children: ReactNode }) {
  const [bottom, setBottom] = useState(0);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => setBottom(viewport.scale === 1 ? Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop) : 0);
    update(); viewport.addEventListener('resize', update); viewport.addEventListener('scroll', update);
    return () => { viewport.removeEventListener('resize', update); viewport.removeEventListener('scroll', update); };
  }, []);
  return <div className="collection-footer" style={{ bottom }}>{children}</div>;
}
