import { setTimeout as pause } from 'node:timers/promises';
import type { AiSettings } from '../../src/shared/ai.ts';
import type { auth, familyFixture } from './fixture.ts';

export const aiReply = () => Response.json({ code: 0, choices: [{ index: 0, message: { role: 'assistant', content: '先想想长方形有几条长边和几条短边。' } }], usage: { prompt_tokens: 28, completion_tokens: 19, total_tokens: 47 } });
// Only the supplier HTTP boundary is replaced; request construction and response parsing are real.
export function aiVendor(reply: (request: { url: URL; init: RequestInit }) => Promise<Response> | Response = aiReply) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const http = async (url: URL, init: RequestInit) => { const request = { url, init }; calls.push(request); return reply(request); };
  return { calls, http };
}
export async function finishedAi(f: Pick<Awaited<ReturnType<typeof familyFixture>>, 'app'>, headers: ReturnType<typeof auth>) {
  for (let index = 0; index < 400; index++) {
    const value = (await f.app.inject({ url: '/api/v1/admin/ai', headers })).json<AiSettings>();
    if (value.tests[0]?.status !== 'running') return value;
    await pause(20);
  }
  throw new Error('AI test did not settle');
}
