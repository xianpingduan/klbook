import { useEffect, useMemo, useState } from 'react';
import type { Home } from '../shared/contracts.ts';
import { MAX_IMAGE_BYTES } from '../shared/collection.ts';
import type { Question, QuestionList, Subject } from '../shared/collection.ts';
import type { ClientPlatform } from './platform.ts';
import { ApiError, FamilyApi } from './api.ts';
import { CaptureCache } from './capture-cache.ts';
import type { PendingCapture } from './capture-cache.ts';
import { QuestionEditor } from './QuestionEditor.tsx';
import { QuestionImage } from './QuestionImage.tsx';
import type { Source } from '../shared/sources.ts';

export function CollectionWorkspace({ api, home, platform, onExpired, onEditing }: {
  api: FamilyApi; home: Home; platform: ClientPlatform; onExpired(): Promise<void>; onEditing(active: boolean): void;
}) {
  const cache = useMemo(() => new CaptureCache(platform, { libraryId: home.library.id, accountId: home.account.id }), [platform, home.library.id, home.account.id]);
  const [screen, setScreen] = useState<'list' | 'upload' | 'edit' | 'detail'>('list');
  const [state, setState] = useState<'draft' | 'collected'>('collected');
  const [list, setList] = useState<QuestionList>({ items: [], total: 0, offset: 0, limit: 50 });
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [selected, setSelected] = useState<Question>();
  const [pending, setPending] = useState<PendingCapture>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [originalOpen, setOriginalOpen] = useState(false);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => { onEditing(screen !== 'list'); }, [screen, onEditing]);
  useEffect(() => {
    let active = true;
    setBusy(true); setError('');
    void Promise.all([api.subjects(), api.questions(state), api.sources(), cache.read().catch(failure => {
      if (active) setError(failure instanceof Error ? failure.message : '本设备暂存无法读取，请重新选择图片');
      return undefined;
    })]).then(([subjects, list, sources, pending]) => {
      if (!active) return;
      setSubjects(subjects); setList(list); setSources(sources); setPending(current => current ?? pending);
    }).catch(async failure => {
      if (!active) return;
      if (failure instanceof ApiError && failure.status === 401) { await onExpired(); return; }
      setError(failure instanceof Error ? failure.message : '读取失败，请重试');
    })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [api, cache, state, refresh]);

  async function run(action: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('');
    try { await action(); }
    catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) { await onExpired(); return; }
      setError(failure instanceof Error ? failure.message : '操作失败，请重试');
    } finally { setBusy(false); }
  }
  async function upload(capture: PendingCapture) {
    setPending(capture);
    await cache.save(capture);
    const question = await api.uploadImage(capture.file, capture.operationId);
    await cache.remove().catch(() => setNotice('材料已保存，本设备暂存清理失败；重复重试不会多建一道题。'));
    setPending(undefined); setSelected(question); setScreen(question.state === 'draft' ? 'edit' : 'detail');
  }
  function back() { setError(''); setNotice(''); setSelected(undefined); setOriginalOpen(false); setScreen('list'); setRefresh(value => value + 1); }
  function open(question: Question) {
    void run(async () => { setSelected(await api.question(question.id)); setOriginalOpen(false); setScreen(question.state === 'draft' ? 'edit' : 'detail'); });
  }
  const subjectName = (id: string | null) => subjects.find(subject => subject.id === id)?.name ?? '待选学科';
  const date = (time: number) => new Date(time).toLocaleString('zh-CN');
  return <div className="collection-workspace">
    {error && <p role="alert" className="message error">{error}</p>}
    {notice && <p role="status" className="message">{notice}</p>}
    {screen === 'list' && <section className="card collection-card">
      <div className="section-heading"><div><p className="eyebrow">从一道题开始</p><h2>我的学习材料</h2></div><button disabled={busy} onClick={() => { setError(''); setScreen('upload'); }}>收集一道错题</button></div>
      {pending && <div className="message"><strong>还有一张图片等待上传</strong><p>{pending.name} · 尚未同步，可继续上传</p><button disabled={busy} onClick={() => { setScreen('upload'); void run(() => upload(pending)); }}>继续上传</button></div>}
      <div className="collection-tabs"><button className="quiet" aria-pressed={state === 'collected'} disabled={busy} onClick={() => setState('collected')}>已收集</button><button className="quiet" aria-pressed={state === 'draft'} disabled={busy} onClick={() => setState('draft')}>草稿</button><button className="quiet" disabled={busy} onClick={() => setRefresh(value => value + 1)}>刷新列表</button></div>
      {busy && <p>正在读取材料…</p>}
      {!busy && list.total === 0 && <div className="empty-state"><h3>{state === 'draft' ? '还没有草稿' : '开始收集第一道错题吧'}</h3><p>{state === 'draft' ? '上传图片后，可以先保存草稿，稍后继续整理。' : '选择图片、框住题目、选好学科，就能保存。'}</p></div>}
      <div className="question-list">{list.items.map(question => <article key={question.id}>
        <div className="question-thumbnail"><QuestionImage api={api} page={question.originalPage} region={question.region} /></div>
        <div><p className="eyebrow">{state === 'draft' ? '草稿' : '已收集'} · {subjectName(question.subjectId)}</p><h3>{question.source || '未填写来源'}{question.questionNumber ? ` · 第 ${question.questionNumber} 题` : ''}</h3><p className="hint">{state === 'collected' ? '收集于' : '暂存于'} {date(question.collectedAt ?? question.createdAt)}</p><button className="quiet" disabled={busy} onClick={() => open(question)}>{state === 'draft' ? '继续整理' : '打开错题'}</button></div>
      </article>)}</div>
      {list.items.length < list.total && <button className="quiet" disabled={busy} onClick={() => void run(async () => { const more = await api.questions(state, list.items.length); setList(current => ({ ...more, items: [...current.items, ...more.items] })); })}>加载更多</button>}
    </section>}
    {screen === 'upload' && <section className="card collection-card">
      <div className="section-heading"><div><p className="eyebrow">先把材料留下来</p><h1>收集一道错题</h1></div><button className="quiet" disabled={busy} onClick={back}>返回列表</button></div>
      <p>选择一张作业或试卷图片。原始页中的图形、作答和批改都会保留，暂时不用填写答案或总结。</p><p className="hint">支持 JPEG、PNG、静态 WebP；每张不超过 15 MB、4000 万像素。</p>
      {!pending && <label className="file-picker">选择题目图片<input type="file" accept="image/jpeg,image/png,image/webp" disabled={busy} onChange={event => {
        const file = event.target.files?.[0];
        if (!file) return;
        if (file.size > MAX_IMAGE_BYTES) { setError('图片超过 15 MB，请选择较小的文件。'); event.target.value = ''; return; }
        void run(() => upload({ file, operationId: crypto.randomUUID(), name: file.name }));
      }} /></label>}
      {pending && <div className="message"><strong>{pending.name}</strong><p>{busy ? '正在暂存并上传，请稍候…' : '尚未确认同步成功。当前图片已保留，可以重试。'}</p><button disabled={busy} onClick={() => void run(() => upload(pending))}>重试上传</button><button className="quiet" disabled={busy} onClick={() => void run(async () => { await cache.remove(); setPending(undefined); })}>放弃这张图片并重新选择</button></div>}
    </section>}
    {screen === 'edit' && selected && <QuestionEditor key={selected.id} api={api} question={selected} subjects={subjects} sources={sources} onBack={back} onExpired={onExpired} onSaved={question => { setSelected(question); if (question.state === 'collected') setScreen('detail'); }} />}
    {screen === 'detail' && selected && <section className="card collection-card">
      <div className="section-heading"><div><p className="eyebrow">{subjectName(selected.subjectId)} · 已收集</p><h1>错题详情</h1></div><button className="quiet" onClick={back}>返回列表</button></div>
      <p className="sync-state">已同步到家庭资料库</p><div className="detail-material"><QuestionImage api={api} page={selected.originalPage} region={selected.region} /></div>
      <dl><div><dt>收集时间</dt><dd>{date(selected.collectedAt!)}</dd></div><div><dt>来源</dt><dd>{selected.source || '未填写'}</dd></div><div><dt>页码 / 题号</dt><dd>{selected.pageNumber || '未填写'} / {selected.questionNumber || '未填写'}</dd></div><div><dt>备注</dt><dd className="note-text">{selected.note || '未填写'}</dd></div></dl>
      <button onClick={() => setScreen('edit')}>补充或更正信息</button><button className="quiet" onClick={() => setOriginalOpen(value => !value)}>{originalOpen ? '收起原始页' : '查看原始页'}</button>
      {originalOpen && <div className="original-material"><h2>原始页</h2><p className="hint">这是上传时保留的完整原图，包含题目、作答和批改。</p><QuestionImage api={api} page={selected.originalPage} original /></div>}
    </section>}
  </div>;
}
