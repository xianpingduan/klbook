import { createHmac } from 'node:crypto';
import type { OcrConfig, OcrCredentials, OcrLine } from '../shared/ocr.ts';
import { OcrFailure, object, readOcrResponse, type VendorHttp } from './ocr-provider.ts';

async function authenticationFailure(response: Response): Promise<OcrFailure> {
  const data = await readOcrResponse(response).catch(() => ({}));
  const message = object(data).message;
  // Match known error categories only; vendor messages may contain credentials or signed URLs.
  if (typeof message === 'string') {
    if (/invalid api[_ -]?key|api[_ -]?key.*(?:invalid|not exist|not found)/i.test(message)) return new OcrFailure('讯飞 APIKey 无效，请从已开通“通用文字识别”的同一应用重新复制 APPID、APIKey、APISecret 并保存');
    if (/a valid date or x-date header is required/i.test(message)) return new OcrFailure('讯飞拒绝了请求时间，请同步家庭电脑系统时间后重新测试');
    if (/HMAC signature does not match/i.test(message)) return new OcrFailure('讯飞签名校验失败，请核对同一应用的 APIKey 和 APISecret');
    if (/HMAC signature cannot be verified/i.test(message)) return new OcrFailure('讯飞无法验证签名，请核对通用文字识别应用的 APIKey、APISecret');
  }
  return new OcrFailure('讯飞鉴权失败，请检查 APPID、APIKey、APISecret、服务权限及电脑系统时间');
}

function textLines(data: Record<string, unknown>, credentials: OcrCredentials): OcrLine[] {
  const result = object(object(data.payload).result);
  if (result.compress !== 'raw' || result.encoding !== 'utf8' || result.format !== 'json' || typeof result.text !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(result.text) || result.text.length % 4 !== 0) throw new OcrFailure('讯飞返回的识别数据格式不完整，请稍后重新测试', false, true);
  const decoded = object(JSON.parse(Buffer.from(result.text, 'base64').toString('utf8')));
  if (!Array.isArray(decoded.pages) || !decoded.pages.length) throw new OcrFailure('讯飞未返回可用页面，请核对服务后重新测试', false, true);
  const lines: OcrLine[] = [];
  for (const item of decoded.pages) {
    const page = object(item);
    if (page.exception !== 0 || !Array.isArray(page.lines)) throw new OcrFailure('讯飞未能完整识别页面，请重新测试并核对材料', false, true);
    for (const item of page.lines) {
      const line = object(item);
      if (line.exception !== 0 || !Array.isArray(line.words)) throw new OcrFailure('讯飞返回了不完整的文字行，请重新测试并核对材料', false, true);
      if (lines.length >= 500) throw new OcrFailure('识别结果过长，请缩小材料范围后测试', false, true);
      let text = '';
      for (const word of line.words) {
        const content = object(word).content;
        if (typeof content !== 'string') throw new OcrFailure('讯飞返回的文字格式不完整', false, true);
        // Preserve Chinese adjacency and English word boundaries without duplicating supplied spaces.
        text += (/[A-Za-z0-9]$/.test(text) && /^[A-Za-z0-9]/.test(content) ? ' ' : '') + content;
      }
      if (!text.trim()) continue;
      text = [credentials.apiKey, credentials.secretKey, credentials.appId!].reduce((value, secret) => value.split(secret).join('[已隐藏]'), text).slice(0, 2000);
      const points = Array.isArray(line.coord) ? line.coord.map(object) : [];
      let box: OcrLine['box'];
      if (points.length === 4 && points.every(point => typeof point.x === 'number' && typeof point.y === 'number' && Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 0 && point.y >= 0 && point.x <= 32768 && point.y <= 32768)) {
        const xs = points.map(point => point.x as number), ys = points.map(point => point.y as number);
        const left = Math.min(...xs), top = Math.min(...ys);
        box = { left, top, width: Math.max(...xs) - left, height: Math.max(...ys) - top };
      }
      lines.push({ text, ...(box ? { box } : {}) });
    }
  }
  if (!lines.length) throw new OcrFailure('请求已返回，但讯飞未识别出文字，请核对材料', false, true);
  return lines;
}

export class XfyunOcr {
  private http: VendorHttp;
  private now: () => number;
  constructor(http: VendorHttp = (url, init) => fetch(url, init), now = Date.now) { this.http = http; this.now = now; }
  async recognize(credentials: OcrCredentials, config: OcrConfig, image: Buffer, signal: AbortSignal, permit: () => void): Promise<OcrLine[]> {
    let dispatched = false;
    const timed = AbortSignal.any([signal, AbortSignal.timeout(config.timeoutSeconds * 1000)]);
    try {
      if (!credentials.appId) throw new OcrFailure('请配置讯飞 APPID');
      const encoded = image.toString('base64');
      if (encoded.length > 4 * 1024 * 1024) throw new OcrFailure('讯飞通用文字识别图片编码后须不超过 4MB');
      const url = new URL('https://api.xf-yun.com/v1/private/sf8e6aca1');
      const date = new Date(this.now()).toUTCString();
      const signature = createHmac('sha256', credentials.secretKey).update(`host: ${url.host}\ndate: ${date}\nPOST ${url.pathname} HTTP/1.1`).digest('base64');
      const authorization = Buffer.from(`api_key="${credentials.apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`).toString('base64');
      url.search = new URLSearchParams({ authorization, host: url.host, date }).toString();
      const body = JSON.stringify({ header: { app_id: credentials.appId, status: 3 }, parameter: { sf8e6aca1: { category: 'ch_en_public_cloud', result: { encoding: 'utf8', compress: 'raw', format: 'json' } } }, payload: { sf8e6aca1_data_1: { encoding: 'png', status: 3, image: encoded } } });
      permit(); timed.throwIfAborted(); dispatched = true;
      const response = await this.http(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, redirect: 'error', signal: timed });
      if (!response.ok) {
        if ([401, 403].includes(response.status)) throw await authenticationFailure(response);
        await response.body?.cancel();
        throw new OcrFailure('讯飞服务暂时无法响应，请稍后测试', response.status >= 500 || response.status === 429, true);
      }
      const data = await readOcrResponse(response), code = object(data.header).code;
      if (typeof code !== 'number' || !Number.isSafeInteger(code)) throw new OcrFailure('讯飞响应不完整，请重新测试', false, true);
      if (code !== 0) throw new OcrFailure(`讯飞调用失败（错误码 ${code}），请检查服务开通、凭据和账户额度`);
      return textLines(data, credentials);
    } catch (error) {
      if (error instanceof OcrFailure) throw error;
      if (signal.aborted) throw new OcrFailure('服务已停止，调用结果不确定；不会自动重试', false, dispatched);
      if (timed.aborted) throw new OcrFailure('讯飞识别请求超时；已发出的请求可能计费', true, dispatched);
      // Error URLs may carry authentication; never return the original error or vendor message.
      throw new OcrFailure('无法连接讯飞或响应无法读取，请检查网络后重试', true, dispatched);
    }
  }
}
