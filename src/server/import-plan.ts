import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { Home } from '../shared/contracts.ts';
import type { LearningPackageData, PackagePart, PackageQuestion, PackageReading, PackageRecognition } from '../shared/learning-package.ts';
import type { ImportPreview, ImportSubject } from '../shared/imports.ts';
import type { Source } from '../shared/sources.ts';
import type { Subject } from '../shared/collection.ts';
import type { CollectionStore } from './collection-store.ts';
import type { PreparedPackage } from './package-reader.ts';
import { fileHash } from './attachments.ts';
import { exportSnapshot } from './export-snapshot.ts';

type Kind = 'subjects' | 'sources' | 'pages' | 'recognitions' | 'readings' | 'questions';
type Entity = LearningPackageData[Kind][number];
export interface ImportEntity { kind: Kind; sourceId: string; targetId: string; sourceHash: string; localHash: string; value: Entity; isNew: boolean; needsLink: boolean }
interface Identity { targetId: string; sourceHash: string; localHash: string }
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  return value;
}
const fingerprint = (value: unknown) => fileHash(Buffer.from(JSON.stringify(canonical(value))));
export interface ImportPlan { preview: ImportPreview; entities: ImportEntity[] }

/** Recompute inside the final transaction after file preparation, so preview decisions cannot go stale. */
export function importPlan(db: Database.Database, collection: CollectionStore, home: Home, prepared: PreparedPackage, id: string, expiresAt: number, targets: Map<string, string>): ImportPlan {
  const data = prepared.data, entities: ImportEntity[] = [], blockers: string[] = [], subjects: ImportSubject[] = [];
  const current = exportSnapshot(db, collection, home, 0).data;
  current.subjects = collection.subjects();
  current.sources = db.prepare<[], Omit<Source, 'active'> & { active: number }>('SELECT id, name, active, revision FROM sources').all().map(s => ({ ...s, active: s.active === 1 }));
  const mapped = new Map<string, string>();
  const key = (kind: Kind, sourceId: string) => `${kind}:${sourceId}`;
  const target = (kind: Kind, sourceId: string) => mapped.get(key(kind, sourceId))!;
  const part = (p: PackagePart): PackagePart => ({ ...p, pageId: target('pages', p.pageId), transcription: p.transcription ?? '', recognition: p.recognition ? { ...p.recognition, runId: target('recognitions', p.recognition.runId) } : null });
  const label: Record<Kind, string> = { subjects: '学科', sources: '来源', pages: '原图', recognitions: '识别记录', readings: '共享阅读材料', questions: '题目' };
  const table: Record<Kind, string> = { subjects: 'subjects', sources: 'sources', pages: 'originalPages', recognitions: 'ocrTests', readings: 'readingMaterials', questions: 'questions' };
  let added = 0, skipped = 0;
  for (const kind of ['subjects', 'sources', 'pages', 'recognitions', 'readings', 'questions'] as const) {
    const local = new Map<string, Entity>(current[kind].map(v => [v.id, v]));
    for (const incoming of data[kind]) {
      const identity = db.prepare<[string, string, string], Identity>('SELECT targetId, sourceHash, localHash FROM importIdentities WHERE sourceLibraryId = ? AND kind = ? AND sourceId = ?').get(data.library.id, kind, incoming.id);
      let targetId = identity?.targetId ?? (data.library.id === home.library.id ? incoming.id : undefined);
      // Built-in subject identities are shared by the application. Names alone never merge subjects.
      if (!targetId && kind === 'subjects' && ['chinese', 'math', 'english', 'science'].includes(incoming.id)) targetId = incoming.id;
      // Sources are a managed name list. Reuse an exactly matching entry, without changing its state.
      if (!targetId && kind === 'sources') targetId = current.sources.find(s => s.name.toLocaleLowerCase() === (incoming as Source).name.toLocaleLowerCase())?.id;
      if (!targetId) {
        if (!targets.has(key(kind, incoming.id))) targets.set(key(kind, incoming.id), kind === 'pages' ? prepared.images.get((incoming as LearningPackageData['pages'][number]).path)!.id : randomUUID());
        targetId = targets.get(key(kind, incoming.id))!;
      }
      mapped.set(key(kind, incoming.id), targetId);
      let value: Entity = { ...incoming, id: targetId };
      if (kind === 'pages') { const p = value as LearningPackageData['pages'][number]; p.path = p.path.replace(incoming.id, targetId); }
      if (kind === 'recognitions') { const r = value as PackageRecognition; r.pageId = target('pages', r.pageId); r.candidates = r.candidates.map(c => ({ ...c, subjectId: c.subjectId ? mapped.get(key('subjects', c.subjectId)) ?? c.subjectId : null })); }
      if (kind === 'readings') { const r = value as PackageReading; r.parts = r.parts.map(part); }
      if (kind === 'questions') { const q = value as PackageQuestion; value = { ...q, learnerId: home.library.learnerId, subjectId: target('subjects', q.subjectId!), sourceId: q.sourceId ? target('sources', q.sourceId) : null, parts: q.parts.map(part), answerParts: q.answerParts.map(part), readingMaterialId: q.readingMaterialId ? target('readings', q.readingMaterialId) : null }; }
      const existing = local.get(targetId), sourceHash = fingerprint(incoming), localHash = fingerprint(value);
      let reason = '';
      if (kind === 'questions' && db.prepare('SELECT 1 FROM questionDeletions WHERE id = ?').get(targetId)) reason = '已在回收站或已永久删除，需要家长单独处理';
      else if (!existing && db.prepare(`SELECT 1 FROM ${table[kind]} WHERE id = ?`).get(targetId)) reason = '当前材料状态不同或已经修改，需要核对';
      else if (identity && (!existing || identity.sourceHash !== sourceHash || identity.localHash !== fingerprint(existing))) reason = '来源版本或当前内容已有修改，保留当前资料';
      else if (existing && fingerprint(existing) !== localHash) reason = '当前内容与资料包不同，保留当前资料';
      else if (!existing && kind === 'subjects' && current.subjects.some(s => s.name.toLocaleLowerCase() === (value as Subject).name.toLocaleLowerCase())) reason = '同名但来源身份不同，需要确认学科对应';
      else if (!existing && kind === 'sources' && current.sources.some(s => s.name.toLocaleLowerCase() === (value as Source).name.toLocaleLowerCase())) reason = '同名来源需要核对';
      if (reason) blockers.push(`${label[kind]}${'name' in incoming ? `“${incoming.name}”` : 'title' in incoming ? `“${incoming.title}”` : ''}：${reason}`);
      if (kind === 'subjects') subjects.push({ id: incoming.id, name: (incoming as Subject).name, action: reason ? 'blocked' : existing ? 'existing' : 'new', targetName: existing ? (existing as Subject).name : null });
      if (kind === 'questions' && !reason) { if (existing) skipped++; else added++; }
      entities.push({ kind, sourceId: incoming.id, targetId, sourceHash, localHash, value, isNew: !existing, needsLink: !identity });
    }
  }
  const token = fingerprint({ packageHash: prepared.packageHash, accountId: home.account.id, entities, blockers });
  return { entities, preview: { id, status: 'preview', token, sourceLearner: data.library.learnerName, targetLearner: home.library.learnerName, added, skipped,
    total: data.questions.length, pageCount: data.pages.length, readingCount: data.readings.length, subjects,
    stages: [...new Map(data.questions.map(q => [JSON.stringify(q.studyStage), q.studyStage])).values()], blockers: [...new Set(blockers)], expiresAt } };
}

/** Called only inside the atomic publication transaction after every original and preview is durable. */
export function applyImport(db: Database.Database, home: Home, prepared: PreparedPackage, plan: ImportPlan, importedAt: number) {
  for (const e of plan.entities) {
    const v = e.value;
    if (e.isNew) switch (e.kind) {
      case 'subjects': { const s = v as Subject; db.prepare('INSERT INTO subjects SELECT ?, ?, COALESCE(MAX(position), -1) + 1 FROM subjects').run(s.id, s.name); break; }
      case 'sources': { const s = v as Source; db.prepare('INSERT INTO sources VALUES (?, ?, ?, ?)').run(s.id, s.name, s.active ? 1 : 0, s.revision); break; }
      case 'pages': {
        const p = v as LearningPackageData['pages'][number], source = prepared.data.pages.find(p => p.id === e.sourceId)!;
        const stored = prepared.images.get(source.path)!;
        db.prepare('INSERT INTO originalPages (id, libraryId, mimeType, byteLength, sha256, previewSha256, width, height) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(p.id, home.library.id, p.mimeType, p.byteLength, p.sha256, stored.previewSha256, p.width, p.height); break;
      }
      case 'recognitions': {
        const r = v as PackageRecognition;
        db.prepare(`INSERT INTO ocrTests (id, accountId, revision, provider, sample, status, createdAt, finishedAt, libraryId, pageId, inputWidth, inputHeight, inputRegion, lines, candidates, message)
          VALUES (?, ?, ?, 'imported', 'original-page', 'succeeded', ?, ?, ?, ?, ?, ?, ?, ?, ?, '从学习资料包恢复，未发起识别')`).run(r.id, home.account.id, r.revision, r.createdAt, r.finishedAt, home.library.id, r.pageId, r.inputWidth, r.inputHeight, r.inputRegion ? JSON.stringify(r.inputRegion) : null, JSON.stringify(r.lines), JSON.stringify(r.candidates)); break;
      }
      case 'readings': {
        const r = v as PackageReading;
        db.prepare('INSERT INTO readingMaterials VALUES (?, ?, ?, ?, ?, ?)').run(r.id, home.library.id, r.title, r.revision, r.createdAt, r.updatedAt);
        r.parts.forEach((p, position) => db.prepare('INSERT INTO readingParts VALUES (?, ?, ?, ?, ?)').run(r.id, p.id, p.pageId, position, JSON.stringify(p.region))); break;
      }
      case 'questions': {
        const q = v as PackageQuestion;
        db.prepare(`INSERT INTO questions (id, libraryId, learnerId, originalPageId, revision, state, subjectId, region, sourceId, source, pageNumber, questionNumber, note, createdAt, updatedAt, collectedAt, schoolYear, grade, term, importedAt)
          VALUES (?, ?, ?, ?, ?, 'collected', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(q.id, home.library.id, home.library.learnerId, q.parts[0]!.pageId, q.revision, q.subjectId, JSON.stringify(q.parts[0]!.region), q.sourceId, q.source, q.pageNumber, q.questionNumber, q.note, q.createdAt, q.updatedAt, q.collectedAt, q.studyStage.schoolYear, q.studyStage.grade, q.studyStage.term, importedAt);
        q.parts.forEach((p, position) => db.prepare('INSERT INTO questionParts (questionId, id, pageId, position, region, transcription, recognition) VALUES (?, ?, ?, ?, ?, ?, ?)').run(q.id, p.id, p.pageId, position, JSON.stringify(p.region), p.transcription ?? '', p.recognition ? JSON.stringify(p.recognition) : null));
        q.answerParts.forEach((p, position) => db.prepare('INSERT INTO answerParts VALUES (?, ?, ?, ?, ?)').run(q.id, p.id, p.pageId, position, JSON.stringify(p.region)));
        if (q.readingMaterialId) db.prepare('INSERT INTO questionReadings VALUES (?, ?)').run(q.id, q.readingMaterialId);
        break;
      }
    }
    if (e.needsLink) db.prepare('INSERT INTO importIdentities (sourceLibraryId, kind, sourceId, targetId, sourceHash, localHash) VALUES (?, ?, ?, ?, ?, ?)').run(prepared.data.library.id, e.kind, e.sourceId, e.targetId, e.sourceHash, e.localHash);
  }
}
