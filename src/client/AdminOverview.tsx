import { useEffect, useState } from 'react';
import { ApiError, FamilyApi } from './api.ts';

type Count = { value?: number; error?: string };
const labels = ['已收集数', '草稿数', '启用来源数', '有效设备数'];
export function AdminOverview({ api, grant, onAccessError }: { api: FamilyApi; grant: string; onAccessError(error: ApiError): Promise<void> }) {
  const [counts, setCounts] = useState<Count[]>([]);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    setCounts([]);
    const queries = [api.questions('collected').then(list => list.total), api.questions('draft').then(list => list.total), api.managedSources(grant).then(sources => sources.filter(source => source.active).length), api.devices(grant).then(devices => devices.length)];
    queries.forEach((query, index) => {
      void query.then(value => {
        if (active) setCounts(current => { const next = [...current]; next[index] = { value }; return next; });
      }).catch(async failure => {
        if (!active) return;
        if (failure instanceof ApiError && [401, 403].includes(failure.status)) { await onAccessError(failure); return; }
        setCounts(current => { const next = [...current]; next[index] = { error: failure instanceof Error ? failure.message : '读取失败' }; return next; });
      });
    });
    return () => { active = false; };
  }, [api, grant, refresh, onAccessError]);
  return <section aria-label="管理概览">
    <div className="section-heading"><div><h1>管理概览</h1><p className="intro">看看家里的整理情况。</p></div><button className="quiet" onClick={() => setRefresh(value => value + 1)}>刷新概览</button></div>
    <div className="overview-grid">{labels.map((label, index) => <section className="card overview-count" key={label} aria-label={label}><h2>{label}</h2>{counts[index]?.error ? <p role="alert">暂不可用<br /><small>{counts[index]?.error}</small></p> : <strong aria-live="polite">{counts[index]?.value ?? '读取中…'}</strong>}</section>)}</div>
    <p className="hint">草稿数包含已保存到家庭电脑的材料。仅在当前设备的待上传图片不计入其中。</p>
  </section>;
}
