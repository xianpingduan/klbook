import type Database from 'better-sqlite3';
import SnapshotDatabase from 'better-sqlite3';
import { mkdir, lstat, readFile, unlink, open } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BackupJob, BackupSettings } from '../shared/backups.ts';
import type { Home } from '../shared/contracts.ts';
import { AccessError } from './family-access.ts';
import { copyFileBytes, describeFile, finishBackup, localDirectory, overlaps, protectDirectory, requireSpace, verifyBackup } from './backup-files.ts';
import type { BackupEntry } from './backup-files.ts';
import { currentSignature, databaseSignature, snapshotSignature, systemFiles } from './backup-snapshot.ts';
import { removeManagedBackup } from './backup-retention.ts';

interface Automation {
  ownerDataDir: string; ownerId: string; baselineDigest: string | null; lastCheckedAt: number | null; nextCheckAt: number | null;
  status: string; message: string; cleanupMessage: string;
}
const jobFields = 'id,status,createdAt,finishedAt,path,message,byteLength,trigger,removedAt';
const nextDay = (now: number) => { const date = new Date(now); date.setHours(24, 0, 0, 0); return date.getTime(); };

export class Backups {
  private db: Database.Database;
  private dataDir: string;
  private serviceDir?: string;
  private now: () => number;
  private work?: Promise<void>;
  private checking?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  constructor(db: Database.Database, dataDir: string, now = Date.now, serviceDir?: string) { this.db = db; this.dataDir = dataDir; this.serviceDir = serviceDir; this.now = now; }
  async initialize() {
    this.dataDir = await localDirectory(this.dataDir);
    if (!this.automation().ownerDataDir && !existsSync(join(this.dataDir, 'backup-restore.json')) && !existsSync(join(this.dataDir, 'system-restore'))) {
      const owner = randomUUID();
      this.db.prepare('UPDATE backupAutomation SET ownerDataDir=?, ownerId=? WHERE singleton=1').run(this.dataDir, owner);
      this.db.prepare("UPDATE backupJobs SET ownerId=? WHERE ownerId=''").run(owner);
    }
    const interrupted = this.db.prepare("UPDATE backupJobs SET status = 'failed', message = '上次备份被中断，请重新备份；已有成功备份保留', finishedAt = ? WHERE status = 'running'").run(this.now());
    if (interrupted.changes) this.db.prepare("UPDATE backupAutomation SET nextCheckAt=NULL, status='failed', message='上次备份被中断，将检查并补做' WHERE singleton=1").run();
    const settings = this.settings(), previous = settings.lastSuccess;
    if (this.owned() && !this.automation().baselineDigest && previous && dirname(previous.path) === settings.directory) {
      // Upgrade existing manual backups without inventing a content change on the first daily check.
      try {
        const manifest = await verifyBackup(previous.path);
        const library = this.db.prepare<[], { libraryId: string }>('SELECT libraryId FROM family WHERE singleton=1').get();
        if (manifest.id !== previous.id || manifest.libraryId !== library?.libraryId) throw Error('Backup identity mismatch');
        const saved = new SnapshotDatabase(join(previous.path, 'data/family.sqlite'), { readonly: true, fileMustExist: true });
        try { this.db.prepare('UPDATE backupAutomation SET baselineDigest=? WHERE singleton=1').run(snapshotSignature(databaseSignature(saved), manifest.files)); }
        finally { saved.close(); }
      } catch { /* An unreadable previous backup cannot be a baseline. Generate and verify a new one. */ }
    }
  }
  private automation() { return this.db.prepare<[], Automation>('SELECT * FROM backupAutomation WHERE singleton=1').get()!; }
  private owned() { return this.automation().ownerDataDir === this.dataDir && !existsSync(join(this.dataDir, 'backup-restore.json')); }
  schedule() {
    this.timer = setInterval(() => { void this.check(); }, 60_000);
    this.timer.unref();
    void this.check();
  }
  private async check() {
    if (this.closed || this.checking || this.work || !this.owned()) return;
    const settings = this.settings(), state = this.automation();
    const family = this.db.prepare<[], { libraryId: string }>('SELECT libraryId FROM family WHERE singleton=1').get();
    if (!family || !settings.directory || (state.nextCheckAt !== null && state.nextCheckAt > this.now())) return;
    this.checking = this.checkChanges(settings, family.libraryId).finally(() => { this.checking = undefined; });
    await this.checking;
  }
  private async checkChanges(settings: BackupSettings, libraryId: string) {
    const now = this.now();
    this.db.prepare("UPDATE backupAutomation SET lastCheckedAt=?, status='checking', message='正在检查资料变化' WHERE singleton=1").run(now);
    try {
      if (this.automation().baselineDigest === await currentSignature(this.db, this.dataDir, this.serviceDir)) {
        this.db.prepare("UPDATE backupAutomation SET status='unchanged', message='资料没有变化，无需生成新备份', nextCheckAt=? WHERE singleton=1").run(nextDay(now));
      } else this.launch(randomUUID(), settings.directory, libraryId, 'automatic');
    } catch {
      this.db.prepare("UPDATE backupAutomation SET status='failed', message='无法检查自动备份，请检查资料目录和运行配置；一小时后重试，也可立即手动备份', nextCheckAt=? WHERE singleton=1").run(now + 60 * 60_000);
    }
  }
  settings(): BackupSettings {
    const config = this.db.prepare<[], { directory: string; revision: number }>('SELECT directory, revision FROM backupSettings WHERE singleton = 1').get()!;
    const state = this.automation();
    const successful = this.db.prepare<[string], BackupJob>(`SELECT ${jobFields} FROM backupJobs WHERE status='succeeded' AND removedAt IS NULL AND ownerId=? ORDER BY finishedAt DESC,rowid DESC`).all(state.ownerId);
    const enabled = this.owned() && Boolean(config.directory);
    return { ...config, latest: this.db.prepare<[], BackupJob>(`SELECT ${jobFields} FROM backupJobs ORDER BY createdAt DESC, rowid DESC LIMIT 1`).get() ?? null,
      lastSuccess: successful[0] ?? null, successful,
      automatic: { enabled, status: enabled ? state.status : 'paused', lastCheckedAt: state.lastCheckedAt, nextCheckAt: enabled ? state.nextCheckAt : null, cleanupMessage: state.cleanupMessage,
        message: !this.owned() ? '恢复副本或资料位置已改变，自动备份已暂停；请设置独立备份目录后恢复运行' : !config.directory ? '设置备份目录后启用每日变化备份' : state.message || '每天检查变化，成功后保留最近七份备份' } };
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
    if (this.work || this.checking) throw new AccessError(409, '正在检查或生成备份，请等待完成再修改目录');
    const current = this.settings();
    if (current.revision !== expectedRevision) {
      if (current.revision === expectedRevision + 1 && current.directory === checked) return current;
      throw new AccessError(409, '备份设置已更新，请刷新后核对');
    }
    if (!this.owned()) {
      const previous = this.db.prepare<[], { path: string }>('SELECT path FROM backupJobs').all();
      if (previous.some(job => overlaps(checked, dirname(resolve(job.path))))) throw new AccessError(422, '恢复副本请使用独立备份目录，不能与原备份目录相互包含');
      this.db.prepare('UPDATE backupAutomation SET ownerDataDir=?, ownerId=? WHERE singleton=1').run(this.dataDir, randomUUID());
      await unlink(join(this.dataDir, 'backup-restore.json')).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    if (current.directory !== checked || !current.automatic.enabled) this.db.prepare("UPDATE backupAutomation SET baselineDigest=NULL, nextCheckAt=NULL, status='waiting', message='将检查资料并生成备份' WHERE singleton=1").run();
    this.db.prepare('UPDATE backupSettings SET directory = ?, revision = revision + 1 WHERE singleton = 1').run(checked);
    return this.settings();
  }
  status(id: string): BackupJob {
    const job = this.db.prepare<[string], BackupJob>(`SELECT ${jobFields} FROM backupJobs WHERE id = ?`).get(id);
    if (!job) throw new AccessError(404, '未找到这次备份，请刷新状态');
    return job;
  }
  start(authorize: () => Home, id: string, expectedRevision: number) {
    const home = authorize(), prior = this.db.prepare('SELECT 1 FROM backupJobs WHERE id = ?').get(id);
    if (prior) return this.status(id);
    const settings = this.settings();
    if (settings.revision !== expectedRevision) throw new AccessError(409, '备份设置已更新，请刷新后核对');
    if (!settings.directory) throw new AccessError(422, '请先设置备份目录');
    if (!this.owned()) throw new AccessError(422, '恢复副本请先设置独立备份目录');
    if (this.work || this.checking) throw new AccessError(409, '已有备份正在检查或生成，请等待完成');
    this.launch(id, settings.directory, home.library.id, 'manual');
    return this.status(id);
  }
  private launch(id: string, directory: string, libraryId: string, trigger: BackupJob['trigger']) {
    const path = join(directory, `klbook-backup-${id}`), now = this.now();
    this.db.prepare("INSERT INTO backupJobs(id,status,createdAt,path,message,trigger,ownerId) VALUES (?, 'running', ?, ?, '正在生成并校验备份', ?, ?)").run(id, now, path, trigger, this.automation().ownerId);
    this.db.prepare("UPDATE backupAutomation SET lastCheckedAt=?, status='running', message='正在生成并校验备份' WHERE singleton=1").run(now);
    this.work = this.build(id, directory, libraryId).finally(() => { this.work = undefined; });
  }
  async close() { this.closed = true; clearInterval(this.timer); await this.checking; await this.work; }
  private async prune(libraryId: string) {
    this.db.prepare("UPDATE backupAutomation SET status='pruning', cleanupMessage='' WHERE singleton=1").run();
    const old = this.settings().successful.slice(7);
    for (const job of old) {
      try {
        await removeManagedBackup(job, libraryId, [this.dataDir, ...(this.serviceDir ? [this.serviceDir] : [])]);
        this.db.prepare('UPDATE backupJobs SET removedAt=? WHERE id=?').run(this.now(), job.id);
      } catch (error) {
        const reason = error instanceof Error && !('code' in error) ? error.message : '旧目录不可读写，请检查目标盘和权限';
        this.db.prepare('UPDATE backupAutomation SET cleanupMessage=? WHERE singleton=1').run(`新备份已成功；${reason}。下次成功备份后再重试清理`);
        break;
      }
    }
    this.db.prepare("UPDATE backupAutomation SET status='succeeded' WHERE singleton=1").run();
  }
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
      const system = await systemFiles(this.dataDir, this.serviceDir);
      if (needsKey && !system.some(file => file.output === 'system/service-credentials.key')) throw Error('服务凭据密钥不可用');
      for (const file of system) {
        await copyFileBytes(join(file.root, file.path), join(job.path, file.output));
        files.push(await describeFile(job.path, file.output));
      }
      const signature = snapshotSignature(databaseSignature(snapshot), files);
      snapshot.close(); snapshot = undefined;
      this.db.prepare("UPDATE backupJobs SET message = '正在校验完整备份' WHERE id = ?").run(id);
      await finishBackup(job.path, { format: 'klbook-runtime-backup', version: 1, id, libraryId, createdAt: job.createdAt, files });
      this.db.transaction(() => {
        this.db.prepare("UPDATE backupJobs SET status = 'succeeded', finishedAt = ?, message = '备份已生成并通过完整性校验', byteLength = ?, snapshotDigest=? WHERE id = ?").run(this.now(), files.reduce((sum, file) => sum + file.size, 0), signature, id);
        this.db.prepare("UPDATE backupAutomation SET baselineDigest=?, nextCheckAt=?, status='succeeded', message='备份成功，次日检查资料变化' WHERE singleton=1").run(signature, nextDay(this.now()));
      })();
      await this.prune(libraryId);
    } catch (error) {
      const message = error instanceof AccessError ? error.message : error instanceof Error && !('code' in error) ? error.message : '备份未完成，请检查目标盘、可用空间、目录权限及原资料后重试';
      this.db.prepare("UPDATE backupJobs SET status = 'failed', finishedAt = ?, message = ? WHERE id = ?").run(this.now(), `${message}。已有成功备份保留。`, id);
      this.db.prepare("UPDATE backupAutomation SET status='failed', message='备份失败，一小时后自动重试；修复后也可立即手动备份', nextCheckAt=? WHERE singleton=1").run(this.now() + 60 * 60_000);
    } finally { snapshot?.close(); }
  }
}
