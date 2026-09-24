import { useRef, useState } from 'react';
import type { ReadingMaterial } from '../shared/reading-materials.ts';
import { validQuestionRegion } from '../shared/collection.ts';
import { ApiError, FamilyApi } from './api.ts';
import type { CaptureCache } from './capture-cache.ts';
import { usePageAppend } from './usePageAppend.ts';
import { useEditorLeave } from './useEditorLeave.tsx';
import { QuestionParts, QuestionPartsEditor } from './QuestionParts.tsx';
import { CaptureInput } from './CaptureInput.tsx';
import { useRevisionedSave } from './useRevisionedSave.ts';
import { useSaveConflict } from './useSaveConflict.ts';
import { SaveConflict } from './SaveConflict.tsx';

const editable = (material: ReadingMaterial) => ({ title: material.title, parts: material.parts });
const content = (fields: ReturnType<typeof editable>) => ({ title: fields.title.trim(), parts: fields.parts.map(part => ({ id: part.id, pageId: part.originalPage.id, region: part.region })) });

export function ReadingMaterialEditor({ api, material, cache, grant, active, onBack, onSaved, onAccessError }: {
  api: FamilyApi; material: ReadingMaterial; cache: CaptureCache; grant?: string; active: boolean; onBack(): void; onSaved(material: ReadingMaterial): Promise<void>; onAccessError(error: ApiError): Promise<void>;
}) {
  const [fields, setFields] = useState(() => editable(material));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [original, setOriginal] = useState(false);
  const [selected, setSelected] = useState(material.parts[0]!.id);
  const saver = useRevisionedSave({ initial: material, contentOf: value => content(editable(value)),
    persist: input => api.saveReadingMaterial(material.id, input, grant), conflictMessage: '阅读材料已在其他页面更新，请核对双方内容', conflictTarget: { entity: 'readingMaterial', id: material.id } });
  const conflict = useSaveConflict({ read: () => api.readingMaterial(material.id, grant), onAccessError });
  const baseline = useRef(JSON.stringify(fields));
  const append = usePageAppend({ api, cache, grant, onAccessError, onAppend: (page, id) => {
    setFields(value => ({ ...value, parts: value.parts.some(part => part.id === id) ? value.parts : [...value.parts, { id, originalPage: page, region: null }] })); setSelected(id);
  } });
  const working = busy || append.busy || append.loading || conflict.loading;
  const leave = useEditorLeave({ dirty: JSON.stringify(fields) !== baseline.current, busy: working, canSave: active, title: '阅读材料还有未保存的修改', error,
    description: <p>保存后返回题目；放弃只丢弃本次范围和名称修改，已保存的材料及其他小题保持原样。</p>, save,
    discard: () => { const saved = editable(saver.discard()); setFields(saved); baseline.current = JSON.stringify(saved); } });
  async function save() {
    if (working || !active) return false;
    if (conflict.open) { setError('请先在冲突核对区选择处理方式，再保存。'); leave.dismiss(); return false; }
    setBusy(true); setError('');
    try {
      const saved = await saver.save(content(fields));
      await append.committed(saved);
      await onSaved(saved);
      baseline.current = JSON.stringify(fields);
      return true;
    } catch (failure) {
      if (failure instanceof ApiError && [401, 403].includes(failure.status)) { leave.dismiss(); await onAccessError(failure); }
      else setError(`${failure instanceof Error ? failure.message : '保存失败'}。当前原文和输入仍保留，请重试。`);
      if (failure instanceof ApiError && failure.status === 409 && failure.conflict?.entity !== 'question') { leave.dismiss(); await conflict.show(); }
      return false;
    } finally { setBusy(false); }
  }
  function resolveConflict(keep: boolean) {
    const latest = conflict.current;
    if (!latest || working || !active) return;
    saver.adopt(latest); baseline.current = JSON.stringify(editable(latest));
    if (!keep) { setFields(editable(latest)); setSelected(latest.parts[0]!.id); }
    conflict.clear(); setError('');
  }
  const compare = (value: ReturnType<typeof editable>) => <><p>{value.title || '未命名阅读材料'}</p><QuestionParts api={api} parts={value.parts} kind="reading" /><details><summary>查看完整原始页</summary><QuestionParts api={api} parts={value.parts} original /></details></>;
  return <section className="card collection-card reading-editor">
    <div className="section-heading"><div><p className="eyebrow">共享阅读材料</p><h1>{material.revision ? '编辑阅读原文' : '框选阅读原文'}</h1></div><button className="quiet" disabled={working} onClick={() => leave.requestLeave(onBack)}>返回题目</button></div>
    <p className="hint">原文不会单独计为错题。{material.referenceCount > 0 ? `已有 ${material.referenceCount} 道小题引用；更正原文会同时更新这些小题看到的内容。` : '保存后关联当前小题，其他小题可选择同一篇材料。'}</p>
    {error && !leave.leaving && <p className="message error" role="alert">{error}</p>}{leave.dialog}
    {conflict.open && <SaveConflict current={conflict.current && compare(editable(conflict.current))} local={compare(fields)}
      loading={conflict.loading} error={conflict.error} disabled={working || !active} onRefresh={() => void conflict.refresh()} onKeep={() => resolveConflict(true)} onAdopt={() => resolveConflict(false)} />}
    <fieldset disabled={working || !active}>
      <label>阅读材料名称<input maxLength={120} value={fields.title} onChange={event => setFields(value => ({ ...value, title: event.target.value }))} placeholder="例如：春天的故事" /></label>
      <QuestionPartsEditor api={api} parts={fields.parts} selectedId={selected} onSelect={setSelected} onChange={parts => setFields(value => ({ ...value, parts }))} disabled={working || !active} kind="reading" />
      <div className="page-addition">
        {append.error && <p className="message error" role="alert">{append.error}</p>}
        {append.capture ? <><p className="hint">{append.capture.name} · {append.appended ? '保存原文后完成关联。' : '本机保留的追加材料，可继续。'}</p>{!append.appended && <><button className="quiet" onClick={append.retry}>继续追加 {append.capture.name}</button><button className="quiet" onClick={append.cancel}>取消追加</button></>}</> : <CaptureInput label="追加原文图片" multiple={false} busy={working || !active || material.revision === 0 || fields.parts.length >= 50} onChoose={append.choose} onCancel={() => {}} />}
        <p className="hint">{material.revision ? '一次追加一页，保存后可继续追加。最多 50 个原文区。' : '先保存原文，再追加跨页图片；本题其他原始页已列出，可移除不需要的区域。'}</p>
      </div>
      <div className="save-actions"><button disabled={!fields.title.trim() || !fields.parts.every(part => validQuestionRegion(part.region))} onClick={() => void save()}>{busy ? '正在保存…' : '保存并返回题目'}</button><button className="quiet" onClick={() => setOriginal(value => !value)}>{original ? '收起原文原始页' : '查看原文原始页'}</button></div>
    </fieldset>
    {original && <QuestionParts api={api} parts={fields.parts} original kind="reading" />}
  </section>;
}
