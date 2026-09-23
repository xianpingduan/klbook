import { useEffect, useState } from 'react';
import type { ReadingMaterial, ReadingMaterialList } from '../shared/reading-materials.ts';
import { ApiError, FamilyApi } from './api.ts';

export function ReadingMaterialPicker({ api, grant, active, current, value, onChange, onAccessError }: {
  api: FamilyApi; grant?: string; active: boolean; current: ReadingMaterial | null; value: string | null; onChange(id: string | null): void; onAccessError(error: ApiError): Promise<void>;
}) {
  const [list, setList] = useState<ReadingMaterialList>({ items: [], total: 0, offset: 0, limit: 50 });
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!active) return;
    let live = true;
    setBusy(true); setError('');
    void api.readingMaterials(0, grant).then(result => { if (live) setList(result); })
      .catch(async failure => { if (!live) return; if (failure instanceof ApiError && [401, 403].includes(failure.status)) await onAccessError(failure); else setError('阅读材料列表暂时无法读取，可以重试。'); })
      .finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [api, grant, active, current?.id, attempt, onAccessError]);
  async function more() {
    setBusy(true); setError('');
    try { const next = await api.readingMaterials(list.items.length, grant); setList(previous => ({ ...next, items: [...previous.items, ...next.items] })); }
    catch (failure) { if (failure instanceof ApiError && [401, 403].includes(failure.status)) await onAccessError(failure); else setError('阅读材料列表暂时无法读取，可以重试。'); }
    finally { setBusy(false); }
  }
  return <div className="reading-picker">
    <label>阅读材料（选填）<select value={value ?? ''} disabled={busy || !active} onChange={event => onChange(event.target.value || null)}>
      <option value="">不关联阅读材料</option>
      {current && !list.items.some(item => item.id === current.id) && <option value={current.id}>{current.title}</option>}
      {list.items.map(item => <option key={item.id} value={item.id}>{item.title} · {item.partCount} 个原文区</option>)}
    </select></label>
    {busy && <p className="hint">正在读取阅读材料…</p>}
    {error && <p className="message error" role="alert">{error}<button className="quiet" onClick={() => setAttempt(value => value + 1)}>重试阅读材料列表</button></p>}
    {list.items.length < list.total && <button className="quiet" disabled={busy || !active} onClick={() => void more()}>加载更多阅读材料</button>}
    <p className="hint">多个小题可选择同一篇原文。选择“不关联”并保存只解除本题引用，原文和其他小题会保留。</p>
  </div>;
}
