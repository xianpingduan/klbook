import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describeFile } from './backup-files.ts';
import type { BackupEntry } from './backup-files.ts';

// Login, authorization, temporary pins and backup bookkeeping do not constitute new material.
const transientTables = new Set(['sessions', 'parentGrants', 'attempts', 'backupSettings', 'backupJobs', 'backupAutomation', 'exportPagePins', 'importPendingPages', 'pageCleanup']);
export function databaseSignature(db: Database.Database) {
  return db.transaction(() => {
    const hash = createHash('sha256');
    for (const { name, sql } of db.prepare<[], { name: string; sql: string }>("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
      if (transientTables.has(name)) continue;
      const rows = db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all().map(row => JSON.stringify(row)).sort();
      hash.update(JSON.stringify([name, sql, rows]));
    }
    return hash.digest('hex');
  })();
}
export async function systemFiles(dataDir: string, serviceDir?: string) {
  const files: { root: string; path: string; output: string }[] = [];
  const key = await lstat(join(dataDir, 'service-credentials.key')).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (key) files.push({ root: dataDir, path: 'service-credentials.key', output: 'system/service-credentials.key' });
  if (serviceDir) {
    const visit = async (path: string) => {
      const info = await lstat(join(serviceDir, path));
      if (info.isSymbolicLink()) throw Error('运行配置包含目录链接');
      if (info.isDirectory()) { for (const child of (await readdir(join(serviceDir, path))).sort()) await visit(`${path}/${child}`); }
      else files.push({ root: serviceDir, path, output: `system/runtime/${path}` });
    };
    for (const path of ['deployment.json', 'Caddyfile', 'KlbookApp.xml', 'KlbookGateway.xml', 'gateway-state']) await visit(path);
  }
  return files;
}
export function snapshotSignature(database: string, files: BackupEntry[]) {
  return createHash('sha256').update(JSON.stringify([database, files.filter(file => file.path.startsWith('system/')).map(file => [file.path, file.sha256]).sort((a, b) => a[0]!.localeCompare(b[0]!))])).digest('hex');
}
export async function currentSignature(db: Database.Database, dataDir: string, serviceDir?: string) {
  const signature = databaseSignature(db), files: BackupEntry[] = [];
  for (const file of await systemFiles(dataDir, serviceDir)) files.push({ ...await describeFile(file.root, file.path), path: file.output });
  return snapshotSignature(signature, files);
}
