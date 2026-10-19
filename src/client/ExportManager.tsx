import { useEffect, useRef, useState } from 'react';
import type { ExportJob, ExportPreview } from '../shared/learning-package.ts';
import { stageLabel } from '../shared/study.ts';
import type { PendingLocalWork } from './pending-local-work.ts';
import { ApiError, FamilyApi } from './api.ts';

const date = (value: number | null) => value === null ? '未设置' : new Date(value).toLocaleString('zh-CN');
const size = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
export function ExportManager({ api, grant, active, onAccessError }: { api: FamilyApi; grant?: string; active: boolean; onAccessError(error: ApiError): Promise<void> }) {
  const [preview, setPreview] = useState<ExportPreview>();
  const [pending, setPending] = useState<PendingLocalWork>();
  const [job, setJob] = useState<ExportJob>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [refresh, setRefresh] = useState(0);
  const operation = useRef<{ id: string; token: string }>(undefined);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const authorized = useRef(false);
  authorized.current = active && !!grant;
  async function failure(reason: unknown) {
    if (!mounted.current) return;
    setError(reason instanceof Error ? reason.message : '导出失败，请重试');
    if (reason instanceof ApiError && [401, 403].includes(reason.status)) await onAccessError(reason);
  }
  useEffect(() => {
    if (!active || !grant) return;
    let current = true;
    setPreview(undefined); setPending(undefined); setError('');
    void Promise.all([api.exportPreview(grant), api.pendingWork()]).then(([range, local]) => {
      if (current) { setPreview(range); setPending(local); }
    }).catch(reason => { if (current) void failure(reason); });
    return () => { current = false; };
  }, [api, active, grant, refresh]);
  useEffect(() => {
    if (!active || !grant || !job || job.status !== 'preparing') return;
    let current = true;
    const timer = window.setTimeout(() => {
      void api.exportStatus(grant, job.id).then(next => { if (current) setJob(next); }).catch(reason => { if (current) void failure(reason); });
    }, 750);
    return () => { current = false; window.clearTimeout(timer); };
  }, [api, active, grant, job, refresh]);
  async function generate() {
    if (!grant || !preview || busy) return;
    setBusy(true); setError(''); setNotice('');
    if (!operation.current) operation.current = { id: crypto.randomUUID(), token: preview.token };
    try {
      const next = await api.startExport(grant, operation.current.id, operation.current.token);
      if (mounted.current) { setJob(next); operation.current = undefined; }
    } catch (reason) {
      if (reason instanceof ApiError && [409, 422].includes(reason.status)) operation.current = undefined;
      await failure(reason);
    } finally { if (mounted.current) setBusy(false); }
  }
  async function download() {
    if (!grant || !job || busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const blob = await api.exportFile(grant, job.id);
      if (!mounted.current || !authorized.current) return;
      const url = URL.createObjectURL(blob), anchor = document.createElement('a');
      anchor.href = url; anchor.download = job.filename; document.body.append(anchor); anchor.click(); anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60000);
      setNotice('已交给浏览器下载，请在下载记录或“文件”中确认保存。');
    } catch (reason) { await failure(reason); }
    finally { if (mounted.current) setBusy(false); }
  }
  const working = job?.status === 'preparing';
  return <section className="card export-manager">
    <div className="section-heading"><h1>导出学习资料</h1><button className="quiet" disabled={busy} onClick={() => setRefresh(value => value + 1)}>刷新导出范围</button></div>
    <p>把已整理的学习资料保存为独立 ZIP 文件，方便保留副本或迁移。</p>
    {error && <p className="message error" role="alert">{error}</p>}
    {notice && <p className="message" role="status">{notice}</p>}
    {!preview ? <p>正在核对家庭资料库…</p> : <>
      <h2>本次导出范围</h2>
      <dl className="export-summary">
        <div><dt>学习者</dt><dd>{preview.learnerName}</dd></div>
        <div><dt>已同步、未删除的已收集题目</dt><dd>{preview.questionCount} 道</dd></div>
        <div><dt>原图与阅读材料</dt><dd>{preview.pageCount} 张原图 · {preview.readingCount} 份共享阅读材料 · 原图约 {size(preview.originalBytes)}</dd></div>
        <div><dt>学科</dt><dd>{preview.subjects.map(s => s.name).join('、') || '暂无'}</dd></div>
        <div><dt>学习阶段</dt><dd>{preview.stages.map(stageLabel).join('；') || '暂无'}</dd></div>
        <div><dt>收集日期</dt><dd>{preview.questionCount ? `${date(preview.collectedFrom)} 至 ${date(preview.collectedTo)}` : '暂无'}</dd></div>
      </dl>
      <p className="hint">包含原图、题目与答案范围、图片顺序、共享阅读材料、识别及更正文字、来源、备注和原收集日期。</p>
      <div className="message" role="status"><strong>本机未同步内容</strong><p>{pending ? `${pending.images} 张待上传图片，${pending.questions} 道题有待处理的本机整理内容。` : '暂时无法核对，请刷新后再试。'}这些尚未同步的内容不在资料包中；请回到收集页处理后再刷新范围。</p></div>
      <p>不包含草稿、回收站和其他设备尚未上传的内容，也不包含账号密码、设备会话及服务配置。这份学习资料包不能代替完整资料库备份。</p>
      <button disabled={busy || working || !grant || !pending || preview.questionCount === 0} onClick={() => void generate()}>{operation.current ? '重试本次生成' : '确认范围并生成资料包'}</button>
      {preview.questionCount === 0 && <p>还没有可导出的已收集题目。</p>}
    </>}
    {job && <section className="export-result" aria-label="本次资料包"><h2>本次资料包</h2><p>快照：{date(job.snapshotAt)} · {job.questionCount} 道题</p><p role="status">{job.message}</p>
      {job.status === 'ready' && <><p>{size(job.byteLength ?? 0)} · 临时下载保留至 {date(job.expiresAt)}，服务重启后需要重新生成。生成之后的修改不会进入这份快照。</p><button disabled={busy || !grant} onClick={() => void download()}>下载 ZIP 资料包</button></>}
      {working && <p className="hint">生成期间可以继续整理；暂时离开本页后，回到这里继续查看结果。</p>}
    </section>}
  </section>;
}
