import { useEffect } from 'react';
import type { Question, Subject } from '../shared/collection.ts';
import type { ReadingMaterial } from '../shared/reading-materials.ts';
import type { Source } from '../shared/sources.ts';
import type { ApiError, FamilyApi } from './api.ts';
import { ConflictQuestionView } from './ConflictQuestionView.tsx';
import { SaveConflict } from './SaveConflict.tsx';
import { useSaveConflict } from './useSaveConflict.ts';
import { useEditorLeave } from './useEditorLeave.tsx';

export function ReadingLinkConflict({ api, question, material, subjects, sources, grant, active, onResolve, onBack, onAccessError }: {
  api: FamilyApi; question: Question; material: ReadingMaterial; subjects: Subject[]; sources: Source[]; grant?: string; active: boolean;
  onResolve(current: Question, keep: boolean): void; onBack(): void; onAccessError(error: ApiError): Promise<void>;
}) {
  const conflict = useSaveConflict({ read: () => api.question(question.id, grant), onAccessError });
  useEffect(() => { void conflict.show(); }, []);
  const leave = useEditorLeave({ dirty: true, busy: conflict.loading, canSave: false, title: '阅读材料关联尚未处理', error: '',
    description: <p>原文已保存在家庭资料库。放弃本次修改并离开会保留题目当前关联；之后仍可从阅读材料列表选择这篇原文。</p>, save: async () => false, discard: () => {} });
  const resolve = (keep: boolean) => { if (active && !conflict.loading && conflict.current) onResolve(conflict.current, keep); };
  return <section className="card collection-card"><h1>核对阅读材料关联</h1>
    <p>原文已保存，关联题目时发生冲突。</p>
    <p className="hint">保留本次编辑会把“{material.title}”填入题目编辑页，其余信息采用当前版本；确认后再保存，不会重复新建原文。</p>
    {leave.dialog}
    <SaveConflict current={conflict.current && <ConflictQuestionView api={api} question={conflict.current} subjects={subjects} sources={sources} />}
      local={<ConflictQuestionView api={api} question={{ ...question, readingMaterial: material }} subjects={subjects} sources={sources} />}
      loading={conflict.loading} error={conflict.error} disabled={!active} onRefresh={() => void conflict.refresh()} onKeep={() => resolve(true)} onAdopt={() => resolve(false)} />
    <button className="quiet" disabled={conflict.loading} onClick={() => leave.requestLeave(onBack)}>返回题目</button>
  </section>;
}
