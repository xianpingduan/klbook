import type Database from 'better-sqlite3';
import type { Home } from '../shared/contracts.ts';
import type { QuestionPart } from '../shared/collection.ts';
import type { ExportPreview, LearningPackageData, PackagePart, PackageRecognition } from '../shared/learning-package.ts';
import type { Source } from '../shared/sources.ts';
import type { StoredPage } from './attachments.ts';
import { fileHash } from './attachments.ts';
import type { CollectionStore } from './collection-store.ts';

/** Caller owns the short SQLite transaction; no file I/O occurs here. */
export function exportSnapshot(db: Database.Database, collection: CollectionStore, home: Home, now: number, includeTrashed = false) {
  const questions = db.prepare<[string, string, number], { id: string }>(`SELECT id FROM questions WHERE libraryId = ? AND learnerId = ?
    AND state = 'collected' AND cancelledAt IS NULL AND (? OR NOT EXISTS (SELECT 1 FROM questionDeletions WHERE id = questions.id)) ORDER BY id`).all(home.library.id, home.library.learnerId, includeTrashed ? 1 : 0).map(row => collection.get(home.library.id, row.id, includeTrashed));
  const pages = new Map<string, StoredPage>();
  const part = (value: QuestionPart): PackagePart => {
    if (!pages.has(value.originalPage.id)) pages.set(value.originalPage.id, db.prepare<[string, string], StoredPage>('SELECT * FROM originalPages WHERE libraryId = ? AND id = ?').get(home.library.id, value.originalPage.id)!);
    return { id: value.id, pageId: value.originalPage.id, region: value.region, transcription: value.transcription ?? '', recognition: value.recognition ?? null };
  };
  const data: LearningPackageData = {
    library: { id: home.library.id, learnerId: home.library.learnerId, learnerName: home.library.learnerName },
    questions: questions.map(q => ({ id: q.id, learnerId: q.learnerId, revision: q.revision, subjectId: q.subjectId, sourceId: q.sourceId, source: q.source,
      pageNumber: q.pageNumber, questionNumber: q.questionNumber, note: q.note, createdAt: q.createdAt, updatedAt: q.updatedAt, collectedAt: q.collectedAt,
      studyStage: q.studyStage, parts: q.parts.map(part), answerParts: q.answerParts.map(part), readingMaterialId: q.readingMaterial?.id ?? null })),
    readings: [...new Map(questions.flatMap(q => q.readingMaterial ? [[q.readingMaterial.id, q.readingMaterial] as const] : [])).values()].sort((a, b) => a.id.localeCompare(b.id))
      .map(r => ({ id: r.id, revision: r.revision, title: r.title, createdAt: r.createdAt, updatedAt: r.updatedAt, parts: r.parts.map(part) })),
    pages: [], subjects: collection.subjects().filter(s => questions.some(q => q.subjectId === s.id)),
    sources: [...new Set(questions.flatMap(q => q.sourceId ? [q.sourceId] : []))].sort().map(id => {
      const source = db.prepare<[string], Omit<Source, 'active'> & { active: number }>('SELECT id, name, active, revision FROM sources WHERE id = ?').get(id)!;
      return { ...source, active: source.active === 1 };
    }), recognitions: []
  };
  const storedPages = [...pages.values()].sort((a, b) => a.id.localeCompare(b.id));
  const extensions: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
  data.pages = storedPages.map(p => ({ id: p.id, mimeType: p.mimeType, byteLength: p.byteLength, sha256: p.sha256, width: p.width, height: p.height, path: `images/${p.id}.${extensions[p.mimeType]}` }));
  type RecognitionRow = Omit<PackageRecognition, 'lines' | 'candidates' | 'inputRegion'> & { lines: string; candidates: string; inputRegion: string | null };
  for (const page of storedPages) data.recognitions.push(...db.prepare<[string, string], RecognitionRow>(`SELECT id, pageId, revision, createdAt, finishedAt, inputWidth, inputHeight, inputRegion, lines, candidates
    FROM ocrTests WHERE libraryId = ? AND pageId = ? AND status = 'succeeded' ORDER BY id`).all(home.library.id, page.id).map(row => ({ ...row,
      lines: JSON.parse(row.lines), candidates: JSON.parse(row.candidates), inputRegion: row.inputRegion ? JSON.parse(row.inputRegion) : null })));
  const bytes = Buffer.from(JSON.stringify(data));
  const dates = questions.flatMap(q => q.collectedAt === null ? [] : [q.collectedAt]);
  const preview: ExportPreview = { token: fileHash(Buffer.concat([Buffer.from(home.account.id), bytes])), checkedAt: now, learnerName: home.library.learnerName,
    questionCount: questions.length, pageCount: storedPages.length, readingCount: data.readings.length, originalBytes: storedPages.reduce((sum, page) => sum + page.byteLength, 0),
    subjects: data.subjects, stages: [...new Map(questions.map(q => [JSON.stringify(q.studyStage), q.studyStage])).values()],
    collectedFrom: dates.length ? dates.reduce((a, b) => Math.min(a, b)) : null, collectedTo: dates.length ? dates.reduce((a, b) => Math.max(a, b)) : null };
  return { data, bytes, storedPages, preview };
}
