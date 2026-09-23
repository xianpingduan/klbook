import { useEffect, useRef, useState } from 'react';
import type { Device } from '../shared/contracts.ts';
import { ApiError, FamilyApi } from './api.ts';
import { useLeaveGuard } from './navigation.ts';

export function DeviceManager({ api, grant, onAccessError, onSignedOut, onRecoveryCode }: {
  api: FamilyApi; grant: string; onAccessError(error: ApiError): Promise<void>; onSignedOut(): Promise<void>; onRecoveryCode(code: string): void;
}) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const busy = loading || acting;
  const [readError, setReadError] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [refresh, setRefresh] = useState(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useLeaveGuard(acting, () => setError('正在处理设备或恢复码，请稍候再离开。'));
  useEffect(() => {
    let active = true;
    setLoading(true); setReadError('');
    void api.devices(grant).then(items => { if (active) setDevices(items); }).catch(async failure => {
      if (!active) return;
      if (failure instanceof ApiError && [401, 403].includes(failure.status)) await onAccessError(failure);
      else setReadError(failure instanceof Error ? failure.message : '设备读取失败');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api, grant, refresh, onAccessError]);
  async function run(action: () => Promise<void>) {
    if (busy) return;
    setActing(true); setError(''); setNotice('');
    try { await action(); }
    catch (failure) {
      if (!mounted.current) return;
      if (failure instanceof ApiError && [401, 403].includes(failure.status)) await onAccessError(failure);
      else setError(`${failure instanceof Error ? failure.message : '操作失败'}。结果尚未确认，请刷新或重试。`);
    } finally { if (mounted.current) setActing(false); }
  }
  async function revoke(device: Device) {
    await api.revoke(grant, device.id);
    if (device.current) { await onSignedOut(); return; }
    if (!mounted.current) return;
    setDevices(items => items.filter(item => item.id !== device.id));
    setNotice(`已撤销“${device.deviceName}”的访问。该设备需重新登录。`);
    setRefresh(value => value + 1);
  }
  return <section className="card device-manager"><h1>设备与账号</h1>
    {error && <p className="message error" role="alert">{error}</p>}
    {notice && <p className="message" role="status">{notice}</p>}
    <section aria-label="设备访问"><div className="section-heading"><div><h2>已登录的设备</h2><p className="hint">撤销后，该设备需要由家长重新登录。撤销当前设备会退出本次会话。</p></div><button className="quiet" disabled={busy} onClick={() => { setError(''); setRefresh(value => value + 1); }}>{readError ? '重试读取设备' : '刷新设备列表'}</button></div>
      {loading && <p role="status">正在读取设备…</p>}
      {readError && <p className="message error" role="alert">{readError}。设备列表暂不可用，请重试读取。</p>}
      {!loading && !readError && <><p className="table-count">有效设备 {devices.length} 台</p><div className="table-scroll" role="region" aria-label="设备表格，可横向滚动" tabIndex={0}><table className="management-table device-table" aria-label="有效设备"><thead><tr><th scope="col">设备名称</th><th scope="col">状态</th><th scope="col">登录时间</th><th scope="col">会话到期时间</th><th scope="col">操作</th></tr></thead><tbody>{devices.map(device => <tr key={device.id}><td className="table-source"><strong>{device.deviceName}</strong></td><td><span className="state-pill">{device.current ? '当前设备' : '已授权'}</span></td><td><time dateTime={new Date(device.createdAt).toISOString()}>{new Date(device.createdAt).toLocaleString('zh-CN')}</time></td><td><time dateTime={new Date(device.expiresAt).toISOString()}>{new Date(device.expiresAt).toLocaleString('zh-CN')}</time></td><td><button className="quiet" aria-label={`撤销 ${device.deviceName}`} disabled={busy} onClick={() => void run(() => revoke(device))}>撤销</button></td></tr>)}</tbody></table></div></>}
    </section>
    <section className="recovery-section" aria-label="恢复码保管"><h2>恢复码保管</h2><p>忘记家长密码时，可以使用单独保存的恢复码找回账号。</p><p className="hint">重新生成后旧码立即失效，新码只显示一次。请及时保存；完成后需要重新验证家长身份。</p><button className="quiet" disabled={busy} onClick={() => void run(async () => { const result = await api.rotateRecoveryCode(grant); onRecoveryCode(result.recoveryCode); })}>重新生成恢复码</button></section>
  </section>;
}
