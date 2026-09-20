import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { Source, SourceEdit } from '../shared/sources.ts';
import { ApiError, FamilyApi } from './api.ts';

export function SourceManager({ api, grant, onAccessError }: { api: FamilyApi; grant: string; onAccessError(error: ApiError): Promise<void> }) {
  const [sources, setSources] = useState<Source[]>([]);
  const [editing, setEditing] = useState<Source>();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [refresh, setRefresh] = useState(0);
  const pending = useRef<{ fingerprint: string; id: string; operationId: string } | null>(null);

  useEffect(() => {
    let active = true;
    setBusy(true); setError('');
    void api.managedSources(grant).then(items => { if (active) setSources(items); }).catch(async failure => {
      if (!active) return;
      if (failure instanceof ApiError && [401, 403].includes(failure.status)) { await onAccessError(failure); return; }
      setError(failure instanceof Error ? failure.message : '来源读取失败，请重试');
    }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [api, grant, refresh]);

  async function save(id: string | undefined, input: Omit<SourceEdit, 'operationId'>) {
    setBusy(true); setError(''); setNotice('');
    const fingerprint = JSON.stringify({ id, ...input });
    if (pending.current?.fingerprint !== fingerprint) pending.current = { fingerprint, id: id ?? crypto.randomUUID(), operationId: crypto.randomUUID() };
    try {
      const saved = await api.saveSource(grant, pending.current.id, { ...input, operationId: pending.current.operationId });
      setSources(current => [...current.filter(item => item.id !== saved.id), saved].sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name, 'zh-CN')));
      pending.current = null; setEditing(undefined); setName('');
      setNotice(saved.active ? '来源已保存，可以在收集时选择。' : '来源已停用，已有错题仍保留来源。');
    } catch (failure) {
      if (failure instanceof ApiError && [401, 403].includes(failure.status)) { await onAccessError(failure); return; }
      setError(failure instanceof Error ? failure.message : '保存失败，请重试');
    } finally { setBusy(false); }
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void save(editing?.id, { expectedRevision: editing?.revision ?? 0, name, active: editing?.active ?? true });
  }
  return <section className="source-manager" aria-label="来源管理列表">
    <p>孩子收集时可以选择这些来源，也可以留空。改名会更新关联错题的显示名称；停用只影响之后的选择。</p>
    {error && <p role="alert" className="message error">{error}</p>}
    {notice && <p role="status" className="message">{notice}</p>}
    <form onSubmit={submit} className="source-form"><fieldset disabled={busy}>
      <h2>{editing ? '修改来源' : '添加常用来源'}</h2>
      <label>来源名称<input value={name} onChange={event => setName(event.target.value)} required maxLength={200} placeholder="例如：每周小测、数学练习册" /></label>
      <div className="source-actions"><button type="submit">{editing ? '保存来源' : '添加来源'}</button>{editing && <button type="button" className="quiet" onClick={() => { setEditing(undefined); setName(''); setError(''); }}>取消修改</button>}</div>
    </fieldset></form>
    <div className="section-heading"><h2>已有来源</h2><button className="quiet" disabled={busy} onClick={() => { setEditing(undefined); setName(''); setRefresh(value => value + 1); }}>刷新来源列表</button></div>
    {busy && <p>正在处理来源…</p>}
    <ul className="source-list">{sources.map(item => <li key={item.id}><div><strong>{item.name}</strong>{!item.active && <span className="badge">已停用</span>}</div><div className="source-actions">
      <button className="quiet" aria-label={`改名 ${item.name}`} disabled={busy} onClick={() => { setEditing(item); setName(item.name); setError(''); setNotice(''); }}>改名</button>
      <button className="quiet" aria-label={`${item.active ? '停用' : '启用'} ${item.name}`} disabled={busy} onClick={() => void save(item.id, { expectedRevision: item.revision, name: item.name, active: !item.active })}>{item.active ? '停用' : '启用'}</button>
    </div></li>)}</ul>
  </section>;
}
