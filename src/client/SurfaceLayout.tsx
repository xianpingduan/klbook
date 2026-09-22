import { useState } from 'react';
import type { ReactNode } from 'react';
import { pages } from '../shared/app-routes.ts';
import type { PagePath } from '../shared/app-routes.ts';

export function SurfaceLayout({ path, navigate, children, authenticated = false, managing = false, editing = false, busy = false, onLock }: {
  path: PagePath; navigate(path: PagePath): void; children: ReactNode; authenticated?: boolean; managing?: boolean; editing?: boolean; busy?: boolean; onLock?(): void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const surface = pages[path].surface;
  const nav = (target: PagePath) => { navigate(target); setMenuOpen(false); };
  const admin = surface === 'admin';
  return <div className="app-surface" data-surface={surface}>
    <div className="surface-layout">
      {admin && authenticated && managing && <aside className={`admin-sidebar ${menuOpen ? 'is-open' : ''}`}>
        <div className="brand"><span className="mark" aria-hidden="true">记</span><div><strong>错题集</strong><span className="caption">家长管理</span></div></div>
        <nav aria-label="管理导航">{(Object.keys(pages) as PagePath[]).filter(key => pages[key].surface === 'admin').map(key => <button key={key} className="quiet" aria-current={path === key ? 'page' : undefined} onClick={() => nav(key)}>{pages[key].label}</button>)}</nav>
      </aside>}
      <div className="surface-main" key="main">
        <header className="surface-header">
          {admin && managing ? <><div className="header-title"><button className="quiet menu-toggle" aria-expanded={menuOpen} onClick={() => setMenuOpen(value => !value)}>管理菜单</button><span>家长管理 / {pages[path].label}</span></div><button className="quiet" disabled={busy} onClick={onLock}>结束管理</button></> : <div className="brand"><span className="mark" aria-hidden="true">记</span><div><strong>错题集</strong><span className="caption">{admin ? '家长管理' : '一点点整理，一点点进步'}</span></div></div>}
        </header>
        <main>{children}</main>
        <footer>家庭电脑保存资料 · 一点点进步</footer>
      </div>
    </div>
    {!admin && authenticated && !editing && <nav className="learn-tabs" aria-label="学习导航">{(Object.keys(pages) as PagePath[]).filter(key => pages[key].surface === 'learn').map(key => <button key={key} aria-current={path === key ? 'page' : undefined} onClick={() => nav(key)}>{pages[key].label}</button>)}</nav>}
  </div>;
}
