import type { ReactNode } from 'react';

export function SaveConflict({ current, local, loading, error, disabled, onRefresh, onKeep, onAdopt }: {
  current?: ReactNode; local: ReactNode; loading: boolean; error: string; disabled: boolean;
  onRefresh(): void; onKeep(): void; onAdopt(): void;
}) {
  return <section className="save-conflict" aria-label="处理保存冲突">
    <h2>其他设备已经更新，请先核对</h2>
    <p>本次编辑仍保留，尚未覆盖资料库。先比较双方内容，再决定如何继续。</p>
    {loading && <p role="status">正在读取当前版本…</p>}
    {error && <p role="alert" className="message error">{error}</p>}
    <div className="conflict-versions">
      <section aria-label="当前版本"><h3>当前版本</h3>{current ?? <p>读取成功后才能选择处理方式。</p>}</section>
      <section aria-label="本次编辑"><h3>本次编辑</h3>{local}</section>
    </div>
    <p className="hint">“保留本次编辑”只更新核对起点，不会立即保存。请在下方编辑区合并需要保留的信息，再保存；若其间又有更新，会再次提示冲突。“采用当前版本”会放弃本次尚未保存的编辑。</p>
    <div className="save-actions">
      <button disabled={disabled || loading || !current} onClick={onKeep}>保留本次编辑，继续核对</button>
      <button className="quiet" disabled={disabled || loading || !current} onClick={onAdopt}>放弃本次编辑，采用当前版本</button>
      <button className="quiet" disabled={disabled || loading} onClick={onRefresh}>重新读取当前版本</button>
    </div>
  </section>;
}
