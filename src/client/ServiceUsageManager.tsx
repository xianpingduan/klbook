import { useEffect, useRef, useState } from 'react';
import { ApiError, type FamilyApi } from './api.ts';
import { capabilities, defaultServiceBudget, type Capability, type ServiceBudget, type ServiceBudgetEdit, type ServiceUsage, type UsageQuery } from '../shared/service-usage.ts';
import type { PagePath } from '../shared/app-routes.ts';
import { useEditorLeave } from './useEditorLeave.tsx';

const money = (micros: number) => `¥${(micros / 1000000).toFixed(6)}`;
const date = (time: number) => new Date(time).toLocaleString('zh-CN');
const status = { running: '处理中', succeeded: '成功', failed: '失败', unknown: '结果不确定' };
const basis = { 'local-call': '按本地调用结果估算', reported: '按返回 token 估算', reserved: '预留／待计量', none: '未计入费用' };
export function ServiceUsageManager({ api, grant, active, onAccessError, navigate }: { api: FamilyApi; grant?: string; active: boolean; onAccessError(error: ApiError): Promise<void>; navigate(path: PagePath): void }) {
  const [data, setData] = useState<ServiceUsage>(), [config, setConfig] = useState<ServiceBudget>(defaultServiceBudget);
  const [query, setQuery] = useState<UsageQuery>({}), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [refresh, setRefresh] = useState(0);
  const baseline = useRef<ServiceUsage | undefined>(undefined), pending = useRef<ServiceBudgetEdit | null>(null);
  const mounted = useRef(true), protectedForm = useRef(false);
  const dirty = JSON.stringify(config) !== JSON.stringify(baseline.current?.config ?? defaultServiceBudget);
  protectedForm.current = dirty || busy || !!pending.current;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!grant || !active) return;
    let live = true, timer: number | undefined;
    setLoading(true); setError('');
    const read = async () => {
      try {
        const value = await api.serviceUsage(grant, query);
        if (!live) return;
        setData(value);
        if (!protectedForm.current) { baseline.current = value; setConfig(value.config); }
        if (value.month === value.currentMonth && value.totals.running > 0) timer = window.setTimeout(() => void read(), 1000);
      } catch (failure) {
        if (!live) return;
        if (failure instanceof ApiError && [401, 403].includes(failure.status)) await onAccessError(failure);
        else setError(failure instanceof Error ? failure.message : '读取服务用量失败');
      } finally { if (live) setLoading(false); }
    };
    void read();
    return () => { live = false; window.clearTimeout(timer); };
  }, [api, grant, active, query, refresh, onAccessError]);
  const discard = () => { pending.current = null; setConfig(baseline.current?.config ?? defaultServiceBudget); };
  const leave = useEditorLeave({ dirty, busy, canSave: active && !!grant && !loading, title: '服务预算还有未保存的修改', description: <p>保存预算不会发起服务调用，也不会修改历史费用估算。</p>, error, save, discard });
  async function save() {
    if (busy || loading || !grant || !active || !baseline.current) return false;
    setBusy(true); setError(''); setNotice('');
    const desired = config;
    const persist = async (input: ServiceBudgetEdit) => {
      pending.current = input;
      const value = await api.saveServiceBudget(grant, input);
      if (!mounted.current) return;
      pending.current = null;
      if (value.revision !== input.expectedRevision + 1) throw new ApiError(409, '预算已被更新，请重新读取预算后核对');
      baseline.current = value; return value;
    };
    try {
      const previous = pending.current;
      let value: ServiceUsage | undefined;
      if (previous) { value = await persist(previous); if (!value) return false; }
      if (!previous || JSON.stringify(previous.config) !== JSON.stringify(desired)) value = await persist({ operationId: crypto.randomUUID(), expectedRevision: baseline.current.revision, config: desired });
      if (!value) return false;
      setData(value); setConfig(value.config); setQuery({}); setNotice('预算已保存，已显示本月记录；未发起服务调用。'); return true;
    } catch (failure) {
      if (failure instanceof ApiError && [400, 422].includes(failure.status)) pending.current = null;
      if (!mounted.current) return false;
      if (failure instanceof ApiError && [401, 403].includes(failure.status)) { leave.dismiss(); await onAccessError(failure); }
      else setError(failure instanceof Error ? failure.message : '保存失败，请重试');
      return false;
    } finally { if (mounted.current) setBusy(false); }
  }
  const update = <K extends keyof ServiceBudget>(key: K, value: ServiceBudget[K]) => setConfig(current => ({ ...current, [key]: value }));
  return <section className="card ocr-manager"><p className="eyebrow">外部能力管理</p><h1>服务用量与预算</h1>
    <p className="hint">三类服务共用总预算，各自的开关、次数和分类限额仍独立。费用均为估算，包含在途和待计量预留，以供应商账单为准。</p>
    {loading && <p role="status">正在读取用量…</p>}{error && !leave.leaving && <p className="message error" role="alert">{error}</p>}{leave.dialog}
    {notice && <p className="message" role="status">{notice}</p>}
    {data && <>
      <form onSubmit={event => { event.preventDefault(); void save(); }}><fieldset disabled={busy || loading || !grant || !active}>
        <h2>服务预算</h2><label>每月服务总预算（元）<input type="number" min={0} max={5000} step="0.01" required value={config.monthlyBudgetCents / 100} onChange={event => update('monthlyBudgetCents', Math.round(Number(event.target.value) * 100))} /></label>
        <p className="hint">以每月 50 元为初始预算。按北京时间自然月统计；新付费调用和重试需同时满足总预算与分类限额。调低预算不撤销已发出的请求，也不影响手动收集和查看。</p>
        <details><summary>硬件、容量与电耗（单独记录）</summary><p className="hint">这些记录不占用服务预算；留空表示尚未核算。预算不是已经核实的支出或采购授权。</p>
          <div className="ocr-grid"><label>硬件一次性费用（元）<input type="number" min={0} max={1000000} step="0.01" value={config.hardwareCents === null ? '' : config.hardwareCents / 100} onChange={event => update('hardwareCents', event.target.value === '' ? null : Math.round(Number(event.target.value) * 100))} /></label>
            <label>每月电耗估算（元）<input type="number" min={0} max={100000} step="0.01" value={config.monthlyElectricityCents === null ? '' : config.monthlyElectricityCents / 100} onChange={event => update('monthlyElectricityCents', event.target.value === '' ? null : Math.round(Number(event.target.value) * 100))} /></label></div>
          <label>硬件与存储容量说明<input maxLength={256} value={config.capacityNote} onChange={event => update('capacityNote', event.target.value)} /></label>
        </details><button type="submit">保存预算</button>
      </fieldset></form>
      <h2>分类限额分配</h2><p className="hint">以下为当前各类上限，可进入对应服务调整；不是独占余额，三类合计仍受总预算约束。分类限额合计 ¥{(data.categories.reduce((sum, item) => sum + item.monthlyBudgetCents, 0) / 100).toFixed(2)}，总预算 ¥{(data.config.monthlyBudgetCents / 100).toFixed(2)}。</p>
      <div className="table-scroll"><table className="management-table" aria-label="分类限额"><thead><tr><th>服务</th><th>状态</th><th>每月费用上限</th><th>每月尝试上限</th><th>配置</th></tr></thead><tbody>{data.categories.map(item => <tr key={item.capability}><td>{capabilities[item.capability]}</td><td>{item.enabled ? '已启用' : '已停用'}</td><td>¥{(item.monthlyBudgetCents / 100).toFixed(2)}</td><td>{item.monthlyLimit} 次</td><td><button className="quiet" disabled={busy} onClick={() => navigate(`/admin/services/${item.capability}`)}>调整{capabilities[item.capability]}限额</button></td></tr>)}</tbody></table></div>
      <h2>{data.month} 用量</h2><div className="ocr-grid"><label>记录月份<input type="month" min="2000-01" max="2099-12" value={query.month ?? data.currentMonth} disabled={busy} onChange={event => { if (!event.target.value || /^20\d{2}-(0[1-9]|1[0-2])$/.test(event.target.value)) setQuery(current => ({ ...current, month: event.target.value || undefined, offset: 0 })); }} /></label></div>
      <p data-testid="usage-total-cost">合计估算 {money(data.totals.estimatedMicros)}，其中预留／待计量 {money(data.totals.reservedMicros)}。</p>
      <p>本地尝试 {data.totals.attempts} 次（含重试）：成功 {data.totals.succeeded}，失败 {data.totals.failed}，结果不确定 {data.totals.unknown}，处理中 {data.totals.running}。</p>
      <p className="hint">汇总包含整月全部记录，不受下面的类别筛选和分页影响。保存配置不算调用；次数、音频时长和 token 分别统计，不相加为同一种用量。历史费用不随当前单价改变。</p>
      {data.month === data.currentMonth && data.totals.estimatedMicros >= data.config.monthlyBudgetCents * 10000 && <p className="message">已达到总预算，新的付费调用受限。手动收集、查看资料以及按已配置零单价的主动调用仍可继续。</p>}
      <div className="table-scroll"><table className="management-table" aria-label="分类用量"><thead><tr><th>服务</th><th>本地尝试与结果</th><th>可得计量</th><th>费用估算</th></tr></thead><tbody>{data.categories.map(item => <tr key={item.capability}><td>{capabilities[item.capability]}</td><td>{item.attempts} 次<br />成功 {item.succeeded}／失败 {item.failed}<br />不确定 {item.unknown}／处理中 {item.running}</td><td>{item.capability === 'ai' ? <>{item.reportedAttempts} 次返回有效计量：输入 {item.promptTokens}、输出 {item.completionTokens}，合计 {item.totalTokens} token；其余 {item.attempts - item.reportedAttempts} 次未知。</> : item.capability === 'speech' ? <>本地输入音频 {(item.audioMs / 1000).toFixed(2)} 秒（含重试），不是供应商计费时长；接口未返回账单计量。</> : <>按本地调用结果计次；接口未返回账单计量。</>}</td><td>{money(item.estimatedMicros)}<br />含预留 {money(item.reservedMicros)}</td></tr>)}</tbody></table></div>
      <h2>调用明细</h2><label>调用类别<select value={query.capability ?? ''} disabled={busy} onChange={event => setQuery(current => ({ ...current, capability: (event.target.value || undefined) as Capability | undefined, offset: 0 }))}><option value="">全部类别</option>{Object.entries(capabilities).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select></label>
      {!data.records.length ? <p>这个月没有符合条件的调用记录。</p> : <div className="table-scroll"><table className="management-table" aria-label="调用明细"><thead><tr><th>时间与服务</th><th>结果与错误摘要</th><th>可得计量</th><th>费用估算</th><th>耗时</th></tr></thead><tbody>{data.records.map(run => <tr key={`${run.capability}:${run.id}`}><td>{date(run.startedAt)}<br />{capabilities[run.capability]} · {run.provider === 'xfyun' ? '讯飞' : '百度'} {run.model}</td><td>{status[run.status]}<br />{run.message}</td><td>{run.capability === 'ai' ? run.totalTokens === null ? '未返回有效 token' : <>输入 {run.promptTokens}／输出 {run.completionTokens}<br />合计 {run.totalTokens} token</> : <>{run.audioMs !== null && <>本地输入 {(run.audioMs / 1000).toFixed(2)} 秒<br /></>}供应商账单计量未返回</>}</td><td>{money(run.estimatedMicros)}<br />{basis[run.costBasis]}</td><td>{run.durationMs === null ? '—' : `${run.durationMs} ms`}</td></tr>)}</tbody></table></div>}
      <div className="ocr-grid"><button className="quiet" disabled={busy || loading || data.offset === 0} onClick={() => setQuery(current => ({ ...current, offset: Math.max(0, data.offset - 40) }))}>上一页</button><p>共 {data.recordCount} 次；第 {Math.floor(data.offset / 40) + 1} 页</p><button className="quiet" disabled={busy || loading || data.offset + 40 >= data.recordCount} onClick={() => setQuery(current => ({ ...current, offset: data.offset + 40 }))}>下一页</button></div>
      <details><summary>所选月份最近 30 条配置与测试操作</summary>{data.audit.length ? <ul>{data.audit.map((event, index) => <li key={index}>{date(event.at)} · {event.actor} · {event.capability === 'budget' ? '总预算' : capabilities[event.capability]} · {event.action}</li>)}</ul> : <p>暂无操作记录。</p>}</details>
    </>}
    <button className="quiet" disabled={busy || loading || !grant || !active} onClick={() => leave.requestLeave(() => { discard(); protectedForm.current = false; setRefresh(value => value + 1); })}>重新读取预算与用量</button>
  </section>;
}
