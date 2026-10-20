import { useEffect, useRef, useState } from 'react';
import type { Home } from '../shared/contracts.ts';
import { MAX_PACKAGE_BYTES, type ImportBatch, type ImportDecisions } from '../shared/imports.ts';
import { stageLabel } from '../shared/study.ts';
import type { PagePath } from '../shared/app-routes.ts';
import { ApiError, type FamilyApi } from './api.ts';
import { ImportChoices } from './ImportChoices.tsx';

export function ImportManager({ api, home, grant, active, onAccessError, navigate }: { api: FamilyApi; home: Home; grant?: string; active: boolean; onAccessError(error: ApiError): Promise<void>; navigate(path: PagePath): void }) {
  const storageKey = `klbook:import:${api.address}:${home.library.id}:${home.account.id}`;
  const [batch, setBatch] = useState<ImportBatch>();
  const [file, setFile] = useState<File>();
  const [pendingChoice, setPendingChoice] = useState<{ id: string; token: string; decisions: ImportDecisions }>();
  const [drafting, setDrafting] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [refresh, setRefresh] = useState(0);
  const operation = useRef<string | undefined>(undefined), mounted = useRef(true);
  const working = useRef(false), generation = useRef(0);
  function begin() { working.current = true; generation.current++; setBusy(true); setError(''); }
  function end() { working.current = false; if (mounted.current) setBusy(false); }
  function receive(result: ImportBatch) {
    setBatch(result);
    setPendingChoice(previous => result.status === 'complete' || result.status === 'preview' && (result.choicesReset || JSON.stringify(previous?.decisions) === JSON.stringify(result.decisions)) ? undefined : previous);
  }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  function remember(id?: string) {
    operation.current = id;
    try { if (id) sessionStorage.setItem(storageKey, id); else sessionStorage.removeItem(storageKey); } catch { /* Reselecting the same file remains safe if browser storage is unavailable. */ }
  }
  async function failure(reason: unknown) {
    if (!mounted.current) return;
    setError(reason instanceof Error ? reason.message : '资料导入未完成，请重试');
    if (reason instanceof ApiError && reason.status === 404) { remember(); setBatch(undefined); }
    if (reason instanceof ApiError && [401, 403].includes(reason.status)) await onAccessError(reason);
  }
  useEffect(() => {
    if (!grant || !active || working.current) return;
    let current = true; const version = generation.current;
    if (!operation.current) { try { const saved = sessionStorage.getItem(storageKey); if (saved && /^[0-9a-f-]{36}$/.test(saved)) operation.current = saved; } catch { /* No receipt locator to restore. */ } }
    if (!operation.current) return;
    setBusy(true); setError('');
    void api.importStatus(grant, operation.current).then(result => { if (current && version === generation.current) receive(result); }).catch(reason => { if (current && version === generation.current) void failure(reason); }).finally(() => { if (current && version === generation.current) setBusy(false); });
    return () => { current = false; };
  }, [api, grant, active, refresh, storageKey]);
  async function choose(selected?: File) {
    if (!selected || !grant || busy) return;
    if (!selected.size || selected.size > MAX_PACKAGE_BYTES) { setError('请选择不超过 512 MB 的完整 ZIP 资料包'); return; }
    begin();
    try {
      if (operation.current) {
        try { await api.removeImport(grant, operation.current); }
        catch (reason) { if (!(reason instanceof ApiError && reason.status === 404)) throw reason; }
      }
      if (!mounted.current) return;
      remember(crypto.randomUUID()); setFile(selected); setBatch(undefined); setPendingChoice(undefined);
      const result = await api.uploadImport(grant, operation.current!, selected);
      if (mounted.current) { remember(result.id); setBatch(result); }
    } catch (reason) { await failure(reason); }
    finally { end(); }
  }
  async function retry() {
    if (!file || !grant || busy) return;
    begin();
    try {
      if (!operation.current) remember(crypto.randomUUID());
      const result = await api.uploadImport(grant, operation.current!, file);
      if (mounted.current) { remember(result.id); setBatch(result); }
    } catch (reason) { await failure(reason); }
    finally { end(); }
  }
  async function confirm() {
    if (!grant || !batch || batch.status !== 'preview' || busy || pendingChoice || drafting) return;
    begin();
    try { const result = await api.confirmImport(grant, batch.id, batch.token); if (mounted.current) { setBatch(result); setFile(undefined); } }
    catch (reason) { await failure(reason); }
    finally { end(); }
  }
  async function saveChoice(request: { id: string; token: string; decisions: ImportDecisions }): Promise<boolean> {
    if (!grant || busy) return false;
    setPendingChoice(request); begin();
    try { const result = await api.decideImport(grant, request.id, request.token, request.decisions); if (mounted.current) { receive(result); setPendingChoice(undefined); } return true; }
    catch (reason) { await failure(reason); return false; }
    finally { end(); }
  }
  async function remove() {
    if (!grant || !operation.current || busy) return;
    begin();
    try { await api.removeImport(grant, operation.current); if (mounted.current) { remember(); setFile(undefined); setBatch(undefined); setPendingChoice(undefined); } }
    catch (reason) { await failure(reason); }
    finally { end(); }
  }
  return <section className="card import-manager">
    <h1>导入学习资料</h1><p>选择本应用导出的资料包，核对后恢复到当前学习者的错题集。</p>
    <label>选择 ZIP 资料包<input type="file" accept=".zip,application/zip" disabled={busy || !grant} onChange={event => { const selected = event.target.files?.[0]; event.target.value = ''; void choose(selected); }} /></label>
    {file && <p className="hint">当前资料包：{file.name}</p>}
    <p className="hint">支持格式 1，最大 512 MB。原收集日期和学习阶段会保留，不改变当前默认学习阶段或服务开关。</p>
    {busy && <p role="status">正在处理资料包，请保持页面打开…</p>}
    {error && <p className="message error" role="alert">{error}</p>}
    {!batch && file && <button disabled={busy || !grant} onClick={() => void retry()}>重新校验资料包</button>}
    {batch?.status === 'preview' && <>
      <div className="section-heading"><h2>核对导入内容</h2><button className="quiet" disabled={busy} onClick={() => { setPendingChoice(undefined); setRefresh(v => v + 1); }}>刷新预览</button></div>
      {batch.choicesReset && <p className="message" role="status">资料已在其他页面变化，原选择已重置。请按最新内容重新核对。</p>}
      <dl className="export-summary">
        <div><dt>来源学习者</dt><dd>{batch.sourceLearner}</dd></div><div><dt>导入到</dt><dd>{batch.targetLearner}的错题集</dd></div>
        <div><dt>题目</dt><dd>新增 {batch.added} 道，跳过 {batch.skipped} 道完全相同的题目。</dd></div>
        <div><dt>冲突与删除</dt><dd><span>修改冲突 {batch.conflicts} 道</span>；<span>回收站或已删除 {batch.trashed} 道</span></dd></div>
        <div><dt>材料</dt><dd>{batch.pageCount} 张原图 · {batch.readingCount} 份共享阅读材料</dd></div>
        <div><dt>学习阶段</dt><dd>{batch.stages.map(stageLabel).join('；')}</dd></div>
      </dl>
      <ImportChoices key={`${batch.id}:${refresh}:${batch.choicesReset}`} batch={batch} api={api} grant={grant} disabled={busy || !grant || !!pendingChoice} onDraft={setDrafting} onChoose={decisions => saveChoice({ id: batch.id, token: batch.token, decisions })} />
      {pendingChoice && <p className="message">所选处理尚未核对完成，当前资料未改变。<button disabled={busy || !grant} onClick={() => void saveChoice(pendingChoice)}>重试所选处理</button></p>}
      {batch.blockers.length > 0 ? <div className="message error" role="alert"><strong>本批暂不能导入，当前资料未改变。</strong><ul>{batch.blockers.map((reason, i) => <li key={i}>{reason}</li>)}</ul></div> : <p>校验已通过。确认后按以下选择整批应用。</p>}
      <div className="import-outcome"><p>本次保留当前版本或删除状态 {batch.kept} 道</p><p>本次将另存 {batch.copied} 道副本</p><p>本次将恢复 {batch.restored} 道题</p></div>
      <div className="actions"><button disabled={busy || !grant || batch.blockers.length > 0 || !!pendingChoice || drafting} onClick={() => void confirm()}>确认导入</button><button className="quiet" disabled={busy || !grant} onClick={() => void remove()}>移除资料包</button></div>
      <p className="hint">预览保留 30 分钟，电脑服务重启后需重新选择资料包校验。</p>
    </>}
    {batch?.status === 'complete' && <section className="export-result"><h2>导入完成</h2><p role="status">已新增 {batch.added} 道，跳过 {batch.skipped} 道相同题目。</p><ul><li>保留 {batch.kept ?? 0} 道</li><li>另存副本 {batch.copied ?? 0} 道</li><li>恢复 {batch.restored ?? 0} 道</li></ul><p className="hint">导入时间：{new Date(batch.importedAt).toLocaleString('zh-CN')}</p><button onClick={() => navigate('/admin/materials')}>查看错题资料</button></section>}
  </section>;
}
