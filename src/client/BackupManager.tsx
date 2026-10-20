import { useEffect, useRef, useState } from 'react';
import type { BackupSettings } from '../shared/backups.ts';
import { ApiError, FamilyApi } from './api.ts';

export function BackupManager({ api, grant, active, onAccessError }: { api: FamilyApi; grant?: string; active: boolean; onAccessError(error: ApiError): Promise<void> }) {
  const [settings, setSettings] = useState<BackupSettings>();
  const [directory, setDirectory] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [refresh, setRefresh] = useState(0);
  const initialized = useRef(false), operation = useRef<{ id: string; revision: number }>(undefined);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  async function failure(reason: unknown) {
    if (!alive.current) return;
    setError(reason instanceof Error ? reason.message : '备份操作未完成，请重试');
    if (reason instanceof ApiError && [401, 403].includes(reason.status)) await onAccessError(reason);
  }
  useEffect(() => {
    if (!active || !grant) return;
    let current = true;
    void api.backups(grant).then(value => {
      if (!current) return;
      setSettings(value);
      if (!initialized.current) { setDirectory(value.directory); initialized.current = true; }
    }).catch(reason => { if (current) void failure(reason); });
    return () => { current = false; };
  }, [api, active, grant, refresh]);
  useEffect(() => {
    if (!active || !grant || settings?.latest?.status !== 'running') return;
    const timer = window.setTimeout(() => setRefresh(value => value + 1), 1000);
    return () => window.clearTimeout(timer);
  }, [active, grant, settings, refresh]);
  async function save() {
    if (!grant || !settings || busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const next = await api.saveBackupDirectory(grant, directory.trim(), settings.revision);
      if (alive.current) { setSettings(next); setDirectory(next.directory); setNotice('备份目录已保存'); }
    } catch (reason) { await failure(reason); }
    finally { if (alive.current) setBusy(false); }
  }
  async function start() {
    if (!grant || !settings || busy) return;
    setBusy(true); setError(''); setNotice('');
    operation.current ??= { id: crypto.randomUUID(), revision: settings.revision };
    try {
      const job = await api.startBackup(grant, operation.current.id, operation.current.revision);
      if (alive.current) { operation.current = undefined; setSettings(value => value && ({ ...value, latest: job })); setRefresh(value => value + 1); }
    } catch (reason) {
      if (reason instanceof ApiError && [409, 422].includes(reason.status)) operation.current = undefined;
      await failure(reason);
    } finally { if (alive.current) setBusy(false); }
  }
  const running = settings?.latest?.status === 'running';
  return <section className="card backup-manager">
    <div className="section-heading"><h1>资料库备份</h1><button className="quiet" disabled={busy} onClick={() => { setError(''); initialized.current = false; setRefresh(value => value + 1); }}>刷新状态</button></div>
    <p>保存整个家庭资料库，包括账号、已同步资料、服务器草稿、回收站、归档及管理配置。其他设备尚未上传的内容不在备份内。</p>
    <p>学习资料包用于交换学习材料；完整备份用于恢复家庭资料库，两者范围不同。</p>
    {error && <p className="message error" role="alert">{error}</p>}
    {notice && <p className="message" role="status">{notice}</p>}
    {!settings ? <p>正在读取备份设置…</p> : <>
      <form onSubmit={event => { event.preventDefault(); void save(); }}>
        <fieldset disabled={busy || running || !grant}>
          <label>家庭电脑上的备份目录<input value={directory} onChange={event => setDirectory(event.target.value)} required maxLength={1024} autoComplete="off" spellCheck={false} placeholder="例如 E:\家庭备份" /></label>
          <p className="hint">填写电脑上已经创建的目录，服务账号需要写入权限。目录须与资料和程序目录分开。同盘副本不能防止整盘损坏，可按现有存储条件选择位置。</p>
          <button type="submit">保存备份目录</button>
        </fieldset>
      </form>
      <h2>生成备份</h2>
      <p>备份文件仅保存在家庭电脑，不通过网页下载。服务密钥和运行配置放在单独受限的区域；请妥善保管整个备份目录。</p>
      <button disabled={busy || running || !grant || !settings.directory || directory.trim() !== settings.directory} onClick={() => void start()}>{operation.current ? '重试本次备份' : running ? '正在备份…' : '立即备份'}</button>
      {settings.latest && <div className={`message ${settings.latest.status === 'failed' ? 'error' : ''}`} role={settings.latest.status === 'failed' ? 'alert' : 'status'}><p>{settings.latest.message}</p><p className="backup-path">{settings.latest.path}</p></div>}
      <dl><div><dt>最近成功备份</dt><dd>{settings.lastSuccess?.finishedAt ? new Date(settings.lastSuccess.finishedAt).toLocaleString('zh-CN') : '尚无成功备份'}</dd></div>
        {settings.lastSuccess && <div><dt>成功备份位置</dt><dd className="backup-path">{settings.lastSuccess.path}</dd></div>}</dl>
      <details><summary>如何恢复</summary><p>先在家庭电脑使用备份恢复工具校验，再恢复到一个新的隔离目录，用原账号登录检查资料。确认完整后再切换正式服务；不要覆盖正在使用的数据目录。</p><p>必要系统配置需要单独确认恢复，运行路径和局域网证书须按电脑部署说明核对。当前提供手动备份，自动日备份和保留规则将在后续启用。</p></details>
    </>}
  </section>;
}
