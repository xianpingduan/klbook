import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { Home } from '../shared/contracts.ts';
import type { LearningPackageData, PackagePart, PackageQuestion, PackageReading, PackageRecognition } from '../shared/learning-package.ts';
import type { ImportDecisions, ImportPreview, ImportQuestionChoice, ImportSubject } from '../shared/imports.ts';
import type { Source } from '../shared/sources.ts';
import type { Subject } from '../shared/collection.ts';
import type { CollectionStore } from './collection-store.ts';
import type { PreparedPackage } from './package-reader.ts';
import { fileHash } from './attachments.ts';
import { exportSnapshot } from './export-snapshot.ts';

type Kind = 'subjects' | 'sources' | 'pages' | 'recognitions' | 'readings' | 'questions';
type Entity = LearningPackageData[Kind][number];
interface Identity { targetId: string; sourceHash: string; localHash: string }
export interface ImportEntity {
  kind: Kind; sourceId: string; targetId: string; sourceHash: string; localHash: string; versionHash: string;
  value: Entity; isNew: boolean; needsLink: boolean; variant: boolean; dependencies: ImportEntity[];
  restore?: boolean; acceptRestored?: boolean;
  replaceLink?: boolean;
}
export interface ImportPlan { preview: ImportPreview; entities: ImportEntity[]; contextToken: string }
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  return value;
}
export const fingerprint = (value: unknown) => fileHash(Buffer.from(JSON.stringify(canonical(value))));
export const noDecisions = (): ImportDecisions => ({ questions: [], subjects: [] });

/** A plan contains only the graph that will be published. Keeping a question never imports orphan materials. */
export function importPlan(db: Database.Database, collection: CollectionStore, home: Home, prepared: PreparedPackage, id: string, expiresAt: number, targets: Map<string, string>, decisions = noDecisions(), now = Date.now()): ImportPlan {
  const data = prepared.data, blockers: string[] = [], subjects: ImportSubject[] = [], questions: ImportQuestionChoice[] = [];
  const current = exportSnapshot(db, collection, home, 0, true).data;
  current.subjects = collection.subjects();
  current.sources = db.prepare<[], Omit<Source, 'active'> & { active: number }>('SELECT id, name, active, revision FROM sources').all().map(s => ({ ...s, active: s.active === 1 }));
  const local = Object.fromEntries(Object.entries(current).filter(([k]) => k !== 'library').map(([k, v]) => [k, new Map((v as Entity[]).map(e => [e.id, e]))])) as Record<Kind, Map<string, Entity>>;
  const deletions = db.prepare<[], { id: string; revision: number; deletedAt: number; expiresAt: number; purgedAt: number | null }>('SELECT * FROM questionDeletions ORDER BY id').all();
  const identities = db.prepare<[string], Identity & { kind: Kind; sourceId: string }>('SELECT * FROM importIdentities WHERE sourceLibraryId = ? ORDER BY kind, sourceId').all(data.library.id);
  const versions = db.prepare<[string], Identity & { kind: Kind; sourceId: string; versionHash: string }>('SELECT * FROM importVersions WHERE sourceLibraryId = ? ORDER BY kind, sourceId, versionHash').all(data.library.id);
  const contextToken = fingerprint({ current, deletions: deletions.map(d => ({ ...d, withinRestorePeriod: d.expiresAt > now })), identities, versions, questions: db.prepare('SELECT id, revision, state, cancelledAt FROM questions ORDER BY id').all() });
  const key = (kind: Kind, sourceId: string) => `${kind}:${sourceId}`;
  const resolved = new Map<string, ImportEntity>(), published = new Set<ImportEntity>();
  const identityMap = new Map(identities.map(i => [key(i.kind, i.sourceId), i]));
  const versionMap = new Map(versions.map(i => [`${key(i.kind, i.sourceId)}:${i.versionHash}`, i]));
  const freshId = (kind: Kind, sourceId: string, versionHash: string) => {
    const slot = `${key(kind, sourceId)}:${versionHash}`;
    if (!targets.has(slot)) targets.set(slot, randomUUID());
    return targets.get(slot)!;
  };
  const publish = (e: ImportEntity) => { if (published.has(e)) return; e.dependencies.forEach(publish); published.add(e); };
  const incomingById = Object.fromEntries((['subjects', 'sources', 'pages', 'recognitions', 'readings', 'questions'] as const).map(kind => [kind, new Map<string, Entity>(data[kind].map(e => [e.id, e]))])) as Record<Kind, Map<string, Entity>>;
  const table: Record<Kind, string> = { subjects: 'subjects', sources: 'sources', pages: 'originalPages', recognitions: 'ocrTests', readings: 'readingMaterials', questions: 'questions' };
  const material = (q: PackageQuestion, from: LearningPackageData) => {
    const p = q.parts[0]!, page = from.pages.find(page => page.id === p.pageId)!;
    return { pageId: page.id, width: page.width, height: page.height, region: p.region };
  };

  function resolve(kind: Kind, incoming: Entity): ImportEntity {
    const cacheKey = key(kind, incoming.id), cached = resolved.get(cacheKey);
    if (cached) return cached;
    const dependencies: ImportEntity[] = [];
    const dependency = (k: Kind, sourceId: string) => { const e = resolve(k, incomingById[k].get(sourceId)!); dependencies.push(e); return e.targetId; };
    const part = (p: PackagePart): PackagePart => ({ ...p, pageId: dependency('pages', p.pageId), transcription: p.transcription ?? '', recognition: p.recognition ? { ...p.recognition, runId: dependency('recognitions', p.recognition.runId) } : null });
    let value = { ...incoming } as Entity;
    if (kind === 'recognitions') { const r = value as PackageRecognition; r.pageId = dependency('pages', r.pageId); r.candidates = r.candidates.map(c => ({ ...c, subjectId: c.subjectId && incomingById.subjects.has(c.subjectId) ? dependency('subjects', c.subjectId) : c.subjectId })); }
    if (kind === 'readings') { const r = value as PackageReading; r.parts = r.parts.map(part); }
    if (kind === 'questions') { const q = value as PackageQuestion; value = { ...q, learnerId: home.library.learnerId, subjectId: dependency('subjects', q.subjectId!), sourceId: q.sourceId ? dependency('sources', q.sourceId) : null, parts: q.parts.map(part), answerParts: q.answerParts.map(part), readingMaterialId: q.readingMaterialId ? dependency('readings', q.readingMaterialId) : null }; }
    const sourceHash = fingerprint(incoming), versionHash = fingerprint({ incoming, dependencies: dependencies.map(e => [e.kind, e.sourceId, e.versionHash]) });
    const identity = identityMap.get(cacheKey), version = versionMap.get(`${cacheKey}:${versionHash}`);
    let targetId = version?.targetId ?? identity?.targetId ?? (data.library.id === home.library.id ? incoming.id : undefined), variant = !!version;
    if (!targetId && kind === 'subjects' && ['chinese', 'math', 'english', 'science'].includes(incoming.id)) targetId = incoming.id;
    if (kind === 'sources') {
      const matching = current.sources.find(s => s.name.toLocaleLowerCase() === (incoming as Source).name.toLocaleLowerCase());
      if (matching && matching.id !== targetId) { targetId = matching.id; variant = !!identity || !!version; }
    }
    const existing = targetId ? local[kind].get(targetId) : undefined;
    const converted = (newId: string) => {
      const result = { ...value, id: newId };
      if (kind === 'pages') (result as LearningPackageData['pages'][number]).path = (incoming as LearningPackageData['pages'][number]).path.replace(incoming.id, newId);
      return result;
    };
    let same = !!existing && (version ?? identity)?.sourceHash === sourceHash && (version ?? identity)?.localHash === fingerprint(existing);
    if (existing && fingerprint(existing) === fingerprint(converted(existing.id))) same = true;
    // Even an already-imported dependency version differs from the material linked to the original question.
    if (kind === 'questions' && existing) {
      const references = (q: PackageQuestion) => ({ subjectId: q.subjectId, sourceId: q.sourceId, parts: q.parts, answerParts: q.answerParts, readingMaterialId: q.readingMaterialId });
      if (fingerprint(references(existing as PackageQuestion)) !== fingerprint(references(converted(existing.id) as PackageQuestion))) same = false;
    }
    let replaceLink = false;
    if (kind === 'subjects') {
      const name = (incoming as Subject).name;
      const choice = decisions.subjects.find(d => d.id === incoming.id);
      let matched = existing && same ? existing as Subject : undefined, newName: string | undefined;
      if (choice) {
        matched = undefined;
        if (!!choice.targetId !== !!choice.newName) {
          if (choice.targetId) matched = current.subjects.find(s => s.id === choice.targetId);
          else {
            const candidate = choice.newName!.trim();
            if (candidate && candidate.length <= 80 && !current.subjects.some(s => s.name.toLocaleLowerCase() === candidate.toLocaleLowerCase())
              && !subjects.some(s => s.action === 'new' && s.targetName?.toLocaleLowerCase() === candidate.toLocaleLowerCase())) newName = candidate;
          }
        }
      }
      if (matched) { targetId = matched.id; value = matched; }
      else if (newName) { targetId = freshId(kind, incoming.id, `${versionHash}:${newName}`); value = { id: targetId, name: newName }; }
      else blockers.push(`学科“${name}”：需要确认学科对应或填写不重名的新学科`);
      replaceLink = !!choice && (!!matched || !!newName);
      subjects.push({ id: incoming.id, name, action: matched ? 'existing' : newName ? 'new' : 'blocked', targetName: matched?.name ?? newName ?? null });
    }
    let restore = false, acceptRestored = false;
    if (kind === 'questions') {
      const q = incoming as PackageQuestion, currentQ = existing as PackageQuestion | undefined;
      const deletion = targetId ? deletions.find(d => d.id === targetId) : undefined;
      const occupied = targetId && db.prepare(`SELECT 1 FROM ${table[kind]} WHERE id = ?`).get(targetId);
      const status: ImportQuestionChoice['status'] = deletion ? deletion.purgedAt === null ? 'trash' : 'deleted' : same ? 'unchanged' : existing || occupied || identity || version ? 'conflict' : 'new';
      const requested = decisions.questions.find(d => d.id === incoming.id)?.action;
      const canCopy = status === 'conflict' && !version;
      const canRestore = status === 'trash' && !!currentQ && deletion!.expiresAt > now;
      const action: ImportQuestionChoice['action'] = status === 'new' ? 'add' : status === 'unchanged' ? 'skip' : requested === 'copy' && canCopy ? 'copy' : requested === 'restore' && canRestore ? 'restore' : 'keep';
      if (requested && requested !== 'keep' && requested !== action) blockers.push('该题当前状态不支持所选操作，请重新核对');
      questions.push({ id: q.id, label: `${(data.subjects.find(s => s.id === q.subjectId)?.name ?? '')}${q.questionNumber ? ` · 第 ${q.questionNumber} 题` : ''}`, status, action, canCopy, canRestore,
        incoming: { note: q.note, revision: q.revision, collectedAt: q.collectedAt, studyStage: q.studyStage, material: material(q, data) },
        current: currentQ ? { id: currentQ.id, note: currentQ.note, revision: currentQ.revision, collectedAt: currentQ.collectedAt, studyStage: currentQ.studyStage, material: material(currentQ, current) } : null });
      if (action === 'copy') { targetId = freshId(kind, incoming.id, versionHash); variant = true; }
      if (action === 'skip') value = currentQ!;
      if (action === 'restore') {
        restore = true;
        const content = (q: PackageQuestion) => ({ ...q, revision: 0, updatedAt: 0 });
        acceptRestored = fingerprint(content(currentQ!)) === fingerprint(content(converted(targetId!) as PackageQuestion));
        value = currentQ!;
        dependencies.length = 0;
        const reading = currentQ!.readingMaterialId ? local.readings.get(currentQ!.readingMaterialId) as PackageReading : undefined;
        for (const pageId of new Set([...currentQ!.parts, ...currentQ!.answerParts, ...(reading?.parts ?? [])].map(p => p.pageId))) {
          const p = local.pages.get(pageId)!;
          dependencies.push({ kind: 'pages', sourceId: pageId, targetId: pageId, sourceHash: fingerprint(p), localHash: fingerprint(p), versionHash: fingerprint(p), value: p, isNew: false, needsLink: false, variant: false, dependencies: [] });
        }
      }
      if (!targetId) targetId = freshId(kind, incoming.id, versionHash);
    } else if (kind !== 'subjects' && existing && !same) {
      // Never rewrite a shared dependency used by local questions. Import its version into a new identity.
      if (kind === 'sources' && (existing as Source).name === (incoming as Source).name) { value = existing; }
      else { targetId = freshId(kind, incoming.id, versionHash); variant = true; }
    } else if (kind !== 'subjects' && targetId && !existing && (identity || version || db.prepare(`SELECT 1 FROM ${table[kind]} WHERE id = ?`).get(targetId))) { targetId = freshId(kind, incoming.id, versionHash); variant = true; }
    if (!targetId) targetId = freshId(kind, incoming.id, versionHash);
    value = converted(targetId);
    const e: ImportEntity = { kind, sourceId: incoming.id, targetId, sourceHash, localHash: fingerprint(value), versionHash, value, isNew: !local[kind].has(targetId), needsLink: !identity && !variant && !restore, variant, dependencies, restore, acceptRestored, replaceLink };
    resolved.set(cacheKey, e);
    return e;
  }
  for (const q of data.questions) {
    const entity = resolve('questions', q), choice = questions.at(-1)!;
    if (choice.action !== 'keep') publish(entity);
  }
  // The package also keeps successful page recognitions that were never adopted into a question.
  for (const run of data.recognitions) {
    const page = resolved.get(key('pages', run.pageId));
    if (page && published.has(page)) publish(resolve('recognitions', run));
  }
  const count = (action: ImportQuestionChoice['action']) => questions.filter(q => q.action === action).length;
  const entities = [...published];
  const token = fingerprint({ packageHash: prepared.packageHash, accountId: home.account.id, contextToken, decisions, entities, blockers, questions });
  return { entities, contextToken, preview: { id, status: 'preview', token, sourceLearner: data.library.learnerName, targetLearner: home.library.learnerName,
    added: count('add'), skipped: count('skip'), kept: count('keep'), copied: count('copy'), restored: count('restore'), conflicts: questions.filter(q => q.status === 'conflict').length, trashed: questions.filter(q => q.status === 'trash' || q.status === 'deleted').length,
    total: data.questions.length, pageCount: data.pages.length, readingCount: data.readings.length, subjects, availableSubjects: current.subjects, questions, decisions,
    stages: [...new Map(data.questions.map(q => [JSON.stringify(q.studyStage), q.studyStage])).values()], blockers: [...new Set(blockers)], expiresAt } };
}
