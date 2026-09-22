import { useEffect, useMemo, useState } from 'react';
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
import { CaptureInput } from './CaptureInput.tsx';

export function CollectionWorkspace({ api, home, platform, onExpired, onEditing, active = true, mode = 'workspace' }: {
  api: FamilyApi; home: Home; platform: ClientPlatform; onExpired(): Promise<void>; onEditing(active: boolean): void; active?: boolean; mode?: 'home' | 'workspace';
}) {
  const cache = useMemo(() => new CaptureCache(platform, { libraryId: home.library.id, accountId: home.account.id }), [platform, home.library.id, home.account.id]);
  const [screen, setScreen] = useState<'list' | 'upload' | 'edit' | 'detail'>('list');
  const [state, setState] = useState<'draft' | 'collected'>('collected');
  const [list, setList] = useState<QuestionList>({ items: [], total: 0, offset: 0, limit: 50 });
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [selected, setSelected] = useState<Question>();
  const [batch, setBatch] = useState<CaptureBatch>();
  const pending = batch?.items[0];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [originalOpen, setOriginalOpen] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const listState = mode === 'home' ? 'collected' : state;

  useEffect(() => { onEditing(screen !== 'list'); }, [screen, onEditing]);
  useEffect(() => {
    if (!active) return;
    let current = true;
    setBusy(true); setError('');
    void Promise.all([api.subjects(), api.questions(listState), api.sources(), cache.readBatch().catch(failure => {
      if (current) setError(failure instanceof Error ? failure.message : '本设备暂存无法读取，请重新选择图片');
      return undefined;
    })]).then(([subjects, list, sources, pending]) => {
      if (!current) return;
      setSubjects(subjects); setList(list); setSources(sources); setBatch(current => current ?? pending);
    }).catch(async failure => {
      if (!current) return;
      if (failure instanceof ApiError && failure.status === 401) { await onExpired(); return; }
      setError(failure instanceof Error ? failure.message : '读取失败，请重试');
    })
      .finally(() => { if (current) setBusy(false); });
    return () => { current = false; };
  }, [api, cache, listState, refresh, active]);

  async function run(action: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('');
    try { await action(); }
    catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) { await onExpired(); return; }
      setError(failure instanceof Error ? failure.message : '操作失败，请重试');
    } finally { setBusy(false); }
  }
  async function upload(capture: PendingCapture, currentBatch = batch!) {
    setBatch(currentBatch);
    await cache.saveBatch(currentBatch);
    const question = await api.uploadImage(capture.file, capture.operationId);
    const next = { ...currentBatch, items: currentBatch.items.filter(item => item.operationId !== capture.operationId), uploaded: currentBatch.uploaded + 1 };
    // Keep the original operation and bytes until progress is durably stored; retry reuses the server result.
    if (next.items.length) await cache.saveBatch(next);
    else await cache.remove();
    setBatch(next.items.length ? next : undefined); setSelected(question); setScreen(question.state === 'draft' ? 'edit' : 'detail');
  }
  function choose(files: FileList | null) {
    if (!files?.length) return;
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
      <div className="section-heading"><div><p className="eyebrow">从一道题开始</p><h2>我的学习材料</h2></div>{mode === 'workspace' && <button disabled={busy} onClick={() => { setError(''); setScreen('upload'); }}>收集一道错题</button>}</div>
      {mode === 'workspace' && pending && <div className="message"><strong>还有 {batch!.items.length} 张图片等待上传</strong><p>已上传 {batch!.uploaded} / {batch!.total} 张，已取消 {batch!.cancelled} 张</p><p>{pending.name} · 尚未同步，可继续上传</p><button disabled={busy} onClick={() => { setScreen('upload'); void run(() => upload(pending)); }}>继续上传</button><button className="quiet" disabled={busy} onClick={() => setScreen('upload')}>查看本批材料</button></div>}
      <div className="collection-tabs">{mode === 'workspace' && <><button className="quiet" aria-pressed={state === 'collected'} disabled={busy} onClick={() => setState('collected')}>已收集</button><button className="quiet" aria-pressed={state === 'draft'} disabled={busy} onClick={() => setState('draft')}>草稿</button></>}<button className="quiet" disabled={busy} onClick={() => setRefresh(value => value + 1)}>刷新列表</button></div>
      {busy && <p>正在读取材料…</p>}
      {!busy && list.total === 0 && <div className="empty-state"><h3>{listState === 'draft' ? '还没有草稿' : '开始收集第一道错题吧'}</h3><p>{mode === 'home' ? '从底部“收集”开始，把材料留下来。' : listState === 'draft' ? '上传图片后，可以先保存草稿，稍后继续整理。' : '选择图片、框住题目、选好学科，就能保存。'}</p></div>}
      <div className="question-list">{list.items.map(question => <article key={question.id}>
        <div className="question-thumbnail"><QuestionImage api={api} page={question.originalPage} region={question.region} /></div>
        <div><p className="eyebrow">{listState === 'draft' ? '草稿' : '已收集'} · {subjectName(question.subjectId)}</p><h3>{question.source || '未填写来源'}{question.questionNumber ? ` · 第 ${question.questionNumber} 题` : ''}</h3><p className="hint">{listState === 'collected' ? '收集于' : '暂存于'} {date(question.collectedAt ?? question.createdAt)}</p><button className="quiet" disabled={busy} onClick={() => open(question)}>{listState === 'draft' ? '继续整理' : '打开错题'}</button></div>
      </article>)}</div>
      {list.items.length < list.total && <button className="quiet" disabled={busy} onClick={() => void run(async () => { const more = await api.questions(listState, list.items.length); setList(current => ({ ...more, items: [...current.items, ...more.items] })); })}>加载更多</button>}
    </section>}
    {screen === 'upload' && <section className="card collection-card">
      <div className="section-heading"><div><p className="eyebrow">先把材料留下来</p><h1>收集一道错题</h1></div><button className="quiet" disabled={busy} onClick={back}>返回列表</button></div>
      <p>拍照或选择作业、试卷图片，逐张框题并选择学科。原始页中的图形、作答和批改都会保留。</p><p className="hint">支持 JPEG、PNG、静态 WebP；每张不超过 15 MB、4000 万像素。每批最多 10 张、合计 75 MB。苹果 HEIC 原件请先导出为 JPEG，原件仍保留在相册中。</p>
      {!pending && <div className="capture-inputs">
        <CaptureInput camera label="拍照" busy={busy} onChoose={choose} onCancel={() => setNotice('没有取得照片。如果相机未打开或权限被拒绝，请从相册选择，或使用下方上传入口。')} />
        <CaptureInput label="从相册选择（可多选）" busy={busy} onChoose={choose} onCancel={() => setNotice('已取消选择，已有材料保留。')} />
        <CaptureInput label="选择题目图片" busy={busy} onChoose={choose} onCancel={() => setNotice('已取消选择，已有材料保留。')} />
        <p className="hint">拍照入口由设备浏览器提供。相机未打开或权限被拒绝时，可以从相册选择或在电脑上传；取消选择不会清除已有材料。</p>
      </div>}
      {pending && <div className="message"><p>已上传 {batch!.uploaded} / {batch!.total} 张，已取消 {batch!.cancelled} 张</p><strong>{pending.name}</strong><p>{busy ? '正在暂存并上传，请稍候…' : '待上传图片已保留。可以上传下一张，失败后仍可重试。'}</p><button disabled={busy} onClick={() => void run(() => upload(pending))}>重试上传</button><button className="quiet" disabled={busy} onClick={() => void run(() => cancel(pending))}>放弃这张图片并重新选择</button>
        <ul className="capture-queue">{batch!.items.map(item => <li key={item.operationId}><span>{item.name}</span><button className="quiet" disabled={busy} aria-label={`取消 ${item.name}`} onClick={() => void run(() => cancel(item))}>取消这张</button></li>)}</ul>
      </div>}
    </section>}
    {screen === 'edit' && selected && <QuestionEditor key={selected.id} api={api} question={selected} subjects={subjects} sources={sources} onBack={back} onExpired={onExpired} onSaved={question => { setSelected(question); if (question.state === 'collected') setScreen('detail'); }} />}
    {screen === 'detail' && selected && <section className="card collection-card">
      <div className="section-heading"><div><p className="eyebrow">{subjectName(selected.subjectId)} · 已收集</p><h1>错题详情</h1></div><button className="quiet" onClick={back}>返回列表</button></div>
      <p className="sync-state">已同步到家庭资料库</p><div className="detail-material"><QuestionImage api={api} page={selected.originalPage} region={selected.region} /></div>
      {pending && <button onClick={() => { setSelected(undefined); setScreen('upload'); }}>继续下一张</button>}
      <dl><div><dt>收集时间</dt><dd>{date(selected.collectedAt!)}</dd></div><div><dt>来源</dt><dd>{selected.source || '未填写'}</dd></div><div><dt>页码 / 题号</dt><dd>{selected.pageNumber || '未填写'} / {selected.questionNumber || '未填写'}</dd></div><div><dt>备注</dt><dd className="note-text">{selected.note || '未填写'}</dd></div></dl>
      <button onClick={() => setScreen('edit')}>补充或更正信息</button><button className="quiet" onClick={() => setOriginalOpen(value => !value)}>{originalOpen ? '收起原始页' : '查看原始页'}</button>
      {originalOpen && <div className="original-material"><h2>原始页</h2><p className="hint">这是上传时保留的完整原图，包含题目、作答和批改。</p><QuestionImage api={api} page={selected.originalPage} original /></div>}
    </section>}
  </div>;
}
