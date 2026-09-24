import { useEffect, useState } from 'react';
import type { ClientPlatform } from './platform.ts';
import { FamilyApi } from './api.ts';

export function ConnectionSettings({ platform, onConnected, onBack }: {
  platform: ClientPlatform; onConnected(connection: Awaited<ReturnType<typeof FamilyApi.select>>): void; onBack(): void;
}) {
  const [address, setAddress] = useState('');
  const [current, setCurrent] = useState('');
  const [checked, setChecked] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => {
    let live = true;
    void Promise.all([platform.target.read(), platform.target.readPending()]).then(([value, pending]) => { if (live) { setCurrent(value); setAddress(pending ?? value); if (pending) setNotice('已读取待连接地址，当前连接保持不变。'); } })
      .catch(() => { if (live) setError('当前地址无法读取，请重新填写服务地址。'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [platform]);
  async function run(action: 'test' | 'use' | 'save') {
    if (busy || loading) return;
    setBusy(true); setError(''); setNotice(''); setChecked('');
    try {
      if (action === 'use') onConnected(await FamilyApi.select(platform, address));
      else if (action === 'save') { await platform.target.writePending(address); setNotice('已保存待连接地址，当前连接保持不变。测试成功后再确认使用。'); }
      else { await FamilyApi.probe(platform, address); setChecked(address); setNotice('连接成功，服务兼容。使用此地址后仍需登录。'); }
    } catch (failure) { setError(failure instanceof Error ? failure.message : '连接失败，请重试'); }
    finally { setBusy(false); }
  }
  return <section className="card connection-settings"><div className="section-heading"><h1>连接设置</h1><button className="quiet" disabled={busy} onClick={onBack}>返回</button></div>
    <p>由家长填写家庭电脑提供的服务地址。只影响当前浏览器，其他设备保持自己的设置。</p>
    <dl><div><dt>当前服务地址</dt><dd><code>{current || '尚未读取'}</code></dd></div></dl>
    {error && <p role="alert" className="message error">{error}</p>}
    {notice && <p role="status" className="message">{notice}</p>}
    <fieldset disabled={loading || busy}>
      <label>后端服务地址<input type="text" inputMode="url" autoComplete="off" spellCheck={false} maxLength={2048} value={address} onChange={event => { setAddress(event.target.value); setChecked(''); setNotice(''); setError(''); }} placeholder="https://192.168.3.208:8443" /></label>
      <p className="hint">填写协议、电脑IP或主机名和端口，例如 https://家庭电脑名称:8443。请使用设备已信任证书的HTTPS地址；本机开发可用HTTP回环地址。</p>
      <div className="save-actions"><button onClick={() => void run('test')}>{busy ? '正在处理…' : '测试连接'}</button><button className="quiet" onClick={() => void run('save')}>保存待连接地址</button><button disabled={!checked || checked !== address} onClick={() => void run('use')}>使用此地址并登录</button></div>
    </fieldset>
    <details className="connection-help"><summary>连接失败时怎么检查</summary><p>确认电脑服务运行、设备在同一局域网、证书受信任，并允许浏览器访问本地网络。不同网页入口连接此服务时，还需在目标电脑允许当前网页来源。</p><p>当前网页来源：<code>{window.location.origin}</code></p><p>家庭电脑的 KLBOOK_ALLOWED_ORIGINS 需包含此来源；配置后重启应用服务。这里只改变资料请求地址，不改变网页入口。换网页来源时，浏览器暂存不会自动共享。</p></details>
  </section>;
}
