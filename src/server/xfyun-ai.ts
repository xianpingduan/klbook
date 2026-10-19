import { aiProvider, type AiConfig, type AiCredentials } from '../shared/ai.ts';

export type AiHttp = (url: URL, init: RequestInit) => Promise<Response>;
export interface AiMeter { promptTokens: number | null; completionTokens: number | null; totalTokens: number | null }
const noMeter: AiMeter = { promptTokens: null, completionTokens: null, totalTokens: null };
export class AiFailure extends Error {
  retryable: boolean; uncertain: boolean; meter: AiMeter;
  constructor(message: string, retryable = false, uncertain = false, meter = noMeter) {
    super(message); this.retryable = retryable; this.uncertain = uncertain; this.meter = meter;
  }
}
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const businessErrors: Record<number, { message: string; retryable?: boolean; uncertain?: boolean }> = {
  10007: { message: '讯飞仍在处理上一项请求，请稍后重试', retryable: true },
  10013: { message: '讯飞输入内容审核未通过，请调整测试文字后再发送' },
  10019: { message: '讯飞提示输入内容不适合处理，请调整测试文字后再发送' },
  10014: { message: '讯飞输出内容审核未通过，未展示该回复；请调整测试内容后再试', uncertain: true },
  10907: { message: '讯飞提示输入 token 超过上限，请精简测试文字后再试' },
  11200: { message: '所选模型未获授权或用量已超限，请核对讯飞控制台权限和额度' },
  11201: { message: '讯飞当日调用额度已用完，请核对额度或改日重试' },
  11202: { message: '讯飞请求过于频繁，请稍后重试', retryable: true },
  11203: { message: '讯飞同时处理的请求已达上限，请稍后重试', retryable: true }
};
function metering(value: unknown): AiMeter {
  const usage = object(value), input = usage.prompt_tokens, output = usage.completion_tokens, total = usage.total_tokens;
  if (![input, output, total].every(n => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= 10_000_000) || Number(input) + Number(output) !== total) return noMeter;
  return { promptTokens: Number(input), completionTokens: Number(output), totalTokens: Number(total) };
}
async function readResponse(response: Response, signal: AbortSignal) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('empty response');
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 1024 * 1024) throw new Error('response too large');
      chunks.push(value);
    }
    signal.throwIfAborted();
    return object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } finally { signal.removeEventListener('abort', cancel); await reader.cancel().catch(() => undefined); }
}
export class XfyunAi {
  private http: AiHttp;
  constructor(http: AiHttp = (url, init) => fetch(url, init)) { this.http = http; }
  async complete(credentials: AiCredentials, config: AiConfig, prompt: string, stopping: AbortSignal) {
    const signal = AbortSignal.any([stopping, AbortSignal.timeout(config.timeoutSeconds * 1000)]);
    try {
      const response = await this.http(new URL(aiProvider.endpoint), { method: 'POST', redirect: 'error', signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credentials.apiPassword}` },
        body: JSON.stringify({ model: config.model, messages: [{ role: 'user', content: prompt }], stream: false, max_tokens: config.maxOutputTokens,
          ...(config.model === '4.0Ultra' ? { tools: [{ type: 'web_search', web_search: { enable: false } }], tool_choice: 'none' } : {}) }) });
      const body = await readResponse(response, signal).catch(error => { if (response.ok || signal.aborted) throw error; return object(null); });
      const meter = metering(body.usage);
      const codeValue = body.code ?? object(body.error).code;
      if (typeof codeValue === 'number' && businessErrors[codeValue]) {
        const error = businessErrors[codeValue]!;
        throw new AiFailure(`${error.message}（代码 ${codeValue}）`, !!error.retryable, !!error.uncertain, meter);
      }
      if ((typeof codeValue === 'number' && codeValue !== 0) || (response.ok && body.error)) {
        const code = typeof codeValue === 'number' && Number.isSafeInteger(codeValue) ? `（代码 ${codeValue}）` : '';
        throw new AiFailure(`讯飞返回业务错误${code}，请稍后重试或核对控制台；本次费用不确定`, false, true, meter);
      }
      if (!response.ok) {
        if ([401, 403].includes(response.status)) throw new AiFailure('讯飞鉴权或权限检查失败，请核对所选模型的 APIPassword 和开通情况', false, false, meter);
        if (response.status === 429) throw new AiFailure('讯飞调用频率或额度受限，请检查控制台额度后重试', true, false, meter);
        if (response.status >= 500) throw new AiFailure('讯飞服务暂时异常，本次结果和费用不确定', true, true, meter);
        throw new AiFailure('讯飞拒绝了测试请求，请核对模型权限和配置', false, false, meter);
      }
      if (body.code !== undefined && body.code !== 0) throw new AiFailure('讯飞返回格式异常，本次结果和费用不确定', false, true, meter);
      const choice = object(Array.isArray(body.choices) ? body.choices[0] : undefined), message = object(choice.message);
      if (typeof message.content !== 'string' || !message.content.trim() || message.content.length > 32768 || message.role !== 'assistant' || message.tool_calls || (choice.finish_reason && !['stop', 'length'].includes(String(choice.finish_reason)))) {
        throw new AiFailure('讯飞未返回可用的完整文字，请核对模型状态后重试', false, true, meter);
      }
      // Supplier output is untrusted; never persist an echoed credential or render it as HTML.
      const text = message.content.split(credentials.apiPassword).join('[凭据已隐藏]');
      return { text, meter, message: choice.finish_reason === 'length' ? '已返回部分文字，达到输出长度限制；请核对后调整配置' : '测试成功，AI 输出仅供核对，不作为标准答案' };
    } catch (error) {
      if (stopping.aborted) throw new AiFailure('电脑服务已停止，本次结果和费用不确定', false, true);
      if (signal.aborted) throw new AiFailure('AI 学习请求超时，本次结果和费用不确定', true, true);
      if (error instanceof AiFailure) throw error;
      throw new AiFailure('AI 学习服务无法连接或响应无法读取，本次结果和费用不确定', true, true);
    }
  }
}
