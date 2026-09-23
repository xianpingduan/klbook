import { useEffect, useState } from 'react';
import type { AnswerPageList, OriginalPage } from '../shared/collection.ts';
import { ApiError, FamilyApi } from './api.ts';
import { QuestionImage } from './QuestionImage.tsx';

export function AnswerPagePicker({ api, grant, active, disabled, onChoose, onAccessError }: {
  api: FamilyApi; grant?: string; active: boolean; disabled: boolean; onChoose(page: OriginalPage): void; onAccessError(error: ApiError): Promise<void>;
}) {
  const [list, setList] = useState<AnswerPageList>({ items: [], total: 0, offset: 0, limit: 50 });
  const [offset, setOffset] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!active) return;
    let live = true;
    setBusy(true); setError('');
    void api.answerPages(offset, grant).then(result => {
      if (live) setList(previous => ({ ...result, items: offset ? [...previous.items, ...result.items.filter(item => !previous.items.some(known => known.id === item.id))] : result.items }));
    }).catch(async failure => {
      if (!live) return;
      if (failure instanceof ApiError && [401, 403].includes(failure.status)) await onAccessError(failure);
      else setError('答案页暂时无法读取，原材料仍保留。');
    }).finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [api, grant, active, offset, attempt, onAccessError]);
  return <section aria-label="已有答案页">
    <p className="hint">选择其他小题正在使用的答案页，再框住本题的解答；不会改变其他题的范围。</p>
    {busy && <p role="status">正在读取答案页…</p>}
    {error && <p role="alert" className="message error">{error}<button className="quiet" disabled={disabled || !active} onClick={() => setAttempt(value => value + 1)}>重试答案页列表</button></p>}
    {!busy && !error && !list.total && <p>还没有已关联的答案页，可以先选择本题原始页或上传答案图片。</p>}
    <div className="answer-page-list">{list.items.map((page, index) => <div key={page.id}><QuestionImage api={api} page={page} /><button className="quiet" disabled={disabled || !active || busy} onClick={() => onChoose(page)}>使用答案页 {index + 1}</button></div>)}</div>
    {list.items.length < list.total && <button className="quiet" disabled={disabled || !active || busy} onClick={() => setOffset(list.items.length)}>加载更多答案页</button>}
  </section>;
}
