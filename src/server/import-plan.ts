import type Database from 'better-sqlite3';
import type { Home } from '../shared/contracts.ts';
import type { LearningPackageData, PackageQuestion, PackageReading, PackageRecognition } from '../shared/learning-package.ts';
import type { Source } from '../shared/sources.ts';
import type { Subject } from '../shared/collection.ts';
import type { PreparedPackage } from './package-reader.ts';
import type { ImportPlan } from './import-resolution.ts';
import { fingerprint } from './import-resolution.ts';
export { importPlan } from './import-resolution.ts';
/** Called only inside the atomic publication transaction after every original and preview is durable. */
export function applyImport(db: Database.Database, home: Home, prepared: PreparedPackage, plan: ImportPlan, importedAt: number) {
  for (const e of plan.entities) {
    const v = e.value;
    if (e.restore) {
      const q = v as PackageQuestion;
      db.prepare('DELETE FROM questionDeletions WHERE id = ?').run(q.id);
      db.prepare('UPDATE questions SET revision = revision + 1, updatedAt = ?, importedAt = ? WHERE id = ?').run(importedAt, importedAt, q.id);
      if (e.acceptRestored) {
        e.localHash = fingerprint({ ...q, revision: q.revision + 1, updatedAt: importedAt });
        db.prepare('UPDATE importIdentities SET localHash = ? WHERE sourceLibraryId = ? AND kind = ? AND sourceId = ? AND targetId = ? AND sourceHash = ?').run(e.localHash, prepared.data.library.id, e.kind, e.sourceId, e.targetId, e.sourceHash);
      }
    }
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
        db.prepare('INSERT INTO questionImportOrigins VALUES (?, ?, ?, ?, ?, ?)').run(q.id, prepared.data.library.id, e.sourceId, q.revision, prepared.data.library.learnerName, e.variant ? 1 : 0);
        break;
      }
    }
    if (e.needsLink || e.replaceLink) db.prepare('INSERT INTO importIdentities (sourceLibraryId, kind, sourceId, targetId, sourceHash, localHash) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(sourceLibraryId, kind, sourceId) DO UPDATE SET targetId = excluded.targetId, sourceHash = excluded.sourceHash, localHash = excluded.localHash').run(prepared.data.library.id, e.kind, e.sourceId, e.targetId, e.sourceHash, e.localHash);
    if (e.variant && (!e.restore || e.acceptRestored)) db.prepare('INSERT INTO importVersions VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(sourceLibraryId, kind, sourceId, versionHash) DO UPDATE SET targetId = excluded.targetId, sourceHash = excluded.sourceHash, localHash = excluded.localHash')
      .run(prepared.data.library.id, e.kind, e.sourceId, e.versionHash, e.targetId, e.sourceHash, e.localHash);
  }
}
