import { useEffect, useRef, useState } from 'react';
import { ApiError, type FamilyApi } from './api.ts';
import { defaultSpeechConfig, speechProvider, type SpeechConfig, type SpeechEdit, type SpeechSettings } from '../shared/speech.ts';
import { useEditorLeave } from './useEditorLeave.tsx';

const money = (cents: number) => `¥${(cents / 100).toFixed(3)}`;
const date = (time: number) => new Date(time).toLocaleString('zh-CN');
export function SpeechManager({ api, grant, active, onAccessError }: { api: FamilyApi; grant?: string; active: boolean; onAccessError(error: ApiError): Promise<void> }) {
  const [data, setData] = useState<SpeechSettings>();
  const [config, setConfig] = useState<SpeechConfig>(defaultSpeechConfig);
  const [appId, setAppId] = useState(''), [apiKey, setApiKey] = useState(''), [secretKey, setSecretKey] = useState('');
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [refresh, setRefresh] = useState(0);
  const [audio, setAudio] = useState<File>(), [preview, setPreview] = useState('');
  const fileInput = useRef<HTMLInputElement>(null), baseline = useRef<SpeechSettings | undefined>(undefined);
  const pending = useRef<SpeechEdit | null>(null), pendingTest = useRef<{ id: string; revision: number; audio: File } | null>(null);
  const mounted = useRef(true), protectedForm = useRef(false);
  const dirty = !!appId || !!apiKey || !!secretKey || JSON.stringify(config) !== JSON.stringify(baseline.current?.config ?? defaultSpeechConfig);
  protectedForm.current = dirty || busy || !!pending.current;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (!grant || !active) { setAppId(''); setApiKey(''); setSecretKey(''); pending.current = null; } }, [grant, active]);
  useEffect(() => {
    if (!audio) { setPreview(''); return; }
    const url = URL.createObjectURL(audio); setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [audio]);
  useEffect(() => {
    if (!grant || !active) return;
    let live = true, timer: number | undefined;
    setLoading(true); setError('');
    const read = async () => {
      try {
        const value = await api.speechSettings(grant);
        if (!live) return;
        setData(value);
        if (!protectedForm.current) { baseline.current = value; setConfig(value.config); }
        if (value.tests.some(run => run.id === pendingTest.current?.id)) pendingTest.current = null;
        if (value.tests.some(run => run.status === 'running')) timer = window.setTimeout(() => void read(), 1000);
      } catch (failure) {
        if (!live) return;
        if (failure instanceof ApiError && [401, 403].includes(failure.status)) await onAccessError(failure);
        else setError(failure instanceof Error ? failure.message : '读取语音转写配置失败');
      } finally { if (live) setLoading(false); }
    };
    void read();
    return () => { live = false; window.clearTimeout(timer); };
  }, [api, grant, active, refresh, onAccessError]);
  function discard() { pending.current = null; setAppId(''); setApiKey(''); setSecretKey(''); if (baseline.current) setConfig(baseline.current.config); }
  const leave = useEditorLeave({ dirty, busy, canSave: active && !!grant && !loading, title: '语音转写配置还有未保存的修改', description: <p>保存配置不会发送音频。离开管理后，未保存的凭据会清空。</p>, error, save, discard });
  async function failed(failure: unknown) {
    if (!mounted.current) return;
    if (failure instanceof ApiError && [401, 403].includes(failure.status)) { leave.dismiss(); await onAccessError(failure); }
    else setError(failure instanceof Error ? failure.message : '操作失败，请重试');
  }
  async function save() {
    if (busy || loading || !grant || !active || !baseline.current) return false;
    const replacing = !!appId || !!apiKey || !!secretKey;
    if (!config.name.trim() || (replacing && (!appId || !apiKey || !secretKey))) { setError('请填写服务名称；更换凭据时需填写全部三个字段。'); return false; }
    setBusy(true); setError(''); setNotice('');
    const desired = { config, ...(replacing ? { credentials: { appId, apiKey, secretKey } } : {}) };
    try {
      let value: SpeechSettings | undefined;
      const previous = pending.current;
      if (previous) {
        value = await api.saveSpeech(grant, previous);
        if (!mounted.current) return false;
        pending.current = null;
        if (value.revision !== previous.expectedRevision + 1) throw new ApiError(409, '配置已被更新，请重新读取配置后核对');
        baseline.current = value;
      }
      if (!previous || JSON.stringify({ config: previous.config, credentials: previous.credentials }) !== JSON.stringify(desired)) {
        const input: SpeechEdit = { ...desired, operationId: crypto.randomUUID(), expectedRevision: baseline.current.revision };
        pending.current = input; value = await api.saveSpeech(grant, input);
        if (!mounted.current) return false;
        pending.current = null;
        if (value.revision !== input.expectedRevision + 1) throw new ApiError(409, '配置已被更新，请重新读取配置后核对');
      }
      if (!value) return false;
      baseline.current = value; setData(value); setConfig(value.config); setAppId(''); setApiKey(''); setSecretKey('');
      setNotice('配置已保存，未发起语音转写调用。'); return true;
    } catch (failure) {
      if (failure instanceof ApiError && [400, 422].includes(failure.status)) pending.current = null;
      await failed(failure); return false;
    } finally { if (mounted.current) setBusy(false); }
  }
  async function test() {
    if (!grant || !data || dirty || busy || !audio) return;
    setBusy(true); setError(''); setNotice('');
    pendingTest.current ??= { id: crypto.randomUUID(), revision: data.revision, audio };
    try {
      const run = await api.testSpeech(grant, pendingTest.current.id, pendingTest.current.revision, pendingTest.current.audio);
      if (!mounted.current) return;
      pendingTest.current = null;
      setData(current => current && ({ ...current, tests: [run, ...current.tests.filter(value => value.id !== run.id)].slice(0, 20) }));
      setRefresh(value => value + 1); setNotice('测试已提交，可在下方查看结果。');
    } catch (failure) {
      if (failure instanceof ApiError && [400, 409, 413, 415, 422, 503].includes(failure.status)) pendingTest.current = null;
      await failed(failure);
    } finally { if (mounted.current) setBusy(false); }
  }
  const update = <K extends keyof SpeechConfig>(key: K, value: SpeechConfig[K]) => setConfig(current => ({ ...current, [key]: value }));
  function choose(file?: File) {
    setError('');
    if (file && (file.size > 2 * 1024 * 1024 || !/\.wav$/i.test(file.name))) { setAudio(undefined); setError('请选择不超过 2 MB 的 WAV 文件。'); if (fileInput.current) fileInput.current.value = ''; return; }
    setAudio(file);
  }
  return <section className="card ocr-manager"><p className="eyebrow">外部能力管理</p><h1>语音转写服务</h1><p>{speechProvider.label}</p>
    <p className="hint">用于家长测试短音频。与图片识别、AI 学习分别管理，启用不会自动读取历史材料。</p>
    {loading && <p role="status">正在读取配置…</p>}
    {error && !leave.leaving && <p className="message error" role="alert">{error}</p>}{leave.dialog}
    {notice && <p className="message" role="status">{notice}</p>}
    {data && <><p className="message">{!data.credentialsConfigured ? '未配置' : !data.credentialAvailable ? '本机凭据无法读取' : data.config.enabled ? '已启用' : '已停用'}</p>
      <form onSubmit={event => { event.preventDefault(); void save(); }}><fieldset disabled={busy || loading || !grant || !active}>
        <h2>服务配置</h2><label>服务名称<input required maxLength={80} value={config.name} onChange={event => update('name', event.target.value)} /></label>
        <label className="ocr-check"><input type="checkbox" checked={config.enabled} onChange={event => update('enabled', event.target.checked)} />启用语音转写服务</label>
        <p className="hint">停用后不接受新测试和自动重试；已发出的请求继续记录真实结果。保存配置本身不会调用服务。</p>
        <h3>凭据</h3><p>{data.credentialsConfigured ? '凭据已保存。留空保留，填写全部凭据以替换。' : '请开通讯飞语音听写（流式版），填写该服务的凭据。图片识别权限不能代替语音权限。'}</p>
        <div className="ocr-grid"><label>APPID<input type="password" autoComplete="off" maxLength={64} value={appId} onChange={event => setAppId(event.target.value)} /></label>
          <label>APIKey<input type="password" autoComplete="off" maxLength={256} value={apiKey} onChange={event => setApiKey(event.target.value)} /></label>
          <label>APISecret<input type="password" autoComplete="new-password" maxLength={256} value={secretKey} onChange={event => setSecretKey(event.target.value)} /></label></div>
        <p className="hint">凭据在家庭电脑加密保存，不回填页面；离开管理或验证到期后清空未保存的凭据。</p>
        <div className="ocr-grid"><label>转写语言<select value={config.language} onChange={event => update('language', event.target.value as SpeechConfig['language'])}><option value="zh_cn">中文普通话（含简单英文）</option><option value="en_us">英文</option></select></label>
          <label>每次请求超时（秒）<input type="number" required min={5} max={120} value={config.timeoutSeconds} onChange={event => update('timeoutSeconds', Number(event.target.value))} /></label>
          <label>最多自动重试（次）<input type="number" required min={0} max={2} value={config.retries} onChange={event => update('retries', Number(event.target.value))} /></label></div>
        <p className="hint">音频按时长分段发送，超时应大于音频时长。重试默认关闭，每次重试可能再次计费。</p>
        <h3>语音转写月度限额</h3><div className="ocr-grid">
          <label>每月最多尝试（次）<input type="number" required min={0} max={10000} value={config.monthlyLimit} onChange={event => update('monthlyLimit', Number(event.target.value))} /></label>
          <label>每月估算预算（元）<input type="number" required min={0} max={5000} step="0.01" value={config.monthlyBudgetCents / 100} onChange={event => update('monthlyBudgetCents', Math.round(Number(event.target.value) * 100))} /></label>
          <label>每次估算单价（元）<input type="number" required min={0} max={100} step="0.001" value={config.priceCents / 100} onChange={event => update('priceCents', Math.round(Number(event.target.value) * 1000) / 10)} /></label></div>
        <p className="hint">请按实际套餐填写估算单价，免费包可填 0。免费额度及有效期不会自动同步。北京时间自然月统计，失败和重试计入次数；成功和结果不确定的请求保留估算费用。音频用量为每次尝试的输入时长合计，供应商实际计费以账单为准。</p>
        <button type="submit">保存配置</button>
      </fieldset></form>
      <h2>主动测试</h2><p>选择自己的测试音频，试听后再发送。仅发送所选文件至讯飞，不加入错题集；家庭电脑保留文字、计量和测试记录，测试音频仅在处理期间暂存内存。</p>
      <p className="hint">WAV：16 位 PCM、单声道、8 kHz 或 16 kHz，最长 60 秒、不超过 2 MB。建议先用 5～10 秒清晰语音。</p>
      <label>测试音频<input ref={fileInput} type="file" accept=".wav,audio/wav,audio/x-wav" disabled={busy || loading || !grant || !active || !!pendingTest.current} onChange={event => choose(event.target.files?.[0])} /></label>
      {audio && <><p>{audio.name} · {(audio.size / 1024).toFixed(1)} KB</p><audio controls src={preview} aria-label="试听所选测试音频" /><button className="quiet" disabled={busy || !!pendingTest.current} onClick={() => { setAudio(undefined); if (fileInput.current) fileInput.current.value = ''; }}>移除测试音频</button></>}
      <p>主动测试可能收费，按当前配置最多尝试 {data.config.retries + 1} 次。</p>
      <button disabled={!audio || dirty || busy || loading || !grant || !active || (!pendingTest.current && (!data.config.enabled || !data.credentialAvailable || data.tests.some(run => run.status === 'running')))} onClick={() => void test()}>{pendingTest.current ? '重试提交同一次测试' : '发送所选音频并测试'}</button>
      {dirty && <p className="hint">请先保存配置再测试。</p>}{!data.config.enabled && <p className="hint">请先启用语音转写并保存配置。</p>}
      <h2>用量与调用记录</h2><p>{data.usage.month}：尝试 {data.usage.attempts} / {data.config.monthlyLimit} 次，输入音频合计 {(data.usage.audioMs / 1000).toFixed(2)} 秒，估算费用 {money(data.usage.estimatedCents)} / {money(data.config.monthlyBudgetCents)}。</p>
      {!data.tests.length ? <p>还没有调用记录。</p> : <div className="table-scroll"><table className="management-table" aria-label="语音转写调用记录"><thead><tr><th>时间</th><th>结果与文字</th><th>音频</th><th>耗时</th><th>尝试</th></tr></thead><tbody>{data.tests.map(run => <tr key={run.id}><td>{date(run.createdAt)}</td><td>{run.status === 'running' ? '正在转写…' : run.message}{run.text && <details open><summary>转写文字（需核对）</summary><pre className="ocr-text">{run.text}</pre></details>}</td><td>{(run.audioMs / 1000).toFixed(2)} 秒<br />{run.sampleRate / 1000} kHz · {(run.audioBytes / 1024).toFixed(1)} KB</td><td>{run.durationMs === null ? '—' : `${run.durationMs} ms`}</td><td>{run.attempts}</td></tr>)}</tbody></table></div>}
      <details><summary>最近配置操作</summary><ul>{data.audit.map((event, index) => <li key={index}>{date(event.at)} · {event.actor} · {event.action}</li>)}</ul></details>
    </>}
    <button className="quiet" disabled={busy || loading || !grant || !active} onClick={() => leave.requestLeave(() => { discard(); protectedForm.current = false; setRefresh(value => value + 1); })}>重新读取配置</button>
    <p className="hint"><a href={speechProvider.product} target="_blank" rel="noreferrer">服务介绍与开通</a> · <a href={speechProvider.docs} target="_blank" rel="noreferrer">接口与样例说明</a></p>
  </section>;
}
