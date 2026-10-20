import { useEffect, useState } from 'react';
import type { ImportDecisions, ImportPreview } from '../shared/imports.ts';
import { stageLabel } from '../shared/study.ts';
import type { FamilyApi } from './api.ts';
import { ImportImage } from './ImportImage.tsx';

export function ImportChoices({ batch, api, grant, disabled, onChoose, onDraft }: { batch: ImportPreview; api: FamilyApi; grant?: string; disabled: boolean; onChoose(decisions: ImportDecisions): Promise<boolean>; onDraft(value: boolean): void }) {
  const [names, setNames] = useState<Record<string, string>>({});
  const hasDraft = Object.keys(names).length > 0;
  useEffect(() => { onDraft(hasDraft); return () => onDraft(false); }, [hasDraft, onDraft]);
  const changeSubject = async (choice: ImportDecisions['subjects'][number]) => {
    if (await onChoose({ ...batch.decisions, subjects: [...batch.decisions.subjects.filter(s => s.id !== choice.id), choice] })) setNames(current => { const next = { ...current }; delete next[choice.id]; return next; });
  };
  return <>
    <h3>学科归属</h3>
    <div className="import-subjects">{batch.subjects.map(s => {
      const choice = batch.decisions.subjects.find(d => d.id === s.id), editing = names[s.id] !== undefined;
      return <div key={s.id} className="import-subject">
        <p>{s.name} → {s.action === 'blocked' ? '请确认对应或新增' : s.action === 'new' ? `新增“${s.targetName}”` : s.targetName}</p>
        {(s.action === 'blocked' || choice || editing) && <>
          <label>{s.name}的学科对应<select disabled={disabled} value={editing || choice?.newName ? 'new' : choice?.targetId ?? ''} onChange={event => {
            const value = event.target.value;
            if (value === 'new') setNames(current => ({ ...current, [s.id]: choice?.newName ?? s.name }));
            else if (value) void changeSubject({ id: s.id, targetId: value });
          }}>
            <option value="" disabled>请选择对应方式</option>
            {batch.availableSubjects.map(target => <option key={target.id} value={target.id}>对应：{target.name}</option>)}
            <option value="new">新增学科…</option>
          </select></label>
          {editing && <div className="import-new-subject"><label>{s.name}的新学科名称<input maxLength={80} disabled={disabled} value={names[s.id]} onChange={event => setNames(current => ({ ...current, [s.id]: event.target.value }))} /></label><button className="quiet" disabled={disabled || !names[s.id]!.trim()} onClick={() => void changeSubject({ id: s.id, newName: names[s.id]!.trim() })}>确认学科名称</button></div>}
        </>}
      </div>;
    })}</div>
    {(batch.conflicts > 0 || batch.trashed > 0) && <section className="import-conflicts">
      <h3>需要核对的题目</h3><p>默认保留当前内容。另存副本不会改动原题；恢复会保留回收站中已有的更正。</p>
      {batch.questions.map((q, index) => ['conflict', 'trash', 'deleted'].includes(q.status) && <article key={q.id}>
        <h4>第 {index + 1} 项 · {q.label}</h4>
        <div className="import-comparison">
          <section><h5>资料包版本</h5><p className="note-text">{q.incoming.note || '未填写备注'}</p><p>{stageLabel(q.incoming.studyStage)}</p><p className="hint">原收集日期：{q.incoming.collectedAt === null ? '未设置' : new Date(q.incoming.collectedAt).toLocaleDateString('zh-CN')}</p><ImportImage api={api} grant={grant} batchId={batch.id} material={q.incoming.material} incoming /></section>
          <section><h5>{q.status === 'trash' ? '回收站当前版本' : '本机当前版本'}</h5><p className="note-text">{q.current?.note || (q.status === 'deleted' ? '已永久删除，不能自动恢复' : '未填写备注')}</p>{q.current && <><p>{stageLabel(q.current.studyStage)}</p><ImportImage api={api} grant={grant} batchId={batch.id} material={q.current.material} incoming={false} /></>}</section>
        </div>
        <label>第 {index + 1} 项的处理<select disabled={disabled} value={q.action} onChange={event => void onChoose({ ...batch.decisions, questions: [...batch.decisions.questions.filter(d => d.id !== q.id), { id: q.id, action: event.target.value as 'keep' | 'copy' | 'restore' }] })}>
          <option value="keep">{q.status === 'trash' || q.status === 'deleted' ? '保持删除状态' : '保留当前版本'}</option>
          {q.canCopy && <option value="copy">将资料包版本另存副本</option>}
          {q.canRestore && <option value="restore">恢复回收站中的当前版本</option>}
        </select></label>
        {q.status === 'conflict' && !q.canCopy && <p className="hint">此版本已经另存过副本，保留已有副本的后续修改，不再重复创建。</p>}
        {q.status === 'trash' && !q.canRestore && <p className="hint">此记录已超过恢复期限或材料不可恢复，继续保持删除状态。</p>}
      </article>)}
    </section>}
  </>;
}
