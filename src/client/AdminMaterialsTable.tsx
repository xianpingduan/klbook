import type { Question, QuestionList, Subject } from '../shared/collection.ts';
import type { FamilyApi } from './api.ts';
import { QuestionImage } from './QuestionImage.tsx';
import { stageLabel } from '../shared/study.ts';

export function AdminMaterialsTable({ api, list, state, subjects, busy, onOpen }: {
  api: FamilyApi; list: QuestionList; state: 'draft' | 'collected'; subjects: Subject[]; busy: boolean; onOpen(question: Question): void;
}) {
  return <>
    <p className="table-count">已显示 {list.items.length} / {list.total} 道</p>
    <div className="table-scroll" role="region" aria-label="资料表格，可横向滚动" tabIndex={0}>
      <table className="management-table" aria-label={state === 'draft' ? '草稿资料' : '已收集资料'}>
        <thead><tr><th scope="col">题目</th><th scope="col">学科</th><th scope="col">来源</th><th scope="col">页码 / 题号</th><th scope="col">状态</th><th scope="col">{state === 'draft' ? '暂存时间' : '收集时间'}</th><th scope="col">操作</th></tr></thead>
        <tbody>{list.items.map(question => <tr key={question.id}>
          <td><div className="table-thumbnail"><QuestionImage api={api} page={question.originalPage} region={question.region} /></div></td>
          <td>{subjects.find(subject => subject.id === question.subjectId)?.name ?? '待选学科'}<p className="hint">{stageLabel(question.studyStage)}</p></td>
          <td className="table-source">{question.source || '未填写'}</td><td>{question.pageNumber || '—'} / {question.questionNumber || '—'}</td>
          <td><span className={`state-pill ${state}`}>{state === 'draft' ? '草稿' : '已收集'}</span></td>
          <td><time dateTime={new Date(question.collectedAt ?? question.createdAt).toISOString()}>{new Date(question.collectedAt ?? question.createdAt).toLocaleString('zh-CN')}</time></td>
          <td><button className="quiet" disabled={busy} onClick={() => onOpen(question)}>打开</button></td>
        </tr>)}</tbody>
      </table>
    </div>
  </>;
}
