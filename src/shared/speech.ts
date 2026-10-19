export const speechProvider = {
  label: '讯飞 · 语音听写（流式版）', endpoint: 'wss://iat-api.xfyun.cn/v2/iat',
  product: 'https://www.xfyun.cn/services/voicedictation', docs: 'https://www.xfyun.cn/doc/asr/voicedictation/API.html'
} as const;
export interface SpeechConfig {
  provider: 'xfyun'; name: string; enabled: boolean; language: 'zh_cn' | 'en_us';
  timeoutSeconds: number; retries: number; monthlyLimit: number; monthlyBudgetCents: number; priceCents: number;
}
export interface SpeechCredentials { appId: string; apiKey: string; secretKey: string }
export interface SpeechEdit { operationId: string; expectedRevision: number; config: SpeechConfig; credentials?: SpeechCredentials }
export interface SpeechTest {
  id: string; revision: number; status: 'running' | 'succeeded' | 'failed' | 'interrupted' | 'stopped';
  createdAt: number; finishedAt: number | null; durationMs: number | null; attempts: number;
  audioMs: number; audioBytes: number; sampleRate: number; message: string; text: string;
}
export interface SpeechSettings {
  revision: number; config: SpeechConfig; credentialsConfigured: boolean; credentialAvailable: boolean;
  usage: { month: string; attempts: number; audioMs: number; estimatedCents: number };
  tests: SpeechTest[]; audit: { actor: string; at: number; action: string }[];
}
// No assumed paid plan: parents must enter their own estimate (zero for a free allowance).
export const defaultSpeechConfig: SpeechConfig = { provider: 'xfyun', name: '讯飞语音听写', enabled: false, language: 'zh_cn', timeoutSeconds: 90, retries: 0, monthlyLimit: 100, monthlyBudgetCents: 1000, priceCents: 0 };
