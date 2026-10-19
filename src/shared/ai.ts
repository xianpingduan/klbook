export const aiModels = { lite: 'Spark Lite', '4.0Ultra': 'Spark Ultra' } as const;
export type AiModel = keyof typeof aiModels;
export const aiInputTokenLimits: Record<AiModel, number> = { lite: 8192, '4.0Ultra': 32768 };
export interface AiPrice { inputCentsPerMillion: number; outputCentsPerMillion: number; confirmed: boolean }
export const aiProvider = {
  label: '讯飞星火', endpoint: 'https://spark-api-open.xf-yun.com/v1/chat/completions',
  product: 'https://xinghuo.xfyun.cn/sparkapi', docs: 'https://www.xfyun.cn/doc/spark/HTTP调用文档.html'
} as const;
export interface AiConfig {
  provider: 'xfyun'; model: AiModel; name: string; enabled: boolean; maxOutputTokens: number;
  timeoutSeconds: number; retries: number; monthlyLimit: number; monthlyBudgetCents: number; modelPrices: Record<AiModel, AiPrice>;
}
export interface AiCredentials { apiPassword: string }
export interface AiEdit { operationId: string; expectedRevision: number; config: AiConfig; credentials?: AiCredentials }
export interface AiTest {
  id: string; revision: number; model: AiModel; prompt: string;
  status: 'running' | 'succeeded' | 'failed' | 'interrupted' | 'stopped';
  createdAt: number; finishedAt: number | null; durationMs: number | null; attempts: number; message: string; text: string;
  promptTokens: number | null; completionTokens: number | null; totalTokens: number | null;
  estimatedCents: number; reservedCents: number;
}
export interface AiSettings {
  revision: number; config: AiConfig; credentialsConfigured: boolean; credentialAvailable: boolean;
  models: Record<AiModel, { credentialsConfigured: boolean; credentialAvailable: boolean }>;
  usage: { month: string; attempts: number; reportedAttempts: number; promptTokens: number; completionTokens: number; totalTokens: number; estimatedCents: number };
  tests: AiTest[]; audit: { actor: string; at: number; action: string }[];
}
export const defaultAiConfig: AiConfig = { provider: 'xfyun', model: 'lite', name: '讯飞星火学习服务', enabled: false, maxOutputTokens: 512, timeoutSeconds: 60, retries: 0, monthlyLimit: 100, monthlyBudgetCents: 1000,
  modelPrices: { lite: { inputCentsPerMillion: 0, outputCentsPerMillion: 0, confirmed: false }, '4.0Ultra': { inputCentsPerMillion: 0, outputCentsPerMillion: 0, confirmed: false } } };
export const aiTestExample = '请给四年级学生一条思考提示，不直接给出答案：一个长方形长 8 厘米、宽 5 厘米，怎样计算它的周长？';
