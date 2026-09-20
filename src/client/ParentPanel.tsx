import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { Device, ParentGrant } from '../shared/contracts.ts';
import { ApiError, FamilyApi } from './api.ts';
import { SourceManager } from './SourceManager.tsx';

export function ParentPanel({ api, onClose, onSignedOut, onRecoveryCode }: { api: FamilyApi; onClose(): void; onSignedOut(): Promise<void>; onRecoveryCode(code: string): void }) {
  const [grant, setGrant] = useState<ParentGrant>();
  const [devices, setDevices] = useState<Device[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [section, setSection] = useState<'devices' | 'sources'>('devices');

  useEffect(() => {
    if (!grant) return;
    const timer = setTimeout(() => { setGrant(undefined); setDevices([]); setError('管理验证已到期，请重新验证'); }, Math.max(0, grant.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [grant]);

  async function run(action: () => Promise<void>) {
    setBusy(true); setError('');
    try { await action(); }
    catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) { await onSignedOut(); return; }
      if (failure instanceof ApiError && failure.status === 403) { setGrant(undefined); setDevices([]); }
      setError(failure instanceof Error ? failure.message : '操作失败，请重试');
    } finally { setBusy(false); }
  }
  function unlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const password = String(new FormData(event.currentTarget).get('password'));
    event.currentTarget.reset();
    void run(async () => {
      const next = await api.unlock(password);
      const devices = await api.devices(next.token);
      setGrant(next); setDevices(devices); setSection('devices');
    });
  }
  return <section className="card parent-panel">
    <p className="eyebrow">家长管理</p><h1>{grant ? section === 'devices' ? '已登录的设备' : '来源管理' : '验证家长身份'}</h1>
    {error && <p role="alert" className="message error">{error}</p>}
    {!grant ? <><p>管理权限在 5 分钟后自动结束。孩子的日常会话不会获得管理权限。</p><form onSubmit={unlock}><fieldset disabled={busy}><label>家长密码<input type="password" name="password" autoComplete="current-password" required minLength={12} maxLength={128} /></label><button type="submit">验证并进入管理</button></fieldset></form><button className="quiet" disabled={busy} onClick={onClose}>返回错题集</button></> : <>
      <div className="collection-tabs"><button className="quiet" aria-pressed={section === 'devices'} disabled={busy} onClick={() => setSection('devices')}>设备管理</button><button className="quiet" aria-pressed={section === 'sources'} disabled={busy} onClick={() => setSection('sources')}>来源管理</button></div>
      {section === 'sources' ? <SourceManager api={api} grant={grant.token} onAccessError={async failure => { if (failure.status === 401) await onSignedOut(); else { setGrant(undefined); setDevices([]); setError(failure.message); } }} /> : <>
      <p>撤销后，该设备需要由家长重新登录。</p><ul className="device-list">{devices.map(device => <li key={device.id}><div><strong>{device.deviceName}</strong>{device.current && <span className="badge">当前设备</span>}<small>登录于 {new Date(device.createdAt).toLocaleString('zh-CN')}</small></div><button className="quiet" aria-label={`撤销 ${device.deviceName}`} disabled={busy} onClick={() => void run(async () => { await api.revoke(grant.token, device.id); if (device.current) await onSignedOut(); else setDevices(await api.devices(grant.token)); })}>撤销</button></li>)}</ul>
      <div className="recovery-section"><h2>恢复码保管</h2><p>没有保存好恢复码时，可以重新生成。生成后旧码立即失效，请单独保存新码。</p><button className="quiet" disabled={busy} onClick={() => void run(async () => { const result = await api.rotateRecoveryCode(grant.token); setGrant(undefined); onRecoveryCode(result.recoveryCode); })}>重新生成恢复码</button></div>
      </>}
      <button disabled={busy} onClick={() => void run(async () => { await api.lock(grant.token); setGrant(undefined); onClose(); })}>结束管理</button>
    </>}
  </section>;
}
