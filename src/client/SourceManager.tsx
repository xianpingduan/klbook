import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { createPortal } from 'react-dom';
import type { Source, SourceEdit } from '../shared/sources.ts';
import { ApiError, FamilyApi } from './api.ts';
import { useLeaveGuard } from './navigation.ts';

export function SourceManager({ api, grant, active = true, onAccessError }: { api: FamilyApi; grant?: string; active?: boolean; onAccessError(error: ApiError): Promise<void> }) {
  const [sources, setSources] = useState<Source[]>([]);
  const [editing, setEditing] = useState<Source>();
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const busy = loading || saving;
  const [readError, setReadError] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [refresh, setRefresh] = useState(0);
  const pending = useRef<{ fingerprint: string; id: string; operationId: string } | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const dirty = name !== (editing?.name ?? '');
  const [leaving, setLeaving] = useState<{ proceed(): void }>();
  const dialog = useRef<HTMLDialogElement>(null);
  const { requestLeave, releaseGuard } = useLeaveGuard(dirty || saving, proceed => setLeaving({ proceed }));
  useEffect(() => { if (leaving) dialog.current?.showModal(); else dialog.current?.close(); }, [leaving]);
  function clearForm() { setEditing(undefined); setName(''); pending.current = null; setError(''); }
  function discard() { releaseGuard(); clearForm(); }
  const saveForm = () => save(editing?.id, { expectedRevision: editing?.revision ?? 0, name, active: editing?.active ?? true });

  useEffect(() => {
    if (!grant || !active) return;
    let current = true;
    setLoading(true); setReadError('');
    void api.managedSources(grant).then(items => { if (current) setSources(items); }).catch(async failure => {
      if (!current) return;
      if (failure instanceof ApiError && [401, 403].includes(failure.status)) { await onAccessError(failure); return; }
      setReadError(failure instanceof Error ? failure.message : '来源读取失败，请重试');
    }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [api, grant, refresh, active]);

  async function save(id: string | undefined, input: Omit<SourceEdit, 'operationId'>) {
    if (!grant || !active || saving) return false;
    if (!input.name.trim()) { setError('请填写来源名称，当前内容仍保留。'); return false; }
    setSaving(true); setError(''); setNotice('');
    const fingerprint = JSON.stringify({ id, ...input });
    if (pending.current?.fingerprint !== fingerprint) pending.current = { fingerprint, id: id ?? crypto.randomUUID(), operationId: crypto.randomUUID() };
    try {
      const saved = await api.saveSource(grant, pending.current.id, { ...input, operationId: pending.current.operationId });
      if (!mounted.current) return false;
      setSources(current => [...current.filter(item => item.id !== saved.id), saved].sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name, 'zh-CN')));
      pending.current = null; setEditing(undefined); setName('');
      setNotice(saved.active ? '来源已保存，可以在收集时选择。' : '来源已停用，已有错题仍保留来源。');
      return true;
    } catch (failure) {
      if (!mounted.current) return false;
      if (failure instanceof ApiError && [401, 403].includes(failure.status)) { setLeaving(undefined); await onAccessError(failure); return false; }
      setError(failure instanceof Error ? failure.message : '保存失败，请重试');
      return false;
    } finally { if (mounted.current) setSaving(false); }
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void saveForm();
  }
  return <section className="source-manager" aria-label="来源管理列表">
    <p>孩子收集时可以选择这些来源，也可以留空。改名会更新关联错题的显示名称；停用只影响之后的选择。</p>
    {error && !leaving && <p role="alert" className="message error">{error}</p>}
    {notice && <p role="status" className="message">{notice}</p>}
    {createPortal(<dialog ref={dialog} className="leave-dialog" aria-labelledby="source-leave-title" onCancel={event => { event.preventDefault(); if (!saving) setLeaving(undefined); }}>
      <h2 id="source-leave-title">来源还有未保存的修改</h2><p>{grant ? '可以先保存来源再离开。放弃本次修改不会删除已有来源。' : '管理验证已到期，选择继续编辑并重新验证后才能保存。'}</p>
      {error && <p role="alert" className="message error">{error}</p>}
      <div className="leave-actions"><button autoFocus disabled={saving} onClick={() => setLeaving(undefined)}>继续编辑</button><button className="quiet" disabled={busy || !grant || !active} onClick={() => { const proceed = leaving?.proceed; void saveForm().then(saved => { if (saved) { releaseGuard(); setLeaving(undefined); proceed?.(); } }); }}>保存后离开</button><button className="quiet" disabled={saving} onClick={() => { const proceed = leaving?.proceed; discard(); setLeaving(undefined); proceed?.(); }}>放弃本次修改并离开</button></div>
    </dialog>, document.querySelector('.app-surface') ?? document.body)}
    <form onSubmit={submit} className="source-form"><fieldset disabled={busy || !grant || !active}>
      <h2>{editing ? '修改来源' : '添加常用来源'}</h2>
      <label>来源名称<input value={name} onChange={event => setName(event.target.value)} required maxLength={200} placeholder="例如：每周小测、数学练习册" /></label>
      <div className="source-actions"><button type="submit">{editing ? '保存来源' : '添加来源'}</button>{(editing || dirty) && <button type="button" className="quiet" onClick={() => requestLeave(clearForm)}>取消修改</button>}</div>
    </fieldset></form>
    <div className="section-heading"><h2>已有来源</h2><button className="quiet" disabled={busy || !grant} onClick={() => setRefresh(value => value + 1)}>{readError ? '重试读取来源' : '刷新来源列表'}</button></div>
    {loading && <p role="status">正在读取来源…</p>}
    {readError && <p role="alert" className="message error">{readError}。来源列表暂不可用，填写内容仍保留。</p>}
    {dirty && <p className="hint">请先保存或取消当前修改，再操作其他来源。</p>}
    {!loading && !readError && <div className="table-scroll" role="region" aria-label="来源表格，可横向滚动" tabIndex={0}><table className="management-table source-table" aria-label="来源列表"><thead><tr><th scope="col">名称</th><th scope="col">状态</th><th scope="col">操作</th></tr></thead><tbody>{sources.map(item => <tr key={item.id}><td className="table-source">{item.name}</td><td><span className={`state-pill ${item.active ? 'collected' : 'draft'}`}>{item.active ? '启用中' : '已停用'}</span></td><td><div className="source-actions">
      <button className="quiet" aria-label={`改名 ${item.name}`} disabled={busy || dirty || !grant} onClick={() => { setEditing(item); setName(item.name); setError(''); setNotice(''); }}>改名</button>
      <button className="quiet" aria-label={`${item.active ? '停用' : '启用'} ${item.name}`} disabled={busy || dirty || !grant} onClick={() => void save(item.id, { expectedRevision: item.revision, name: item.name, active: !item.active })}>{item.active ? '停用' : '启用'}</button>
    </div></td></tr>)}</tbody></table></div>}
  </section>;
}
