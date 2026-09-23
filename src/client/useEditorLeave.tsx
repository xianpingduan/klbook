import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useLeaveGuard } from './navigation.ts';

/** Editors own saving and discarding; this boundary owns the pending navigation and dialog. */
export function useEditorLeave({ dirty, busy, canSave, title, description, error, save, discard }: {
  dirty: boolean; busy: boolean; canSave: boolean; title: string; description: ReactNode; error: string;
  save(): Promise<boolean>; discard(): void;
}) {
  const [leaving, setLeaving] = useState<{ proceed(): void }>();
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const { requestLeave, releaseGuard } = useLeaveGuard(dirty || busy, proceed => setLeaving({ proceed }));
  useEffect(() => { if (leaving) dialog.current?.showModal(); else dialog.current?.close(); }, [leaving]);
  function finish(proceed?: () => void) { releaseGuard(); setLeaving(undefined); proceed?.(); }
  return {
    requestLeave,
    leaving: !!leaving,
    dismiss: () => setLeaving(undefined),
    dialog: createPortal(<dialog ref={dialog} className="leave-dialog" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); if (!busy) setLeaving(undefined); }}>
      <h2 id={titleId}>{title}</h2>{description}
      {error && <p role="alert" className="message error">{error}</p>}
      <div className="leave-actions">
        <button autoFocus disabled={busy} onClick={() => setLeaving(undefined)}>继续编辑</button>
        <button className="quiet" disabled={busy || !canSave} onClick={() => { const proceed = leaving?.proceed; void save().then(saved => { if (saved) finish(proceed); }); }}>{busy ? '正在保存…' : '保存后离开'}</button>
        <button className="quiet" disabled={busy} onClick={() => { const proceed = leaving?.proceed; discard(); finish(proceed); }}>放弃本次修改并离开</button>
      </div>
    </dialog>, document.querySelector('.app-surface') ?? document.body),
  };
}
