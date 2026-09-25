import { useEffect, useRef, useState } from 'react';
import { ApiError, type FamilyApi } from './api.ts';
import { defaultOcrConfig, type OcrConfig, type OcrEdit, type OcrSettings } from '../shared/ocr.ts';
import { useEditorLeave } from './useEditorLeave.tsx';

const money = (cents: number) => `¥${(cents / 100).toFixed(2)}`;
const date = (value: number) => new Date(value).toLocaleString('zh-CN');
export function OcrManager({ api, grant, active, onAccessError }: { api: FamilyApi; grant?: string; active: boolean; onAccessError(error: ApiError): Promise<void> }) {
  const [data, setData] = useState<OcrSettings>();
  const [config, setConfig] = useState<OcrConfig>(defaultOcrConfig);
  const [apiKey, setApiKey] = useState(''), [secretKey, setSecretKey] = useState('');
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0), [sample, setSample] = useState('');
  const baseline = useRef<OcrSettings | undefined>(undefined);
  const pending = useRef<OcrEdit | null>(null);
  const pendingTest = useRef<{ id: string; revision: number } | null>(null);
  const mounted = useRef(true), protectedForm = useRef(false);
  const dirty = !!apiKey || !!secretKey || JSON.stringify(config) !== JSON.stringify(baseline.current?.config ?? defaultOcrConfig);
  protectedForm.current = dirty || busy || !!pending.current;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!grant || !active) {
      setApiKey(''); setSecretKey(''); pending.current = null;
      setNotice('离开管理或验证到期后，未保存的凭据会清空；其他设置仍保留。');
    }
  }, [grant, active]);
  useEffect(() => {
    if (!active || !grant) return;
    let live = true, timer: number | undefined;
    setLoading(true); setError('');
    const read = async () => {
      try {
        const value = await api.ocrSettings(grant);
        if (!live) return;
        setData(value);
        if (!protectedForm.current) { baseline.current = value; setConfig(value.config); }
        if (pendingTest.current && value.tests.some(test => test.id === pendingTest.current!.id)) pendingTest.current = null;
        if (value.tests.some(test => test.status === 'running')) timer = window.setTimeout(() => void read(), 1000);
      } catch (failure) {
        if (!live) return;
        if (failure instanceof ApiError && [401, 403].includes(failure.status)) await onAccessError(failure);
        else setError(failure instanceof Error ? failure.message : '读取识别配置失败');
      } finally { if (live) setLoading(false); }
    };
    void read();
    return () => { live = false; window.clearTimeout(timer); };
  }, [api, grant, active, refresh, onAccessError]);
  useEffect(() => {
    if (!active || !grant) return;
    let live = true, url = ''; setSample('');
    void api.ocrSample(grant).then(blob => { if (live) { url = URL.createObjectURL(blob); setSample(url); } }).catch(() => { /* Test stays disabled unless the exact sample is visible. */ });
    return () => { live = false; if (url) URL.revokeObjectURL(url); };
  }, [api, grant, active, refresh]);
  function discard() { pending.current = null; setApiKey(''); setSecretKey(''); if (baseline.current) setConfig(baseline.current.config); }
  const leave = useEditorLeave({ dirty, busy, canSave: active && !!grant && !loading, title: '图片识别配置还有未保存的修改', description: <p>凭据只在本次管理期间保留，保存配置不会发送图片。</p>, error, save, discard });
  async function failed(failure: unknown) {
    if (!mounted.current) return;
    if (failure instanceof ApiError && [401, 403].includes(failure.status)) { leave.dismiss(); await onAccessError(failure); }
    else setError(failure instanceof Error ? failure.message : '操作失败，请重试');
  }
  async function save() {
    if (busy || loading || !active || !grant || !baseline.current) return false;
    if (!config.name.trim() || (!!apiKey !== !!secretKey)) { setError('请填写服务名称；更换凭据时需同时填写 API Key 和 Secret Key。'); return false; }
    setBusy(true); setError(''); setNotice('');
    const desired = { config, ...(apiKey && secretKey ? { credentials: { apiKey, secretKey } } : {}) };
    try {
      // Resolve an uncertain save with the original ID before attempting newer edits.
      let value: OcrSettings | undefined;
      const previous = pending.current;
      if (previous) {
        value = await api.saveOcr(grant, previous);
        if (!mounted.current) return false;
        pending.current = null;
        if (value.revision !== previous.expectedRevision + 1) throw new ApiError(409, '配置已被更新，请重新读取配置后核对');
        baseline.current = value;
      }
      if (!previous || JSON.stringify({ config: previous.config, credentials: previous.credentials }) !== JSON.stringify(desired)) {
        const input: OcrEdit = { ...desired, operationId: crypto.randomUUID(), expectedRevision: baseline.current.revision };
        pending.current = input; value = await api.saveOcr(grant, input);
        if (!mounted.current) return false;
        pending.current = null;
        if (value.revision !== input.expectedRevision + 1) throw new ApiError(409, '配置已被更新，请重新读取配置后核对');
      }
      if (!value) return false;
      baseline.current = value; setData(value); setConfig(value.config); setApiKey(''); setSecretKey('');
      setNotice('配置已保存，未发起识别调用。'); return true;
    } catch (failure) {
      if (failure instanceof ApiError && [400, 422].includes(failure.status)) pending.current = null;
      await failed(failure); return false;
    } finally { if (mounted.current) setBusy(false); }
  }
  async function test() {
    if (!grant || !data || dirty || busy || !sample) return;
    setBusy(true); setError(''); setNotice('');
    pendingTest.current ??= { id: crypto.randomUUID(), revision: data.revision };
    try {
      await api.testOcr(grant, pendingTest.current.id, pendingTest.current.revision);
      if (!mounted.current) return;
      pendingTest.current = null; setRefresh(value => value + 1); setNotice('测试已提交，可在下方查看结果。');
    } catch (failure) {
      if (failure instanceof ApiError && [400, 409, 422, 503].includes(failure.status)) pendingTest.current = null;
      await failed(failure);
    } finally { if (mounted.current) setBusy(false); }
  }
  const update = <K extends keyof OcrConfig>(key: K, value: OcrConfig[K]) => setConfig(current => ({ ...current, [key]: value }));
  const latest = data?.tests[0];
  const state = !data?.credentialsConfigured ? '未配置' : !data.credentialAvailable ? '本机凭据无法读取' : !data.config.enabled ? '已停用' : latest?.revision !== data.revision ? '已启用，当前配置尚未测试' : latest.status === 'succeeded' ? '已启用，测试成功' : latest.status === 'running' ? '已启用，测试中' : '已启用，请检查测试结果';
  return <section className="card ocr-manager"><p className="eyebrow">外部能力管理</p><h1>图片识别服务</h1>
    <p>百度智能云 · 试卷分析与识别 · 中国大陆服务 · doc_analysis v1</p>
    <p className="hint">当前用于配置和测试，学习端暂继续手动收集。识别文字和公式需要人工核对。</p>
    {loading && <p role="status">正在读取配置…</p>}
    {data && <p className="message">{state}</p>}
    {error && !leave.leaving && <p className="message error" role="alert">{error}</p>}{leave.dialog}
    {notice && <p className="message" role="status">{notice}</p>}
    {data && <><form onSubmit={event => { event.preventDefault(); void save(); }}><fieldset disabled={busy || loading || !grant || !active}>
      <h2>服务配置</h2><label>服务名称<input value={config.name} maxLength={80} required onChange={event => update('name', event.target.value)} /></label>
      <label className="ocr-check"><input type="checkbox" checked={config.enabled} onChange={event => update('enabled', event.target.checked)} />启用图片识别服务</label>
      <p className="hint">停用不删除在途结果，重新启用不自动处理历史材料。停用时仍可由家长主动测试。</p>
      <h3>凭据</h3><p>{data.credentialsConfigured ? '凭据已保存。留空保留现有凭据，填写两项以替换。' : '尚未配置凭据。请在百度智能云控制台开通文字识别并获取应用凭据。'}</p>
      <div className="ocr-grid"><label>API Key<input type="password" autoComplete="off" maxLength={256} value={apiKey} onChange={event => setApiKey(event.target.value)} /></label><label>Secret Key<input type="password" autoComplete="new-password" maxLength={256} value={secretKey} onChange={event => setSecretKey(event.target.value)} /></label></div>
      <p className="hint">凭据在家庭电脑加密保存，不回填到页面；管理验证到期会清空未保存的凭据。</p>
      <div className="ocr-grid"><label>识别语言<select value={config.language} onChange={event => update('language', event.target.value as OcrConfig['language'])}><option value="CHN_ENG">中文与英文</option><option value="ENG">英文</option></select></label>
        <label>每次请求超时（秒）<input type="number" min={5} max={30} step={1} required value={config.timeoutSeconds} onChange={event => update('timeoutSeconds', Number(event.target.value))} /></label>
        <label>最多自动重试（次）<input type="number" min={0} max={2} step={1} required value={config.retries} onChange={event => update('retries', Number(event.target.value))} /></label></div>
      <label className="ocr-check"><input type="checkbox" checked={config.handwriting} onChange={event => update('handwriting', event.target.checked)} />识别印刷与手写混排</label>
      <label className="ocr-check"><input type="checkbox" checked={config.formulas} onChange={event => update('formulas', event.target.checked)} />识别公式（LaTeX）</label>
      <h3>图片识别月度限额</h3><div className="ocr-grid">
        <label>每月最多尝试（次）<input type="number" min={0} max={10000} step={1} required value={config.monthlyLimit} onChange={event => update('monthlyLimit', Number(event.target.value))} /></label>
        <label>每月估算预算（元）<input type="number" min={0} max={5000} step="0.01" required value={config.monthlyBudgetCents / 100} onChange={event => update('monthlyBudgetCents', Math.round(Number(event.target.value) * 100))} /></label>
        <label>每次估算单价（元）<input type="number" min="0.01" max={100} step="0.01" required value={config.priceCents / 100} onChange={event => update('priceCents', Math.round(Number(event.target.value) * 100))} /></label></div>
      <p className="hint">当前预算 {money(config.monthlyBudgetCents)}，单价 {money(config.priceCents)}。参考按次价为 0.16 元，请按你的实际套餐调整；免费额度和折扣未自动抵扣。测试、失败和重试计入尝试次数；成功或结果不确定的请求保守预留费用。以北京时间自然月统计。</p>
      <button type="submit">保存配置</button>
    </fieldset></form>
    <h2>主动测试</h2><p>点击测试后，仅将下方合成样例发送到百度智能云，不读取孩子的材料。测试可能收费，最多尝试 {data.config.retries + 1} 次。</p>
    {sample ? <img className="ocr-sample" src={sample} alt="将发送的合成测试材料" /> : <p>测试材料尚未加载，请重新读取配置。</p>}
    <button disabled={!sample || dirty || busy || loading || !grant || !active || !data.credentialAvailable || data.tests.some(test => test.status === 'running')} onClick={() => void test()}>{pendingTest.current ? '重试提交测试请求' : '发送样例并测试'}</button>
    {dirty && <p className="hint">请先保存配置再测试。</p>}
    <h2>用量与测试记录</h2><p>{data.usage.month}：尝试 {data.usage.attempts} 次 / {data.config.monthlyLimit} 次，估算费用 {money(data.usage.estimatedCents)} / {money(data.config.monthlyBudgetCents)}。这不是供应商账单。</p>
    {data.tests.length === 0 ? <p>还没有测试记录。</p> : <div className="table-scroll"><table className="management-table" aria-label="图片识别测试记录"><thead><tr><th>时间</th><th>结果</th><th>耗时</th><th>尝试次数</th></tr></thead><tbody>{data.tests.map(test => <tr key={test.id}><td>{date(test.createdAt)}</td><td>{test.status === 'running' ? '正在测试…' : test.message}</td><td>{test.durationMs === null ? '—' : `${test.durationMs} ms`}</td><td>{test.attempts}</td></tr>)}</tbody></table></div>}
    {latest?.lines.length ? <details open><summary>最近一次识别文字（需人工核对）</summary><pre className="ocr-text">{latest.lines.map(line => line.text).join('\n')}</pre></details> : null}
    <details><summary>最近配置操作</summary><ul>{data.audit.map((event, index) => <li key={index}>{date(event.at)} · {event.actor} · {event.action}</li>)}</ul></details>
    </>}
    <button className="quiet" disabled={busy || loading || !grant || !active} onClick={() => leave.requestLeave(() => { discard(); protectedForm.current = false; setRefresh(value => value + 1); })}>重新读取配置</button>
    <p className="hint"><a href="https://cloud.baidu.com/product/OCR/doc-analysis.html" target="_blank" rel="noreferrer">服务介绍与开通</a> · <a href="https://ai.baidu.com/ai-doc/OCR/jk9m7mj1l" target="_blank" rel="noreferrer">接口说明</a> · <a href="https://cloud.baidu.com/product-price/ocr.html" target="_blank" rel="noreferrer">供应商计费说明</a></p>
  </section>;
}
