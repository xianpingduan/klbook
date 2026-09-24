import { useEffect, useState } from 'react';
import type { Question, Subject } from '../shared/collection.ts';
import type { Source } from '../shared/sources.ts';
import type { ReadingMaterial } from '../shared/reading-materials.ts';
import { stageLabel } from '../shared/study.ts';
import type { FamilyApi } from './api.ts';
import { QuestionParts } from './QuestionParts.tsx';
import { questionFields, type QuestionFields } from './question-edit.ts';

export function ConflictQuestionView({ api, question, fields = questionFields(question), subjects, sources }: {
  api: FamilyApi; question: Question; fields?: QuestionFields; subjects: Subject[]; sources: Source[];
}) {
  return <>
    <p className="hint">{question.state === 'collected' ? '已收集' : '草稿'} · 版本 {question.revision}</p>
    <dl><div><dt>学科</dt><dd>{subjects.find(item => item.id === fields.subjectId)?.name ?? '未设置'}</dd></div>
      <div><dt>学习阶段</dt><dd>{stageLabel(fields.studyStage)}</dd></div>
      <div><dt>来源</dt><dd>{(sources.find(item => item.id === fields.sourceId)?.name ?? (fields.sourceId === question.sourceId ? question.source : '')) || '未设置'}</dd></div>
      <div><dt>页码 / 题号</dt><dd>{fields.pageNumber || '未填写'} / {fields.questionNumber || '未填写'}</dd></div>
      <div><dt>备注</dt><dd className="note-text">{fields.note || '未填写'}</dd></div>
    </dl>
    <details><summary>题目材料（{fields.parts.length} 个题目区）</summary><QuestionParts api={api} parts={fields.parts} /><details><summary>查看完整原始页</summary><QuestionParts api={api} parts={fields.parts} original /></details></details>
    <ConflictReadingReference api={api} id={fields.readingMaterialId} material={question.readingMaterial} />
    <details><summary>纸质答案（{question.answerParts.length} 个解答区）</summary><QuestionParts api={api} parts={question.answerParts} kind="answer" /></details>
  </>;
}

function ConflictReadingReference({ api, id, material }: { api: FamilyApi; id: string | null; material: ReadingMaterial | null }) {
  const [loaded, setLoaded] = useState<ReadingMaterial>();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const current = material?.id === id ? material : loaded?.id === id ? loaded : undefined;
  useEffect(() => {
    if (!id || material?.id === id) return;
    let live = true; setLoaded(undefined); setFailed(false);
    void api.readingMaterial(id).then(value => { if (live) setLoaded(value); }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [api, id, material?.id, attempt]);
  if (!id) return <p>阅读材料：未关联</p>;
  return <details><summary>阅读材料：{current?.title ?? (failed ? '暂时无法读取' : '正在读取…')}</summary>
    {current && <QuestionParts api={api} parts={current.parts} kind="reading" />}
    {failed && <button className="quiet" onClick={() => setAttempt(value => value + 1)}>重试读取关联原文</button>}
  </details>;
}
