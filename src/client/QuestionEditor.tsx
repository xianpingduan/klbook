import { useRef, useState } from 'react';
import type { OriginalPage, Question, QuestionCreate, QuestionEdit, Subject } from '../shared/collection.ts';
import { validQuestionRegion } from '../shared/collection.ts';
import { ApiError, FamilyApi } from './api.ts';
import { QuestionParts, QuestionPartsEditor } from './QuestionParts.tsx';
import type { Source } from '../shared/sources.ts';
import { useEditorLeave } from './useEditorLeave.tsx';
import { usePageAppend } from './usePageAppend.ts';
import type { CaptureCache } from './capture-cache.ts';
import { CaptureInput } from './CaptureInput.tsx';
import { NewQuestionFromPage } from './NewQuestionFromPage.tsx';
import { ReadingMaterialPicker } from './ReadingMaterialPicker.tsx';
import { ReadingMaterialView } from './ReadingMaterialView.tsx';

function editable(question: Question) {
  return { subjectId: question.subjectId, parts: question.parts, sourceId: question.sourceId, pageNumber: question.pageNumber, questionNumber: question.questionNumber, note: question.note, readingMaterialId: question.readingMaterial?.id ?? null };
}

export function QuestionEditor({ api, question, subjects, sources, active, admin = false, creating = false, grant, pageCache, onSaved, onBack, onAccessError, onNewFromPage, onReading }: {
  api: FamilyApi; question: Question; subjects: Subject[]; sources: Source[]; active: boolean; admin?: boolean; creating?: boolean; grant?: string; pageCache: CaptureCache; onSaved(question: Question): void; onBack(): void; onNewFromPage(page: OriginalPage): void; onAccessError(error: ApiError): Promise<void>;
  onReading(id: string | null): void;
}) {
  const [fields, setFields] = useState(() => editable(question));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [step, setStep] = useState<'crop' | 'confirm'>(question.region ? 'confirm' : 'crop');
  const [originalOpen, setOriginalOpen] = useState(false);
  const [selectedPart, setSelectedPart] = useState(question.parts[0]!.id);
  const append = usePageAppend({ api, cache: pageCache, grant, onAccessError, onAppend: (page, partId) => {
    setFields(current => ({ ...current, parts: current.parts.some(part => part.id === partId) ? current.parts : [...current.parts, { id: partId, originalPage: page, region: null }] }));
    setSelectedPart(partId); setStep('crop');
  } });
  const working = busy || append.busy || append.loading;
  const baseline = useRef(JSON.stringify(editable(question)));
  const pending = useRef<{ fingerprint: string; operationId: string } | null>(null);
  const creation = useRef<{ pageId: string; input: QuestionCreate } | null>(null);
  const created = useRef<Question | null>(null);
  const dirty = JSON.stringify(fields) !== baseline.current;
  const leave = useEditorLeave({
    dirty, busy: working, canSave: active, title: '还有未保存的修改', error,
    description: <><p>{question.state === 'draft' ? '保存后离开会保留为草稿，稍后可以继续整理。' : '保存后离开会更新这道错题，保留原来的收集时间。'}</p>{!active && <p className="message">管理验证已到期。选择继续编辑，重新验证家长身份后就能保存；也可以放弃本次修改并离开。</p>}</>,
    save: () => save(question.state),
    discard: () => { setFields(editable(question)); baseline.current = JSON.stringify(editable(question)); pending.current = null; },
  });

  async function save(state: 'draft' | 'collected') {
    if (!active || working || (admin && !grant)) return false;
    setBusy(true); setError(''); setNotice('');
    const content = { state, ...fields, region: fields.parts[0]!.region,
      parts: fields.parts.map(part => ({ id: part.id, pageId: part.originalPage.id, region: part.region })) };
    try {
      let saved: Question | undefined;
      if (creating && !created.current) {
        // Replay the exact unresolved creation before applying edits, so a lost response cannot create a second question.
        creation.current ??= { pageId: fields.parts[0]!.originalPage.id, input: { ...content, operationId: crypto.randomUUID() } };
        const attempt = creation.current;
        try { created.current = await api.createQuestion(attempt.pageId, attempt.input, grant); }
        catch (failure) {
          if (failure instanceof ApiError && [400, 422].includes(failure.status)) creation.current = null;
          throw failure;
        }
        creation.current = null;
        const { operationId: _operation, ...submitted } = attempt.input;
        if (JSON.stringify(submitted) === JSON.stringify(content)) saved = created.current;
      }
      if (!saved) {
        const current = created.current ?? question;
        const update = { ...content, expectedRevision: current.revision, state: current.state === 'collected' ? 'collected' as const : state };
        const fingerprint = JSON.stringify(update);
        if (pending.current?.fingerprint !== fingerprint) pending.current = { fingerprint, operationId: crypto.randomUUID() };
        const input: QuestionEdit = { ...update, operationId: pending.current.operationId };
        saved = await api.saveQuestion(current.id, input, grant);
      }
      if (creating) created.current = saved;
      setFields(editable(saved)); baseline.current = JSON.stringify(editable(saved)); pending.current = null;
      await append.committed(saved);
      setNotice(saved.state === 'draft' ? '草稿已保存到家庭资料库，可以稍后继续。' : '已同步到家庭资料库');
      onSaved(saved);
      if (admin && saved.region) setStep('confirm');
      return true;
    } catch (failure) {
      if (failure instanceof ApiError && [401, 403].includes(failure.status)) { leave.dismiss(); await onAccessError(failure); return false; }
      setError(`${failure instanceof Error ? failure.message : '保存失败'}。当前填写内容仍保留，请核对后重试。`);
      return false;
    } finally { setBusy(false); }
  }
  const validRegion = fields.parts.every(part => validQuestionRegion(part.region));
  const crop = <QuestionPartsEditor api={api} parts={fields.parts} selectedId={selectedPart} onSelect={setSelectedPart} onChange={parts => setFields(current => ({ ...current, parts }))} disabled={working || !active} />;
  const addition = <div className="page-addition">
    {append.error && <p className="message error" role="alert">{append.error}</p>}
    {append.capture ? <><p className="hint">{append.capture.name} · {append.appended ? '图片已上传，保存题目后完成关联。' : '本机保留的追加材料，可重试继续。'}</p>{!append.appended && <><button className="quiet" disabled={working || !active} onClick={append.retry}>继续追加 {append.capture.name}</button><button className="quiet" disabled={working || !active} onClick={append.cancel}>取消追加</button></>}</> : <CaptureInput label="追加跨页图片" multiple={false} busy={working || !active || creating || fields.parts.length >= 50} onChoose={append.choose} onCancel={() => {}} />}
    <p className="hint">{creating ? '先保存本题，再追加跨页图片。' : '一次追加一页，保存后可继续追加。每道题最多 50 个题目区；图片限制与收集入口相同。'}</p>
  </div>;
  return <section className="card collection-card question-editor">
    <div className="section-heading"><div><p className="eyebrow">{admin ? '资料整理' : step === 'crop' ? '第 1 步 · 确认题目范围' : '第 2 步 · 确认信息'} · {question.state === 'draft' ? '草稿' : '已收集'}</p><h1>{admin ? '错题资料详情' : step === 'crop' ? '框住这道题' : question.state === 'draft' ? '确认并保存' : '补充或更正信息'}</h1>{admin && <p className="hint">{question.collectedAt ? '收集于' : '暂存于'} {new Date(question.collectedAt ?? question.createdAt).toLocaleString('zh-CN')}</p>}</div><button className="quiet" disabled={working} onClick={() => leave.requestLeave(onBack)}>返回列表</button></div>
    {error && !leave.leaving && <p role="alert" className="message error">{error}</p>}
    {notice && !dirty && <p role="status" className="message">{notice}</p>}
    {leave.dialog}
    {admin && !creating && question.state === 'collected' && <NewQuestionFromPage parts={question.parts} disabled={working || !active} onChoose={page => leave.requestLeave(() => onNewFromPage(page))} />}
    {!admin && step === 'crop' ? <div className="crop-step">{crop}{addition}<div className="save-actions"><button disabled={working || !validRegion} onClick={() => setStep('confirm')}>下一步，选学科</button>{question.state === 'draft' && <button className="quiet" disabled={working} onClick={() => void save('draft')}>保存草稿</button>}</div></div> : <div className="editor-grid">
      <section className="confirmation-material" aria-label="题目与原始页">
        {admin && step === 'crop' ? <>{crop}<button className="quiet" disabled={working || !validRegion} onClick={() => setStep('confirm')}>确认题目范围</button></> : <>
          <QuestionParts api={api} parts={originalOpen ? [...fields.parts, ...(question.readingMaterial?.parts ?? [])] : fields.parts} original={originalOpen} />
          {!originalOpen && question.readingMaterial && fields.readingMaterialId === question.readingMaterial.id && <ReadingMaterialView api={api} material={question.readingMaterial} />}
          <div className="material-actions"><button className="quiet" disabled={working} onClick={() => { setOriginalOpen(false); setStep('crop'); }}>调整题目范围</button>{admin && <button className="quiet" onClick={() => setOriginalOpen(value => !value)}>{originalOpen ? '查看题目区' : '查看原始页'}</button>}</div>
        </>}
        {addition}
      </section>
      <div><fieldset disabled={working || !active}>
        <label>学科<select value={fields.subjectId ?? ''} onChange={event => setFields(current => ({ ...current, subjectId: event.target.value || null }))}><option value="">请选择</option>{subjects.map(subject => <option key={subject.id} value={subject.id}>{subject.name}</option>)}</select></label>
        <p className="hint">确认范围和学科就可以收集，答案和总结可以以后再补。</p>
        <h2>顺手记一点（选填）</h2>
        <label>来源（选填）<select value={fields.sourceId ?? ''} onChange={event => setFields(current => ({ ...current, sourceId: event.target.value || null }))}>
          <option value="">暂不填写</option>
          {question.sourceId && !sources.some(source => source.id === question.sourceId) && <option value={question.sourceId} disabled>{question.source}（已停用）</option>}
          {sources.map(source => <option key={source.id} value={source.id}>{source.name}</option>)}
        </select></label>
        <div className="two-fields"><label>页码（选填）<input value={fields.pageNumber} maxLength={32} onChange={event => setFields(current => ({ ...current, pageNumber: event.target.value }))} /></label><label>题号（选填）<input value={fields.questionNumber} maxLength={32} onChange={event => setFields(current => ({ ...current, questionNumber: event.target.value }))} /></label></div>
        <label>备注（选填）<textarea value={fields.note} maxLength={2000} rows={3} onChange={event => setFields(current => ({ ...current, note: event.target.value }))} placeholder="想说什么都可以，也可以先留空" /></label>
        <ReadingMaterialPicker api={api} grant={grant} active={active} current={question.readingMaterial} value={fields.readingMaterialId} onChange={readingMaterialId => setFields(current => ({ ...current, readingMaterialId }))} onAccessError={onAccessError} />
        <div className="reading-actions"><button className="quiet" disabled={creating} onClick={() => leave.requestLeave(() => onReading(null))}>从原始页新建阅读材料</button>{question.readingMaterial && <button className="quiet" disabled={creating || fields.readingMaterialId !== question.readingMaterial.id} onClick={() => leave.requestLeave(() => onReading(question.readingMaterial!.id))}>编辑已关联原文</button>}</div>
        {creating && <p className="hint">可先选已有原文；新建阅读材料需先保存本题。</p>}
        <div className="save-actions">{question.state === 'draft' && <button className="quiet" onClick={() => void save('draft')}>保存草稿</button>}<button disabled={!fields.subjectId || !validRegion} onClick={() => void save('collected')}>{busy ? '正在保存…' : question.state === 'draft' ? '保存到错题集' : '保存修改'}</button></div>
      </fieldset></div>
    </div>}
  </section>;
}
