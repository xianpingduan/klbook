import { useEffect, useState } from 'react';
import type { Device } from '../shared/contracts.ts';
import { ApiError, FamilyApi } from './api.ts';

export function DeviceManager({ api, grant, onAccessError, onSignedOut, onRecoveryCode }: {
  api: FamilyApi; grant: string; onAccessError(error: ApiError): Promise<void>; onSignedOut(): Promise<void>; onRecoveryCode(code: string): void;
}) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    setBusy(true);
    void api.devices(grant).then(items => { if (active) setDevices(items); }).catch(async failure => {
      if (!active) return;
      if (failure instanceof ApiError && [401, 403].includes(failure.status)) await onAccessError(failure);
      else setError(failure instanceof Error ? failure.message : '设备读取失败');
    }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [api, grant, refresh, onAccessError]);
  async function run(action: () => Promise<void>) {
    setBusy(true); setError('');
    try { await action(); }
    catch (failure) {
      if (failure instanceof ApiError && [401, 403].includes(failure.status)) await onAccessError(failure);
      else setError(failure instanceof Error ? failure.message : '操作失败，请重试');
    } finally { setBusy(false); }
  }
  return <section className="card"><h1>设备与账号</h1>{error && <p className="message error" role="alert">{error}</p>}
    <h2>已登录的设备</h2><p>撤销后，该设备需要由家长重新登录。</p>
    <button className="quiet" disabled={busy} onClick={() => { setError(''); setRefresh(value => value + 1); }}>刷新设备列表</button>
    <ul className="device-list">{devices.map(device => <li key={device.id}><div><strong>{device.deviceName}</strong>{device.current && <span className="badge">当前设备</span>}<small>登录于 {new Date(device.createdAt).toLocaleString('zh-CN')}</small></div><button className="quiet" aria-label={`撤销 ${device.deviceName}`} disabled={busy} onClick={() => void run(async () => { await api.revoke(grant, device.id); if (device.current) await onSignedOut(); else setDevices(await api.devices(grant)); })}>撤销</button></li>)}</ul>
    <div className="recovery-section"><h2>恢复码保管</h2><p>生成后旧码立即失效，请单独保存新码。</p><button className="quiet" disabled={busy} onClick={() => void run(async () => { const result = await api.rotateRecoveryCode(grant); onRecoveryCode(result.recoveryCode); })}>重新生成恢复码</button></div>
  </section>;
}
