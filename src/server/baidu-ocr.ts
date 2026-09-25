import type { OcrConfig, OcrCredentials, OcrLine } from '../shared/ocr.ts';
import { digest } from './secrets.ts';

export type VendorHttp = (url: URL, init: RequestInit) => Promise<Response>;
export class OcrFailure extends Error {
  retryable: boolean; chargeable: boolean;
  constructor(message: string, retryable = false, chargeable = false) { super(message); this.retryable = retryable; this.chargeable = chargeable; }
}
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
async function readResponse(response: Response): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('empty response');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 2 * 1024 * 1024) throw new Error('response too large');
      chunks.push(value);
    }
    return object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } finally { await reader.cancel().catch(() => undefined); }
}
function linesOf(data: Record<string, unknown>, secrets: string[]): OcrLine[] {
  const candidates = Array.isArray(data.words_result) ? data.words_result : Array.isArray(data.results) ? data.results.flatMap(result => {
    const words = object(result).words; return Array.isArray(words) ? words : [object(words)];
  }) : [];
  const lines: OcrLine[] = [];
  for (const item of candidates.slice(0, 500)) {
    const value = object(item); const text = value.words ?? value.word;
    if (typeof text !== 'string' || !text.trim()) continue;
    const clean = secrets.reduce((value, secret) => secret ? value.split(secret).join('[已隐藏]') : value, text).slice(0, 2000);
    const box = object(value.location ?? value.words_location);
    const { left, top, width, height } = box;
    const valid = [left, top, width, height].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 8192);
    lines.push({ text: clean, ...(valid ? { box: { left: left as number, top: top as number, width: width as number, height: height as number } } : {}) });
  }
  return lines;
}

/** Only the documented Baidu endpoints are reachable; HTTP is the external test seam. */
export class BaiduOcr {
  private http: VendorHttp;
  private cached?: { key: string; token: string; until: number };
  constructor(http: VendorHttp = (url, init) => fetch(url, init)) { this.http = http; }
  async recognize(credentials: OcrCredentials, config: OcrConfig, image: Buffer, signal: AbortSignal, permit: () => void): Promise<OcrLine[]> {
    let dispatched = false;
    const timed = AbortSignal.any([signal, AbortSignal.timeout(config.timeoutSeconds * 1000)]);
    try {
      const key = digest(JSON.stringify(credentials));
      if (!this.cached || this.cached.key !== key || this.cached.until <= Date.now()) {
        const url = new URL('https://aip.baidubce.com/oauth/2.0/token');
        url.search = new URLSearchParams({ grant_type: 'client_credentials', client_id: credentials.apiKey, client_secret: credentials.secretKey }).toString();
        const response = await this.http(url, { method: 'POST', redirect: 'error', signal: timed });
        if (!response.ok) { await response.body?.cancel(); throw new OcrFailure('识别服务认证失败，请检查凭据、网络及服务开通状态', response.status >= 500); }
        const data = await readResponse(response);
        if (typeof data.access_token !== 'string' || !data.access_token || data.access_token.length > 4096 || typeof data.expires_in !== 'number' || data.expires_in <= 0) throw new OcrFailure('识别服务认证失败，请检查 API Key 和 Secret Key');
        this.cached = { key, token: data.access_token, until: Date.now() + Math.min(data.expires_in, 2592000) * 1000 - 60000 };
      }
      permit(); timed.throwIfAborted();
      const url = new URL('https://aip.baidubce.com/rest/2.0/ocr/v1/doc_analysis');
      url.searchParams.set('access_token', this.cached.token);
      const form = new URLSearchParams({ image: image.toString('base64'), language_type: config.language, result_type: 'big', detect_direction: 'true', layout_analysis: 'true', recg_formula: String(config.formulas), ...(config.handwriting ? { words_type: 'handprint_mix' } : {}) });
      dispatched = true;
      const response = await this.http(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString(), redirect: 'error', signal: timed });
      if (!response.ok) { await response.body?.cancel(); throw new OcrFailure('识别服务暂时无法响应，请稍后测试', response.status >= 500 || response.status === 429, true); }
      const data = await readResponse(response);
      if (data.error_code !== undefined) {
        const code = Number(data.error_code);
        if ([110, 111].includes(code)) this.cached = undefined;
        const message = [110, 111].includes(code) ? '识别凭据已失效，请检查配置后重新测试' : [4, 14, 17, 19].includes(code) ? '供应商调用额度不足或未开通服务，请检查供应商控制台' : code === 18 ? '供应商请求繁忙，请稍后重试' : [216200, 216201, 216202].includes(code) ? '供应商无法读取测试图片，请检查图片识别服务权限和格式' : '识别服务返回错误，请检查服务开通状态或稍后重试';
        throw new OcrFailure(message, [18, 282000].includes(code));
      }
      const lines = linesOf(data, [credentials.apiKey, credentials.secretKey, this.cached.token]);
      if (!lines.length) throw new OcrFailure('请求已返回，但未识别出文字；请检查服务能力后重新测试', false, true);
      return lines;
    } catch (error) {
      if (error instanceof OcrFailure) throw error;
      if (signal.aborted) throw new OcrFailure('服务已停止，调用结果不确定；不会自动重试', false, dispatched);
      if (timed.aborted) throw new OcrFailure('识别请求超时；已发出的请求可能计费', true, dispatched);
      // Never expose fetch errors: they may contain credential-bearing URLs.
      throw new OcrFailure('无法连接识别服务或响应无法读取，请检查网络后重试', true, dispatched);
    }
  }
}
