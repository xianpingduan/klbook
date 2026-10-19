import type { LearningPackageData, LearningPackageManifest } from '../shared/learning-package.ts';
import { validQuestionRegion } from '../shared/collection.ts';
import { emptyStage, validStage } from '../shared/study.ts';
import { AccessError } from './family-access.ts';

export function requirePackage(condition: unknown, message = '资料包结构或引用不完整，请重新导出后再试'): asserts condition {
  if (!condition) throw new AccessError(422, message);
}
type ObjectValue = Record<string, unknown>;
function object(value: unknown, keys: string, optional = ''): asserts value is ObjectValue {
  requirePackage(value !== null && typeof value === 'object' && !Array.isArray(value));
  const required = keys.split(' ').filter(Boolean), allowed = [...required, ...optional.split(' ')];
  requirePackage(required.every(k => Object.hasOwn(value, k)) && Object.keys(value).every(k => allowed.includes(k)));
}
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (value: unknown) => typeof value === 'string' && uuidPattern.test(value);
const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const text = (value: unknown, max: number, min = 0) => typeof value === 'string' && value.length >= min && value.length <= max;
const integer = (value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER) => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
const timestamp = (value: unknown) => integer(value, 0, 8_640_000_000_000_000);
function array(value: unknown, max = 10000): asserts value is unknown[] { requirePackage(Array.isArray(value) && value.length <= max); }
function region(value: unknown, nullable = false) {
  if (nullable && value === null) return;
  object(value, 'x y width height');
  requirePackage(validQuestionRegion(value as unknown as import('../shared/collection.ts').Region));
}
function unique(values: { id: string }[]) { requirePackage(new Set(values.map(v => v.id)).size === values.length); }
export function packageManifest(value: unknown): LearningPackageManifest {
  object(value, 'format version packageId snapshotAt sourceLibraryId questionCount files');
  requirePackage(value.format === 'klbook-learning-package', '请选择本应用导出的学习资料 ZIP 包');
  requirePackage(value.version === 1, '不支持此资料包版本，请使用匹配版本的应用');
  requirePackage(uuid(value.packageId) && uuid(value.sourceLibraryId) && timestamp(value.snapshotAt) && integer(value.questionCount, 1, 10000));
  array(value.files, 10001);
  for (const entry of value.files) {
    object(entry, 'path byteLength sha256');
    requirePackage(text(entry.path, 100, 1) && integer(entry.byteLength, 1, 16 * 1024 * 1024) && hash(entry.sha256));
  }
  const result = value as unknown as LearningPackageManifest;
  requirePackage(new Set(result.files.map(f => f.path)).size === result.files.length);
  return result;
}
export function packageData(value: unknown, manifest: LearningPackageManifest): LearningPackageData {
  object(value, 'library questions readings pages subjects sources recognitions');
  object(value.library, 'id learnerId learnerName');
  requirePackage(uuid(value.library.id) && value.library.id === manifest.sourceLibraryId && uuid(value.library.learnerId) && text(value.library.learnerName, 64, 1));
  for (const key of ['questions', 'readings', 'pages', 'subjects', 'sources', 'recognitions']) array(value[key]);
  const data = value as unknown as LearningPackageData;
  for (const list of [data.questions, data.readings, data.pages, data.subjects, data.sources, data.recognitions]) unique(list);
  requirePackage(data.questions.length === manifest.questionCount);
  for (const p of data.pages) {
    object(p, 'id mimeType byteLength sha256 width height path');
    const extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[p.mimeType];
    requirePackage(uuid(p.id) && extension && p.path === `images/${p.id}.${extension}` && integer(p.byteLength, 1, 15 * 1024 * 1024)
      && hash(p.sha256) && integer(p.width, 1, 40_000_000) && integer(p.height, 1, 40_000_000) && p.width * p.height <= 40_000_000);
  }
  for (const s of data.subjects) { object(s, 'id name'); requirePackage(text(s.id, 64, 1) && text(s.name, 80, 1) && s.name.trim() === s.name); }
  for (const s of data.sources) { object(s, 'id name active revision'); requirePackage(uuid(s.id) && text(s.name, 200, 1) && s.name.trim() === s.name && typeof s.active === 'boolean' && integer(s.revision, 1)); }
  for (const list of [data.subjects, data.sources]) requirePackage(new Set(list.map(s => s.name.toLocaleLowerCase())).size === list.length, '资料包存在同名的重复学科或来源，请核对后重新导出');
  const pages = new Set(data.pages.map(p => p.id)), readings = new Set(data.readings.map(r => r.id));
  const subjects = new Set(data.subjects.map(s => s.id)), sources = new Map(data.sources.map(s => [s.id, s]));
  const runs = new Map(data.recognitions.map(r => [r.id, r]));
  const usedPages = new Set<string>(), usedReadings = new Set<string>(), usedSubjects = new Set<string>(), usedSources = new Set<string>();
  for (const r of data.recognitions) {
    object(r, 'id pageId revision createdAt finishedAt inputWidth inputHeight inputRegion lines candidates');
    requirePackage(uuid(r.id) && pages.has(r.pageId) && integer(r.revision, 0) && timestamp(r.createdAt) && (r.finishedAt === null || timestamp(r.finishedAt)));
    requirePackage((r.inputWidth === null || integer(r.inputWidth, 1, 40_000_000)) && (r.inputHeight === null || integer(r.inputHeight, 1, 40_000_000)));
    region(r.inputRegion, true); array(r.lines, 10000); array(r.candidates, 100); unique(r.candidates);
    for (const l of r.lines) {
      object(l, 'text', 'box'); requirePackage(text(l.text, 20000));
      if (l.box !== undefined) { object(l.box, 'left top width height'); requirePackage(Object.values(l.box).every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 40_000_000)); }
    }
    for (const c of r.candidates) {
      object(c, 'id text region questionNumber subjectId'); region(c.region);
      requirePackage(text(c.id, 20, 1) && text(c.text, 20000) && text(c.questionNumber, 32) && (c.subjectId === null || subjects.has(c.subjectId) || ['chinese', 'math', 'english', 'science'].includes(c.subjectId)));
    }
  }
  function parts(values: unknown, question: boolean, allowEmpty = false) {
    array(values, 50); requirePackage(allowEmpty || values.length > 0);
    const ids = new Set();
    for (const p of values) {
      object(p, 'id pageId region', 'transcription recognition');
      requirePackage(uuid(p.id) && !ids.has(p.id) && typeof p.pageId === 'string' && pages.has(p.pageId)); ids.add(p.id); usedPages.add(p.pageId);
      region(p.region); requirePackage(p.transcription === undefined || text(p.transcription, 20000));
      if (p.recognition != null) {
        object(p.recognition, 'runId candidateId'); const r = runs.get(String(p.recognition.runId)), candidateId = p.recognition.candidateId;
        requirePackage(r && r.pageId === p.pageId && (candidateId === null || r.candidates.some(c => c.id === candidateId)));
      }
      requirePackage(question || ((!p.transcription || p.transcription === '') && p.recognition == null));
      p.transcription ??= ''; p.recognition ??= null;
    }
  }
  for (const r of data.readings) { object(r, 'id title revision createdAt updatedAt parts'); requirePackage(uuid(r.id) && text(r.title, 120, 1) && integer(r.revision, 1) && timestamp(r.createdAt) && timestamp(r.updatedAt)); parts(r.parts, false); }
  for (const q of data.questions) {
    object(q, 'id learnerId revision subjectId sourceId source pageNumber questionNumber note createdAt updatedAt collectedAt parts answerParts readingMaterialId', 'studyStage');
    requirePackage(uuid(q.id) && q.learnerId === data.library.learnerId && integer(q.revision, 1) && typeof q.subjectId === 'string' && subjects.has(q.subjectId));
    usedSubjects.add(q.subjectId);
    requirePackage(q.sourceId === null || sources.has(q.sourceId)); if (q.sourceId) { usedSources.add(q.sourceId); requirePackage(q.source === sources.get(q.sourceId)!.name); }
    requirePackage(text(q.source, 200) && text(q.pageNumber, 32) && text(q.questionNumber, 32) && text(q.note, 2000));
    requirePackage(timestamp(q.createdAt) && timestamp(q.updatedAt) && timestamp(q.collectedAt));
    if (!Object.hasOwn(q, 'studyStage')) q.studyStage = { ...emptyStage };
    requirePackage(validStage(q.studyStage)); parts(q.parts, true); parts(q.answerParts, false, true);
    requirePackage(q.readingMaterialId === null || readings.has(q.readingMaterialId)); if (q.readingMaterialId) usedReadings.add(q.readingMaterialId);
  }
  requirePackage(usedPages.size === pages.size && usedReadings.size === readings.size && usedSubjects.size === subjects.size && usedSources.size === sources.size);
  return data;
}
