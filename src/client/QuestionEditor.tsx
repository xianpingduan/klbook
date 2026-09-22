import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Question, QuestionEdit, Subject } from '../shared/collection.ts';
import { validQuestionRegion } from '../shared/collection.ts';
import { ApiError, FamilyApi } from './api.ts';
import { CropSelector, QuestionImage } from './QuestionImage.tsx';
import type { Source } from '../shared/sources.ts';
import { useLeaveGuard } from './navigation.ts';

function editable(question: Question) {
  return { subjectId: question.subjectId, region: question.region, sourceId: question.sourceId, pageNumber: question.pageNumber, questionNumber: question.questionNumber, note: question.note };
}

export function QuestionEditor({ api, question, subjects, sources, active, onSaved, onBack, onExpired }: {
  api: FamilyApi; question: Question; subjects: Subject[]; sources: Source[]; active: boolean; onSaved(question: Question): void; onBack(): void; onExpired(): Promise<void>;
}) {
  const [fields, setFields] = useState(() => editable(question));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [leaving, setLeaving] = useState<{ proceed(): void }>();
  const dialog = useRef<HTMLDialogElement>(null);
  const [step, setStep] = useState<'crop' | 'confirm'>(question.region ? 'confirm' : 'crop');
  const baseline = useRef(JSON.stringify(editable(question)));
  const pending = useRef<{ fingerprint: string; operationId: string } | null>(null);
  const dirty = JSON.stringify(fields) !== baseline.current;
  const { requestLeave, releaseGuard } = useLeaveGuard(dirty || busy, proceed => setLeaving({ proceed }));
  useEffect(() => {
    if (leaving) dialog.current?.showModal(); else dialog.current?.close();
  }, [leaving]);

  async function save(state: 'draft' | 'collected') {
    if (!active) return false;
    setBusy(true); setError(''); setNotice('');
    const content = { expectedRevision: question.revision, state, ...fields };
    const fingerprint = JSON.stringify(content);
    if (pending.current?.fingerprint !== fingerprint) pending.current = { fingerprint, operationId: crypto.randomUUID() };
    const input: QuestionEdit = { ...content, operationId: pending.current.operationId };
    try {
      const saved = await api.saveQuestion(question.id, input);
      setFields(editable(saved)); baseline.current = JSON.stringify(editable(saved)); pending.current = null;
      setNotice(saved.state === 'draft' ? '草稿已保存到家庭资料库，可以稍后继续。' : '已同步到家庭资料库');
      onSaved(saved);
      return true;
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) { await onExpired(); return false; }
      setError(`${failure instanceof Error ? failure.message : '保存失败'}。当前填写内容仍保留，请核对后重试。`);
      return false;
    } finally { setBusy(false); }
  }
  const validRegion = validQuestionRegion(fields.region);
  return <section className="card collection-card question-editor">
    <div className="section-heading"><div><p className="eyebrow">{step === 'crop' ? '第 1 步 · 确认题目范围' : '第 2 步 · 确认信息'} · {question.state === 'draft' ? '草稿' : '补充信息'}</p><h1>{step === 'crop' ? '框住这道题' : question.state === 'draft' ? '确认并保存' : '补充或更正信息'}</h1></div><button className="quiet" disabled={busy} onClick={() => requestLeave(onBack)}>返回列表</button></div>
    {error && !leaving && <p role="alert" className="message error">{error}</p>}
    {notice && <p role="status" className="message">{notice}</p>}
    {createPortal(<dialog ref={dialog} className="leave-dialog" aria-labelledby="leave-title" onCancel={event => { event.preventDefault(); if (!busy) setLeaving(undefined); }}>
      <h2 id="leave-title">还有未保存的修改</h2><p>{question.state === 'draft' ? '保存后离开会保留为草稿，稍后可以继续整理。' : '保存后离开会更新这道错题，保留原来的收集时间。'}</p>
      {!active && <p className="message">管理验证已到期。选择继续编辑，重新验证家长身份后就能保存；也可以放弃本次修改并离开。</p>}
      {error && <p role="alert" className="message error">{error}</p>}
      <div className="leave-actions"><button autoFocus disabled={busy} onClick={() => setLeaving(undefined)}>继续编辑</button><button className="quiet" disabled={busy || !active} onClick={() => { const proceed = leaving?.proceed; void save(question.state).then(saved => { if (saved) { releaseGuard(); setLeaving(undefined); proceed?.(); } }); }}>{busy ? '正在保存…' : '保存后离开'}</button><button className="quiet" disabled={busy} onClick={() => { const proceed = leaving?.proceed; setFields(editable(question)); baseline.current = JSON.stringify(editable(question)); pending.current = null; releaseGuard(); setLeaving(undefined); proceed?.(); }}>放弃本次修改并离开</button></div>
    </dialog>, document.querySelector('.app-surface') ?? document.body)}
    {step === 'crop' ? <div className="crop-step"><CropSelector api={api} page={question.originalPage} region={fields.region} disabled={busy} onChange={region => setFields(current => ({ ...current, region }))} /><div className="save-actions"><button disabled={busy || !validRegion} onClick={() => setStep('confirm')}>下一步，选学科</button>{question.state === 'draft' && <button className="quiet" disabled={busy} onClick={() => void save('draft')}>保存草稿</button>}</div></div> : <div className="editor-grid">
      <div className="confirmation-material"><QuestionImage api={api} page={question.originalPage} region={fields.region} /><button className="quiet" disabled={busy} onClick={() => setStep('crop')}>调整题目范围</button></div>
      <div><fieldset disabled={busy}>
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
        <div className="save-actions">{question.state === 'draft' && <button className="quiet" onClick={() => void save('draft')}>保存草稿</button>}<button disabled={!fields.subjectId || !validRegion} onClick={() => void save('collected')}>{busy ? '正在保存…' : question.state === 'draft' ? '保存到错题集' : '保存修改'}</button></div>
      </fieldset></div>
    </div>}
  </section>;
}
