import { useEffect, useId, useRef, useState } from 'react';
import { ApiError, type FamilyApi } from './api.ts';
import { aiModels, aiProvider, aiTestExample, defaultAiConfig, type AiConfig, type AiEdit, type AiSettings } from '../shared/ai.ts';
import { useEditorLeave } from './useEditorLeave.tsx';

const money = (cents: number) => `¥${(cents / 100).toFixed(3)}`;
const date = (time: number) => new Date(time).toLocaleString('zh-CN');
export function AiManager({ api, grant, active, onAccessError }: { api: FamilyApi; grant?: string; active: boolean; onAccessError(error: ApiError): Promise<void> }) {
  const promptId = useId();
  const [data, setData] = useState<AiSettings>(), [config, setConfig] = useState<AiConfig>(defaultAiConfig);
  const [apiPassword, setApiPassword] = useState(''), [prompt, setPrompt] = useState(aiTestExample);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [refresh, setRefresh] = useState(0);
  const baseline = useRef<AiSettings | undefined>(undefined), pending = useRef<AiEdit | null>(null);
  const pendingTest = useRef<{ id: string; revision: number; prompt: string } | null>(null);
  const mounted = useRef(true), protectedForm = useRef(false);
  const dirty = !!apiPassword || JSON.stringify(config) !== JSON.stringify(baseline.current?.config ?? defaultAiConfig);
  protectedForm.current = dirty || busy || !!pending.current;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (!grant || !active) { setApiPassword(''); pending.current = null; } }, [grant, active]);
  useEffect(() => {
    if (!grant || !active) return;
    let live = true, timer: number | undefined;
    setLoading(true); setError('');
    const read = async () => {
      try {
        const value = await api.aiSettings(grant);
        if (!live) return;
        setData(value);
        if (!protectedForm.current) { baseline.current = value; setConfig(value.config); }
        if (value.tests.some(run => run.id === pendingTest.current?.id)) pendingTest.current = null;
        if (value.tests.some(run => run.status === 'running')) timer = window.setTimeout(() => void read(), 1000);
      } catch (failure) {
        if (!live) return;
        if (failure instanceof ApiError && [401, 403].includes(failure.status)) await onAccessError(failure);
        else setError(failure instanceof Error ? failure.message : '读取 AI 学习配置失败');
      } finally { if (live) setLoading(false); }
    };
    void read();
    return () => { live = false; window.clearTimeout(timer); };
  }, [api, grant, active, refresh, onAccessError]);
  function discard() { pending.current = null; setApiPassword(''); if (baseline.current) setConfig(baseline.current.config); }
  const leave = useEditorLeave({ dirty, busy, canSave: active && !!grant && !loading, title: 'AI 学习配置还有未保存的修改', description: <p>保存配置不会发送测试文字。离开管理后，未保存的凭据会清空。</p>, error, save, discard });
  async function failed(failure: unknown) {
    if (!mounted.current) return;
    if (failure instanceof ApiError && [401, 403].includes(failure.status)) { leave.dismiss(); await onAccessError(failure); }
    else setError(failure instanceof Error ? failure.message : '操作失败，请重试');
  }
  async function save() {
    if (busy || loading || !grant || !active || !baseline.current) return false;
    if (!config.name.trim()) { setError('请填写服务名称。'); return false; }
    setBusy(true); setError(''); setNotice('');
    const desired = { config, ...(apiPassword ? { credentials: { apiPassword } } : {}) };
    try {
      let value: AiSettings | undefined;
      const previous = pending.current;
      if (previous) {
        value = await api.saveAi(grant, previous);
        if (!mounted.current) return false;
        pending.current = null;
        if (value.revision !== previous.expectedRevision + 1) throw new ApiError(409, '配置已被更新，请重新读取配置后核对');
        baseline.current = value;
      }
      if (!previous || JSON.stringify({ config: previous.config, credentials: previous.credentials }) !== JSON.stringify(desired)) {
        const input: AiEdit = { ...desired, operationId: crypto.randomUUID(), expectedRevision: baseline.current.revision };
        pending.current = input; value = await api.saveAi(grant, input);
        if (!mounted.current) return false;
        pending.current = null;
        if (value.revision !== input.expectedRevision + 1) throw new ApiError(409, '配置已被更新，请重新读取配置后核对');
      }
      if (!value) return false;
      baseline.current = value; setData(value); setConfig(value.config); setApiPassword('');
      setNotice('配置已保存，未发起 AI 学习调用。'); return true;
    } catch (failure) {
      if (failure instanceof ApiError && [400, 422].includes(failure.status)) pending.current = null;
      await failed(failure); return false;
    } finally { if (mounted.current) setBusy(false); }
  }
  async function test() {
    if (!grant || !active || !data || dirty || busy || loading || !prompt.trim()) return;
    setBusy(true); setError(''); setNotice('');
    pendingTest.current ??= { id: crypto.randomUUID(), revision: data.revision, prompt };
    try {
      const input = pendingTest.current;
      const run = await api.testAi(grant, input.id, input.revision, input.prompt);
      if (!mounted.current) return;
      pendingTest.current = null;
      setData(current => current && ({ ...current, tests: [run, ...current.tests.filter(value => value.id !== run.id)].slice(0, 20) }));
      setRefresh(value => value + 1); setNotice('测试已提交，可在下方查看结果。');
    } catch (failure) {
      if (failure instanceof ApiError && [400, 409, 413, 422, 503].includes(failure.status)) pendingTest.current = null;
      await failed(failure);
    } finally { if (mounted.current) setBusy(false); }
  }
  const update = <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => setConfig(current => ({ ...current, [key]: value }));
  return <section className="card ocr-manager"><p className="eyebrow">外部能力管理</p><h1>AI 学习服务</h1><p>{aiProvider.label} · 家长后台测试</p>
    <p className="hint">与图片识别、语音转写分别管理。启用不会读取历史材料，测试结果不会成为错题的标准答案。</p>
    {loading && <p role="status">正在读取配置…</p>}
    {error && !leave.leaving && <p className="message error" role="alert">{error}</p>}{leave.dialog}
    {notice && <p className="message" role="status">{notice}</p>}
    {data && <><p className="message">{!data.credentialsConfigured ? '未配置' : !data.credentialAvailable ? '本机凭据无法读取' : data.config.enabled ? '已启用' : '已停用'}</p>
      <form onSubmit={event => { event.preventDefault(); void save(); }}><fieldset disabled={busy || loading || !grant || !active || !!pendingTest.current}>
        <h2>服务配置</h2><label>服务名称<input required maxLength={80} value={config.name} onChange={event => update('name', event.target.value)} /></label>
        <label>模型<select value={config.model} onChange={event => { const model = event.target.value as AiConfig['model']; setApiPassword(''); setConfig(current => ({ ...current, model, enabled: current.enabled && data.models[model].credentialAvailable })); }}>{Object.entries(aiModels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className="ocr-check"><input type="checkbox" checked={config.enabled} onChange={event => update('enabled', event.target.checked)} />启用 AI 学习服务</label>
        <p className="hint">停用后不接受新测试和自动重试；已发出的请求继续记录真实结果。保存配置本身不会调用服务。</p>
        <h3>所选模型的凭据</h3><p>{data.models[config.model].credentialsConfigured ? '所选模型已保存凭据。留空保留，填写新凭据以替换。' : '所选模型尚未配置凭据。'}</p>
        <label>APIPassword<input type="password" autoComplete="new-password" maxLength={512} value={apiPassword} onChange={event => setApiPassword(event.target.value)} /></label>
        <p className="hint">在讯飞控制台所选模型的 HTTP 接口页面获取。各模型分别保管，不自动使用 OCR 或语音的凭据。凭据加密保存，不回填页面；离开管理或验证到期后清空未保存的凭据。</p>
        <div className="ocr-grid"><label>最大输出 token<input type="number" required min={1} max={2048} value={config.maxOutputTokens} onChange={event => update('maxOutputTokens', Number(event.target.value))} /></label>
          <label>每次请求超时（秒）<input type="number" required min={5} max={120} value={config.timeoutSeconds} onChange={event => update('timeoutSeconds', Number(event.target.value))} /></label>
          <label>最多自动重试（次）<input type="number" required min={0} max={2} value={config.retries} onChange={event => update('retries', Number(event.target.value))} /></label></div>
        <p className="hint">token 是模型的文字计量单位，不等于字数。达到输出上限可能截断回复。自动重试默认关闭，每次重试可能再次计费。</p>
        <h3>AI 学习月度限额</h3><div className="ocr-grid">
          <label>每月最多尝试（次）<input type="number" required min={0} max={10000} value={config.monthlyLimit} onChange={event => update('monthlyLimit', Number(event.target.value))} /></label>
          <label>每月估算预算（元）<input type="number" required min={0} max={5000} step="0.01" value={config.monthlyBudgetCents / 100} onChange={event => update('monthlyBudgetCents', Math.round(Number(event.target.value) * 100))} /></label>
          <label>每次估算单价（元）<input type="number" required min={0} max={100} step="0.001" value={config.priceCents / 100} onChange={event => update('priceCents', Math.round(Number(event.target.value) * 1000) / 10)} /></label></div>
        <p className="hint">按实际套餐填写每次调用的保守估算，免费额度内可填 0。这里按次数预留估算费用，不按 token 自动结算；实际费用以供应商账单为准。北京时间自然月统计，失败和重试计入次数，结果不确定仍保留估算费用。切换模型不重置本月总额度。</p>
        <button type="submit">保存配置</button>
      </fieldset></form>
      <h2>主动测试</h2><p>只向所选模型发送下面的文字，不附带错题、图片、录音或历史对话。可以修改示例，发送前请核对内容。</p>
      <label htmlFor={promptId}>本次发送的测试内容</label><textarea id={promptId} rows={5} maxLength={2000} value={prompt} disabled={busy || loading || !grant || !active || !!pendingTest.current} onChange={event => setPrompt(event.target.value)} />
      <p className="hint">家庭电脑保留测试文字、模型回复与计量。输出需人工核对；本页不修改错题或标准答案。</p>
      <p>当前模型：{aiModels[data.config.model]}，最大输出 {data.config.maxOutputTokens} token；本次最多尝试 {data.config.retries + 1} 次，可能产生费用。</p>
      <button disabled={!prompt.trim() || dirty || busy || loading || !grant || !active || (!pendingTest.current && (!data.config.enabled || !data.credentialAvailable || data.tests.some(run => run.status === 'running')))} onClick={() => void test()}>{pendingTest.current ? '重试提交同一次测试' : '发送以上文字并测试'}</button>
      {dirty && <p className="hint">请先保存配置再测试。</p>}{!data.config.enabled && <p className="hint">请先启用 AI 学习并保存配置。</p>}
      <h2>用量与调用记录</h2><p>{data.usage.month}：尝试 {data.usage.attempts} / {data.config.monthlyLimit} 次，估算费用 {money(data.usage.estimatedCents)} / {money(data.config.monthlyBudgetCents)}。</p>
      <p>已有计量的 {data.usage.reportedAttempts} 次：输入 {data.usage.promptTokens}、输出 {data.usage.completionTokens}，合计 {data.usage.totalTokens} token。其余 {data.usage.attempts - data.usage.reportedAttempts} 次未返回有效计量，不按零用量推算。</p>
      {!data.tests.length ? <p>还没有调用记录。</p> : <div className="table-scroll"><table className="management-table" aria-label="AI 学习调用记录"><thead><tr><th>时间与模型</th><th>内容与结果</th><th>回复计量</th><th>耗时</th><th>尝试</th></tr></thead><tbody>{data.tests.map(run => <tr key={run.id}><td>{date(run.createdAt)}<br />{aiModels[run.model]}</td><td>{run.status === 'running' ? '正在等待模型回复…' : run.message}<details><summary>本次测试内容</summary><pre className="ocr-text">{run.prompt}</pre></details>{run.text && <details open><summary>AI 回复（需核对）</summary><pre className="ocr-text">{run.text}</pre></details>}</td><td>{run.totalTokens === null ? '未返回有效计量' : <>输入 {run.promptTokens}<br />输出 {run.completionTokens}<br />合计 {run.totalTokens} token</>}</td><td>{run.durationMs === null ? '—' : `${run.durationMs} ms`}</td><td>{run.attempts}</td></tr>)}</tbody></table></div>}
      <details><summary>最近配置操作</summary><ul>{data.audit.map((event, index) => <li key={index}>{date(event.at)} · {event.actor} · {event.action}</li>)}</ul></details>
    </>}
    <button className="quiet" disabled={busy || loading || !grant || !active} onClick={() => leave.requestLeave(() => { discard(); protectedForm.current = false; setRefresh(value => value + 1); })}>重新读取配置</button>
    <p className="hint"><a href={aiProvider.product} target="_blank" rel="noreferrer">服务介绍与开通</a> · <a href={aiProvider.docs} target="_blank" rel="noreferrer">接口说明</a></p>
  </section>;
}
