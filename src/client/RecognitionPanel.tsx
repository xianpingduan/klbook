import { useEffect, useRef, useState } from 'react';
import type { QuestionPart, Subject } from '../shared/collection.ts';
import { ocrProviders, type OcrCandidate, type PageRecognition, type PageRecognitions } from '../shared/ocr.ts';
import { ApiError, type FamilyApi } from './api.ts';

export function RecognitionPanel({ api, part, subjects, grant, disabled, onText, onAdopt, onAccessError }: {
  api: FamilyApi; part: QuestionPart; subjects: Subject[]; grant?: string; disabled: boolean;
  onText(text: string): void;
  onAdopt(run: PageRecognition, candidate: OcrCandidate): void;
  onAccessError(error: ApiError): Promise<void>;
}) {
  const [data, setData] = useState<PageRecognitions>();
  const [error, setError] = useState(''), [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false), [selected, setSelected] = useState('');
  const [proposal, setProposal] = useState<{ run: PageRecognition; candidate: OcrCandidate }>();
  const pending = useRef<string | null>(null), live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => {
    let current = true, timer: ReturnType<typeof setTimeout> | undefined;
    if (disabled) return;
    async function read() {
      try {
        const next = await api.pageRecognitions(part.originalPage.id, grant);
        if (!current) return;
        setData(next); setError('');
        if (next.runs.some(run => run.status === 'running')) timer = setTimeout(() => void read(), 700);
      } catch (failure) {
        if (!current) return;
        setError(failure instanceof Error ? failure.message : '识别记录暂时无法读取，可以继续手动框题');
        if (failure instanceof ApiError && [401, 403].includes(failure.status)) await onAccessError(failure);
      }
    }
    void read();
    return () => { current = false; clearTimeout(timer); };
  }, [api, part.originalPage.id, grant, disabled, refresh, onAccessError]);
  async function start() {
    if (disabled || busy) return;
    setBusy(true); setError('');
    pending.current ??= crypto.randomUUID();
    try {
      const run = await api.recognizePage(part.originalPage.id, pending.current, grant);
      if (!live.current) return;
      pending.current = null; setSelected(run.id); setProposal(undefined); setRefresh(value => value + 1);
    } catch (failure) {
      if (!live.current) return;
      if (failure instanceof ApiError && [400, 401, 403, 404, 409, 422, 503].includes(failure.status)) pending.current = null;
      setError(failure instanceof Error ? failure.message : '识别请求未确认，请重试读取');
      if (failure instanceof ApiError && [401, 403].includes(failure.status)) await onAccessError(failure);
    } finally { if (live.current) setBusy(false); }
  }
  const run = data?.runs.find(item => item.id === selected) ?? data?.runs[0];
  const running = data?.runs.some(item => item.status === 'running');
  return <section className="recognition-panel" aria-label="识别与文字更正">
    <h2>识别建议</h2>
    <p className="hint">建议不会自动保存为错题。先选一道，再检查完整题干、图形和批改；也可以直接手动框题。</p>
    {data && <p className="hint">{ocrProviders[data.service.provider].label} · {!data.service.available ? '尚未配置' : data.service.enabled ? '已启用' : '已停用'}。{!data.service.formulas && '当前服务未提供专用公式识别，复杂公式请以原图为准。'}</p>}
    {error && <p className="message error">{error} <button className="quiet" disabled={disabled || busy} onClick={() => setRefresh(value => value + 1)}>重试读取识别记录</button></p>}
    {!run && <p className="hint">{data?.initialMessage || (data ? '此页暂无识别结果，可以手动框题或主动识别。' : '正在读取识别状态…')}</p>}
    {data && data.runs.length > 1 && <label>查看识别批次<select value={run?.id ?? ''} disabled={disabled} onChange={event => { setSelected(event.target.value); setProposal(undefined); }}>{data.runs.map(item => <option key={item.id} value={item.id}>{new Date(item.createdAt).toLocaleString('zh-CN')} · {ocrProviders[item.provider].name} · {item.status === 'running' ? '识别中' : item.message}</option>)}</select></label>}
    {run && <p className="hint">{run.status === 'running' ? '正在识别，仍可手动框题和保存；结果回来后由你决定是否采用。' : run.message}{run.durationMs !== null && ` · ${run.durationMs} ms`}</p>}
    {run?.status === 'succeeded' && <>
      <div className="recognition-candidates">{run.candidates.map(candidate => <article key={candidate.id}>
        <p>{candidate.questionNumber ? `第 ${candidate.questionNumber} 题` : `文字组 ${candidate.id}`}{candidate.subjectId && ` · 建议${subjects.find(subject => subject.id === candidate.subjectId)?.name ?? '学科'}`}</p>
        <p className="recognition-excerpt">{candidate.text}</p>
        <button type="button" className="quiet" disabled={disabled || busy} onClick={() => setProposal({ run, candidate })}>选用候选题 {candidate.id}</button>
      </article>)}</div>
      {!run.candidates.length && <p className="hint">未得到可用题目范围，请手动框选；下方文字仍可核对参考。</p>}
      <details><summary>本次完整识别文字</summary><pre className="ocr-text">{run.lines.map(line => line.text).join('\n')}</pre></details>
    </>}
    {proposal && <div className="message" role="group" aria-label="确认采用识别建议"><p>这会替换当前题目区的范围和文字，并带入可用的学科、题号建议。请保留需要的手工更正后再决定。</p><button disabled={disabled || busy} onClick={() => { onAdopt(proposal.run, proposal.candidate); setProposal(undefined); }}>确认采用建议</button><button className="quiet" onClick={() => setProposal(undefined)}>保留当前内容</button></div>}
    <button type="button" className="quiet" disabled={disabled || busy || running || !data?.service.enabled || !data.service.available} onClick={() => void start()}>{pending.current ? '重试提交识别' : data?.runs.length ? '重新识别此页' : '识别此页'}</button>
    <p className="hint">主动识别会把本页图片发送给所选服务并计入用量。新结果不会自动覆盖已修改的范围和文字。</p>
    <label>题干文字（选填，可更正）<textarea rows={4} maxLength={20000} disabled={disabled} value={part.transcription ?? ''} onChange={event => onText(event.target.value)} /></label>
    <RecognitionOrigin api={api} part={part} />
  </section>;
}

export function RecognitionOrigin({ api, part }: { api: FamilyApi; part: QuestionPart }) {
  const [open, setOpen] = useState(false), [run, setRun] = useState<PageRecognition>(), [error, setError] = useState(''), [retry, setRetry] = useState(0);
  const id = part.recognition?.runId;
  useEffect(() => {
    let live = true; setRun(undefined); setError('');
    if (!open || !id) return;
    void api.pageRecognition(part.originalPage.id, id).then(value => { if (live) setRun(value); }).catch(() => { if (live) setError('原识别记录暂时无法读取，已保存文字仍保留。'); });
    return () => { live = false; };
  }, [api, part.originalPage.id, id, open, retry]);
  if (!id) return null;
  const candidate = run?.candidates.find(item => item.id === part.recognition?.candidateId);
  return <details className="recognition-origin" onToggle={event => setOpen(event.currentTarget.open)}><summary>查看采用时的识别结果</summary>
    {error && <p>{error}<button className="quiet" onClick={() => setRetry(value => value + 1)}>重试读取原识别</button></p>}
    {run ? <><p className="hint">{ocrProviders[run.provider].label} · {new Date(run.createdAt).toLocaleString('zh-CN')}。保留采用时的文字，供与当前更正内容对照。</p><pre className="ocr-text">{candidate?.text ?? run.lines.map(line => line.text).join('\n')}</pre></> : !error && open && <p>正在读取…</p>}
  </details>;
}
