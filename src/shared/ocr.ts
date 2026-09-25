export interface OcrConfig {
  name: string; enabled: boolean; language: 'CHN_ENG' | 'ENG'; handwriting: boolean; formulas: boolean;
  timeoutSeconds: number; retries: number; monthlyLimit: number; monthlyBudgetCents: number; priceCents: number;
}
export interface OcrCredentials { apiKey: string; secretKey: string }
export interface OcrEdit { operationId: string; expectedRevision: number; config: OcrConfig; credentials?: OcrCredentials }
export interface OcrLine { text: string; box?: { left: number; top: number; width: number; height: number } }
export interface OcrTest {
  id: string; revision: number; sample: 'school-v1'; status: 'running' | 'succeeded' | 'failed' | 'interrupted' | 'stopped';
  createdAt: number; finishedAt: number | null; durationMs: number | null; attempts: number; message: string; lines: OcrLine[];
}
export interface OcrSettings {
  revision: number; config: OcrConfig; credentialsConfigured: boolean; credentialAvailable: boolean;
  usage: { month: string; attempts: number; estimatedCents: number };
  tests: OcrTest[]; audit: { actor: string; at: number; action: string }[];
}
export const defaultOcrConfig: OcrConfig = { name: '百度试卷识别', enabled: false, language: 'CHN_ENG', handwriting: true, formulas: true, timeoutSeconds: 15, retries: 1, monthlyLimit: 300, monthlyBudgetCents: 5000, priceCents: 16 };
