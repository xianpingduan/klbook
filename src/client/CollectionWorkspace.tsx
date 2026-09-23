import { useEffect, useMemo, useRef, useState } from 'react';
import type { Home } from '../shared/contracts.ts';
import { MAX_IMAGE_BYTES } from '../shared/collection.ts';
import type { Question, QuestionList, Subject } from '../shared/collection.ts';
import type { ClientPlatform } from './platform.ts';
import { ApiError, FamilyApi } from './api.ts';
import { CaptureCache } from './capture-cache.ts';
import type { CaptureBatch, PendingCapture } from './capture-cache.ts';
import { QuestionEditor } from './QuestionEditor.tsx';
import { QuestionImage } from './QuestionImage.tsx';
import type { Source } from '../shared/sources.ts';
import { CaptureChoices } from './CaptureChoices.tsx';
import { CaptureQueue } from './CaptureQueue.tsx';
import type { PagePath } from '../shared/app-routes.ts';
import { useLeaveGuard } from './navigation.ts';
import { AdminMaterialsTable } from './AdminMaterialsTable.tsx';
import { CaptureInput } from './CaptureInput.tsx';

export function CollectionWorkspace({ api, home, platform, path, grant, onAccessError, onEditing, active = true, mode = 'workspace' }: {
  api: FamilyApi; home: Home; platform: ClientPlatform; path: PagePath; grant?: string; onAccessError(error: ApiError): Promise<void>; onEditing(active: boolean): void; active?: boolean; mode?: 'home' | 'collect' | 'workspace';
}) {
  const cache = useMemo(() => new CaptureCache(platform, { libraryId: home.library.id, accountId: home.account.id }), [platform, home.library.id, home.account.id]);
  const [screen, setScreen] = useState<'list' | 'edit' | 'detail'>('list');
  const [state, setState] = useState<'draft' | 'collected'>('collected');
  const [list, setList] = useState<QuestionList>({ items: [], total: 0, offset: 0, limit: 50 });
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [selected, setSelected] = useState<Question>();
  const [batch, setBatch] = useState<CaptureBatch>();
  const pending = batch?.items[0];
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [cacheLoading, setCacheLoading] = useState(true);
  const [readError, setReadError] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [originalOpen, setOriginalOpen] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const listState = mode === 'home' ? 'collected' : mode === 'collect' ? 'draft' : state;
  const admin = mode === 'workspace';
  const managementGrant = admin ? grant : undefined;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const { requestLeave } = useLeaveGuard(busy && screen !== 'edit', () => setError('正在处理材料，请稍候再离开。当前材料仍保留。'));
  useEffect(() => { setScreen('list'); setSelected(undefined); setOriginalOpen(false); }, [path]);

  useEffect(() => { onEditing(screen !== 'list'); }, [screen, onEditing]);
  useEffect(() => {
    let current = true;
    void cache.readBatch().then(saved => { if (current) setBatch(saved); })
      .catch(failure => { if (current) setError(failure instanceof Error ? failure.message : '本设备暂存无法读取，请保留原图片后重试'); })
      .finally(() => { if (current) setCacheLoading(false); });
    return () => { current = false; };
  }, [cache]);
  useEffect(() => {
    if (!active) return;
    let current = true;
    setLoading(true); setReadError(''); setList({ items: [], total: 0, offset: 0, limit: 50 });
    void Promise.all([api.subjects(), api.questions(listState, 0, managementGrant), api.sources()]).then(([subjects, list, sources]) => {
      if (!current) return;
      setSubjects(subjects); setList(list); setSources(sources);
    }).catch(async failure => {
      if (!current) return;
      if (failure instanceof ApiError && [401, 403].includes(failure.status)) { await onAccessError(failure); return; }
      setReadError(failure instanceof Error ? failure.message : '读取失败，请重试');
    })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [api, listState, refresh, active, path, managementGrant, onAccessError]);

  async function run(action: () => Promise<void>) {
    if (busy || cacheLoading || !active || (admin && !grant)) return;
    setBusy(true); setError(''); setNotice('');
    try { await action(); }
    catch (failure) {
      if (!mounted.current) return;
      if (failure instanceof ApiError && [401, 403].includes(failure.status)) { await onAccessError(failure); return; }
      setError(failure instanceof Error ? failure.message : '操作失败，请重试');
    } finally { if (mounted.current) setBusy(false); }
  }
  async function upload(capture: PendingCapture, currentBatch = batch!) {
    setBatch(currentBatch);
    await cache.saveBatch(currentBatch);
    if (!mounted.current) return;
    const question = await api.uploadImage(capture.file, capture.operationId, managementGrant);
    if (!mounted.current) return;
    const next = { ...currentBatch, items: currentBatch.items.filter(item => item.operationId !== capture.operationId), uploaded: currentBatch.uploaded + 1 };
    // Keep the original operation and bytes until progress is durably stored; retry reuses the server result.
    if (next.items.length) await cache.saveBatch(next);
    else await cache.remove();
    setBatch(next.items.length ? next : undefined); setSelected(question); setScreen(admin || question.state === 'draft' ? 'edit' : 'detail'); setRefresh(value => value + 1);
  }
  function choose(files: FileList | null) {
    if (!files?.length || busy || cacheLoading || pending) return;
    const images = Array.from(files);
    if (images.length > 10 || images.reduce((sum, file) => sum + file.size, 0) > 75 * 1024 * 1024) { setError('一次最多选择 10 张、合计 75 MB，请分批收集。'); return; }
    if (images.some(file => file.size > MAX_IMAGE_BYTES || file.size === 0)) { setError('每张图片需为非空文件且不超过 15 MB，请重新选择。'); return; }
    const next: CaptureBatch = { items: images.map(file => ({ file, name: file.name, operationId: crypto.randomUUID() })), total: images.length, uploaded: 0, cancelled: 0 };
    void run(() => upload(next.items[0]!, next));
  }
  async function cancel(capture: PendingCapture) {
    const next = { ...batch!, items: batch!.items.filter(item => item.operationId !== capture.operationId), cancelled: batch!.cancelled + 1 };
    if (next.items.length) await cache.saveBatch(next); else await cache.remove();
    setBatch(next.items.length ? next : undefined);
    setNotice('已取消这张材料。若此前已上传成功，服务器草稿仍会保留。');
    setRefresh(value => value + 1);
  }
  function back() { setError(''); setNotice(''); setSelected(undefined); setOriginalOpen(false); setScreen('list'); setRefresh(value => value + 1); }
  function open(question: Question) {
    void run(async () => { const latest = await api.question(question.id, managementGrant); setSelected(latest); setOriginalOpen(false); setScreen(admin || latest.state === 'draft' ? 'edit' : 'detail'); });
  }
  const subjectName = (id: string | null) => subjects.find(subject => subject.id === id)?.name ?? '待选学科';
  const date = (time: number) => new Date(time).toLocaleString('zh-CN');
  const continuation = pending && <div className="batch-next"><p>还有 {batch!.items.length} 张图片待处理 · 下一张：{pending.name}</p><button disabled={busy} onClick={() => requestLeave(() => { back(); void run(() => upload(pending)); })}>继续下一张</button><button className="quiet" disabled={busy} aria-label={`取消 ${pending.name}`} onClick={() => void run(() => cancel(pending))}>取消这张</button><button className="quiet" disabled={busy} onClick={() => requestLeave(back)}>稍后继续</button><p className="hint">已上传 {batch!.uploaded} / {batch!.total} 张，已取消 {batch!.cancelled} 张</p></div>;
  return <div className="collection-workspace">
    {error && <p role="alert" className="message error">{error}</p>}
    {notice && <p role="status" className="message">{notice}</p>}
    {screen === 'list' && mode === 'collect' && <section className="collection-entry" aria-label="收集新材料"><h1>收集</h1><p className="intro">先把材料留下来，再慢慢整理。</p><CaptureChoices busy={busy || cacheLoading || !!pending} onChoose={choose} onNotice={setNotice} />{pending && <p className="hint">先继续或取消本机待上传图片，再选择新的材料。</p>}</section>}
    {screen === 'list' && mode !== 'home' && batch && <CaptureQueue batch={batch} busy={busy} onUpload={item => void run(() => upload(item))} onCancel={item => void run(() => cancel(item))} />}
    {screen === 'list' && <section className="card collection-card" aria-label={listState === 'draft' ? '已保存的草稿' : '已收集错题'}>
      <div className="section-heading"><div>{admin ? <h1>错题资料</h1> : <h2>{listState === 'draft' ? '已保存的草稿' : '已收集'}</h2>}{mode === 'collect' && <p className="hint">已保存在家庭电脑，可以换设备继续整理。</p>}</div>{admin && <div className="admin-upload"><CaptureInput label="上传材料" busy={busy || cacheLoading || !!pending} onChoose={choose} onCancel={() => setNotice('已取消选择，已有材料保留。')} /></div>}</div>
      {admin && <p className="hint">支持 JPEG、PNG、静态 WebP；每张最多 15 MB、4000 万像素，每批最多 10 张、合计 75 MB。{pending ? '请先继续或取消本机待上传材料。' : '选择图片后可框题、确认学科并保存。'}</p>}
      <div className="collection-tabs">{mode === 'workspace' && <><button className="quiet" aria-pressed={state === 'collected'} disabled={busy} onClick={() => setState('collected')}>已收集</button><button className="quiet" aria-pressed={state === 'draft'} disabled={busy} onClick={() => setState('draft')}>草稿</button></>}<button className="quiet" disabled={busy || loading} onClick={() => setRefresh(value => value + 1)}>{readError ? '重试读取' : '刷新列表'}</button></div>
      {readError && <p role="alert" className="message error">{readError}。服务器材料暂时无法读取，本机待上传图片仍保留。</p>}
      {loading && <p role="status">正在读取材料…</p>}
      {!loading && !readError && list.total === 0 && <div className="empty-state"><h3>{listState === 'draft' ? '还没有草稿' : '开始收集第一道错题吧'}</h3><p>{mode === 'home' ? '从底部“收集”开始，把材料留下来。' : listState === 'draft' ? '上传图片后，可以先保存草稿，稍后继续整理。' : '选择图片、框住题目、选好学科，就能保存。'}</p></div>}
      {admin ? !loading && !readError && <AdminMaterialsTable api={api} list={list} state={listState} subjects={subjects} busy={busy} onOpen={open} /> : <div className="question-list">{list.items.map(question => <article key={question.id}>
        <div className="question-thumbnail"><QuestionImage api={api} page={question.originalPage} region={question.region} /></div>
        <div><p className="eyebrow">{listState === 'draft' ? '草稿' : '已收集'} · {subjectName(question.subjectId)}</p><h3>{question.source || '未填写来源'}{question.questionNumber ? ` · 第 ${question.questionNumber} 题` : ''}</h3><p className="hint">{listState === 'collected' ? '收集于' : '暂存于'} {date(question.collectedAt ?? question.createdAt)}</p><button className="quiet" disabled={busy} onClick={() => open(question)}>{listState === 'draft' ? '继续整理' : '打开错题'}</button></div>
      </article>)}</div>}
      {list.items.length < list.total && <button className="quiet" disabled={busy} onClick={() => void run(async () => { const more = await api.questions(listState, list.items.length, managementGrant); setList(current => ({ ...more, items: [...current.items, ...more.items] })); })}>加载更多</button>}
    </section>}
    {screen === 'edit' && selected && <QuestionEditor key={selected.id} api={api} question={selected} subjects={subjects} sources={sources} active={active} admin={admin} grant={managementGrant} onBack={back} onAccessError={onAccessError} onSaved={question => { setSelected(question); setRefresh(value => value + 1); if (!admin && question.state === 'collected') setScreen('detail'); }} />}
    {admin && screen === 'edit' && continuation}
    {screen === 'detail' && selected && <section className="card collection-card">
      <div className="section-heading"><div><p className="eyebrow">{subjectName(selected.subjectId)} · 已收集</p><h1>错题详情</h1></div><button className="quiet" disabled={busy} onClick={back}>返回列表</button></div>
      <p className="sync-state">已同步到家庭资料库</p><div className="detail-material"><QuestionImage api={api} page={selected.originalPage} region={selected.region} /></div>
      {continuation}
      <dl><div><dt>收集时间</dt><dd>{date(selected.collectedAt!)}</dd></div><div><dt>来源</dt><dd>{selected.source || '未填写'}</dd></div><div><dt>页码 / 题号</dt><dd>{selected.pageNumber || '未填写'} / {selected.questionNumber || '未填写'}</dd></div><div><dt>备注</dt><dd className="note-text">{selected.note || '未填写'}</dd></div></dl>
      <button disabled={busy} onClick={() => setScreen('edit')}>补充或更正信息</button><button className="quiet" onClick={() => setOriginalOpen(value => !value)}>{originalOpen ? '收起原始页' : '查看原始页'}</button>
      {originalOpen && <div className="original-material"><h2>原始页</h2><p className="hint">这是上传时保留的完整原图，包含题目、作答和批改。</p><QuestionImage api={api} page={selected.originalPage} original /></div>}
    </section>}
  </div>;
}
