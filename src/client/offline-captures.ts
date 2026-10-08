import type { Home } from '../shared/contracts.ts';
import type { OriginalPage, Question } from '../shared/collection.ts';
import type { ClientPlatform, DraftScope } from './platform.ts';
import type { StudyStage } from '../shared/study.ts';
import { emptyStage } from '../shared/study.ts';
import { LocalLibrary } from './local-library.ts';

export interface OfflineCapture {
  operationId: string; kind: 'drafts' | 'pages'; page: OriginalPage;
  question?: Question; remote?: OriginalPage | Question; stage: StudyStage;
}

/** Stable local identities stay stable while the upload receipt supplies the
 * server's identities. The original upload key and bytes survive lost receipts. */
export class OfflineCaptures {
  private platform: ClientPlatform;
  private scope: DraftScope;
  constructor(platform: ClientPlatform, scope: DraftScope) { this.platform = platform; this.scope = scope; }
  records(): OfflineCapture[] { return this.platform.journal.entries(this.scope).filter(([key]) => key.startsWith('upload:')).map(([, raw]) => JSON.parse(raw) as OfflineCapture); }
  find(operationId: string) { return this.records().find(record => record.operationId === operationId); }
  remember(record: OfflineCapture) { this.platform.journal.write(this.scope, `upload:${record.operationId}`, JSON.stringify(record)); }
  remoteId(id: string) {
    for (const item of this.records()) {
      if (!item.remote) continue;
      const page = item.kind === 'drafts' ? (item.remote as Question).originalPage : item.remote as OriginalPage;
      if (item.page.id === id) return page.id;
      if (item.question?.id === id) return (item.remote as Question).id;
      if (item.question?.parts[0]?.id === id) return (item.remote as Question).parts[0]!.id;
    }
    return id;
  }
  localId(id: string) {
    for (const item of this.records()) {
      if (!item.remote) continue;
      const page = item.kind === 'drafts' ? (item.remote as Question).originalPage : item.remote as OriginalPage;
      if (page.id === id) return item.page.id;
      if (item.question && (item.remote as Question).id === id) return item.question.id;
      if (item.question && (item.remote as Question).parts[0]?.id === id) return item.question.parts[0]!.id;
    }
    return id;
  }
  question(value: Question): Question {
    const part = (entry: Question['parts'][number]) => ({ ...entry, id: this.localId(entry.id), originalPage: { ...entry.originalPage, id: this.localId(entry.originalPage.id) } });
    return { ...value, id: this.localId(value.id), originalPage: { ...value.originalPage, id: this.localId(value.originalPage.id) }, parts: value.parts.map(part), answerParts: value.answerParts.map(part), readingMaterial: value.readingMaterial ? { ...value.readingMaterial, parts: value.readingMaterial.parts.map(part) } : null };
  }
  async create(file: Blob, operationId: string, kind: OfflineCapture['kind'], home: Home, stage = emptyStage) {
    const existing = this.find(operationId);
    if (existing) return existing;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('离线时请使用 JPEG、PNG 或 WebP 图片');
    const url = URL.createObjectURL(file);
    let width: number, height: number;
    try {
      const image = new Image(); image.src = url; await image.decode();
      width = image.naturalWidth; height = image.naturalHeight;
      if (!width || !height || width * height > 40_000_000) throw new Error('图片尺寸超过限制');
    } finally { URL.revokeObjectURL(url); }
    const page = { id: crypto.randomUUID(), width, height, mimeType: file.type, byteLength: file.size, sha256: '' };
    const now = Date.now();
    const question: Question | undefined = kind === 'drafts' ? {
      id: operationId, libraryId: home.library.id, learnerId: home.library.learnerId, revision: 1,
      state: 'draft', syncState: 'pending', subjectId: null, region: null, sourceId: null, source: '', pageNumber: '', questionNumber: '', note: '',
      originalPage: page, parts: [{ id: crypto.randomUUID(), originalPage: page, region: null }], answerParts: [], readingMaterial: null,
      studyStage: stage, createdAt: now, updatedAt: now, collectedAt: null
    } : undefined;
    const record = { operationId, kind, page, question, stage };
    const local = new LocalLibrary(this.platform, this.scope);
    await local.putImage(page.id, 'original', file); await local.putImage(page.id, 'preview', file);
    this.remember(record);
    if (question) local.question(question);
    return record;
  }
}
