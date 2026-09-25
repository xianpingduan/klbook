export type VendorHttp = (url: URL, init: RequestInit) => Promise<Response>;
export class OcrFailure extends Error {
  retryable: boolean; chargeable: boolean;
  constructor(message: string, retryable = false, chargeable = false) { super(message); this.retryable = retryable; this.chargeable = chargeable; }
}
export const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export async function readOcrResponse(response: Response): Promise<Record<string, unknown>> {
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
