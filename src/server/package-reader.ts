import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { openPromise } from 'yauzl';
import { MAX_PACKAGE_BYTES } from '../shared/imports.ts';
import { Attachments, fileHash, type StoredPage } from './attachments.ts';
import { AccessError } from './family-access.ts';
import { packageData, packageManifest, requirePackage } from './package-schema.ts';

/** Only generated UUID directories are written. ZIP paths are labels, never disk destinations. */
export async function receivePackage(input: Readable, directory: string, libraryId: string) {
  const path = join(directory, 'package.zip'), hash = createHash('sha256');
  const file = await open(path, 'wx'); let total = 0;
  try {
    for await (const chunk of input) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.length;
      if (total > MAX_PACKAGE_BYTES) throw new AccessError(413, '资料包超过 512 MB，请减少本次资料范围');
      hash.update(bytes); await file.writeFile(bytes);
    }
    await file.sync();
  } finally { await file.close(); }
  const packageHash = hash.digest('hex');
  const files = new Map<string, { byteLength: number; sha256: string }>();
  const texts = new Map<string, Buffer>(), images = new Map<string, StoredPage>();
  const attachments = new Attachments(directory);
  let expanded = 0;
  try {
    const zip = await openPromise(path, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true });
    try {
      requirePackage(zip.entryCount <= 10003, '资料包文件数量超过当前支持范围');
      for await (const entry of zip.eachEntry()) {
        const name = entry.fileName;
        const isImage = /^images\/[0-9a-fA-F-]{36}\.(jpg|png|webp)$/.test(name);
        requirePackage(isImage || ['manifest.json', 'manifest.sha256', 'data.json'].includes(name), '资料包包含不支持的文件或路径');
        requirePackage(!files.has(name) && !entry.isEncrypted() && [0, 8].includes(entry.compressionMethod), '资料包包含重复、加密或不支持的文件');
        const kind = (entry.externalFileAttributes >>> 16) & 0xf000;
        requirePackage(kind === 0 || kind === 0x8000, '资料包不能包含链接或特殊文件');
        const limit = isImage ? 15 * 1024 * 1024 : name === 'data.json' ? 16 * 1024 * 1024 : name === 'manifest.json' ? 2 * 1024 * 1024 : 128;
        requirePackage(entry.uncompressedSize > 0 && entry.uncompressedSize <= limit, '资料包文件大小超出支持范围');
        expanded += entry.uncompressedSize; requirePackage(expanded <= 2 * MAX_PACKAGE_BYTES, '资料包解压后过大');
        const stream = await zip.openReadStreamPromise(entry); const chunks: Buffer[] = []; let length = 0;
        try {
          for await (const chunk of stream) { length += chunk.length; requirePackage(length <= limit, '资料包文件大小不正确'); chunks.push(chunk); }
        } finally { stream.destroy(); }
        requirePackage(length === entry.uncompressedSize, '资料包文件不完整');
        const bytes = Buffer.concat(chunks);
        files.set(name, { byteLength: bytes.length, sha256: fileHash(bytes) });
        if (isImage) images.set(name, await attachments.save(randomUUID(), libraryId, bytes));
        else texts.set(name, bytes);
      }
    } finally { zip.close(); }
    const manifestBytes = texts.get('manifest.json');
    requirePackage(manifestBytes && texts.get('manifest.sha256')?.toString().trim() === fileHash(manifestBytes), '资料包清单校验失败，请重新导出');
    const decode = (bytes: Buffer) => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const manifest = packageManifest(decode(manifestBytes));
    requirePackage(manifest.files.length + 2 === files.size, '资料包文件与清单不一致');
    for (const f of manifest.files) requirePackage(files.get(f.path)?.byteLength === f.byteLength && files.get(f.path)?.sha256 === f.sha256, '资料包缺少文件或文件已损坏，请重新导出');
    requirePackage(texts.has('data.json') && manifest.files.some(f => f.path === 'data.json'), '资料包缺少学习记录');
    const data = packageData(decode(texts.get('data.json')!), manifest);
    requirePackage(data.pages.length === images.size && manifest.files.length === data.pages.length + 1);
    for (const p of data.pages) {
      const actual = images.get(p.path);
      requirePackage(actual && ['mimeType', 'width', 'height', 'byteLength', 'sha256'].every(key => actual[key as keyof StoredPage] === p[key as keyof typeof p]), '原图内容、尺寸或摘要与资料包不一致');
    }
    return { data, manifest, packageHash, images, directory };
  } catch (error) {
    if (error instanceof AccessError) throw error;
    if (error instanceof Error && 'code' in error && ['ENOSPC', 'EACCES', 'EIO'].includes(String(error.code))) throw new AccessError(503, '校验暂存失败，请检查家庭电脑的磁盘空间和数据目录后重试');
    throw new AccessError(422, '资料包无法读取或已损坏，请选择完整的本应用 ZIP 资料包');
  }
}
export type PreparedPackage = Awaited<ReturnType<typeof receivePackage>>;

export async function preparedOriginal(prepared: PreparedPackage, path: string) {
  return readFile(join(prepared.directory, 'attachments', 'pages', prepared.images.get(path)!.id, 'original'));
}
