import type { ClientPlatform, DraftScope } from './platform.ts';

export interface PendingCapture { operationId: string; file: Blob; name: string }
// One Blob atomically stores a length-prefixed JSON header and the untouched image bytes.
export class CaptureCache {
  private platform: ClientPlatform;
  private scope: DraftScope;
  constructor(platform: ClientPlatform, scope: DraftScope) { this.platform = platform; this.scope = scope; }
  async save(capture: PendingCapture) {
    const header = new TextEncoder().encode(JSON.stringify({ version: 1, operationId: capture.operationId, name: capture.name, type: capture.file.type }));
    const length = new ArrayBuffer(4);
    new DataView(length).setUint32(0, header.byteLength);
    const blob = new Blob([length, header, capture.file]);
    try { await this.platform.drafts.put(this.scope, 'manual-capture', blob); }
    catch { throw new Error('本设备暂存失败，请检查浏览器可用空间后重试。当前图片仍保留在页面中。'); }
  }
  async read(): Promise<PendingCapture | undefined> {
    const blob = await this.platform.drafts.get(this.scope, 'manual-capture');
    if (!blob) return;
    try {
      const length = new DataView(await blob.slice(0, 4).arrayBuffer()).getUint32(0);
      if (length > 65536 || length + 4 >= blob.size) throw new Error('Invalid header length');
      const header = JSON.parse(await blob.slice(4, length + 4).text());
      if (header.version !== 1 || typeof header.operationId !== 'string' || !/^[a-f0-9-]{36}$/i.test(header.operationId) || typeof header.name !== 'string' || typeof header.type !== 'string') throw new Error('Invalid header');
      return { operationId: header.operationId, file: blob.slice(length + 4, blob.size, header.type), name: header.name };
    } catch { throw new Error('本设备暂存信息无法读取，请重新选择原图片。'); }
  }
  remove() { return this.platform.drafts.remove(this.scope, 'manual-capture'); }
}
