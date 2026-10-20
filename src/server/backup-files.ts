import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, readFile, realpath, statfs, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { checkExistingData } from './startup.ts';
import Database from 'better-sqlite3';
import { CredentialVault } from './credential-vault.ts';

const exec = promisify(execFile);
export interface BackupEntry { path: string; size: number; sha256: string }
export interface BackupManifest {
  format: 'klbook-runtime-backup'; version: 1; id: string; libraryId: string; createdAt: number; files: BackupEntry[];
}
export function overlaps(a: string, b: string) {
  const inside = (parent: string, child: string) => { const part = relative(parent, child); return !part || (!part.startsWith(`..${sep}`) && part !== '..' && !isAbsolute(part)); };
  return inside(a, b) || inside(b, a);
}
// Refuse links/junctions along the whole path, including an existing restore parent.
export async function localDirectory(path: string) {
  if (!isAbsolute(path) || path.startsWith('\\\\') || path.startsWith('//') || path.includes('\0') || path.slice(parse(path).root.length).includes(':')) throw Error('请选择家庭电脑上的绝对目录路径');
  const full = resolve(path);
  let current = full;
  while (true) {
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw Error('目录不可用，不能使用文件、快捷链接或目录联接');
    if (dirname(current) === current) break;
    current = dirname(current);
  }
  return realpath(full);
}
export async function protectDirectory(path: string, ownerSid?: string) {
  if (process.platform !== 'win32') return;
  const { stdout } = await exec('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true });
  const currentSid = stdout.match(/S-1-(?:\d+-)*\d+/)?.[0];
  if (!currentSid || (ownerSid && !/^S-1-(?:\d+-)*\d+$/.test(ownerSid))) throw Error('无法确认备份目录的访问身份');
  const sids = new Set([currentSid, ...(ownerSid ? [ownerSid] : []), 'S-1-5-18', 'S-1-5-32-544']);
  await exec('icacls.exe', [path, '/inheritance:r', '/grant:r', ...[...sids].map(sid => `*${sid}:(OI)(CI)F`)], { windowsHide: true });
}
export async function requireSpace(directory: string, bytes: number) {
  const volume = await statfs(directory, { bigint: true });
  if (volume.bavail * volume.bsize < BigInt(Math.ceil(bytes)) + 64n * 1024n * 1024n) throw Error('备份目录可用空间不足，请释放空间或选择其他目录');
}
export async function describeFile(root: string, path: string): Promise<BackupEntry> {
  const filename = join(root, path), info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink()) throw Error('备份文件缺失或不是普通文件');
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(filename)) hash.update(bytes);
  return { path, size: info.size, sha256: hash.digest('hex') };
}
export async function copyFileBytes(source: string, target: string) {
  const info = await lstat(source);
  if (!info.isFile() || info.isSymbolicLink()) throw Error('源文件不可用或包含链接');
  await localDirectory(dirname(source));
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await pipeline(createReadStream(source), createWriteStream(target, { flags: 'wx', mode: 0o600, flush: true }));
}
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export async function finishBackup(root: string, manifest: BackupManifest) {
  const bytes = Buffer.from(JSON.stringify(manifest));
  await writeFile(join(root, 'manifest.json'), bytes, { flag: 'wx', mode: 0o600, flush: true });
  await writeFile(join(root, 'complete.json'), JSON.stringify({ manifestSha256: digest(bytes) }), { flag: 'wx', mode: 0o600, flush: true });
  await verifyBackup(root);
}
export async function verifyBackup(source: string): Promise<BackupManifest> {
  const root = await localDirectory(source);
  for (const name of ['manifest.json', 'complete.json']) {
    const info = await lstat(join(root, name));
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024) throw Error('备份清单不可用');
  }
  const bytes = await readFile(join(root, 'manifest.json'));
  const complete = JSON.parse(await readFile(join(root, 'complete.json'), 'utf8'));
  if (complete.manifestSha256 !== digest(bytes)) throw Error('备份未完成或清单校验失败');
  const manifest: BackupManifest = JSON.parse(bytes.toString('utf8'));
  if (manifest.format !== 'klbook-runtime-backup' || manifest.version !== 1 || !/^[a-f0-9-]{36}$/i.test(manifest.id) || !/^[a-f0-9-]{36}$/i.test(manifest.libraryId)
    || !Number.isSafeInteger(manifest.createdAt) || !Array.isArray(manifest.files) || manifest.files.length > 200000) throw Error('这不是受支持的完整资料库备份');
  const seen = new Set<string>();
  for (const file of manifest.files) {
    if (typeof file.path !== 'string' || !/^(data\/family\.sqlite|data\/attachments\/pages\/[a-f0-9-]{36}\/(original|preview)|system\/service-credentials\.key|system\/runtime\/[a-zA-Z0-9_./-]+)$/.test(file.path)
      || file.path.split('/').some(part => part === '..' || part === '.' || !part) || seen.has(file.path.toLowerCase())) throw Error('备份清单包含无效或重复路径');
    seen.add(file.path.toLowerCase());
    await localDirectory(dirname(join(root, file.path)));
    const actual = await describeFile(root, file.path);
    if (actual.size !== file.size || actual.sha256 !== file.sha256) throw Error('备份文件缺失、损坏或校验失败');
  }
  if (!seen.has('data/family.sqlite')) throw Error('备份缺少家庭数据库');
  await checkExistingData(join(root, 'data'), manifest.libraryId, { readOnly: true });
  const db = new Database(join(root, 'data/family.sqlite'), { readonly: true, fileMustExist: true });
  try {
    for (const page of db.prepare<[], { id: string }>('SELECT id FROM originalPages').all()) {
      if (!['original', 'preview'].every(variant => seen.has(`data/attachments/pages/${page.id}/${variant}`.toLowerCase()))) throw Error('备份清单缺少数据库引用的附件');
    }
    const queries = [
      ['ocr', 'SELECT credentials FROM ocrProviderCredentials'],
      ['speech', 'SELECT credentials FROM speechSettings WHERE credentials IS NOT NULL'],
      ['ai', 'SELECT credentials FROM aiModelCredentials']
    ] as const;
    for (const [capability, sql] of queries) {
      const values = db.prepare<[], { credentials: string }>(sql).all();
      if (values.length && !seen.has('system/service-credentials.key')) throw Error('备份缺少配套服务密钥');
      const vault = new CredentialVault(db, join(root, 'system'), capability);
      for (const value of values) vault.open(value.credentials);
    }
  } finally { db.close(); }
  return manifest;
}
export async function restoreBackup(source: string, target: string, withSystem: boolean) {
  const manifest = await verifyBackup(source);
  if (!isAbsolute(target)) throw Error('恢复目标必须是绝对路径');
  const parent = await localDirectory(dirname(resolve(target))), destination = join(parent, parse(target).base);
  if (overlaps(source, destination)) throw Error('恢复目标必须与备份目录分开');
  if (await lstat(destination).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) throw Error('恢复目标必须是尚不存在的新目录，不能覆盖已有资料');
  if (!withSystem && manifest.files.some(file => file.path.startsWith('system/'))) throw Error('本备份包含受保护配置，请确认 --with-system 后恢复');
  await requireSpace(parent, manifest.files.reduce((sum, file) => sum + file.size, 0));
  await mkdir(destination, { mode: 0o700 });
  try {
    await protectDirectory(destination);
    await mkdir(join(destination, 'attachments'), { mode: 0o700 });
    for (const file of manifest.files) {
      const output = file.path.startsWith('data/') ? file.path.slice(5)
        : file.path === 'system/service-credentials.key' ? 'service-credentials.key' : `system-restore/${file.path.slice(7)}`;
      await copyFileBytes(join(source, file.path), join(destination, output));
      const copied = await describeFile(destination, output);
      if (copied.sha256 !== file.sha256 || copied.size !== file.size) throw Error('恢复文件校验失败');
    }
    await checkExistingData(destination, manifest.libraryId);
    return { status: 'restored', dataDir: destination, libraryId: manifest.libraryId, systemConfiguration: '运行配置保留于 system-restore，核对路径及证书后单独部署' };
  } catch {
    throw Error('恢复未完成，目标目录保留供检查；原资料和成功备份未改变，请选择另一个新目录重试');
  }
}
