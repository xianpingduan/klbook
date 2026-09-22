import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { Home, SessionResult } from '../shared/contracts.ts';
import type { ClientPlatform } from './platform.ts';
import { ApiError, FamilyApi } from './api.ts';
import { AuthenticatedWorkspace } from './AuthenticatedWorkspace.tsx';
import { SurfaceLayout } from './SurfaceLayout.tsx';
import { usePage } from './navigation.ts';

function Field({ label, name, type = 'text', value, autoComplete, minLength }: { label: string; name: string; type?: string; value?: string; autoComplete?: string; minLength?: number }) {
  return <label>{label}<input name={name} type={type} defaultValue={value} autoComplete={autoComplete} minLength={minLength} maxLength={name.toLowerCase().includes('password') || name.includes('Code') ? 128 : 64} required /></label>;
}
const value = (data: FormData, name: string) => String(data.get(name) ?? '');

export function App({ platform }: { platform: ClientPlatform }) {
  const [api, setApi] = useState<FamilyApi>();
  const [screen, setScreen] = useState<'loading' | 'setup' | 'login' | 'recovery' | 'save-code' | 'home'>('loading');
  const [home, setHome] = useState<Home>();
  const [recoveryCode, setRecoveryCode] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const { path, navigate } = usePage();
  const signedOut = useCallback(async () => { await api?.forget(); setHome(undefined); setScreen('login'); }, [api]);

  async function boot() {
    setError(''); setScreen('loading');
    try {
      const connection = await FamilyApi.connect(platform);
      setApi(connection.api);
      if (!connection.info.initialized) { setScreen('setup'); return; }
      try { setHome(await connection.api.home()); setScreen('home'); }
      catch (failure) {
        if (!(failure instanceof ApiError && failure.status === 401)) throw failure;
        await connection.api.forget(); setScreen('login');
      }
    } catch (failure) { setError(failure instanceof Error ? failure.message : '连接失败'); }
  }
  useEffect(() => { void boot(); }, [platform]);

  async function run(action: () => Promise<void>) {
    setBusy(true); setError('');
    try { await action(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '操作失败，请重试'); }
    finally { setBusy(false); }
  }
  async function signedIn(result: SessionResult) {
    if (!await api!.remember(result)) setNotice('此浏览器无法保存登录状态；本次可以使用，关闭后需重新登录。');
    setHome({ account: result.account, library: result.library, session: result.session });
    if (result.recoveryCode) { setRecoveryCode(result.recoveryCode); setAcknowledged(false); setScreen('save-code'); }
    else setScreen('home');
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const password = value(data, 'password');
    const passwordField = event.currentTarget.querySelector<HTMLInputElement>('input[type="password"]');
    if (passwordField) passwordField.value = '';
    void run(async () => {
      const deviceName = value(data, 'deviceName');
      if (screen === 'setup') await signedIn(await api!.setup({ setupCode: value(data, 'setupCode'), username: value(data, 'username'), password, learnerName: value(data, 'learnerName'), deviceName }));
      else if (screen === 'recovery') await signedIn(await api!.recover({ recoveryCode: value(data, 'recoveryCode'), newPassword: password, deviceName }));
      else await signedIn(await api!.login({ username: value(data, 'username'), password, deviceName }));
    });
  }

  if (screen === 'home' && home && api) return <AuthenticatedWorkspace key={home.session.id} api={api} home={home} platform={platform} path={path} navigate={navigate} notice={notice} onSignedOut={signedOut} onRecoveryCode={code => { setRecoveryCode(code); setAcknowledged(false); setScreen('save-code'); }} />;
  return <SurfaceLayout path={path} navigate={navigate}>
    {error && <p role="alert" className="message error">{error}</p>}
    {notice && <p role="status" className="message">{notice}</p>}
    {screen === 'loading' && <section className="card"><h1>连接家庭资料库</h1><p>请保持家庭电脑开机，并运行错题集服务。</p>{error ? <button onClick={() => void boot()}>重新连接</button> : <p role="status">正在连接…</p>}</section>}
    {['setup', 'login', 'recovery'].includes(screen) && <section className="card auth-card" key={screen}>
      <p className="eyebrow">由家长完成</p>
      <h1>{screen === 'setup' ? '建立家庭资料库' : screen === 'recovery' ? '恢复家长账号' : '登录家庭资料库'}</h1>
      <p className="intro">{screen === 'setup' ? '建立一个家庭资料库，供孩子的常用设备共同使用。' : screen === 'recovery' ? '使用已保存的恢复码设置新密码。所有旧设备将退出，需要重新登录。' : '登录后保持日常学习状态；管理设备时仍需验证家长密码。'}</p>
      <form onSubmit={submit}><fieldset disabled={busy}>
        {screen === 'setup' && <><Field label="本机设置码" name="setupCode" autoComplete="off" /><p className="hint">在家庭电脑上打开启动提示中的 setup-code.txt，将设置码填入。</p></>}
        {screen === 'recovery' ? <Field label="恢复码" name="recoveryCode" autoComplete="off" /> : <Field label="家长账号" name="username" autoComplete="username" />}
        <Field label={screen === 'recovery' ? '新的家长密码' : '家长密码'} name="password" type="password" autoComplete={screen === 'login' ? 'current-password' : 'new-password'} minLength={12} />
        <p className="hint">密码为 12～128 个字符，可以使用容易记住的长短语。</p>
        {screen === 'setup' && <Field label="学习者称呼" name="learnerName" autoComplete="off" />}
        <Field label="设备名称" name="deviceName" value="我的设备" autoComplete="off" />
        <button type="submit">{busy ? '请稍候…' : screen === 'setup' ? '建立资料库' : screen === 'recovery' ? '重设密码并登录' : '登录此设备'}</button>
      </fieldset></form>
      {screen === 'login' && <button className="quiet" disabled={busy} onClick={() => { setError(''); setScreen('recovery'); }}>忘记密码，使用恢复码</button>}
      {screen === 'recovery' && <button className="quiet" disabled={busy} onClick={() => { setError(''); setScreen('login'); }}>返回登录</button>}
    </section>}
    {screen === 'save-code' && <section className="card"><p className="eyebrow">家长专用 · 请单独保管</p><h1>请保存恢复码</h1><p>忘记密码时，用它恢复账号。此码只显示这一次；恢复账号后会生成新码，旧码失效。</p><label>恢复码<input className="recovery-code" readOnly value={recoveryCode} /></label><label className="check"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} />我已将恢复码保存在安全的地方</label><button disabled={!acknowledged} onClick={() => { setRecoveryCode(''); setScreen('home'); }}>进入错题集</button></section>}
  </SurfaceLayout>;
}
