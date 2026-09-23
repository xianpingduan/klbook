import { useRef, useState } from 'react';
import type { Question, QuestionEdit, Subject } from '../shared/collection.ts';
import { validQuestionRegion } from '../shared/collection.ts';
import { ApiError, FamilyApi } from './api.ts';
import { CropSelector, QuestionImage } from './QuestionImage.tsx';
import type { Source } from '../shared/sources.ts';
import { useEditorLeave } from './useEditorLeave.tsx';

function editable(question: Question) {
  return { subjectId: question.subjectId, region: question.region, sourceId: question.sourceId, pageNumber: question.pageNumber, questionNumber: question.questionNumber, note: question.note };
}

export function QuestionEditor({ api, question, subjects, sources, active, admin = false, grant, onSaved, onBack, onAccessError }: {
  api: FamilyApi; question: Question; subjects: Subject[]; sources: Source[]; active: boolean; admin?: boolean; grant?: string; onSaved(question: Question): void; onBack(): void; onAccessError(error: ApiError): Promise<void>;
}) {
  const [fields, setFields] = useState(() => editable(question));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [step, setStep] = useState<'crop' | 'confirm'>(question.region ? 'confirm' : 'crop');
  const [originalOpen, setOriginalOpen] = useState(false);
  const baseline = useRef(JSON.stringify(editable(question)));
  const pending = useRef<{ fingerprint: string; operationId: string } | null>(null);
  const dirty = JSON.stringify(fields) !== baseline.current;
  const leave = useEditorLeave({
    dirty, busy, canSave: active, title: '还有未保存的修改', error,
    description: <><p>{question.state === 'draft' ? '保存后离开会保留为草稿，稍后可以继续整理。' : '保存后离开会更新这道错题，保留原来的收集时间。'}</p>{!active && <p className="message">管理验证已到期。选择继续编辑，重新验证家长身份后就能保存；也可以放弃本次修改并离开。</p>}</>,
    save: () => save(question.state),
    discard: () => { setFields(editable(question)); baseline.current = JSON.stringify(editable(question)); pending.current = null; },
  });

  async function save(state: 'draft' | 'collected') {
    if (!active || busy || (admin && !grant)) return false;
    setBusy(true); setError(''); setNotice('');
    const content = { expectedRevision: question.revision, state, ...fields };
    const fingerprint = JSON.stringify(content);
    if (pending.current?.fingerprint !== fingerprint) pending.current = { fingerprint, operationId: crypto.randomUUID() };
    const input: QuestionEdit = { ...content, operationId: pending.current.operationId };
    try {
      const saved = await api.saveQuestion(question.id, input, grant);
      setFields(editable(saved)); baseline.current = JSON.stringify(editable(saved)); pending.current = null;
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
  const validRegion = validQuestionRegion(fields.region);
  return <section className="card collection-card question-editor">
    <div className="section-heading"><div><p className="eyebrow">{admin ? '资料整理' : step === 'crop' ? '第 1 步 · 确认题目范围' : '第 2 步 · 确认信息'} · {question.state === 'draft' ? '草稿' : '已收集'}</p><h1>{admin ? '错题资料详情' : step === 'crop' ? '框住这道题' : question.state === 'draft' ? '确认并保存' : '补充或更正信息'}</h1>{admin && <p className="hint">{question.collectedAt ? '收集于' : '暂存于'} {new Date(question.collectedAt ?? question.createdAt).toLocaleString('zh-CN')}</p>}</div><button className="quiet" disabled={busy} onClick={() => leave.requestLeave(onBack)}>返回列表</button></div>
    {error && !leave.leaving && <p role="alert" className="message error">{error}</p>}
    {notice && !dirty && <p role="status" className="message">{notice}</p>}
    {leave.dialog}
    {!admin && step === 'crop' ? <div className="crop-step"><CropSelector api={api} page={question.originalPage} region={fields.region} disabled={busy} onChange={region => setFields(current => ({ ...current, region }))} /><div className="save-actions"><button disabled={busy || !validRegion} onClick={() => setStep('confirm')}>下一步，选学科</button>{question.state === 'draft' && <button className="quiet" disabled={busy} onClick={() => void save('draft')}>保存草稿</button>}</div></div> : <div className="editor-grid">
      <section className="confirmation-material" aria-label="题目与原始页">
        {admin && step === 'crop' ? <><CropSelector api={api} page={question.originalPage} region={fields.region} disabled={busy} onChange={region => setFields(current => ({ ...current, region }))} /><button className="quiet" disabled={busy || !validRegion} onClick={() => setStep('confirm')}>确认题目范围</button></> : <>
          <QuestionImage api={api} page={question.originalPage} region={fields.region} original={originalOpen} />
          <div className="material-actions"><button className="quiet" disabled={busy} onClick={() => { setOriginalOpen(false); setStep('crop'); }}>调整题目范围</button>{admin && <button className="quiet" onClick={() => setOriginalOpen(value => !value)}>{originalOpen ? '查看题目区' : '查看原始页'}</button>}</div>
        </>}
      </section>
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
