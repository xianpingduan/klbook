import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { AccessError } from './family-access.ts';
import type { OriginalPage } from '../shared/collection.ts';

export interface StoredPage extends OriginalPage { previewSha256: string; libraryId: string }
export const fileHash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export class Attachments {
  private root: string;
  constructor(dataDir: string) { this.root = join(dataDir, 'attachments', 'pages'); }

  async save(id: string, libraryId: string, bytes: Buffer): Promise<StoredPage> {
    let width: number, height: number, mimeType: string, preview: Buffer;
    try {
      const image = sharp(bytes, { limitInputPixels: 40_000_000, failOn: 'warning' });
      const meta = await image.metadata();
      const formats: Record<string, string> = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
      if (!meta.width || !meta.height || !meta.format || !formats[meta.format] || (meta.pages ?? 1) > 1) throw new Error('Unsupported image');
      const swapped = (meta.orientation ?? 1) >= 5;
      width = swapped ? meta.height : meta.width;
      height = swapped ? meta.width : meta.height;
      mimeType = formats[meta.format]!;
      preview = await image.autoOrient().resize({ width: 2800, height: 2800, fit: 'inside', withoutEnlargement: true }).webp({ quality: 90 }).toBuffer();
    } catch { throw new AccessError(422, '图片无法读取，请选择完整的 JPEG、PNG 或静态 WebP 图片（不超过 4000 万像素）'); }
    const staging = join(this.root, `.upload-${id}`);
    try {
      await mkdir(this.root, { recursive: true });
      await mkdir(staging);
      for (const [name, content] of [['original', bytes], ['preview', preview]] as const) {
        const file = await open(join(staging, name), 'wx');
        try { await file.writeFile(content); await file.sync(); }
        finally { await file.close(); }
      }
      await rename(staging, join(this.root, id));
    } catch {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
      throw new AccessError(503, '图片未能完整保存。请保留当前材料，检查家庭电脑的磁盘空间和数据目录后重试');
    }
    return { id, libraryId, mimeType, byteLength: bytes.length, sha256: fileHash(bytes), previewSha256: fileHash(preview), width, height };
  }

  async read(page: StoredPage, variant: 'original' | 'preview') {
    try {
      const bytes = await readFile(join(this.root, page.id, variant));
      if (fileHash(bytes) !== (variant === 'original' ? page.sha256 : page.previewSha256)) throw new Error('File integrity mismatch');
      return bytes;
    } catch { throw new AccessError(503, '原始材料暂时不可读，请检查家庭电脑的数据目录后重试'); }
  }

  async discard(id: string) { await rm(join(this.root, id), { recursive: true, force: true }).catch(() => {}); }
}
