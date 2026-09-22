import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { pagePath } from '../shared/app-routes.ts';
import type { PagePath } from '../shared/app-routes.ts';

type LeaveGuard = (proceed: () => void) => void;
interface LeaveBoundary {
  requestLeave(proceed: () => void): void;
  register(guard: LeaveGuard): () => void;
}
export const LeaveContext = createContext<LeaveBoundary>({ requestLeave: proceed => proceed(), register: () => () => {} });

/** The editor owns the decision; routing only supplies the pending destination. */
export function useLeaveGuard(enabled: boolean, onBlocked: LeaveGuard) {
  const boundary = useContext(LeaveContext);
  const handler = useRef(onBlocked);
  const unregister = useRef<() => void>(() => {});
  useLayoutEffect(() => { handler.current = onBlocked; });
  useLayoutEffect(() => {
    unregister.current = enabled ? boundary.register(proceed => handler.current(proceed)) : () => {};
    return unregister.current;
  }, [boundary, enabled]);
  useEffect(() => {
    if (!enabled) return;
    const leaving = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', leaving);
    return () => window.removeEventListener('beforeunload', leaving);
  }, [enabled]);
  return { requestLeave: boundary.requestLeave, releaseGuard: () => unregister.current() };
}

interface Entry { owner: string; index: number; path: PagePath }
function historyEntry(): Entry | undefined {
  const entry = window.history.state?.klbookNavigation;
  return entry && typeof entry.owner === 'string' && Number.isSafeInteger(entry.index) && entry.path === pagePath(window.location.pathname) ? entry : undefined;
}
const writeEntry = (entry: Entry, replace = false) => window.history[replace ? 'replaceState' : 'pushState']({ klbookNavigation: entry }, '', entry.path);

export function usePage() {
  const [path, setPath] = useState(() => pagePath(window.location.pathname));
  const current = useRef<Entry>({ owner: crypto.randomUUID(), index: 0, path });
  const guard = useRef<LeaveGuard | undefined>(undefined);
  const boundary = useMemo<LeaveBoundary>(() => ({
    requestLeave(proceed) { if (guard.current) guard.current(proceed); else proceed(); },
    register(next) { guard.current = next; return () => { if (guard.current === next) guard.current = undefined; }; },
  }), []);
  useEffect(() => {
    current.current = historyEntry() ?? current.current;
    writeEntry(current.current, true);
    let restored: (() => void) | undefined;
    let allowed = false;
    const accept = (entry: Entry) => { current.current = entry; setPath(entry.path); };
    const pop = () => {
      if (restored) { const next = restored; restored = undefined; next(); return; }
      const target = historyEntry();
      if (allowed || !guard.current) {
        allowed = false;
        const entry = target ?? { owner: crypto.randomUUID(), index: 0, path: pagePath(window.location.pathname) };
        writeEntry(entry, true); accept(entry); return;
      }
      const previous = current.current;
      if (target?.owner === previous.owner) {
        const distance = target.index - previous.index;
        // Restore the editing entry before asking. Cancel retains both Back and Forward.
        restored = () => boundary.requestLeave(() => { allowed = true; window.history.go(distance); });
        window.history.go(-distance);
      } else {
        // Older versions had unmarked entries. Keep the editor and its target one step back.
        writeEntry(previous);
        boundary.requestLeave(() => { allowed = true; window.history.back(); });
      }
    };
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, [boundary]);
  function navigate(next: PagePath) {
    if (next === current.current.path) return;
    boundary.requestLeave(() => {
      const entry = { ...current.current, index: current.current.index + 1, path: next };
      writeEntry(entry); current.current = entry; setPath(next);
    });
  }
  return { path, navigate, boundary };
}
