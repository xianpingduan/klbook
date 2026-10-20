import { stat, writeFile, open, unlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';

/** A local maintenance record, separate from HTTP so startup failures remain readable. */
export class StartupStatus {
  private startedAt = Date.now();
  private file: string | undefined;
  constructor(file: string | undefined) {
    if (file && !isAbsolute(file)) throw new Error('启动状态文件必须是绝对路径');
    this.file = file;
  }
  async report(phase: 'checking' | 'ready' | 'failed' | 'stopped', message: string) {
    if (this.file) await writeFile(this.file, JSON.stringify({ version: 1, phase, message, pid: process.pid, startedAt: this.startedAt, updatedAt: Date.now() }), { mode: 0o600 });
  }
}

export async function checkExistingData(dataDir: string, expectedLibraryId?: string) {
  if (!isAbsolute(dataDir)) throw new Error('数据目录必须是绝对路径');
  if (!(await stat(dataDir).catch(() => null))?.isDirectory()) throw new Error('数据目录不存在或无法读取，请恢复原目录后重新启动');
  const databasePath = join(dataDir, 'family.sqlite'), attachments = join(dataDir, 'attachments');
  if (!(await stat(databasePath).catch(() => null))?.isFile()) throw new Error('原家庭数据库不存在或无法读取，不会新建空库');
  if (!(await stat(attachments).catch(() => null))?.isDirectory()) throw new Error('附件目录不存在或无法读取，请恢复原目录');
  for (const directory of [dataDir, attachments]) {
    const probe = join(directory, `.startup-${randomUUID()}`);
    let created = false;
    try { const file = await open(probe, 'wx'); created = true; try { await file.writeFile('klbook'); await file.sync(); } finally { await file.close(); } }
    catch { throw new Error(directory === dataDir ? '数据目录不可写，请检查磁盘空间与服务账号权限' : '附件目录不可写，请检查磁盘空间与服务账号权限'); }
    finally { if (created) await unlink(probe); }
  }
  let db: Database.Database;
  try { db = new Database(databasePath, { fileMustExist: true, readonly: true }); }
  catch { throw new Error('数据库无法打开，请检查文件和权限'); }
  try {
    if (db.pragma('quick_check', { simple: true }) !== 'ok' || (db.pragma('foreign_key_check') as unknown[]).length) throw new Error('数据库完整性检查失败，请使用完整备份恢复');
    const family = db.prepare<[], { libraryId: string }>('SELECT libraryId FROM family WHERE singleton = 1').get();
    if (!family) throw new Error('家庭资料库尚未初始化，请先在本机完成设置');
    if (expectedLibraryId && expectedLibraryId !== family.libraryId) throw new Error('资料库身份与安装配置不符，请核对原数据目录');
    const pages = db.prepare<[], { id: string; sha256: string; previewSha256: string }>('SELECT id, sha256, previewSha256 FROM originalPages').all();
    for (const page of pages) {
      if (!/^[0-9a-f-]{36}$/i.test(page.id)) throw new Error('数据库附件标识异常，请核对备份');
      for (const [variant, expected] of [['original', page.sha256], ['preview', page.previewSha256]] as const) {
        try {
          const hash = createHash('sha256');
          for await (const bytes of createReadStream(join(attachments, 'pages', page.id, variant))) hash.update(bytes);
          if (hash.digest('hex') !== expected) throw new Error('Hash mismatch');
        } catch { throw new Error(`附件缺失、不可读或内容校验失败：${page.id}/${variant}。请恢复原文件后重启`); }
      }
    }
    return family;
  } finally { db.close(); }
}
