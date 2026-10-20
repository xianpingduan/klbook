import { useEffect, useState } from 'react';
import type { ImportMaterial } from '../shared/imports.ts';
import type { FamilyApi } from './api.ts';

export function ImportImage({ api, grant, batchId, material, incoming }: { api: FamilyApi; grant?: string; batchId: string; material: ImportMaterial; incoming: boolean }) {
  const [open, setOpen] = useState(false), [url, setUrl] = useState(''), [error, setError] = useState(''), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!open || !grant) return;
    let live = true, objectUrl = '';
    setError(''); setUrl('');
    void (incoming ? api.importImage(grant, batchId, material.pageId) : api.pageImage(material.pageId, 'preview')).then(blob => {
      if (live) { objectUrl = URL.createObjectURL(blob); setUrl(objectUrl); }
    }).catch(reason => { if (live) setError(reason instanceof Error ? reason.message : '图片读取失败'); });
    return () => { live = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [api, grant, batchId, material.pageId, incoming, open, attempt]);
  const r = material.region ?? { x: 0, y: 0, width: 1, height: 1 };
  return <details onToggle={event => setOpen(event.currentTarget.open)}><summary>查看{incoming ? '资料包' : '当前'}题目图片</summary>
    {open && (error ? <p role="alert">{error} <button className="quiet" onClick={() => setAttempt(v => v + 1)}>重新加载图片</button></p> : url ? <svg className="question-crop" role="img" aria-label={incoming ? '资料包题目图片' : '当前题目图片'} width={r.width * material.width} height={r.height * material.height} viewBox={`${r.x * material.width} ${r.y * material.height} ${r.width * material.width} ${r.height * material.height}`}><image href={url} width={material.width} height={material.height} /></svg> : <p>正在读取图片…</p>)}
  </details>;
}
