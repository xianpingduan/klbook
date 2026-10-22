import { lstat, readdir, rmdir, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { BackupJob } from '../shared/backups.ts';
import { localDirectory, overlaps, verifyBackup } from './backup-files.ts';

export async function removeManagedBackup(job: BackupJob, libraryId: string, protectedDirectories: string[]) {
  const root = await localDirectory(job.path);
  if (root !== resolve(job.path) || basename(root) !== `klbook-backup-${job.id}` || protectedDirectories.some(path => overlaps(root, resolve(path)))) throw Error('旧备份位置不符合管理范围，未清理');
  const manifest = await verifyBackup(root);
  if (manifest.id !== job.id || manifest.libraryId !== libraryId || manifest.createdAt !== job.createdAt) throw Error('旧备份身份不符，未清理');
  const expected = new Set(['manifest.json', 'complete.json', ...manifest.files.map(file => file.path)]);
  const files: string[] = [], directories: string[] = [];
  const scan = async (directory: string, prefix = '') => {
    for (const entry of await readdir(directory)) {
      const relative = prefix ? `${prefix}/${entry}` : entry, path = join(directory, entry), info = await lstat(path);
      if (info.isSymbolicLink()) throw Error('旧备份包含链接，未清理');
      if (info.isDirectory()) {
        if (![...expected].some(file => file.startsWith(`${relative}/`))) throw Error('旧备份包含其他目录，未清理');
        await scan(path, relative); directories.push(path);
      } else {
        // SQLite's read-only WAL connections can leave these idle sidecars after verification.
        const idleSqliteFile = relative === 'data/family.sqlite-wal' && info.size === 0 || relative === 'data/family.sqlite-shm' && info.size === 32768;
        if (!info.isFile() || !expected.has(relative) && !idleSqliteFile) throw Error(`旧备份包含其他文件（${relative}），未清理`);
        files.push(path);
      }
    }
  };
  await scan(root);
  // Delete only the verified manifest's files. An added file prevents rmdir; it is never recursively swept away.
  for (const path of files) { await localDirectory(dirname(path)); await unlink(path); }
  for (const path of directories) { await localDirectory(path); await rmdir(path); }
  await localDirectory(root); await rmdir(root);
}
