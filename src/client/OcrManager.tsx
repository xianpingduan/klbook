import { useEffect, useRef, useState } from 'react';
import { ApiError, type FamilyApi } from './api.ts';
import { defaultOcrConfig, ocrProviders, type OcrProvider, type OcrConfig, type OcrEdit, type OcrSettings } from '../shared/ocr.ts';
import { useEditorLeave } from './useEditorLeave.tsx';

const money = (cents: number) => `¥${(cents / 100).toFixed(Number.isInteger(cents) ? 2 : 3)}`;
const date = (value: number) => new Date(value).toLocaleString('zh-CN');
export function OcrManager({ api, grant, active, onAccessError }: { api: FamilyApi; grant?: string; active: boolean; onAccessError(error: ApiError): Promise<void> }) {
  const [data, setData] = useState<OcrSettings>();
  const [config, setConfig] = useState<OcrConfig>(defaultOcrConfig);
  const [apiKey, setApiKey] = useState(''), [secretKey, setSecretKey] = useState('');
  const [appId, setAppId] = useState('');
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0), [sample, setSample] = useState('');
  const baseline = useRef<OcrSettings | undefined>(undefined);
  const pending = useRef<OcrEdit | null>(null);
  const pendingTest = useRef<{ id: string; revision: number } | null>(null);
  const mounted = useRef(true), protectedForm = useRef(false);
  const dirty = !!appId || !!apiKey || !!secretKey || JSON.stringify(config) !== JSON.stringify(baseline.current?.config ?? defaultOcrConfig);
  protectedForm.current = dirty || busy || !!pending.current;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!grant || !active) {
      setAppId(''); setApiKey(''); setSecretKey(''); pending.current = null;
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
  function discard() { pending.current = null; setAppId(''); setApiKey(''); setSecretKey(''); if (baseline.current) setConfig(baseline.current.config); }
  const leave = useEditorLeave({ dirty, busy, canSave: active && !!grant && !loading, title: '图片识别配置还有未保存的修改', description: <p>凭据只在本次管理期间保留，保存配置不会发送图片。</p>, error, save, discard });
  async function failed(failure: unknown) {
    if (!mounted.current) return;
    if (failure instanceof ApiError && [401, 403].includes(failure.status)) { leave.dismiss(); await onAccessError(failure); }
    else setError(failure instanceof Error ? failure.message : '操作失败，请重试');
  }
  async function save() {
    if (busy || loading || !active || !grant || !baseline.current) return false;
    const replacing = !!apiKey || !!secretKey || !!appId;
    if (!config.name.trim() || (replacing && (!apiKey || !secretKey || (config.provider === 'xfyun' && !appId)))) { setError('请填写服务名称；更换凭据时需填写所选供应商的全部凭据。'); return false; }
    setBusy(true); setError(''); setNotice('');
    const desired = { config, ...(replacing ? { credentials: { apiKey, secretKey, ...(config.provider === 'xfyun' ? { appId } : {}) } } : {}) };
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
      baseline.current = value; setData(value); setConfig(value.config); setAppId(''); setApiKey(''); setSecretKey('');
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
  function chooseProvider(provider: OcrProvider) {
    setAppId(''); setApiKey(''); setSecretKey(''); setError('');
    setConfig(current => ({ ...current, provider, name: ocrProviders[provider].name, enabled: false, language: 'CHN_ENG', handwriting: true, formulas: provider === 'baidu', priceCents: ocrProviders[provider].priceCents }));
    setNotice('切换后请保存配置。未保存的凭据已清空；已保存的凭据分别保留，本月次数和费用继续合计。');
  }
  const provider = ocrProviders[config.provider];
  const latest = data?.latestSample;
  const state = !data?.credentialsConfigured ? '未配置' : !data.credentialAvailable ? '本机凭据无法读取' : !data.config.enabled ? '已停用' : latest?.revision !== data.revision ? '已启用，当前配置尚未测试' : latest.status === 'succeeded' ? '已启用，测试成功' : latest.status === 'running' ? '已启用，测试中' : '已启用，请检查测试结果';
  return <section className="card ocr-manager"><p className="eyebrow">外部能力管理</p><h1>图片识别服务</h1>
    <p>{provider.label}</p>
    <p className="hint">启用后，新收集的图片会送至所选服务提供建议；学习端仍可手动收集。识别结果需要人工核对。</p>
    {loading && <p role="status">正在读取配置…</p>}
    {data && <p className="message">{state}</p>}
    {error && !leave.leaving && <p className="message error" role="alert">{error}</p>}{leave.dialog}
    {notice && <p className="message" role="status">{notice}</p>}
    {data && <><form onSubmit={event => { event.preventDefault(); void save(); }}><fieldset disabled={busy || loading || !grant || !active}>
      <h2>服务配置</h2><label>识别供应商<select value={config.provider} onChange={event => chooseProvider(event.target.value as OcrProvider)}>{Object.entries(ocrProviders).map(([id, option]) => <option key={id} value={id}>{option.label}</option>)}</select></label>
      <label>服务名称<input value={config.name} maxLength={80} required onChange={event => update('name', event.target.value)} /></label>
      <label className="ocr-check"><input type="checkbox" checked={config.enabled} onChange={event => update('enabled', event.target.checked)} />启用图片识别服务</label>
      <p className="hint">停用不删除在途结果，重新启用不自动处理历史材料。停用时仍可由家长主动测试。</p>
      <h3>凭据</h3><p>{data.credentialStatus[config.provider].configured ? '所选供应商的凭据已保存。留空保留，填写全部凭据以替换。' : `尚未配置${provider.name}凭据，请在对应供应商控制台开通服务并获取凭据。`}</p>
      <div className="ocr-grid">{config.provider === 'xfyun' && <label>APPID<input type="password" autoComplete="off" maxLength={64} value={appId} onChange={event => setAppId(event.target.value)} /></label>}
        <label>{config.provider === 'xfyun' ? 'APIKey' : 'API Key'}<input type="password" autoComplete="off" maxLength={256} value={apiKey} onChange={event => setApiKey(event.target.value)} /></label><label>{config.provider === 'xfyun' ? 'APISecret' : 'Secret Key'}<input type="password" autoComplete="new-password" maxLength={256} value={secretKey} onChange={event => setSecretKey(event.target.value)} /></label></div>
      <p className="hint">凭据在家庭电脑加密保存，不回填到页面；管理验证到期会清空未保存的凭据。</p>
      <div className="ocr-grid">{config.provider === 'baidu' && <label>识别语言<select value={config.language} onChange={event => update('language', event.target.value as OcrConfig['language'])}><option value="CHN_ENG">中文与英文</option><option value="ENG">英文</option></select></label>}
        <label>每次请求超时（秒）<input type="number" min={5} max={30} step={1} required value={config.timeoutSeconds} onChange={event => update('timeoutSeconds', Number(event.target.value))} /></label>
        <label>最多自动重试（次）<input type="number" min={0} max={2} step={1} required value={config.retries} onChange={event => update('retries', Number(event.target.value))} /></label></div>
      {config.provider === 'baidu' ? <><label className="ocr-check"><input type="checkbox" checked={config.handwriting} onChange={event => update('handwriting', event.target.checked)} />识别印刷与手写混排</label>
      <label className="ocr-check"><input type="checkbox" checked={config.formulas} onChange={event => update('formulas', event.target.checked)} />识别公式（LaTeX）</label></> : <p className="hint">讯飞通用文字识别：中英文印刷与手写文字。此接口不提供专用公式识别或自动切题能力。</p>}
      <h3>图片识别月度限额</h3><div className="ocr-grid">
        <label>每月最多尝试（次）<input type="number" min={0} max={10000} step={1} required value={config.monthlyLimit} onChange={event => update('monthlyLimit', Number(event.target.value))} /></label>
        <label>每月估算预算（元）<input type="number" min={0} max={5000} step="0.01" required value={config.monthlyBudgetCents / 100} onChange={event => update('monthlyBudgetCents', Math.round(Number(event.target.value) * 100))} /></label>
        <label>每次估算单价（元）<input type="number" min={0} max={100} step="0.001" required value={config.priceCents / 100} onChange={event => update('priceCents', Math.round(Number(event.target.value) * 1000) / 10)} /></label></div>
      <p className="hint">当前预算 {money(config.monthlyBudgetCents)}，单价 {money(config.priceCents)}。{config.provider === 'xfyun' ? '参考套餐 350 元／1 万次，折合 0.035 元／次。' : '参考按次价为 0.16 元。'}请按实际套餐调整；免费包可填 0 元，但余额和有效期不会自动同步。测试、失败和重试计入尝试次数；成功或结果不确定的请求保守预留费用。以北京时间自然月统计，两个供应商合计，切换不清零。</p>
      <button type="submit">保存配置</button>
    </fieldset></form>
    <h2>主动测试</h2><p>点击测试后，仅将下方合成样例发送到已保存的“{ocrProviders[data.config.provider].label}”，不读取孩子的材料。测试可能收费，最多尝试 {data.config.retries + 1} 次。</p>
    {sample ? <img className="ocr-sample" src={sample} alt="将发送的合成测试材料" /> : <p>测试材料尚未加载，请重新读取配置。</p>}
    <button disabled={!sample || dirty || busy || loading || !grant || !active || !data.credentialAvailable || data.tests.some(test => test.status === 'running')} onClick={() => void test()}>{pendingTest.current ? '重试提交测试请求' : '发送样例并测试'}</button>
    {dirty && <p className="hint">请先保存配置再测试。</p>}
    <h2>用量与调用记录</h2><p>{data.usage.month}：尝试 {data.usage.attempts} 次 / {data.config.monthlyLimit} 次，估算费用 {money(data.usage.estimatedCents)} / {money(data.config.monthlyBudgetCents)}。这不是供应商账单。</p>
    {data.tests.length === 0 ? <p>还没有调用记录。</p> : <div className="table-scroll"><table className="management-table" aria-label="图片识别调用记录"><thead><tr><th>时间</th><th>用途</th><th>供应商</th><th>结果</th><th>耗时</th><th>尝试次数</th></tr></thead><tbody>{data.tests.map(run => <tr key={run.id}><td>{date(run.createdAt)}</td><td>{run.sample === 'school-v1' ? '样例测试' : '收集材料'}</td><td>{ocrProviders[run.provider].label}</td><td>{run.status === 'running' ? '正在识别…' : run.message}</td><td>{run.durationMs === null ? '—' : `${run.durationMs} ms`}</td><td>{run.attempts}</td></tr>)}</tbody></table></div>}
    {latest?.lines.length ? <details open><summary>最近一次识别文字（需人工核对）</summary><pre className="ocr-text">{latest.lines.map(line => line.text).join('\n')}</pre></details> : null}
    <details><summary>最近配置操作</summary><ul>{data.audit.map((event, index) => <li key={index}>{date(event.at)} · {event.actor} · {event.action}</li>)}</ul></details>
    </>}
    <button className="quiet" disabled={busy || loading || !grant || !active} onClick={() => leave.requestLeave(() => { discard(); protectedForm.current = false; setRefresh(value => value + 1); })}>重新读取配置</button>
    <p className="hint"><a href={provider.product} target="_blank" rel="noreferrer">服务介绍与开通</a> · <a href={provider.docs} target="_blank" rel="noreferrer">接口说明</a> · <a href={provider.price} target="_blank" rel="noreferrer">供应商计费说明</a></p>
  </section>;
}
