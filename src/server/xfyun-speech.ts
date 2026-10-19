import { createHmac } from 'node:crypto';
import { speechProvider, type SpeechConfig, type SpeechCredentials } from '../shared/speech.ts';
import type { SpeechAudio } from './speech-audio.ts';

export interface SpeechSocket extends EventTarget { send(data: string): void; close(code?: number): void }
export type SpeechSocketFactory = (url: string) => SpeechSocket;
export class SpeechFailure extends Error {
  retryable: boolean; uncertain: boolean;
  constructor(message: string, retryable = false, uncertain = false) { super(message); this.retryable = retryable; this.uncertain = uncertain; }
}
function vendorFailure(code: number) {
  if ([10005, 10010, 10110, 11200, 11203].includes(code)) return new SpeechFailure(`讯飞语音听写未获授权或额度已用完（${code}），请核对 APPID、语音听写服务权限、语种和套餐有效期`);
  if ([11201, 11202].includes(code)) return new SpeechFailure(`讯飞语音听写调用过于频繁（${code}），请稍后重试`, true);
  if ([10014, 10019, 10114, 10200, 10222, 10500, 10600, 10700].includes(code)) return new SpeechFailure(`讯飞语音听写暂时无法完成（${code}），可稍后重试`, true, true);
  return new SpeechFailure(`讯飞语音听写返回错误（${code}），请核对音频格式和服务配置`);
}
export class XfyunSpeech {
  private connect: SpeechSocketFactory;
  private now: () => number;
  constructor(connect: SpeechSocketFactory = url => new WebSocket(url), now = Date.now) { this.connect = connect; this.now = now; }
  transcribe(credentials: SpeechCredentials, config: SpeechConfig, audio: SpeechAudio, signal: AbortSignal): Promise<string> {
    const url = new URL(speechProvider.endpoint), date = new Date(this.now()).toUTCString();
    const signature = createHmac('sha256', credentials.secretKey).update(`host: ${url.host}\ndate: ${date}\nGET ${url.pathname} HTTP/1.1`).digest('base64');
    url.searchParams.set('host', url.host); url.searchParams.set('date', date);
    url.searchParams.set('authorization', Buffer.from(`api_key="${credentials.apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`).toString('base64'));
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(new SpeechFailure('电脑服务正在停止，结果不确定', false, true)); return; }
      let socket: SpeechSocket;
      try { socket = this.connect(url.toString()); }
      catch { reject(new SpeechFailure('无法连接讯飞语音听写，请检查网络、凭据、服务权限与电脑时间', true, true)); return; }
      let settled = false, offset = 0, frame = 0, receivedBytes = 0;
      let sendTimer: ReturnType<typeof setTimeout> | undefined;
      const pieces = new Map<number, string>();
      const finish = (error?: SpeechFailure) => {
        if (settled) return; settled = true;
        clearTimeout(timeout); clearTimeout(sendTimer); signal.removeEventListener('abort', abort);
        socket.removeEventListener('open', open); socket.removeEventListener('message', message);
        socket.removeEventListener('close', closed); socket.removeEventListener('error', failed);
        try { socket.close(1000); } catch { /* Already disconnected. */ }
        if (error) reject(error); else resolve([...pieces].sort(([a], [b]) => a - b).map(([, value]) => value).join(''));
      };
      const abort = () => finish(new SpeechFailure('电脑服务已中断，结果不确定；不会自动重新发送', false, true));
      const timeout = setTimeout(() => finish(new SpeechFailure('语音转写超时，结果不确定；请检查网络或提高请求超时', true, true)), config.timeoutSeconds * 1000);
      const failed = () => finish(new SpeechFailure('无法连接讯飞语音听写，请检查网络、APPID、APIKey、APISecret、服务权限与电脑时间', true, true));
      const closed = () => finish(new SpeechFailure('讯飞连接提前结束，未收到完整结果，可稍后重试', true, true));
      const send = () => {
        if (settled) return;
        try {
          if (offset >= audio.pcm.length) { socket.send(JSON.stringify({ data: { status: 2 } })); return; }
          const end = Math.min(offset + audio.sampleRate * 2 * 0.04, audio.pcm.length);
          socket.send(JSON.stringify({ ...(frame === 0 ? { common: { app_id: credentials.appId }, business: { language: config.language, domain: 'iat', accent: 'mandarin', eos: 10000 } } : {}), data: { status: frame === 0 ? 0 : 1, format: `audio/L16;rate=${audio.sampleRate}`, encoding: 'raw', audio: audio.pcm.subarray(offset, end).toString('base64') } }));
          offset = end; frame++;
          if (!settled) sendTimer = setTimeout(send, 40);
        } catch { failed(); }
      };
      const open = () => send();
      const message = (event: Event) => {
        if (settled) return;
        try {
          const raw: unknown = 'data' in event ? event.data : undefined;
          if (typeof raw !== 'string' || (receivedBytes += Buffer.byteLength(raw)) > 1024 * 1024) throw new Error('invalid response');
          const value = JSON.parse(raw);
          if (!Number.isInteger(value?.code)) throw new Error('invalid code');
          if (value.code !== 0) { finish(vendorFailure(value.code)); return; }
          if (![0, 1, 2].includes(value.data?.status)) throw new Error('invalid status');
          const result = value.data.result;
          if (result) {
            if (!Number.isInteger(result.sn) || result.sn < 0 || !Array.isArray(result.ws)) throw new Error('invalid result');
            const words = result.ws.map((word: { cw?: { w?: unknown }[] }) => {
              if (!Array.isArray(word.cw) || typeof word.cw[0]?.w !== 'string') throw new Error('invalid word');
              return word.cw[0].w;
            }).join('');
            if (result.pgs === 'rpl') {
              const range: unknown = result.rg;
              if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isInteger) || range[0] < 0 || range[0] > range[1]) throw new Error('invalid correction');
              for (const key of pieces.keys()) if (key >= range[0] && key <= range[1]) pieces.delete(key);
            } else if (result.pgs !== undefined && result.pgs !== 'apd') throw new Error('invalid correction');
            pieces.set(result.sn, words);
          }
          if (value.data.status === 2) finish(offset < audio.pcm.length ? new SpeechFailure('讯飞提前结束听写，音频未完整处理；请缩短静音或分段测试', false, true) : undefined);
        } catch { finish(new SpeechFailure('讯飞返回的转写结果格式异常，未保存为成功结果', false, true)); }
      };
      socket.addEventListener('open', open); socket.addEventListener('message', message);
      socket.addEventListener('close', closed); socket.addEventListener('error', failed); signal.addEventListener('abort', abort, { once: true });
    });
  }
}
