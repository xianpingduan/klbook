import type { ClientPlatform, DraftScope } from './platform.ts';

export interface PendingCapture { operationId: string; file: Blob; name: string }
export interface CaptureBatch { items: PendingCapture[]; total: number; uploaded: number; cancelled: number }
// One Blob atomically stores a length-prefixed JSON header and the untouched image bytes.
export class CaptureCache {
  private platform: ClientPlatform;
  private scope: DraftScope;
  private key: string;
  constructor(platform: ClientPlatform, scope: DraftScope, key = 'manual-capture') { this.platform = platform; this.scope = scope; this.key = key; }
  async saveBatch(batch: CaptureBatch) {
    const header = new TextEncoder().encode(JSON.stringify({ version: 2, total: batch.total, uploaded: batch.uploaded, cancelled: batch.cancelled,
      items: batch.items.map(item => ({ operationId: item.operationId, name: item.name, type: item.file.type, size: item.file.size })) }));
    const length = new ArrayBuffer(4);
    new DataView(length).setUint32(0, header.byteLength);
    try { await this.platform.drafts.put(this.scope, this.key, new Blob([length, header, ...batch.items.map(item => item.file)])); }
    catch { throw new Error('本设备暂存失败，请检查浏览器可用空间后重试。当前图片仍保留在页面中。'); }
  }
  async readBatch(): Promise<CaptureBatch | undefined> {
    const blob = await this.platform.drafts.get(this.scope, this.key);
    if (!blob) return;
    try {
      const length = new DataView(await blob.slice(0, 4).arrayBuffer()).getUint32(0);
      if (length > 65536 || length + 4 > blob.size) throw new Error('Invalid header length');
      const header = JSON.parse(await blob.slice(4, length + 4).text());
      if (header.version === 1) { const old = await this.read(); return old ? { items: [old], total: 1, uploaded: 0, cancelled: 0 } : undefined; }
      if (header.version !== 2 || !Array.isArray(header.items) || ![header.total, header.uploaded, header.cancelled].every(value => Number.isInteger(value) && value >= 0)
        || header.total > 10 || header.items.length + header.uploaded + header.cancelled !== header.total) throw new Error('Invalid batch');
      let offset = length + 4;
      const items: PendingCapture[] = header.items.map((item: { operationId: string; name: string; type: string; size: number }) => {
        if (typeof item.operationId !== 'string' || !/^[a-f0-9-]{36}$/i.test(item.operationId) || typeof item.name !== 'string' || typeof item.type !== 'string'
          || !Number.isInteger(item.size) || item.size <= 0 || offset + item.size > blob.size) throw new Error('Invalid image');
        const file = blob.slice(offset, offset + item.size, item.type); offset += item.size;
        return { operationId: item.operationId, name: item.name, file };
      });
      if (offset !== blob.size) throw new Error('Invalid payload size');
      return { items, total: header.total, uploaded: header.uploaded, cancelled: header.cancelled };
    } catch { throw new Error('本设备暂存信息无法读取，请保留原图片并重试。'); }
  }
  async save(capture: PendingCapture) {
    const header = new TextEncoder().encode(JSON.stringify({ version: 1, operationId: capture.operationId, name: capture.name, type: capture.file.type }));
    const length = new ArrayBuffer(4);
    new DataView(length).setUint32(0, header.byteLength);
    const blob = new Blob([length, header, capture.file]);
    try { await this.platform.drafts.put(this.scope, this.key, blob); }
    catch { throw new Error('本设备暂存失败，请检查浏览器可用空间后重试。当前图片仍保留在页面中。'); }
  }
  async read(): Promise<PendingCapture | undefined> {
    const blob = await this.platform.drafts.get(this.scope, this.key);
    if (!blob) return;
    try {
      const length = new DataView(await blob.slice(0, 4).arrayBuffer()).getUint32(0);
      if (length > 65536 || length + 4 >= blob.size) throw new Error('Invalid header length');
      const header = JSON.parse(await blob.slice(4, length + 4).text());
      if (header.version !== 1 || typeof header.operationId !== 'string' || !/^[a-f0-9-]{36}$/i.test(header.operationId) || typeof header.name !== 'string' || typeof header.type !== 'string') throw new Error('Invalid header');
      return { operationId: header.operationId, file: blob.slice(length + 4, blob.size, header.type), name: header.name };
    } catch { throw new Error('本设备暂存信息无法读取，请重新选择原图片。'); }
  }
  remove() { return this.platform.drafts.remove(this.scope, this.key); }
}
