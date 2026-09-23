import { useState } from 'react';
import { useLeaveGuard } from './navigation.ts';

export function RecoveryCodeNotice({ code, onContinue }: { code: string; onContinue(): void }) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [warning, setWarning] = useState('');
  const { releaseGuard } = useLeaveGuard(true, () => setWarning('请先保存恢复码并勾选确认，再继续使用。'));
  return <section className="card auth-card">
    <p className="eyebrow">家长专用 · 请单独保管</p><h1>请保存恢复码</h1>
    <p>忘记密码时，用它恢复账号。此码只显示这一次；恢复账号后会生成新码，旧码失效。</p>
    {warning && <p className="message error" role="alert">{warning}</p>}
    <label>恢复码<input className="recovery-code" readOnly value={code} autoComplete="off" /></label>
    <label className="check"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} />我已将恢复码保存在安全的地方</label>
    <button disabled={!acknowledged} onClick={() => { releaseGuard(); onContinue(); }}>进入错题集</button>
  </section>;
}
