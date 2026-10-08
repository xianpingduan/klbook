import type { ClientPlatform, DraftScope } from './platform.ts';
import type { Question, QuestionFilters, QuestionList } from '../shared/collection.ts';
import type { Home } from '../shared/contracts.ts';

/** Cached server snapshots are separate from editable progress and are never
 * treated as server authorization. All replay first verifies the live home. */
export class LocalLibrary {
  private platform: ClientPlatform;
  private scope: DraftScope;
  constructor(platform: ClientPlatform, scope: DraftScope) { this.platform = platform; this.scope = scope; }
  read<T>(path: string): T | undefined {
    const raw = this.platform.journal.read(this.scope, `cache:${path}`);
    return raw ? JSON.parse(raw) as T : undefined;
  }
  remember(path: string, value: unknown) { this.platform.journal.write(this.scope, `cache:${path}`, JSON.stringify(value)); }
  home() {
    const home = this.read<Home>('/home');
    if (!home || home.library.id !== this.scope.libraryId || home.account.id !== this.scope.accountId || home.session.expiresAt <= Date.now()) return;
    return home;
  }
  question(question: Question) { this.remember(`/collection/questions/${question.id}`, question); }
  list(state: 'draft' | 'collected', offset: number, filters: QuestionFilters): QuestionList {
    const questions = this.platform.journal.entries(this.scope)
      .filter(([key]) => /^cache:\/collection\/questions\/[a-f0-9-]+$/i.test(key))
      .map(([, raw]) => JSON.parse(raw) as Question)
      .filter(q => q.libraryId === this.scope.libraryId && q.state === state)
      .filter(q => Object.entries(filters).every(([key, value]) => {
        if (!value) return true;
        if (key === 'collectedFrom') return q.collectedAt !== null && q.collectedAt >= Number(value);
        if (key === 'collectedBefore') return q.collectedAt !== null && q.collectedAt < Number(value);
        const field = key === 'subjectId' ? q.subjectId : key === 'sourceId' ? q.sourceId : q.studyStage[key as keyof Question['studyStage']];
        return value === '__unset__' ? field === null : field === value;
      })).sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
    return { items: questions.slice(offset, offset + 50), total: questions.length, offset, limit: 50 };
  }
  removeQuestion(id: string) { this.platform.journal.remove(this.scope, `cache:/collection/questions/${id}`); }
  putImage(pageId: string, variant: 'preview' | 'original', blob: Blob) { return this.platform.drafts.put(this.scope, `image:${pageId}:${variant}`, blob); }
  image(pageId: string, variant: 'preview' | 'original') { return this.platform.drafts.get(this.scope, `image:${pageId}:${variant}`); }
}
