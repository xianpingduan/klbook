import { useEffect, useMemo, useRef, useState } from 'react';
import type { Home } from '../shared/contracts.ts';
import { MAX_IMAGE_BYTES } from '../shared/collection.ts';
import type { OriginalPage, Question, QuestionList, Subject } from '../shared/collection.ts';
import type { ClientPlatform } from './platform.ts';
import { ApiError, FamilyApi } from './api.ts';
import { CaptureCache } from './capture-cache.ts';
import type { CaptureBatch, PendingCapture } from './capture-cache.ts';
import { QuestionEditor } from './QuestionEditor.tsx';
import { QuestionImage } from './QuestionImage.tsx';
import { QuestionParts } from './QuestionParts.tsx';
import { NewQuestionFromPage } from './NewQuestionFromPage.tsx';
import type { Source } from '../shared/sources.ts';
import { CaptureChoices } from './CaptureChoices.tsx';
import { CaptureQueue } from './CaptureQueue.tsx';
import type { PagePath } from '../shared/app-routes.ts';
import { useLeaveGuard } from './navigation.ts';
import { AdminMaterialsTable } from './AdminMaterialsTable.tsx';
import { CaptureInput } from './CaptureInput.tsx';
import type { ReadingMaterial } from '../shared/reading-materials.ts';
import { ReadingMaterialEditor } from './ReadingMaterialEditor.tsx';
import { ReadingMaterialView } from './ReadingMaterialView.tsx';
import { AnswerEditor } from './AnswerEditor.tsx';
import { AnswerView } from './AnswerView.tsx';
import { emptyStage, stageLabel } from '../shared/study.ts';
import { QuestionFilters } from './QuestionFilters.tsx';
import type { FilterOptions, QuestionFilters as Filters } from '../shared/collection.ts';
import { ReadingLinkConflict } from './ReadingLinkConflict.tsx';

export function CollectionWorkspace({ api, home, platform, path, grant, onAccessError, onEditing, active = true, mode = 'workspace' }: {
  api: FamilyApi; home: Home; platform: ClientPlatform; path: PagePath; grant?: string; onAccessError(error: ApiError): Promise<void>; onEditing(active: boolean): void; active?: boolean; mode?: 'home' | 'collect' | 'workspace';
}) {
  const cache = useMemo(() => new CaptureCache(platform, { libraryId: home.library.id, accountId: home.account.id }), [platform, home.library.id, home.account.id]);
  const [screen, setScreen] = useState<'list' | 'edit' | 'detail' | 'reading' | 'answers' | 'reading-conflict'>('list');
  const answerReturn = useRef<'edit' | 'detail'>('detail');
  const [state, setState] = useState<'draft' | 'collected'>('collected');
  const [list, setList] = useState<QuestionList>({ items: [], total: 0, offset: 0, limit: 50 });
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [filters, setFilters] = useState<Filters>({});
  const [filterOptions, setFilterOptions] = useState<FilterOptions>({ schoolYears: [], grades: [], sources: [] });
  const [defaultStage, setDefaultStage] = useState(emptyStage);
  const [selected, setSelected] = useState<Question>();
  const [creating, setCreating] = useState(false);
  const [reading, setReading] = useState<ReadingMaterial>();
  const [proposedReading, setProposedReading] = useState<ReadingMaterial>();
  const readingLinkOperation = useRef('');
  const readingCache = useMemo(() => new CaptureCache(platform, { libraryId: home.library.id, accountId: home.account.id }, `reading-pages:${reading?.id}`), [platform, home.library.id, home.account.id, reading?.id]);
  const pageCache = useMemo(() => new CaptureCache(platform, { libraryId: home.library.id, accountId: home.account.id }, `question-pages:${selected?.id}`), [platform, home.library.id, home.account.id, selected?.id]);
  const answerCache = useMemo(() => new CaptureCache(platform, { libraryId: home.library.id, accountId: home.account.id }, `answer-pages:${selected?.id}`), [platform, home.library.id, home.account.id, selected?.id]);
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
  useEffect(() => { setScreen('list'); setSelected(undefined); setProposedReading(undefined); setCreating(false); setOriginalOpen(false); }, [path]);

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
    void Promise.all([api.subjects(), api.questions(listState, 0, managementGrant, mode === 'collect' ? {} : filters), api.sources(), api.filterOptions(managementGrant), api.studySettings()]).then(([subjects, list, sources, options, settings]) => {
      if (!current) return;
      setSubjects(subjects); setList(list); setSources(sources); setFilterOptions(options); setDefaultStage(settings.stage);
    }).catch(async failure => {
      if (!current) return;
      if (failure instanceof ApiError && [401, 403].includes(failure.status)) { await onAccessError(failure); return; }
      setReadError(failure instanceof Error ? failure.message : '读取失败，请重试');
    })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [api, listState, refresh, active, path, mode, managementGrant, onAccessError, filters]);

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
    const question = await api.uploadImage(capture.file, capture.operationId, managementGrant, capture.studyStage ?? emptyStage);
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
    const next: CaptureBatch = { items: images.map(file => ({ file, name: file.name, operationId: crypto.randomUUID(), studyStage: defaultStage })), total: images.length, uploaded: 0, cancelled: 0 };
    setBatch(next);
    void run(async () => {
      await cache.saveBatch(next);
      let stage = defaultStage;
      try { stage = (await api.studySettings()).stage; }
      catch (failure) { if (failure instanceof ApiError && [401, 403].includes(failure.status)) throw failure; }
      if (!mounted.current) return;
      const captured = { ...next, items: next.items.map(item => ({ ...item, studyStage: stage })) };
      await upload(captured.items[0]!, captured);
    });
  }
  async function cancel(capture: PendingCapture) {
    const next = { ...batch!, items: batch!.items.filter(item => item.operationId !== capture.operationId), cancelled: batch!.cancelled + 1 };
    if (next.items.length) await cache.saveBatch(next); else await cache.remove();
    setBatch(next.items.length ? next : undefined);
    setNotice('已取消这张材料。若此前已上传成功，服务器草稿仍会保留。');
    setRefresh(value => value + 1);
  }
  function back() { setError(''); setNotice(''); setSelected(undefined); setProposedReading(undefined); setCreating(false); setOriginalOpen(false); setScreen('list'); setRefresh(value => value + 1); }
  function newFromPage(page: OriginalPage) {
    if (!selected || !active || busy || (admin && !grant)) return;
    setProposedReading(undefined);
    void run(async () => {
    const settings = await api.studySettings();
    if (!mounted.current) return;
    setSelected({ ...selected, studyStage: settings.stage, id: crypto.randomUUID(), revision: 1, state: 'draft', subjectId: null, region: null, questionNumber: '', note: '', collectedAt: null,
      originalPage: page, parts: [{ id: crypto.randomUUID(), originalPage: page, region: null }], answerParts: [],
      sourceId: sources.some(source => source.id === selected.sourceId && source.active) ? selected.sourceId : null });
    setCreating(true); setOriginalOpen(false); setScreen('edit');
    });
  }
  function open(question: Question) {
    setProposedReading(undefined);
    void run(async () => { const latest = await api.question(question.id, managementGrant); setSelected(latest); setOriginalOpen(false); setScreen(admin || latest.state === 'draft' ? 'edit' : 'detail'); });
  }
  function openAnswers() {
    if (!selected || creating) return;
    setProposedReading(undefined);
    void run(async () => {
      const latest = await api.question(selected.id, managementGrant);
      if (!mounted.current) return;
      answerReturn.current = screen === 'edit' ? 'edit' : 'detail'; setSelected(latest); setScreen('answers');
    });
  }
  function openReading(id: string | null) {
    if (!selected || creating) return;
    setProposedReading(undefined);
    void run(async () => {
      // Leaving the question editor can save new pages before this queued callback runs.
      const question = id ? undefined : await api.question(selected.id, managementGrant);
      const material = id ? await api.readingMaterial(id, managementGrant) : {
        id: crypto.randomUUID(), libraryId: home.library.id, title: '', revision: 0, referenceCount: 0, partCount: 0, createdAt: 0, updatedAt: 0,
        parts: question!.parts.filter((part, index, parts) => parts.findIndex(other => other.originalPage.id === part.originalPage.id) === index).map(part => ({ id: crypto.randomUUID(), originalPage: part.originalPage, region: null }))
      };
      if (!mounted.current) return;
      setReading(material); readingLinkOperation.current = crypto.randomUUID(); setScreen('reading');
    });
  }
  async function readingSaved(material: ReadingMaterial): Promise<boolean> {
    if (!selected) return false;
    try {
    const alreadyLinked = selected.readingMaterial?.id === material.id;
    const latest = alreadyLinked ? await api.question(selected.id, managementGrant) : await api.saveQuestion(selected.id, {
      operationId: readingLinkOperation.current, expectedRevision: selected.revision, state: selected.state, subjectId: selected.subjectId,
      region: selected.region, parts: selected.parts.map(part => ({ id: part.id, pageId: part.originalPage.id, region: part.region })),
      sourceId: selected.sourceId, pageNumber: selected.pageNumber, questionNumber: selected.questionNumber, note: selected.note, readingMaterialId: material.id
    }, managementGrant);
    if (!mounted.current) return false;
    if (latest.readingMaterial?.id !== material.id || (!alreadyLinked && latest.revision !== selected.revision + 1)) {
      throw new ApiError(409, '题目已在其他页面更新，请核对双方内容', { entity: 'question', id: selected.id });
    }
    setSelected(latest); setReading(undefined); setScreen('edit'); setRefresh(value => value + 1);
    return true;
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 409) { setReading(material); setScreen('reading-conflict'); return false; }
      throw failure;
    }
  }
  const subjectName = (id: string | null) => subjects.find(subject => subject.id === id)?.name ?? '待选学科';
  const date = (time: number) => new Date(time).toLocaleString('zh-CN');
  function changeListState(next: 'draft' | 'collected') {
    setState(next);
    setFilters(({ collectedFrom: _from, collectedBefore: _before, ...remaining }) => remaining);
  }
  const continuation = pending && <div className="batch-next"><p>还有 {batch!.items.length} 张图片待处理 · 下一张：{pending.name}</p><button disabled={busy} onClick={() => requestLeave(() => { back(); void run(() => upload(pending)); })}>继续下一张</button><button className="quiet" disabled={busy} aria-label={`取消 ${pending.name}`} onClick={() => void run(() => cancel(pending))}>取消这张</button><button className="quiet" disabled={busy} onClick={() => requestLeave(back)}>稍后继续</button><p className="hint">已上传 {batch!.uploaded} / {batch!.total} 张，已取消 {batch!.cancelled} 张</p></div>;
  return <div className="collection-workspace">
    {error && <p role="alert" className="message error">{error}</p>}
    {notice && <p role="status" className="message">{notice}</p>}
    {screen === 'list' && mode === 'collect' && <section className="collection-entry" aria-label="收集新材料"><h1>收集</h1><p className="intro">先把材料留下来，再慢慢整理。</p><CaptureChoices busy={busy || cacheLoading || !!pending} onChoose={choose} onNotice={setNotice} />{pending && <p className="hint">先继续或取消本机待上传图片，再选择新的材料。</p>}</section>}
    {screen === 'list' && mode !== 'home' && batch && <CaptureQueue batch={batch} busy={busy} onUpload={item => void run(() => upload(item))} onCancel={item => void run(() => cancel(item))} />}
    {screen === 'list' && <section className="card collection-card" aria-label={listState === 'draft' ? '已保存的草稿' : '已收集错题'}>
      <div className="section-heading"><div>{admin ? <h1>错题资料</h1> : <h2>{listState === 'draft' ? '已保存的草稿' : '已收集'}</h2>}{mode === 'collect' && <p className="hint">已保存在家庭电脑，可以换设备继续整理。</p>}</div>{admin && <div className="admin-upload"><CaptureInput label="上传材料" busy={busy || cacheLoading || !!pending} onChoose={choose} onCancel={() => setNotice('已取消选择，已有材料保留。')} /></div>}</div>
      {admin && <p className="hint">支持 JPEG、PNG、静态 WebP；每张最多 15 MB、4000 万像素，每批最多 10 张、合计 75 MB。{pending ? '请先继续或取消本机待上传材料。' : '选择图片后可框题、确认学科并保存。'}</p>}
      <div className="collection-tabs">{mode === 'workspace' && <><button className="quiet" aria-pressed={state === 'collected'} disabled={busy} onClick={() => changeListState('collected')}>已收集</button><button className="quiet" aria-pressed={state === 'draft'} disabled={busy} onClick={() => changeListState('draft')}>草稿</button></>}<button className="quiet" disabled={busy || loading} onClick={() => setRefresh(value => value + 1)}>{readError ? '重试读取' : '刷新列表'}</button></div>
      {mode !== 'collect' && <QuestionFilters key={`${path}:${listState}`} value={filters} subjects={subjects} options={filterOptions} disabled={busy || loading} dates={listState === 'collected'} onChange={setFilters} />}
      {readError && <p role="alert" className="message error">{readError}。服务器材料暂时无法读取，本机待上传图片仍保留。</p>}
      {loading && <p role="status">正在读取材料…</p>}
      {cacheLoading && <p role="status">正在读取本机暂存，请稍候…</p>}
      {!loading && !readError && list.total === 0 && <div className="empty-state"><h3>{mode !== 'collect' && Object.values(filters).some(Boolean) ? '没有符合筛选条件的题目' : listState === 'draft' ? '还没有草稿' : '开始收集第一道错题吧'}</h3><p>{mode !== 'collect' && Object.values(filters).some(Boolean) ? '调整条件或清空筛选后再看看。' : mode === 'home' ? '从底部“收集”开始，把材料留下来。' : listState === 'draft' ? '上传图片后，可以先保存草稿，稍后继续整理。' : '选择图片、框住题目、选好学科，就能保存。'}</p></div>}
      {admin ? !loading && !readError && <AdminMaterialsTable api={api} list={list} state={listState} subjects={subjects} busy={busy || cacheLoading} onOpen={open} /> : <div className="question-list">{list.items.map(question => <article key={question.id}>
        <div className="question-thumbnail"><QuestionImage api={api} page={question.originalPage} region={question.region} /></div>
        <div><p className="eyebrow">{listState === 'draft' ? '草稿' : '已收集'} · {subjectName(question.subjectId)}</p><h3>{question.source || '未填写来源'}{question.questionNumber ? ` · 第 ${question.questionNumber} 题` : ''}</h3><p className="hint">{listState === 'collected' ? '收集于' : '暂存于'} {date(question.collectedAt ?? question.createdAt)}</p><button className="quiet" disabled={busy || cacheLoading} onClick={() => open(question)}>{listState === 'draft' ? '继续整理' : '打开错题'}</button></div>
      </article>)}</div>}
      {list.items.length < list.total && <button className="quiet" disabled={busy || cacheLoading || loading} onClick={() => void run(async () => { const more = await api.questions(listState, list.items.length, managementGrant, mode === 'collect' ? {} : filters); setList(current => ({ ...more, items: [...current.items, ...more.items] })); })}>加载更多</button>}
    </section>}
    {screen === 'edit' && selected && <QuestionEditor key={selected.id} api={api} question={selected} proposedReading={proposedReading} subjects={subjects} sources={sources} active={active} externalBusy={busy} admin={admin} creating={creating} grant={managementGrant} pageCache={pageCache} onBack={back} onNewFromPage={newFromPage} onReading={openReading} onAnswers={openAnswers} onAccessError={onAccessError} onCurrent={setSelected} onSaved={question => { setSelected(question); setProposedReading(undefined); setCreating(false); setRefresh(value => value + 1); if (!admin && question.state === 'collected') setScreen('detail'); }} />}
    {screen === 'answers' && selected && <AnswerEditor key={selected.id} api={api} question={selected} subjects={subjects} sources={sources} cache={answerCache} grant={managementGrant} active={active} onBack={() => setScreen(answerReturn.current)} onCurrent={setSelected} onSaved={question => { setSelected(question); setScreen(answerReturn.current); setRefresh(value => value + 1); }} onAccessError={onAccessError} />}
    {screen === 'reading' && reading && <ReadingMaterialEditor key={reading.id} api={api} material={reading} cache={readingCache} grant={managementGrant} active={active} onBack={() => { setReading(undefined); setScreen('edit'); }} onSaved={readingSaved} onAccessError={onAccessError} />}
    {screen === 'reading-conflict' && reading && selected && <ReadingLinkConflict api={api} question={selected} material={reading} subjects={subjects} sources={sources} grant={managementGrant} active={active} onAccessError={onAccessError}
      onResolve={(current, keep) => { setSelected(current); setProposedReading(keep ? reading : undefined); setReading(undefined); setScreen('edit'); }}
      onBack={() => { setReading(undefined); setScreen('edit'); }} />}
    {admin && screen === 'edit' && continuation}
    {screen === 'detail' && selected && <section className="card collection-card">
      <div className="section-heading"><div><p className="eyebrow">{subjectName(selected.subjectId)} · 已收集</p><h1>错题详情</h1></div><button className="quiet" disabled={busy} onClick={back}>返回列表</button></div>
      <p className="sync-state">已同步到家庭资料库</p><div className="detail-material"><QuestionParts api={api} parts={selected.parts} /></div>
      {selected.readingMaterial && <ReadingMaterialView api={api} material={selected.readingMaterial} />}
      <AnswerView api={api} parts={selected.answerParts} />
      <p className="study-stage">{stageLabel(selected.studyStage)}</p>
      <button className="quiet" disabled={busy} onClick={openAnswers}>{selected.answerParts.length ? '整理纸质答案' : '补充纸质答案'}</button>
      {continuation}
      <dl><div><dt>收集时间</dt><dd>{date(selected.collectedAt!)}</dd></div><div><dt>来源</dt><dd>{selected.source || '未填写'}</dd></div><div><dt>页码 / 题号</dt><dd>{selected.pageNumber || '未填写'} / {selected.questionNumber || '未填写'}</dd></div><div><dt>备注</dt><dd className="note-text">{selected.note || '未填写'}</dd></div></dl>
      <button disabled={busy} onClick={() => setScreen('edit')}>补充或更正信息</button><button className="quiet" onClick={() => setOriginalOpen(value => !value)}>{originalOpen ? '收起原始页' : '查看原始页'}</button>
      <NewQuestionFromPage parts={selected.parts} disabled={busy} onChoose={newFromPage} />
      {originalOpen && <div className="original-material"><h2>原始页</h2><p className="hint">这是上传时保留的完整原图，包含题目、作答和批改。</p><QuestionParts api={api} parts={[...selected.parts, ...selected.answerParts, ...(selected.readingMaterial?.parts ?? [])]} original /></div>}
    </section>}
  </div>;
}
