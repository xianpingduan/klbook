import type { QuestionPart } from '../shared/collection.ts';
import type { FamilyApi } from './api.ts';
import { QuestionParts } from './QuestionParts.tsx';

export function AnswerView({ api, parts }: { api: FamilyApi; parts: QuestionPart[] }) {
  if (!parts.length) return null;
  return <details className="answer-view"><summary>查看纸质答案（{parts.length} 个解答区）</summary><p className="hint">保留纸上已有的作答、批改和图形；图片中的答案未经过自动判定。</p><QuestionParts api={api} parts={parts} kind="answer" /></details>;
}
