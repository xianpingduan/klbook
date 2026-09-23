import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { Home, ParentGrant } from '../shared/contracts.ts';
import type { PagePath } from '../shared/app-routes.ts';
import { pages } from '../shared/app-routes.ts';
import type { ClientPlatform } from './platform.ts';
import { ApiError, FamilyApi } from './api.ts';
import { SurfaceLayout } from './SurfaceLayout.tsx';
import { AdminOverview } from './AdminOverview.tsx';
import { CollectionWorkspace } from './CollectionWorkspace.tsx';
import { SourceManager } from './SourceManager.tsx';
import { DeviceManager } from './DeviceManager.tsx';
import { LeaveContext } from './navigation.ts';

export function AuthenticatedWorkspace({ api, home, platform, path, navigate, onSignedOut, onRecoveryCode, notice }: {
  api: FamilyApi; home: Home; platform: ClientPlatform; path: PagePath; navigate(path: PagePath): void; onSignedOut(): Promise<void>; onRecoveryCode(code: string): void; notice: string;
}) {
  const [grant, setGrant] = useState<ParentGrant>();
  const sessionActive = useRef(true);
  useEffect(() => { sessionActive.current = true; return () => { sessionActive.current = false; }; }, []);
  // Accepted device operations may finish after the management view expires.
  // Keep their results only while this authenticated session still owns the workspace.
  const deviceSignedOut = async () => { if (sessionActive.current) await onSignedOut(); };
  const recoveryCodeReady = (code: string) => {
    if (!sessionActive.current) return;
    setGrant(undefined); onRecoveryCode(code);
  };
  const { requestLeave } = useContext(LeaveContext);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [collecting, setCollecting] = useState(false);
  const [connection, setConnection] = useState('正在检查连接…');
  const admin = pages[path].surface === 'admin';
  const allowed = !admin || !!grant;
  const collectionVisible = allowed && ['/learn', '/learn/collect', '/admin/materials'].includes(path);
  const [collectionStarted, setCollectionStarted] = useState(false);
  const [sourcesStarted, setSourcesStarted] = useState(false);

  useEffect(() => {
    if (collectionVisible) setCollectionStarted(true);
    if (path === '/admin/sources' && grant) setSourcesStarted(true);
  }, [collectionVisible, path, grant]);
  useEffect(() => {
    if (!grant) return;
    const timer = window.setTimeout(() => { setGrant(undefined); setError('管理验证已到期，请重新验证。当前未提交内容仍保留。'); }, Math.max(0, grant.expiresAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [grant]);
  const accessError = useCallback(async (failure: ApiError) => {
    if (failure.status === 401) { await onSignedOut(); return; }
    setGrant(undefined); setError(failure.message);
  }, [onSignedOut]);
  useEffect(() => {
    if (path !== '/learn/mine') return;
    let active = true;
    setConnection('正在检查连接…');
    void api.home().then(() => { if (active) setConnection('家庭资料库已连接'); }).catch(async failure => {
      if (!active) return;
      if (failure instanceof ApiError && failure.status === 401) await onSignedOut();
      else setConnection('暂时无法连接家庭电脑');
    });
    return () => { active = false; };
  }, [path, api, onSignedOut]);
  async function run(action: () => Promise<void>) {
    setBusy(true); setError('');
    try { await action(); }
    catch (failure) {
      if (failure instanceof ApiError && [401, 403].includes(failure.status)) await accessError(failure);
      else setError(failure instanceof Error ? failure.message : '操作失败，请重试');
    } finally { setBusy(false); }
  }
  function unlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const password = String(new FormData(event.currentTarget).get('password') ?? '');
    event.currentTarget.reset();
    void run(async () => { setGrant(await api.unlock(password)); });
  }
  const lock = () => requestLeave(() => void run(async () => { if (grant) await api.lock(grant.token); setGrant(undefined); navigate('/learn'); }));
  return <SurfaceLayout path={path} navigate={navigate} authenticated managing={!!grant} editing={collectionVisible && collecting} busy={busy} onLock={lock}>
    {notice && <p className="message" role="status">{notice}</p>}
    {error && <p className="message error" role="alert">{error}</p>}
    {admin && !grant && <section className="card auth-card"><p className="eyebrow">家长管理</p><h1>验证家长身份</h1><p>管理权限在 5 分钟后自动结束。孩子的日常会话不会获得管理权限。</p><form onSubmit={unlock}><fieldset disabled={busy}><label>家长密码<input type="password" name="password" autoComplete="current-password" required minLength={12} maxLength={128} /></label><button type="submit">验证并进入管理</button></fieldset></form><button className="quiet" disabled={busy} onClick={() => { setError(''); navigate('/learn'); }}>返回错题集</button></section>}
    {path === '/admin' && grant && <AdminOverview api={api} grant={grant.token} onAccessError={accessError} />}
    {path === '/learn' && !collecting && <section className="learn-welcome"><h1>{home.library.learnerName}的错题集</h1><div className="encouragement"><span>给自己一点鼓励</span><h2>不会的题，可以慢慢弄懂。</h2><p>每一次认真回看，都是一点进步。</p></div></section>}
    <div hidden={!collectionVisible} inert={!collectionVisible}>
      {collectionStarted && <CollectionWorkspace api={api} home={home} platform={platform} path={path} active={collectionVisible} mode={path === '/learn' ? 'home' : path === '/learn/collect' ? 'collect' : 'workspace'} grant={grant?.token} onEditing={setCollecting} onAccessError={accessError} />}
    </div>
    <div hidden={path !== '/admin/sources' || !grant} inert={path !== '/admin/sources' || !grant}>
      {sourcesStarted && <section className="card"><h1>来源管理</h1><SourceManager api={api} grant={grant?.token} active={path === '/admin/sources'} onAccessError={accessError} /></section>}
    </div>
    {path === '/admin/devices' && grant && <DeviceManager api={api} grant={grant.token} onAccessError={accessError} onSignedOut={deviceSignedOut} onRecoveryCode={recoveryCodeReady} />}
    {path === '/learn/mine' && <section className="card"><h1>我的</h1><p role="status">{connection}</p><dl><div><dt>学习者</dt><dd>{home.library.learnerName}</dd></div><div><dt>家长账号</dt><dd>{home.account.username}</dd></div><div><dt>当前设备</dt><dd>{home.session.deviceName}</dd></div></dl><details open><summary>资料库身份</summary><code data-testid="library-id">{home.library.id}</code></details><button onClick={() => { setError(''); navigate('/admin'); }}>家长管理</button><button className="quiet" disabled={busy} onClick={() => void run(async () => { await api.logout(); await onSignedOut(); })}>退出此设备</button></section>}
  </SurfaceLayout>;
}
