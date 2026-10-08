import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { OriginalPage, Question, Subject } from '../shared/collection.ts';
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
import { AnswerView } from './AnswerView.tsx';
import { StudyStageFields } from './StudyStageFields.tsx';
import { questionFields as editable, questionContent } from './question-edit.ts';
import { useRevisionedSave } from './useRevisionedSave.ts';
import { useSaveConflict } from './useSaveConflict.ts';
import { SaveConflict } from './SaveConflict.tsx';
import { ConflictQuestionView } from './ConflictQuestionView.tsx';
import type { ReadingMaterial } from '../shared/reading-materials.ts';
import { RecognitionPanel } from './RecognitionPanel.tsx';
import { recognitionScope, useCropRecognition } from './useCropRecognition.ts';
import type { QuestionCheckpoint } from './question-journal.ts';

export function QuestionEditor({ api, question: initialQuestion, proposedReading, subjects, sources, active, admin = false, creating = false, externalBusy = false, grant, pageCache, onSaved, onCurrent, onBack, onCancelled, onAccessError, onNewFromPage, onReading, onAnswers }: {
  api: FamilyApi; question: Question; subjects: Subject[]; sources: Source[]; active: boolean; admin?: boolean; creating?: boolean; grant?: string; pageCache: CaptureCache; onSaved(question: Question): void; onBack(): void; onNewFromPage(page: OriginalPage): void; onAccessError(error: ApiError): Promise<void>;
  onReading(id: string | null): void;
  onAnswers(): void;
  onCancelled(): void;
  externalBusy?: boolean;
  onCurrent(question: Question): void;
  proposedReading?: ReadingMaterial;
}) {
  const [local] = useState(() => {
    try { return { journal: !admin && !creating ? api.questionJournal(initialQuestion.id) : undefined, error: '' }; }
    catch (failure) { return { journal: undefined, error: failure instanceof Error ? failure.message : '本机整理进度无法读取' }; }
  });
  const restored = useRef(local.journal?.read()).current;
  const [question, setQuestion] = useState(restored?.checkpoint.current ?? initialQuestion);
  const recordId = useRef(initialQuestion.id);
  const [fields, setFields] = useState(() => ({ ...(restored?.fields ?? editable(question)), ...(proposedReading ? { readingMaterialId: proposedReading.id } : {}) }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [step, setStep] = useState<'crop' | 'confirm'>(restored?.step ?? (question.region ? 'confirm' : 'crop'));
  const [localError, setLocalError] = useState(local.error);
  const [progress, setProgress] = useState(restored ? '已在本机保留' : '');
  const currentEdit = useRef({ fields, step });
  currentEdit.current = { fields, step };
  const autoRunning = useRef(false);
  const paused = useRef(false);
  const completed = useRef(false);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  function checkpoint(value: QuestionCheckpoint) {
    if (!local.journal || completed.current) return;
    local.journal.write({ version: 1, ...currentEdit.current, checkpoint: value, updatedAt: Date.now() });
  }
  const [originalOpen, setOriginalOpen] = useState(false);
  const [selectedPart, setSelectedPart] = useState(question.parts[0]!.id);
  const automaticRecognition = useCropRecognition(api, grant);
  function nextStep() { setStep('confirm'); automaticRecognition.start(fields.parts); }
  const cancelOperation = useRef<{ operationId: string; expectedRevision: number; cancelled: true } | undefined>(undefined);
  const append = usePageAppend({ api, cache: pageCache, grant, onAccessError, onAppend: (page, partId, replacePartId) => {
    setFields(current => ({ ...current, parts: replacePartId
      ? current.parts.map(part => part.id === replacePartId ? { id: part.id, originalPage: page, region: null, transcription: '', recognition: null } : part)
      : current.parts.some(part => part.id === partId) ? current.parts : [...current.parts, { id: partId, originalPage: page, region: null }] }));
    setSelectedPart(replacePartId ?? partId); setStep('crop');
  } });
  const conflict = useSaveConflict({ read: () => api.question(recordId.current, grant), onAccessError });
  const saver = useRevisionedSave({ initial: creating ? { ...question, revision: 0 } : question,
    contentOf: value => questionContent(editable(value), value.state),
    persist: async input => {
      const { expectedRevision, ...creation } = input;
      const result = expectedRevision === 0 && creating
        ? await api.createQuestion(input.parts[0]!.pageId, creation, grant)
        : await api.saveQuestion(recordId.current, input, grant);
      recordId.current = result.id;
      return result;
    }, checkpoint: local.journal ? { initial: restored?.checkpoint, write: checkpoint } : undefined,
    defer: (value, desired) => api.deferQuestion(value.id, desired),
    conflictMessage: '这道题已在其他页面更新，请核对双方内容', conflictTarget: { entity: 'question', id: recordId.current } });
  const working = externalBusy || busy || append.busy || append.loading || conflict.loading;
  const editingLocked = working || !!cancelOperation.current;
  const baseline = useRef(JSON.stringify(editable(question)));
  const dirty = JSON.stringify(fields) !== baseline.current;
  const leave = useEditorLeave({
    dirty: local.journal ? !!localError : dirty, busy: working, canSave: active && !cancelOperation.current, title: '还有未保存的修改', error: localError || error,
    description: <><p>{question.state === 'draft' ? '保存后离开会保留为草稿，稍后可以继续整理。' : '保存后离开会更新这道错题，保留原来的收集时间。'}</p>{!active && <p className="message">管理验证已到期。选择继续编辑，重新验证家长身份后就能保存；也可以放弃本次修改并离开。</p>}</>,
    save: () => save(question.state),
    discard: () => { const saved = saver.discard(); setQuestion(saved); setFields(editable(saved)); baseline.current = JSON.stringify(editable(saved)); conflict.clear(); },
  });

  useLayoutEffect(() => {
    if (!local.journal || paused.current) return;
    try { checkpoint(saver.snapshot()); setLocalError(''); if (dirty) setProgress('已在本机保留'); }
    catch (failure) { setLocalError(failure instanceof Error ? failure.message : '本机整理进度未能保存'); }
  }, [fields, step]);
  useEffect(() => {
    if (!local.journal || localError || question.state !== 'draft' || !dirty || !active || editingLocked || conflict.open || paused.current) return;
    const timer = setTimeout(() => {
      if (autoRunning.current || paused.current) return;
      autoRunning.current = true;
      const snapshot = fields;
      setProgress('正在同步草稿…');
      void saver.save(questionContent(snapshot, 'draft')).then(saved => {
        if (!live.current || paused.current) return;
        setQuestion(saved); onCurrent(saved); baseline.current = JSON.stringify(editable(saved));
        setProgress(saved.syncState === 'pending' ? '已在本机保留，等待同步' : JSON.stringify(currentEdit.current.fields) === JSON.stringify(snapshot) ? '草稿已同步到家庭电脑' : '已在本机保留');
        void append.committed(saved);
      }).catch(async failure => {
        if (!live.current || paused.current) return;
        setProgress('已在本机保留，等待同步');
        if (failure instanceof ApiError && [401, 403].includes(failure.status)) await onAccessError(failure);
        else if (failure instanceof ApiError && failure.status === 409) { setError(failure.message); await conflict.show(); }
        else if (failure instanceof ApiError) setError(failure.message);
        else setLocalError('本机整理进度未能完整保存，请保留页面并重试。');
      }).finally(() => { autoRunning.current = false; });
    }, 500);
    return () => clearTimeout(timer);
  }, [fields, active, editingLocked, localError, question.revision, conflict.open]);

  async function save(state: 'draft' | 'collected') {
    if (!active || editingLocked || (admin && !grant)) return false;
    if (conflict.open) { setError('请先在冲突核对区选择处理方式，再保存。'); leave.dismiss(); return false; }
    setBusy(true); setError(''); setNotice('');
    const content = questionContent(fields, question.state === 'collected' ? 'collected' : state);
    try {
      const saved = await saver.save(content, true);
      setQuestion(saved); setFields(editable(saved)); baseline.current = JSON.stringify(editable(saved));
      await append.committed(saved);
      if (saved.state === 'collected') { paused.current = true; if (saved.syncState === 'synced') { local.journal?.complete(); completed.current = true; } }
      setNotice(saved.syncState === 'pending' ? '已在本机保留，等待同步' : saved.state === 'draft' ? '草稿已保存到家庭资料库，可以稍后继续。' : '已同步到家庭资料库');
      onSaved(saved);
      if (admin && saved.region) setStep('confirm');
      return true;
    } catch (failure) {
      if (failure instanceof ApiError && [401, 403].includes(failure.status)) { leave.dismiss(); await onAccessError(failure); return false; }
      setError(`${failure instanceof Error ? failure.message : '保存失败'}。当前填写内容仍保留，请核对后重试。`);
      // A creation precondition can fail before any question exists; only revision conflicts have a record to compare.
      if (failure instanceof ApiError && failure.status === 409 && failure.conflict?.entity === 'question') { leave.dismiss(); await conflict.show(); }
      return false;
    } finally { setBusy(false); }
  }
  async function cancelCurrent() {
    if (working || !active || question.state !== 'draft') return;
    setBusy(true); setError(''); paused.current = true;
    try {
      await saver.idle();
      // Retain current edits for undo; retry an uncertain cancellation before attempting another save.
      if (!cancelOperation.current) {
        const saved = await saver.save(questionContent(fields, 'draft'), true);
        setQuestion(saved); onCurrent(saved); baseline.current = JSON.stringify(editable(saved));
        await append.committed(saved);
        cancelOperation.current = { operationId: crypto.randomUUID(), expectedRevision: saved.revision, cancelled: true };
      }
      await api.cancelDraft(recordId.current, cancelOperation.current, grant);
      local.journal?.complete(); completed.current = true;
      leave.complete(onCancelled);
    } catch (failure) {
      setError(`${failure instanceof Error ? failure.message : '取消未完成'}。材料仍保留，请重试取消或返回列表核对。`);
      if (failure instanceof ApiError && [401, 403].includes(failure.status)) await onAccessError(failure);
      if (failure instanceof ApiError && failure.status === 409) { cancelOperation.current = undefined; paused.current = false; await conflict.show(); }
    } finally { setBusy(false); }
  }
  function resolveConflict(keep: boolean) {
    const latest = conflict.current;
    if (!latest || editingLocked || !active) return;
    saver.adopt(latest); setQuestion(latest); baseline.current = JSON.stringify(editable(latest));
    if (!creating) onCurrent(latest);
    if (!keep) { setFields(editable(latest)); setSelectedPart(latest.parts[0]!.id); setStep(latest.region ? 'confirm' : 'crop'); }
    conflict.clear(); setError(''); setNotice(keep ? '本次编辑已保留。请合并需要的信息，再保存。' : '已采用资料库当前版本。');
  }
  const validRegion = fields.parts.every(part => validQuestionRegion(part.region));
  const recognitionPart = fields.parts.find(part => part.id === selectedPart) ?? fields.parts[0]!;
  const recognition = <RecognitionPanel key={recognitionScope(recognitionPart.originalPage.id, recognitionPart.region)} api={api} part={recognitionPart} subjects={subjects} grant={grant} disabled={editingLocked || !active} onAccessError={onAccessError}
    refreshToken={automaticRecognition.refresh} backgroundMessage={automaticRecognition.messages[recognitionScope(recognitionPart.originalPage.id, recognitionPart.region)]}
    onRetryBackground={() => automaticRecognition.start([recognitionPart], true)}
    onText={text => setFields(current => ({ ...current, parts: current.parts.map(part => part.id === recognitionPart.id ? { ...part, transcription: text } : part) }))}
    onAdopt={(run, candidate) => setFields(current => ({ ...current, subjectId: candidate.subjectId ?? current.subjectId, questionNumber: candidate.questionNumber || current.questionNumber,
      parts: current.parts.map(part => part.id === recognitionPart.id ? { ...part, region: candidate.region, transcription: candidate.text, recognition: { runId: run.id, candidateId: candidate.id } } : part) }))} />;
  const crop = <QuestionPartsEditor api={api} parts={fields.parts} selectedId={selectedPart} onSelect={setSelectedPart} onChange={parts => setFields(current => ({ ...current, parts }))} disabled={editingLocked || !active} />;
  const addition = <div className="page-addition">
    {append.error && <p className="message error" role="alert">{append.error}</p>}
    {append.capture ? <><p className="hint">{append.capture.name} · {append.appended ? '图片已上传，保存题目后完成关联。' : '图片已在本机保留，可重试继续。'}</p>{!append.appended && <><button className="quiet" disabled={editingLocked || !active} onClick={append.retry}>{append.capture.replacePartId ? '重试换图' : `继续追加 ${append.capture.name}`}</button><button className="quiet" disabled={editingLocked || !active} onClick={append.cancel}>{append.capture.replacePartId ? '放弃换图' : '取消追加'}</button></>}</> : <CaptureInput label="追加跨页图片" multiple={false} busy={editingLocked || !active || creating || fields.parts.length >= 50} onChoose={append.choose} onCancel={() => {}} />}
    <p className="hint">{creating ? '先保存本题，再追加跨页图片。' : '一次追加一页，保存后可继续追加。每道题最多 50 个题目区；图片限制与收集入口相同。'}</p>
  </div>;
  return <section className="card collection-card question-editor">
    <div className="section-heading"><div><p className="eyebrow">{admin ? '资料整理' : step === 'crop' ? '第 1 步 · 确认题目范围' : '第 2 步 · 确认信息'} · {question.state === 'draft' ? '草稿' : '已收集'}</p><h1>{admin ? '错题资料详情' : step === 'crop' ? '框住这道题' : question.state === 'draft' ? '确认并保存' : '补充或更正信息'}</h1>{admin && <p className="hint">{question.collectedAt ? '收集于' : '暂存于'} {new Date(question.collectedAt ?? question.createdAt).toLocaleString('zh-CN')}</p>}</div><button className="quiet" disabled={working} onClick={() => leave.requestLeave(onBack)}>返回列表</button></div>
    {error && !leave.leaving && <p role="alert" className="message error">{error}</p>}
    {localError && <p role="alert" className="message error">{localError}<button className="quiet" onClick={() => { try { checkpoint(saver.snapshot()); setLocalError(''); setProgress('已在本机保留'); } catch (failure) { setLocalError((failure as Error).message); } }}>重试本机保存</button></p>}
    {local.journal && progress && !localError && <p role="status" className="draft-progress">{progress}</p>}
    {notice && !dirty && <p role="status" className="message">{notice}</p>}
    <div className="material-actions">
      {step === 'crop' && <CaptureInput label="换图" multiple={false} busy={editingLocked || !active || creating || (!!append.capture && !append.appended)} onChoose={files => append.choose(files, selectedPart)} onCancel={() => {}} />}
      {question.state === 'draft' && <button className="quiet" disabled={working || !active || conflict.open} onClick={() => void cancelCurrent()}>取消本次</button>}
    </div>
    {leave.dialog}
    {conflict.open && <SaveConflict current={conflict.current && <ConflictQuestionView api={api} question={conflict.current} subjects={subjects} sources={sources} />}
      local={<ConflictQuestionView api={api} question={question} fields={fields} subjects={subjects} sources={sources} />}
      loading={conflict.loading} error={conflict.error} disabled={editingLocked || !active} onRefresh={() => void conflict.refresh()} onKeep={() => resolveConflict(true)} onAdopt={() => resolveConflict(false)} />}
    {admin && !creating && question.state === 'collected' && <NewQuestionFromPage parts={question.parts} disabled={editingLocked || !active} onChoose={page => leave.requestLeave(() => onNewFromPage(page))} />}
    {!admin && step === 'crop' ? <div className="crop-step">{crop}{recognition}{addition}<div className="save-actions"><button disabled={editingLocked || !validRegion} onClick={nextStep}>下一步，选学科</button>{question.state === 'draft' && <button className="quiet" disabled={editingLocked} onClick={() => void save('draft')}>保存草稿</button>}</div></div> : <div className="editor-grid">
      <section className="confirmation-material" aria-label="题目与原始页">
        {admin && step === 'crop' ? <>{crop}<button className="quiet" disabled={editingLocked || !validRegion} onClick={nextStep}>确认题目范围</button></> : <>
          <QuestionParts api={api} parts={originalOpen ? [...fields.parts, ...question.answerParts, ...(question.readingMaterial?.parts ?? [])] : fields.parts} original={originalOpen} />
          {!originalOpen && question.readingMaterial && fields.readingMaterialId === question.readingMaterial.id && <ReadingMaterialView api={api} material={question.readingMaterial} />}
          {!originalOpen && <AnswerView api={api} parts={question.answerParts} />}
          <div className="material-actions"><button className="quiet" disabled={editingLocked} onClick={() => { setOriginalOpen(false); setStep('crop'); }}>调整题目范围</button>{admin && <button className="quiet" onClick={() => setOriginalOpen(value => !value)}>{originalOpen ? '查看题目区' : '查看原始页'}</button>}</div>
        </>}
        {recognition}{addition}
      </section>
      <div><fieldset disabled={editingLocked || !active}>
        <label>学科<select value={fields.subjectId ?? ''} onChange={event => setFields(current => ({ ...current, subjectId: event.target.value || null }))}><option value="">请选择</option>{subjects.map(subject => <option key={subject.id} value={subject.id}>{subject.name}</option>)}</select></label>
        <p className="hint">确认范围和学科就可以收集，答案和总结可以以后再补。</p>
        <h2>顺手记一点（选填）</h2>
        <StudyStageFields value={fields.studyStage} onChange={studyStage => setFields(current => ({ ...current, studyStage }))} />
        <p className="hint">填写材料实际所属的学习阶段；更正不会改变收集日期。</p>
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
        <button className="quiet" disabled={creating} onClick={() => leave.requestLeave(onAnswers)}>{question.answerParts.length ? '整理纸质答案' : '补充纸质答案'}</button>
        <p className="hint">{creating ? '先保存本题，再补充纸质答案。' : '答案可以以后补充，不影响先收集题目。'}</p>
        <div className="save-actions">{question.state === 'draft' && <button className="quiet" onClick={() => void save('draft')}>保存草稿</button>}<button disabled={!fields.subjectId || !validRegion} onClick={() => void save('collected')}>{busy ? '正在保存…' : question.state === 'draft' ? '保存到错题集' : '保存修改'}</button></div>
      </fieldset></div>
    </div>}
  </section>;
}
