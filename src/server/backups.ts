import type Database from 'better-sqlite3';
import SnapshotDatabase from 'better-sqlite3';
import { mkdir, lstat, readFile, readdir, unlink, open } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BackupJob, BackupSettings } from '../shared/backups.ts';
import type { Home } from '../shared/contracts.ts';
import { AccessError } from './family-access.ts';
import { copyFileBytes, describeFile, finishBackup, localDirectory, overlaps, protectDirectory, requireSpace } from './backup-files.ts';
import type { BackupEntry } from './backup-files.ts';

export class Backups {
  private db: Database.Database;
  private dataDir: string;
  private serviceDir?: string;
  private now: () => number;
  private work?: Promise<void>;
  constructor(db: Database.Database, dataDir: string, now = Date.now, serviceDir?: string) { this.db = db; this.dataDir = dataDir; this.serviceDir = serviceDir; this.now = now; }
  initialize() { this.db.prepare("UPDATE backupJobs SET status = 'failed', message = '上次备份被中断，请重新备份；已有成功备份保留', finishedAt = ? WHERE status = 'running'").run(this.now()); }
  settings(): BackupSettings {
    const config = this.db.prepare<[], { directory: string; revision: number }>('SELECT directory, revision FROM backupSettings WHERE singleton = 1').get()!;
    return { ...config, latest: this.db.prepare<[], BackupJob>('SELECT * FROM backupJobs ORDER BY createdAt DESC, rowid DESC LIMIT 1').get() ?? null,
      lastSuccess: this.db.prepare<[], BackupJob>("SELECT * FROM backupJobs WHERE status = 'succeeded' ORDER BY createdAt DESC, rowid DESC LIMIT 1").get() ?? null };
  }
  private async directory(value: string) {
    try {
      const directory = await localDirectory(value), data = await localDirectory(this.dataDir);
      if (overlaps(directory, data) || (this.serviceDir && overlaps(directory, await localDirectory(this.serviceDir)))) throw Error('备份目录须独立于资料目录和运行目录');
      const probe = join(directory, `.klbook-write-${randomUUID()}`);
      const file = await open(probe, 'wx', 0o600);
      try { await file.writeFile('klbook'); await file.sync(); } finally { await file.close(); await unlink(probe); }
      await requireSpace(directory, 0);
      return directory;
    } catch (error) { throw new AccessError(422, error instanceof Error && !('code' in error) ? error.message : '备份目录不存在或不可写，请连接目标盘并检查目录权限'); }
  }
  async configure(authorize: () => Home, directory: string, expectedRevision: number) {
    authorize();
    const checked = await this.directory(directory);
    authorize();
    const current = this.settings();
    if (current.revision !== expectedRevision) {
      if (current.revision === expectedRevision + 1 && current.directory === checked) return current;
      throw new AccessError(409, '备份设置已更新，请刷新后核对');
    }
    this.db.prepare('UPDATE backupSettings SET directory = ?, revision = revision + 1 WHERE singleton = 1').run(checked);
    return this.settings();
  }
  status(id: string): BackupJob {
    const job = this.db.prepare<[string], BackupJob>('SELECT * FROM backupJobs WHERE id = ?').get(id);
    if (!job) throw new AccessError(404, '未找到这次备份，请刷新状态');
    return job;
  }
  start(authorize: () => Home, id: string, expectedRevision: number) {
    const home = authorize(), prior = this.db.prepare('SELECT 1 FROM backupJobs WHERE id = ?').get(id);
    if (prior) return this.status(id);
    const settings = this.settings();
    if (settings.revision !== expectedRevision) throw new AccessError(409, '备份设置已更新，请刷新后核对');
    if (!settings.directory) throw new AccessError(422, '请先设置备份目录');
    if (this.work) throw new AccessError(409, '已有备份正在生成，请等待完成');
    const path = join(settings.directory, `klbook-backup-${id}`);
    this.db.prepare("INSERT INTO backupJobs VALUES (?, 'running', ?, NULL, ?, '正在生成并校验备份', NULL)").run(id, this.now(), path);
    this.work = this.build(id, settings.directory, home.library.id).finally(() => { this.work = undefined; });
    return this.status(id);
  }
  async close() { await this.work; }
  private async build(id: string, directory: string, libraryId: string) {
    const job = this.status(id);
    let snapshot: SnapshotDatabase.Database | undefined;
    try {
      await this.directory(directory);
      const estimated = (await lstat(join(this.dataDir, 'family.sqlite'))).size * 2
        + this.db.prepare<[], { size: number }>('SELECT COALESCE(SUM(byteLength), 0) AS size FROM originalPages').get()!.size * 2;
      await requireSpace(directory, estimated);
      let ownerSid: string | undefined;
      if (this.serviceDir) {
        const config = JSON.parse(await readFile(join(this.serviceDir, 'deployment.json'), 'utf8'));
        if (resolve(config.dataDir) !== resolve(this.dataDir)) throw Error('运行配置与当前资料目录不符');
        ownerSid = config.ownerSid;
      }
      await mkdir(job.path, { mode: 0o700 });
      await protectDirectory(job.path, ownerSid);
      await mkdir(join(job.path, 'data', 'attachments'), { recursive: true, mode: 0o700 });
      await this.db.backup(join(job.path, 'data', 'family.sqlite'));
      snapshot = new SnapshotDatabase(join(job.path, 'data', 'family.sqlite'), { readonly: true, fileMustExist: true });
      this.db.prepare("UPDATE backupJobs SET message = '正在复制并校验附件' WHERE id = ?").run(id);
      const files: BackupEntry[] = [await describeFile(job.path, 'data/family.sqlite')];
      for (const page of snapshot.prepare<[], { id: string; sha256: string; previewSha256: string }>('SELECT id, sha256, previewSha256 FROM originalPages').all()) {
        if (!/^[a-f0-9-]{36}$/i.test(page.id)) throw Error('附件标识异常');
        for (const variant of ['original', 'preview'] as const) {
          const path = `data/attachments/pages/${page.id}/${variant}`;
          await copyFileBytes(join(this.dataDir, 'attachments', 'pages', page.id, variant), join(job.path, path));
          const entry = await describeFile(job.path, path);
          if (entry.sha256 !== (variant === 'original' ? page.sha256 : page.previewSha256)) throw Error('原图或预览校验失败，请修复原资料后重试');
          files.push(entry);
        }
      }
      const needsKey = snapshot.prepare("SELECT 1 FROM ocrProviderCredentials UNION ALL SELECT 1 FROM speechSettings WHERE credentials IS NOT NULL UNION ALL SELECT 1 FROM aiModelCredentials LIMIT 1").get();
      const keyPath = join(this.dataDir, 'service-credentials.key');
      if (needsKey || await lstat(keyPath).then(() => true, () => false)) {
        if ((await readFile(keyPath)).length !== 32) throw Error('服务凭据密钥不可用');
        await copyFileBytes(keyPath, join(job.path, 'system/service-credentials.key'));
        files.push(await describeFile(job.path, 'system/service-credentials.key'));
      }
      if (this.serviceDir) {
        const copy = async (path: string) => {
          const input = join(this.serviceDir!, path), info = await lstat(input);
          if (info.isSymbolicLink()) throw Error('运行配置包含目录链接');
          if (info.isDirectory()) { for (const child of await readdir(input)) await copy(`${path}/${child}`); }
          else {
            const output = `system/runtime/${path}`;
            await copyFileBytes(input, join(job.path, output));
            files.push(await describeFile(job.path, output));
          }
        };
        for (const path of ['deployment.json', 'Caddyfile', 'KlbookApp.xml', 'KlbookGateway.xml', 'gateway-state']) await copy(path);
      }
      snapshot.close(); snapshot = undefined;
      this.db.prepare("UPDATE backupJobs SET message = '正在校验完整备份' WHERE id = ?").run(id);
      await finishBackup(job.path, { format: 'klbook-runtime-backup', version: 1, id, libraryId, createdAt: job.createdAt, files });
      this.db.prepare("UPDATE backupJobs SET status = 'succeeded', finishedAt = ?, message = '备份已生成并通过完整性校验', byteLength = ? WHERE id = ?").run(this.now(), files.reduce((sum, file) => sum + file.size, 0), id);
    } catch (error) {
      const message = error instanceof AccessError ? error.message : error instanceof Error && !('code' in error) ? error.message : '备份未完成，请检查目标盘、可用空间、目录权限及原资料后重试';
      this.db.prepare("UPDATE backupJobs SET status = 'failed', finishedAt = ?, message = ? WHERE id = ?").run(this.now(), `${message}。已有成功备份保留。`, id);
    } finally { snapshot?.close(); }
  }
}
