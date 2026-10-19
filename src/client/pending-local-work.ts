import type { ClientPlatform, DraftScope } from './platform.ts';
import { CaptureCache } from './capture-cache.ts';
import { OfflineCaptures } from './offline-captures.ts';
import { QuestionJournal } from './question-journal.ts';

export interface PendingLocalWork { images: number; questions: number }

/** Count retained uploads once even when the queue and offline receipt overlap. */
export async function pendingLocalWork(platform: ClientPlatform, scope: DraftScope): Promise<PendingLocalWork> {
  const captures = new OfflineCaptures(platform, scope).records();
  const images = new Set(captures.filter(item => !item.remote && item.kind !== 'questions').map(item => item.operationId));
  for (const key of await platform.drafts.keys(scope)) {
    const cache = new CaptureCache(platform, scope, key);
    if (key === 'manual-capture') {
      for (const item of (await cache.readBatch())?.items ?? []) images.add(item.operationId);
    } else if (/^(question|reading|answer)-pages:/.test(key)) {
      const item = await cache.read();
      if (item) images.add(item.operationId);
    }
  }
  return { images: images.size, questions: QuestionJournal.pendingCount(platform, scope) };
}
