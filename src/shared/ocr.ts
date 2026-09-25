export type OcrProvider = 'baidu' | 'xfyun';
export const ocrProviders = {
  baidu: { label: '百度 · 试卷分析与识别', name: '百度试卷识别', product: 'https://cloud.baidu.com/product/OCR/doc-analysis.html', docs: 'https://ai.baidu.com/ai-doc/OCR/jk9m7mj1l', price: 'https://cloud.baidu.com/product-price/ocr.html', priceCents: 16 },
  xfyun: { label: '讯飞 · 通用文字识别', name: '讯飞通用文字识别', product: 'https://www.xfyun.cn/services/textRecg1', docs: 'https://www.xfyun.cn/doc/words/universal_character_recognition/API.html', price: 'https://www.xfyun.cn/services/textRecg1', priceCents: 3.5 }
} as const;
export interface OcrConfig {
  provider: OcrProvider;
  name: string; enabled: boolean; language: 'CHN_ENG' | 'ENG'; handwriting: boolean; formulas: boolean;
  timeoutSeconds: number; retries: number; monthlyLimit: number; monthlyBudgetCents: number; priceCents: number;
}
export interface OcrCredentials { apiKey: string; secretKey: string; appId?: string }
export interface OcrEdit { operationId: string; expectedRevision: number; config: OcrConfig; credentials?: OcrCredentials }
export interface OcrLine { text: string; box?: { left: number; top: number; width: number; height: number } }
export interface OcrTest {
  id: string; revision: number; provider: OcrProvider; sample: 'school-v1' | 'original-page'; status: 'running' | 'succeeded' | 'failed' | 'interrupted' | 'stopped';
  createdAt: number; finishedAt: number | null; durationMs: number | null; attempts: number; message: string; lines: OcrLine[];
}
export interface OcrCandidate {
  id: string; text: string; region: import('./collection.ts').Region; questionNumber: string; subjectId: string | null;
}
export interface PageRecognition extends OcrTest {
  pageId: string | null; inputWidth: number | null; inputHeight: number | null; candidates: OcrCandidate[];
}
export interface PageRecognitions {
  initialMessage: string;
  service: { provider: OcrProvider; enabled: boolean; available: boolean; formulas: boolean };
  runs: PageRecognition[];
}
export interface OcrSettings {
  revision: number; config: OcrConfig; credentialsConfigured: boolean; credentialAvailable: boolean;
  credentialStatus: Record<OcrProvider, { configured: boolean; available: boolean }>;
  usage: { month: string; attempts: number; estimatedCents: number };
  tests: OcrTest[]; audit: { actor: string; at: number; action: string }[];
}
export const defaultOcrConfig: OcrConfig = { provider: 'baidu', name: '百度试卷识别', enabled: false, language: 'CHN_ENG', handwriting: true, formulas: true, timeoutSeconds: 15, retries: 1, monthlyLimit: 300, monthlyBudgetCents: 5000, priceCents: 16 };
