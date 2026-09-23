import { useEffect, useRef, useState } from 'react';
import { MAX_IMAGE_BYTES } from '../shared/collection.ts';
import type { OriginalPage, QuestionPart } from '../shared/collection.ts';
import { ApiError, FamilyApi } from './api.ts';
import type { CaptureCache, PendingCapture } from './capture-cache.ts';

/** Keep the selected bytes and operation until the owning question or reading material saves the page reference. */
export function usePageAppend({ api, cache, grant, onAppend, onAccessError }: {
  api: FamilyApi; cache: CaptureCache; grant?: string; onAppend(page: OriginalPage, partId: string): void; onAccessError(error: ApiError): Promise<void>;
}) {
  const [capture, setCapture] = useState<PendingCapture>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [appended, setAppended] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    void cache.read().then(saved => { if (mounted.current) setCapture(saved); })
      .catch(failure => { if (mounted.current) setError(failure instanceof Error ? failure.message : '追加材料无法读取'); })
      .finally(() => { if (mounted.current) setLoading(false); });
    return () => { mounted.current = false; };
  }, [cache]);
  async function upload(pending: PendingCapture) {
    if (busy || loading) return;
    setBusy(true); setError(''); setCapture(pending);
    try {
      await cache.save(pending);
      if (!mounted.current) return;
      const page = await api.uploadPage(pending.file, pending.operationId, grant);
      if (!mounted.current) return;
      onAppend(page, pending.operationId); setAppended(true);
    } catch (failure) {
      if (!mounted.current) return;
      if (failure instanceof ApiError && [401, 403].includes(failure.status)) await onAccessError(failure);
      else setError(`${failure instanceof Error ? failure.message : '追加失败'}。当前图片仍保留，请继续追加或重试。`);
    } finally { if (mounted.current) setBusy(false); }
  }
  function choose(files: FileList | null) {
    if (!files?.length || capture || busy || loading) return;
    const file = files[0]!;
    if (files.length !== 1 || !file.size || file.size > MAX_IMAGE_BYTES) { setError('每次追加一张非空图片，不超过 15 MB。'); return; }
    void upload({ file, name: file.name, operationId: crypto.randomUUID() });
  }
  async function clear() {
    setBusy(true); setError('');
    try { await cache.remove(); if (mounted.current) { setCapture(undefined); setAppended(false); } }
    catch { if (mounted.current) setError('本设备追加记录暂时无法清理，材料仍保留，可稍后重试。'); }
    finally { if (mounted.current) setBusy(false); }
  }
  async function committed(material: { parts: QuestionPart[] }) {
    if (capture && (appended || material.parts.some(part => part.id === capture.operationId))) await clear();
  }
  return { capture, loading, busy, appended, error, choose, retry: () => capture && void upload(capture), cancel: () => void clear(), committed };
}
