export const capabilities = { ocr: '图片识别', speech: '语音转写', ai: 'AI 学习' } as const;
export type Capability = keyof typeof capabilities;
export interface ServiceBudget {
  monthlyBudgetCents: number;
  hardwareCents: number | null;
  monthlyElectricityCents: number | null;
  capacityNote: string;
}
export const defaultServiceBudget: ServiceBudget = { monthlyBudgetCents: 5000, hardwareCents: null, monthlyElectricityCents: null, capacityNote: '' };
export interface ServiceBudgetEdit { operationId: string; expectedRevision: number; config: ServiceBudget }
export interface UsageTotals {
  attempts: number; succeeded: number; failed: number; unknown: number; running: number;
  estimatedMicros: number; reservedMicros: number;
}
export interface UsageCategory extends UsageTotals {
  capability: Capability; enabled: boolean; monthlyBudgetCents: number; monthlyLimit: number;
  audioMs: number; reportedAttempts: number; promptTokens: number; completionTokens: number; totalTokens: number;
}
export interface UsageAttempt {
  capability: Capability; id: number; testId: string; provider: string; model: string;
  startedAt: number; finishedAt: number | null; status: 'running' | 'succeeded' | 'failed' | 'unknown';
  durationMs: number | null; estimatedMicros: number; costBasis: 'local-call' | 'reported' | 'reserved' | 'none';
  audioMs: number | null; promptTokens: number | null; completionTokens: number | null; totalTokens: number | null; message: string;
}
export interface ServiceUsage {
  revision: number; config: ServiceBudget; month: string; currentMonth: string;
  totals: UsageTotals; categories: UsageCategory[];
  records: UsageAttempt[]; recordCount: number; offset: number;
  audit: { capability: Capability | 'budget'; actor: string; at: number; action: string }[];
}
export interface UsageQuery { month?: string; capability?: Capability; offset?: number }
