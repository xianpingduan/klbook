import { lstat, readdir, rmdir, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { BackupJob } from '../shared/backups.ts';
import { describeFile, localDirectory, overlaps, verifyBackup } from './backup-files.ts';
import type { BackupEntry } from './backup-files.ts';

async function removalRoot(job: BackupJob, protectedDirectories: string[]) {
  const root = resolve(job.path);
  if (root !== job.path || basename(root) !== `klbook-backup-${job.id}` || protectedDirectories.some(path => overlaps(root, resolve(path)))) throw Error('旧备份位置不符合管理范围，未清理');
  await localDirectory(dirname(root));
  const info = await lstat(root).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!info) return null;
  if (await localDirectory(root) !== root) throw Error('旧备份位置不符合管理范围，未清理');
  return root;
}

async function scan(root: string, expected: Set<string>, allowIdleSqliteFiles: boolean) {
  const files: string[] = [], directories: string[] = [];
  const visit = async (directory: string, prefix = '') => {
    for (const entry of await readdir(directory)) {
      const relative = prefix ? `${prefix}/${entry}` : entry, path = join(directory, entry), info = await lstat(path);
      if (info.isSymbolicLink()) throw Error('旧备份包含链接，未清理');
      if (info.isDirectory()) {
        // Every generated backup has this directory, including a family that has no images yet.
        if (relative !== 'data/attachments' && ![...expected].some(file => file.startsWith(`${relative}/`))) throw Error('旧备份包含其他目录，未清理');
        await visit(path, relative); directories.push(path);
      } else {
        // SQLite's read-only WAL connections can leave these idle sidecars after verification.
        const idleSqliteFile = allowIdleSqliteFiles && (relative === 'data/family.sqlite-wal' && info.size === 0 || relative === 'data/family.sqlite-shm' && info.size === 32768);
        if (!info.isFile() || !expected.has(relative) && !idleSqliteFile) throw Error(`旧备份包含其他文件（${relative}），未清理`);
        files.push(relative);
      }
    }
  };
  await visit(root);
  return { files, directories };
}

export async function planBackupRemoval(job: BackupJob, libraryId: string, protectedDirectories: string[]) {
  const root = await removalRoot(job, protectedDirectories);
  if (!root) throw Error('旧备份目录缺失，未清理');
  const manifest = await verifyBackup(root);
  if (manifest.id !== job.id || manifest.libraryId !== libraryId || manifest.createdAt !== job.createdAt) throw Error('旧备份身份不符，未清理');
  const expected = new Set(['manifest.json', 'complete.json', ...manifest.files.map(file => file.path)]);
  const { files } = await scan(root, expected, true);
  return Promise.all(files.map(path => describeFile(root, path)));
}

export async function removeRetiredBackup(job: BackupJob, plan: BackupEntry[], protectedDirectories: string[]) {
  const root = await removalRoot(job, protectedDirectories);
  if (!root) return; // A crash may happen after rmdir but before recording completion.
  const expected = new Map(plan.map(file => [file.path, file]));
  const { files, directories } = await scan(root, new Set(expected.keys()), false);
  // The database keeps the verified allowlist before the first unlink. Missing files are already removed.
  for (const path of files) {
    const actual = await describeFile(root, path), saved = expected.get(path)!;
    if (actual.size !== saved.size || actual.sha256 !== saved.sha256) throw Error('待清理备份文件已改变，未继续清理');
  }
  // Never recursively sweep a directory: foreign files added during cleanup survive and prevent rmdir.
  for (const path of files) { await localDirectory(dirname(join(root, path))); await unlink(join(root, path)); }
  for (const path of directories) { await localDirectory(path); await rmdir(path); }
  await localDirectory(root); await rmdir(root);
}
