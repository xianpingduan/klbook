import { useEffect, useRef, useState } from 'react';
import type { OriginalPage, Question, QuestionPart } from '../shared/collection.ts';
import { validQuestionRegion } from '../shared/collection.ts';
import { ApiError, FamilyApi } from './api.ts';
import type { CaptureCache } from './capture-cache.ts';
import { usePageAppend } from './usePageAppend.ts';
import { useEditorLeave } from './useEditorLeave.tsx';
import { QuestionParts, QuestionPartsEditor } from './QuestionParts.tsx';
import { CaptureInput } from './CaptureInput.tsx';
import { AnswerPagePicker } from './AnswerPagePicker.tsx';
import { useTouchInput } from './useTouchInput.ts';
import { useRevisionedSave } from './useRevisionedSave.ts';

const content = (parts: QuestionPart[]) => parts.map(part => ({ id: part.id, pageId: part.originalPage.id, region: part.region }));

export function AnswerEditor({ api, question, cache, grant, active, onBack, onSaved, onAccessError }: {
  api: FamilyApi; question: Question; cache: CaptureCache; grant?: string; active: boolean; onBack(): void; onSaved(question: Question): void; onAccessError(error: ApiError): Promise<void>;
}) {
  const [parts, setParts] = useState(question.answerParts);
  const touch = useTouchInput();
  const [selected, setSelected] = useState(parts[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [original, setOriginal] = useState(false);
  const [picking, setPicking] = useState(false);
  const saver = useRevisionedSave({ initial: question, contentOf: value => ({ parts: content(value.answerParts) }),
    persist: input => api.saveAnswers(question.id, input, grant), conflictMessage: '这道题已在其他页面更新，请返回列表重新打开后核对' });
  const baseline = useRef(JSON.stringify(parts));
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  function add(page: OriginalPage, id: string = crypto.randomUUID()) {
    setParts(value => value.some(part => part.id === id) ? value : [...value, { id, originalPage: page, region: null }]); setSelected(id); setPicking(false);
  }
  const append = usePageAppend({ api, cache, grant, onAccessError, onAppend: add });
  const working = busy || append.busy || append.loading;
  const leave = useEditorLeave({ dirty: JSON.stringify(parts) !== baseline.current, busy: working, canSave: active, title: '纸质答案还有未保存的修改', error,
    description: <p>保存会更新本题的解答区；放弃本次修改不会删除原始图片或其他题目的答案。</p>, save,
    discard: () => { const saved = saver.discard(); setParts(saved.answerParts); baseline.current = JSON.stringify(saved.answerParts); } });
  async function save() {
    if (working || !active) return false;
    if (parts.some(part => !validQuestionRegion(part.region))) { setError('请先框选每个解答区，或移除不需要的区域。'); return false; }
    setBusy(true); setError('');
    try {
      const saved = await saver.save({ parts: content(parts) });
      await append.committed({ parts: saved.answerParts });
      if (!mounted.current) return false;
      baseline.current = JSON.stringify(parts); onSaved(saved); return true;
    } catch (failure) {
      if (!mounted.current) return false;
      if (failure instanceof ApiError && [401, 403].includes(failure.status)) { leave.dismiss(); await onAccessError(failure); }
      else setError(`${failure instanceof Error ? failure.message : '保存失败'}。当前图片和解答区仍保留，请核对后重试。`);
      return false;
    } finally { if (mounted.current) setBusy(false); }
  }
  const pages = [...question.parts, ...(question.readingMaterial?.parts ?? [])].map(part => part.originalPage).filter((page, index, all) => all.findIndex(other => other.id === page.id) === index);
  return <section className="card collection-card answer-editor">
    <div className="section-heading"><div><p className="eyebrow">纸质答案 · {question.questionNumber ? `第 ${question.questionNumber} 题` : '当前小题'}</p><h1>整理纸质答案</h1></div><button className="quiet" disabled={working} onClick={() => leave.requestLeave(onBack)}>返回题目</button></div>
    <p className="hint">答案可以以后再补。答案与题干交叠时保留真实图片和原批改。</p>
    {error && !leave.leaving && <p role="alert" className="message error">{error}</p>}{leave.dialog}
    <fieldset disabled={working || !active}>
      {parts.length ? <QuestionPartsEditor api={api} parts={parts} selectedId={selected} onSelect={setSelected} onChange={setParts} disabled={working || !active} kind="answer" /> : <p className="empty-state">还没有解答区，可以从下面选择材料；没有答案也能保存题目。</p>}
      <div className="answer-sources"><h2>选择答案材料</h2>
        <div className="part-actions">{pages.map((page, index) => <button key={page.id} className="quiet" disabled={parts.length >= 50} onClick={() => add(page)}>从本题原始页 {index + 1} 框选</button>)}<button className="quiet" disabled={parts.length >= 50} aria-expanded={picking} onClick={() => setPicking(value => !value)}>{picking ? '收起已有答案页' : '从已有答案页选择'}</button></div>
        {picking && <AnswerPagePicker api={api} grant={grant} active={active} disabled={working || parts.length >= 50} onChoose={add} onAccessError={onAccessError} />}
        {append.error && <p role="alert" className="message error">{append.error}</p>}
        {append.capture ? <><p>{append.capture.name} · {append.appended ? '保存答案后完成关联。' : '本机保留的答案图片，可继续。'}</p>{!append.appended && <><button className="quiet" onClick={append.retry}>继续追加 {append.capture.name}</button><button className="quiet" onClick={append.cancel}>取消追加</button></>}</> : <div className="answer-capture">{touch && <CaptureInput label="拍摄答案" camera busy={working || !active || parts.length >= 50} onChoose={append.choose} onCancel={() => {}} />}<CaptureInput label="选择答案图片" multiple={false} busy={working || !active || parts.length >= 50} onChoose={append.choose} onCancel={() => {}} /></div>}
        <p className="hint">一次追加一张，保存后可继续。最多 50 个解答区；移除全部解答区再保存，可解除本题的答案关联，原图保留。</p>
      </div>
      <div className="save-actions"><button disabled={parts.some(part => !validQuestionRegion(part.region))} onClick={() => void save()}>{busy ? '正在保存…' : '保存答案并返回'}</button><button className="quiet" onClick={() => setOriginal(value => !value)}>{original ? '收起答案原始页' : '查看答案原始页'}</button></div>
    </fieldset>
    {original && <QuestionParts api={api} parts={parts} original kind="answer" />}
  </section>;
}
