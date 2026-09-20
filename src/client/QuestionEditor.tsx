import { useRef, useState } from 'react';
import type { Question, QuestionEdit, Subject } from '../shared/collection.ts';
import { ApiError, FamilyApi } from './api.ts';
import { CropSelector } from './QuestionImage.tsx';
import type { Source } from '../shared/sources.ts';

function editable(question: Question) {
  return { subjectId: question.subjectId, region: question.region, sourceId: question.sourceId, pageNumber: question.pageNumber, questionNumber: question.questionNumber, note: question.note };
}

export function QuestionEditor({ api, question, subjects, sources, onSaved, onBack, onExpired }: {
  api: FamilyApi; question: Question; subjects: Subject[]; sources: Source[]; onSaved(question: Question): void; onBack(): void; onExpired(): Promise<void>;
}) {
  const [fields, setFields] = useState(() => editable(question));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [leaving, setLeaving] = useState(false);
  const baseline = useRef(JSON.stringify(editable(question)));
  const pending = useRef<{ fingerprint: string; operationId: string } | null>(null);

  async function save(state: 'draft' | 'collected') {
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
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) { await onExpired(); return; }
      setError(`${failure instanceof Error ? failure.message : '保存失败'}。当前填写内容仍保留，请核对后重试。`);
    } finally { setBusy(false); }
  }
  const dirty = JSON.stringify(fields) !== baseline.current;
  return <section className="card collection-card">
    <div className="section-heading"><div><p className="eyebrow">{question.state === 'draft' ? '草稿 · 尚未完成收集' : '补充信息'}</p><h1>{question.state === 'draft' ? '整理这道题' : '补充或更正信息'}</h1></div><button className="quiet" disabled={busy} onClick={() => dirty ? setLeaving(true) : onBack()}>返回列表</button></div>
    {error && <p role="alert" className="message error">{error}</p>}
    {notice && <p role="status" className="message">{notice}</p>}
    {leaving && <div className="message"><p>还有未保存的修改。可以先保存草稿或修改，再返回列表。</p><button className="quiet" onClick={() => setLeaving(false)}>继续编辑</button><button className="quiet" onClick={onBack}>放弃本次修改并返回</button></div>}
    <div className="editor-grid">
      <div><h2>1. 确认题目范围</h2><CropSelector api={api} page={question.originalPage} region={fields.region} disabled={busy} onChange={region => setFields(current => ({ ...current, region }))} /></div>
      <div><h2>2. 选择学科</h2><fieldset disabled={busy}>
        <label>学科<select value={fields.subjectId ?? ''} onChange={event => setFields(current => ({ ...current, subjectId: event.target.value || null }))}><option value="">请选择</option>{subjects.map(subject => <option key={subject.id} value={subject.id}>{subject.name}</option>)}</select></label>
        <p className="hint">确认范围和学科就可以收集，答案和总结可以以后再补。</p>
        <h2>3. 顺手记一点（选填）</h2>
        <label>来源（选填）<select value={fields.sourceId ?? ''} onChange={event => setFields(current => ({ ...current, sourceId: event.target.value || null }))}>
          <option value="">暂不填写</option>
          {question.sourceId && !sources.some(source => source.id === question.sourceId) && <option value={question.sourceId} disabled>{question.source}（已停用）</option>}
          {sources.map(source => <option key={source.id} value={source.id}>{source.name}</option>)}
        </select></label><p className="hint">需要添加或修改来源时，请返回列表，进入“家长管理 → 来源管理”。</p>
        <div className="two-fields"><label>页码（选填）<input value={fields.pageNumber} maxLength={32} onChange={event => setFields(current => ({ ...current, pageNumber: event.target.value }))} /></label><label>题号（选填）<input value={fields.questionNumber} maxLength={32} onChange={event => setFields(current => ({ ...current, questionNumber: event.target.value }))} /></label></div>
        <label>备注（选填）<textarea value={fields.note} maxLength={2000} rows={3} onChange={event => setFields(current => ({ ...current, note: event.target.value }))} placeholder="想说什么都可以，也可以先留空" /></label>
        <div className="save-actions">{question.state === 'draft' && <button className="quiet" onClick={() => void save('draft')}>保存草稿</button>}<button disabled={!fields.subjectId || !fields.region} onClick={() => void save('collected')}>{busy ? '正在保存…' : question.state === 'draft' ? '保存到错题集' : '保存修改'}</button></div>
      </fieldset></div>
    </div>
  </section>;
}
