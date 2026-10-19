import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { TrashChange, TrashItem, TrashList } from '../shared/trash.ts';
import { ApiError, FamilyApi } from './api.ts';
import { QuestionParts } from './QuestionParts.tsx';
import { ReadingMaterialView } from './ReadingMaterialView.tsx';
import { AnswerView } from './AnswerView.tsx';
import { stageLabel } from '../shared/study.ts';
import { useLeaveGuard } from './navigation.ts';

const date = (time: number) => new Date(time).toLocaleString('zh-CN');
export function TrashManager({ api, grant, active, onAccessError }: { api: FamilyApi; grant?: string; active: boolean; onAccessError(error: ApiError): Promise<void> }) {
  const [list, setList] = useState<TrashList>();
  const [selected, setSelected] = useState<TrashItem>();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const operation = useRef<{ id: string; input: TrashChange } | undefined>(undefined);
  const dialog = useRef<HTMLDialogElement>(null);
  useLeaveGuard(busy, () => setError('正在处理，请稍候；结果不确定时可以重试同一次操作。'));
  useLayoutEffect(() => { if (confirm && active && grant) dialog.current?.showModal(); else dialog.current?.close(); }, [confirm, active, grant]);
  async function failure(reason: unknown) {
    setError(reason instanceof Error ? reason.message : '读取回收站失败，请重试');
    if (reason instanceof ApiError && [401, 403].includes(reason.status)) await onAccessError(reason);
  }
  useEffect(() => {
    if (!active || !grant) return;
    let current = true;
    void api.trash(grant).then(result => { if (current) setList(result); }).catch(reason => { if (current) void failure(reason); });
    return () => { current = false; };
  }, [api, active, grant]);
  async function refresh(cleanup = false, offset = 0) {
    if (!grant || !active || busy) return;
    setBusy(true); setError('');
    try {
      const result = cleanup ? await api.cleanupTrash(grant) : await api.trash(grant, offset);
      setList(result); setSelected(undefined); operation.current = undefined; setConfirm(false);
    } catch (reason) { await failure(reason); } finally { setBusy(false); }
  }
  async function change(action: 'restore' | 'purge') {
    if (!selected || !grant || !active || busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      operation.current ??= { id: selected.id, input: { operationId: crypto.randomUUID(), expectedRevision: selected.revision, action, ...(action === 'purge' ? { confirm: true } : {}) } };
      await api.changeTrash(grant, operation.current.id, operation.current.input);
      operation.current = undefined; setConfirm(false); setSelected(undefined);
      setNotice(action === 'restore' ? '题目已恢复，保留原收集时间和整理信息。' : '题目已永久删除；其他题目仍引用的材料会保留。');
      setList(await api.trash(grant));
    } catch (reason) {
      if (reason instanceof ApiError && [409, 410].includes(reason.status)) { operation.current = undefined; setConfirm(false); }
      await failure(reason);
    } finally { setBusy(false); }
  }
  return <section className="card trash-manager">
    <div className="section-heading"><h1>回收站</h1><button className="quiet" disabled={busy} onClick={() => void refresh()}>刷新回收站</button></div>
    <p>删除后保留 30 天，到期自动清理。家庭电脑停机时暂停检查，恢复服务后按原到期时间处理。</p>
    <p className="hint">回收站不能代替备份。永久删除无法撤销；其他设备已保留的本机副本需联网后核对。</p>
    {error && <p className="message error" role="alert">{error}</p>}
    {notice && <p className="message" role="status">{notice}</p>}
    {!!list?.cleanup.pending && <div className="message" role="status"><p>{list.cleanup.pending} 份文件等待清理。{list.cleanup.failed ? '部分清理未完成，请检查家庭电脑数据目录的访问权限后重试。' : '正在使用的识别材料会在任务结束后清理。'}</p><button disabled={busy} onClick={() => void refresh(true)}>重试清理文件</button></div>}
    {selected ? <>
      <button className="quiet" disabled={busy} onClick={() => { setSelected(undefined); operation.current = undefined; }}>返回回收站列表</button>
      <h2>已删除的题目</h2><p>删除时间：{date(selected.deletedAt)} · 到期时间：{date(selected.expiresAt)}</p>
      <p>{stageLabel(selected.question.studyStage)} · 来源：{selected.question.source || '未填写'} · 页码 / 题号：{selected.question.pageNumber || '未填写'} / {selected.question.questionNumber || '未填写'}</p>
      <p className="note-text">{selected.question.note || '未填写备注'}</p>
      <QuestionParts api={api} parts={selected.question.parts} />
      {selected.question.readingMaterial && <ReadingMaterialView api={api} material={selected.question.readingMaterial} />}
      <AnswerView api={api} parts={selected.question.answerParts} />
      <div className="material-actions"><button disabled={busy || !grant || operation.current?.input.action === 'purge'} onClick={() => void change('restore')}>恢复题目</button><button className="quiet" disabled={busy || !grant || operation.current?.input.action === 'restore'} onClick={() => setConfirm(true)}>永久删除</button></div>
    </> : !list ? <p>正在读取…</p> : list.total === 0 ? <p>回收站为空</p> : <>
      <div className="table-scroll"><table className="management-table" aria-label="回收站资料"><thead><tr><th>题目</th><th>删除时间</th><th>到期时间</th><th>操作</th></tr></thead><tbody>{list.items.map(item => <tr key={item.id}><td>{item.question.state === 'collected' ? '已收集' : '草稿'} · {item.question.pageNumber || '未填页码'} / {item.question.questionNumber || '未填题号'}</td><td>{date(item.deletedAt)}</td><td>{date(item.expiresAt)}</td><td><button className="quiet" disabled={busy} onClick={() => { setSelected(item); operation.current = undefined; setError(''); }}>查看与恢复</button></td></tr>)}</tbody></table></div>
      <p>共 {list.total} 道 · 第 {Math.floor(list.offset / list.limit) + 1} 页</p><div className="material-actions"><button className="quiet" disabled={busy || list.offset === 0} onClick={() => void refresh(false, Math.max(0, list.offset - list.limit))}>上一页</button><button className="quiet" disabled={busy || list.offset + list.limit >= list.total} onClick={() => void refresh(false, list.offset + list.limit)}>下一页</button></div>
    </>}
    <dialog ref={dialog} className="leave-dialog" aria-label="永久删除这道题" onCancel={event => { event.preventDefault(); if (!busy) setConfirm(false); }}><h2>永久删除这道题</h2><p>题目与不再被其他题目引用的材料将被清理，无法从回收站恢复。</p>{error && <p className="message error" role="alert">{error}</p>}<div className="leave-actions"><button className="quiet" autoFocus disabled={busy} onClick={() => setConfirm(false)}>保留在回收站</button><button disabled={busy || !grant || !active} onClick={() => void change('purge')}>确认永久删除</button></div></dialog>
  </section>;
}
