import type { Question } from '../shared/collection.ts';
import type { ClientPlatform, DraftScope } from './platform.ts';
import type { QuestionFields, questionContent } from './question-edit.ts';

export interface QuestionCheckpoint { current: Question; pending: (ReturnType<typeof questionContent> & { operationId: string; expectedRevision: number }) | null; intent?: ReturnType<typeof questionContent> }
export interface QuestionProgress {
  version: 1; fields: QuestionFields; step: 'crop' | 'confirm';
  checkpoint: QuestionCheckpoint; updatedAt: number;
}

/** A compare-and-write snapshot never replaces edits made by another tab. */
class StoredProgress {
  private platform: ClientPlatform;
  private scope: DraftScope;
  readonly key: string;
  private raw: string;
  value: QuestionProgress;
  constructor(platform: ClientPlatform, scope: DraftScope, key: string, raw: string, value: QuestionProgress) {
    this.platform = platform; this.scope = scope; this.key = key; this.raw = raw; this.value = value;
  }
  unchanged() { return this.platform.journal.read(this.scope, this.key) === this.raw; }
  write(value: QuestionProgress) {
    if (!this.unchanged()) throw new Error('本机整理进度已在另一页面更新，请重新打开后同步');
    const raw = JSON.stringify(value);
    this.platform.journal.write(this.scope, this.key, raw); this.raw = raw; this.value = value;
  }
  remove() { if (this.unchanged()) this.platform.journal.remove(this.scope, this.key); }
  inherited(): [string, string] { return [this.key, this.raw]; }
}

/** Small synchronous edit journal: an input is durable before the next navigation event.
 * Images remain in the platform's Blob store. Keep a separate copy per editor so
 * two tabs never destroy each other's pending work; server revisions resolve merges.
 */
export class QuestionJournal {
  private key: string;
  private platform: ClientPlatform;
  private scope: DraftScope;
  private latest?: QuestionProgress;
  private inherited?: [string, string];
  static entries(platform: ClientPlatform, scope: DraftScope, id?: string) {
    return platform.journal.entries(scope).filter(([key]) => key.startsWith(id ? `question:${id}:` : 'question:')).map(([key, raw]) => {
      try {
        const value = JSON.parse(raw) as QuestionProgress;
        if (value.version !== 1 || !key.startsWith(`question:${value.checkpoint.current.id}:`) || !value.fields.parts?.length) throw new Error();
        return new StoredProgress(platform, scope, key, raw, value);
      } catch { throw new Error('本机整理进度无法读取，请保留当前页面后重试'); }
    });
  }
  constructor(platform: ClientPlatform, scope: DraftScope, id: string) {
    this.platform = platform; this.scope = scope;
    const entries = QuestionJournal.entries(platform, scope, id).sort((a, b) => b.value.updatedAt - a.value.updatedAt);
    this.latest = entries[0]?.value;
    if (entries[0]) this.inherited = entries[0].inherited();
    this.key = `question:${id}:${crypto.randomUUID()}`;
  }
  read() { return this.latest; }
  write(value: QuestionProgress) {
    try {
      this.platform.journal.write(this.scope, this.key, JSON.stringify(value)); this.latest = value;
      if (this.inherited && this.platform.journal.read(this.scope, this.inherited[0]) === this.inherited[1]) this.platform.journal.remove(this.scope, this.inherited[0]);
      this.inherited = undefined;
    }
    catch { throw new Error('本机整理进度未能保存，请保留当前页面并检查浏览器可用空间后重试'); }
  }
  complete() {
    this.platform.journal.remove(this.scope, this.key);
    this.latest = undefined;
  }
}
