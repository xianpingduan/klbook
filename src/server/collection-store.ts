import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { Home } from '../shared/contracts.ts';
import type { AnswerEdit, AnswerPageList, Question, QuestionCreate, QuestionEdit, QuestionList, QuestionPartEdit, Region, Subject } from '../shared/collection.ts';
import { validQuestionRegion } from '../shared/collection.ts';
import { AccessError } from './family-access.ts';
import { Attachments, fileHash } from './attachments.ts';
import type { StoredPage } from './attachments.ts';
import { Sources } from './sources.ts';
import { ReadingMaterials } from './reading-materials.ts';
import { Study, normalizeStage } from './study.ts';
import type { StudyStage } from '../shared/study.ts';
import type { FilterOptions, QuestionFilters } from '../shared/collection.ts';

interface QuestionRow extends Omit<Question, 'originalPage' | 'parts' | 'region' | 'syncState' | 'readingMaterial' | 'answerParts' | 'studyStage'>, StudyStage { originalPageId: string; region: string | null }
export class CollectionStore {
  private db: Database.Database;
  private files: Attachments;
  private now: () => number;
  private sources: Sources;
  readonly readings: ReadingMaterials;
  constructor(db: Database.Database, dataDir: string, now = Date.now) {
    this.db = db; this.files = new Attachments(dataDir); this.now = now; this.sources = new Sources(db);
    this.readings = new ReadingMaterials(db, { get: (library, page) => this.publicPage(library, page), verify: (library, page) => this.verifyPage(library, page) }, now);
  }
  subjects(): Subject[] { return this.db.prepare<[], Subject>('SELECT id, name FROM subjects ORDER BY position').all(); }
  private page(libraryId: string, id: string) {
    const page = this.db.prepare<[string, string], StoredPage>('SELECT * FROM originalPages WHERE libraryId = ? AND id = ?').get(libraryId, id);
    if (!page) throw new AccessError(404, '找不到原始页');
    return page;
  }
  publicPage(libraryId: string, id: string) {
    const { previewSha256: _preview, libraryId: _libraryId, ...page } = this.page(libraryId, id);
    return page;
  }
  private async verifyPage(libraryId: string, id: string) {
    const page = this.page(libraryId, id);
    await this.files.read(page, 'original'); await this.files.read(page, 'preview');
  }
  private async verifyQuestion(question: Question) {
    for (const pageId of new Set([...question.parts, ...question.answerParts, ...(question.readingMaterial?.parts ?? [])].map(part => part.originalPage.id))) await this.verifyPage(question.libraryId, pageId);
  }
  get(libraryId: string, id: string): Question {
    const row = this.db.prepare<[string, string], QuestionRow>('SELECT * FROM questions WHERE libraryId = ? AND id = ?').get(libraryId, id);
    if (!row) throw new AccessError(404, '找不到这道题');
    const { originalPageId, region, schoolYear, grade, term, ...rest } = row;
    const parts = this.db.prepare<[string], { id: string; pageId: string; region: string | null; transcription: string; recognition: string | null }>('SELECT id, pageId, region, transcription, recognition FROM questionParts WHERE questionId = ? ORDER BY position').all(id)
      .map(part => ({ id: part.id, originalPage: this.publicPage(libraryId, part.pageId), region: part.region ? JSON.parse(part.region) as Region : null, transcription: part.transcription, recognition: part.recognition ? JSON.parse(part.recognition) : null }));
    const reading = this.db.prepare<[string], { materialId: string }>('SELECT materialId FROM questionReadings WHERE questionId = ?').get(id);
    const answerParts = this.db.prepare<[string], { id: string; pageId: string; region: string }>('SELECT id, pageId, region FROM answerParts WHERE questionId = ? ORDER BY position').all(id)
      .map(part => ({ id: part.id, originalPage: this.publicPage(libraryId, part.pageId), region: JSON.parse(part.region) as Region }));
    return { ...rest, studyStage: { schoolYear, grade, term }, source: rest.sourceId ? this.sources.get(rest.sourceId).name : rest.source, region: region ? JSON.parse(region) as Region : null, originalPage: this.publicPage(libraryId, originalPageId), parts, answerParts, readingMaterial: reading ? this.readings.get(libraryId, reading.materialId) : null, syncState: 'synced' };
  }
  filterOptions(libraryId: string): FilterOptions {
    const values = (column: 'schoolYear' | 'grade') => this.db.prepare<[string], { value: string }>(`SELECT DISTINCT ${column} AS value FROM questions WHERE libraryId = ? AND ${column} IS NOT NULL ORDER BY ${column} DESC`).all(libraryId).map(row => row.value);
    return { schoolYears: values('schoolYear'), grades: values('grade'), sources: this.sources.list(true) };
  }
  list(libraryId: string, state: 'draft' | 'collected', offset: number, filters: QuestionFilters = {}): QuestionList {
    const clauses = ['libraryId = ?', 'state = ?'];
    const values: (string | number)[] = [libraryId, state];
    for (const key of ['subjectId', 'schoolYear', 'grade', 'term', 'sourceId'] as const) {
      if (!filters[key]) continue;
      if (filters[key] === '__unset__') clauses.push(`${key} IS NULL`);
      else { clauses.push(`${key} = ?`); values.push(filters[key]); }
    }
    if (filters.collectedFrom && filters.collectedBefore && Number(filters.collectedFrom) >= Number(filters.collectedBefore)) throw new AccessError(422, '收集日期的开始时间需早于结束时间');
    if (filters.collectedFrom) { clauses.push('collectedAt >= ?'); values.push(Number(filters.collectedFrom)); }
    if (filters.collectedBefore) { clauses.push('collectedAt < ?'); values.push(Number(filters.collectedBefore)); }
    const where = clauses.join(' AND ');
    const ids = this.db.prepare<(string | number)[], { id: string }>(`SELECT id FROM questions WHERE ${where} ORDER BY createdAt DESC, id LIMIT 50 OFFSET ?`).all(...values, offset);
    const total = this.db.prepare<(string | number)[], { count: number }>(`SELECT COUNT(*) AS count FROM questions WHERE ${where}`).get(...values)!.count;
    return { items: ids.map(row => this.get(libraryId, row.id)), total, offset, limit: 50 };
  }
  private replay(home: Home, operationId: string, requestHash: string) {
    const operation = this.db.prepare<[string, string, string], { requestHash: string; questionId: string }>('SELECT requestHash, questionId FROM collectionOperations WHERE libraryId = ? AND accountId = ? AND operationId = ?').get(home.library.id, home.account.id, operationId);
    if (!operation) return null;
    if (operation.requestHash !== requestHash) throw new AccessError(409, '此次重试内容已改变，请重新确认后保存');
    return this.get(home.library.id, operation.questionId);
  }
  answerPages(libraryId: string, offset: number): AnswerPageList {
    const selection = 'FROM originalPages WHERE libraryId = ? AND EXISTS (SELECT 1 FROM answerParts WHERE pageId = originalPages.id)';
    const ids = this.db.prepare<[string, number], { id: string }>(`SELECT id ${selection} ORDER BY id LIMIT 50 OFFSET ?`).all(libraryId, offset);
    const total = this.db.prepare<[string], { count: number }>(`SELECT COUNT(*) AS count ${selection}`).get(libraryId)!.count;
    return { items: ids.map(row => this.publicPage(libraryId, row.id)), total, offset, limit: 50 };
  }
  async saveAnswers(authorize: () => Home, id: string, input: AnswerEdit) {
    const home = authorize();
    const question = this.get(home.library.id, id);
    if (input.parts.length > 50 || new Set(input.parts.map(part => part.id)).size !== input.parts.length
      || input.parts.some(part => !validQuestionRegion(part.region))) throw new AccessError(422, '请确认不超过 50 个不重复的解答区，范围需在图片内；也可以移除全部解答区');
    const parts = input.parts.map(part => ({ id: part.id, pageId: part.pageId, region: { x: part.region!.x, y: part.region!.y, width: part.region!.width, height: part.region!.height } }));
    const requestHash = `answers:${fileHash(Buffer.from(JSON.stringify({ id, expectedRevision: input.expectedRevision, parts })))}`;
    for (const pageId of new Set([...parts.map(part => part.pageId), ...question.parts.map(part => part.originalPage.id), ...(question.readingMaterial?.parts.map(part => part.originalPage.id) ?? [])])) await this.verifyPage(home.library.id, pageId);
    const saved = this.db.transaction(() => {
      authorize();
      const duplicate = this.replay(home, input.operationId, requestHash);
      if (duplicate) return duplicate;
      const latest = this.get(home.library.id, id);
      if (latest.revision !== input.expectedRevision) throw new AccessError(409, '这道题已在其他页面更新，请核对双方内容；当前解答区仍保留', { entity: 'question', id });
      this.db.prepare('DELETE FROM answerParts WHERE questionId = ?').run(id);
      const add = this.db.prepare('INSERT INTO answerParts VALUES (?, ?, ?, ?, ?)');
      parts.forEach((part, position) => add.run(id, part.id, part.pageId, position, JSON.stringify(part.region)));
      this.db.prepare('UPDATE questions SET revision = revision + 1, updatedAt = ? WHERE id = ?').run(this.now(), id);
      this.db.prepare('INSERT INTO collectionOperations VALUES (?, ?, ?, ?, ?)').run(home.library.id, home.account.id, input.operationId, requestHash, id);
      return this.get(home.library.id, id);
    })();
    // A replay can return a newer question; verify exactly the attachments in that snapshot.
    await this.verifyQuestion(saved);
    authorize();
    return saved;
  }
  async upload(authorize: () => Home, operationId: string, bytes: Buffer, stage?: StudyStage) {
    const requestHash = `upload:${fileHash(bytes)}`;
    const saved = await this.storeUpload(authorize, bytes, home => {
      const result = this.replay(home, operationId, requestHash);
      return result ? { pageId: result.originalPage.id, result } : undefined;
    }, (home, page) => {
      const id = randomUUID();
      this.db.prepare("INSERT INTO questions (id, libraryId, learnerId, originalPageId, revision, state, createdAt, updatedAt) VALUES (?, ?, ?, ?, 1, 'draft', ?, ?)").run(id, home.library.id, home.library.learnerId, page.id, this.now(), this.now());
      this.db.prepare('UPDATE questions SET schoolYear = @schoolYear, grade = @grade, term = @term WHERE id = @id').run({ id, ...(stage === undefined ? new Study(this.db).settings().stage : normalizeStage(stage)) });
      this.db.prepare('INSERT INTO questionParts (questionId, id, pageId, position, region) VALUES (?, ?, ?, 0, NULL)').run(id, randomUUID(), page.id);
      this.db.prepare('INSERT INTO collectionOperations VALUES (?, ?, ?, ?, ?)').run(home.library.id, home.account.id, operationId, requestHash, id);
      return this.get(home.library.id, id);
    });
    await this.verifyQuestion(saved); authorize();
    return saved;
  }
  async uploadPage(authorize: () => Home, operationId: string, bytes: Buffer) {
    const requestHash = fileHash(bytes);
    return this.storeUpload(authorize, bytes, home => {
      const row = this.db.prepare<[string, string, string], { pageId: string; requestHash: string }>('SELECT pageId, requestHash FROM pageOperations WHERE libraryId = ? AND accountId = ? AND operationId = ?').get(home.library.id, home.account.id, operationId);
      if (row && row.requestHash !== requestHash) throw new AccessError(409, '此次重试的图片已改变，请重新选择');
      return row ? { pageId: row.pageId, result: this.publicPage(home.library.id, row.pageId) } : undefined;
    }, (home, page) => {
      this.db.prepare('INSERT INTO pageOperations VALUES (?, ?, ?, ?, ?)').run(home.library.id, home.account.id, operationId, requestHash, page.id);
      return this.publicPage(home.library.id, page.id);
    });
  }
  private async storeUpload<T>(authorize: () => Home, bytes: Buffer, replay: (home: Home) => { pageId: string; result: T } | undefined, publish: (home: Home, page: StoredPage) => T): Promise<T> {
    const home = authorize();
    const existing = replay(home);
    if (existing) {
      const page = this.page(home.library.id, existing.pageId);
      await this.files.read(page, 'original'); await this.files.read(page, 'preview'); authorize();
      return existing.result;
    }
    const page = await this.files.save(randomUUID(), home.library.id, bytes);
    try {
      return this.db.transaction(() => {
        authorize();
        const duplicate = replay(home);
        if (duplicate) return duplicate.result;
        this.db.prepare('INSERT INTO originalPages VALUES (@id, @libraryId, @mimeType, @byteLength, @sha256, @previewSha256, @width, @height)').run(page);
        return publish(home, page);
      })();
    } finally {
      if (!this.db.prepare('SELECT 1 FROM originalPages WHERE id = ?').get(page.id)) await this.files.discard(page.id);
    }
  }
  async attachment(libraryId: string, pageId: string, variant: 'original' | 'preview') {
    const page = this.page(libraryId, pageId);
    return { bytes: await this.files.read(page, variant), mimeType: variant === 'original' ? page.mimeType : 'image/webp' };
  }

  create(authorize: () => Home, pageId: string, input: QuestionCreate) {
    return this.write(authorize, null, { ...input, expectedRevision: 0 }, pageId);
  }
  save(authorize: () => Home, id: string, input: QuestionEdit) {
    return this.write(authorize, id, input);
  }
  private async write(authorize: () => Home, id: string | null, input: QuestionEdit, pageId?: string) {
    const home = authorize();
    const current = id ? this.get(home.library.id, id) : undefined;
    const providedStage = input.studyStage === undefined ? undefined : normalizeStage(input.studyStage);
    const parts: QuestionPartEdit[] = input.parts ?? (current ? current.parts.map((part, index) => ({ id: part.id, pageId: part.originalPage.id, region: index === 0 ? input.region : part.region })) : [{ id: randomUUID(), pageId: pageId!, region: input.region }]);
    if (!parts.length || parts.length > 50 || new Set(parts.map(part => part.id)).size !== parts.length) throw new AccessError(422, '每道题需保留 1～50 个不重复的题目区');
    if (parts.some(part => part.region && !validQuestionRegion(part.region))) throw new AccessError(422, '题目范围必须在原始页内');
    if (['x', 'y', 'width', 'height'].some(key => parts[0]!.region?.[key as keyof Region] !== input.region?.[key as keyof Region])) throw new AccessError(422, '首个题目区与题目范围不一致，请刷新后重试');
    if (pageId && parts[0]!.pageId !== pageId) throw new AccessError(422, '新题需从所选原始页开始');
    if (input.region && !validQuestionRegion(input.region)) throw new AccessError(422, '题目范围必须在原始页内');
    if (input.subjectId !== null && !this.db.prepare('SELECT 1 FROM subjects WHERE id = ?').get(input.subjectId)) throw new AccessError(422, '请选择有效学科');
    if (input.state === 'collected' && (!input.subjectId || parts.some(part => !part.region))) throw new AccessError(422, '确认所有题目范围并选择学科后，才能完成收集');
    const content = {
      state: input.state, subjectId: input.subjectId, region: input.region ? { x: input.region.x, y: input.region.y, width: input.region.width, height: input.region.height } : null,
      ...(input.sourceId !== undefined ? { sourceId: input.sourceId } : { source: input.source!.trim() }),
      pageNumber: input.pageNumber.trim(), questionNumber: input.questionNumber.trim(), note: input.note.trim()
    };
    const requestHash = `save:${fileHash(Buffer.from(JSON.stringify({ id, pageId, expectedRevision: input.expectedRevision, ...content, ...(input.parts ? { parts: input.parts } : {}), ...(input.readingMaterialId !== undefined ? { readingMaterialId: input.readingMaterialId } : {}), ...(providedStage !== undefined ? { studyStage: providedStage } : {}) })))}`;
    const readingId = input.readingMaterialId === undefined ? current?.readingMaterial?.id : input.readingMaterialId;
    const reading = readingId ? await this.readings.verify(home.library.id, readingId) : null;
    // Verify the actual required files before publishing a collected record or acknowledging a retry.
    for (const required of new Set([...parts.map(part => part.pageId), ...(current?.answerParts.map(part => part.originalPage.id) ?? [])])) {
      await this.verifyPage(home.library.id, required);
    }
    const saved = this.db.transaction(() => {
      authorize();
      const duplicate = this.replay(home, input.operationId, requestHash);
      if (duplicate) return duplicate;
      const latest = id ? this.get(home.library.id, id) : undefined;
      if (latest && latest.revision !== input.expectedRevision) throw new AccessError(409, '这道题已在其他页面更新。你的修改仍在当前页面，请先重新读取并核对', { entity: 'question', id: latest.id });
      if (latest?.state === 'collected' && input.state === 'draft') throw new AccessError(409, '已收集的题目不能改回草稿');
      if (reading && this.readings.get(home.library.id, reading.id).revision !== reading.revision) throw new AccessError(409, '阅读材料已更新，请核对后重试', id ? { entity: 'question', id } : undefined);
      let selectedSource = input.sourceId ? this.sources.get(input.sourceId) : undefined;
      if (input.sourceId === undefined && input.source!.trim()) {
        const name = input.source!.trim();
        selectedSource = name === latest?.source && latest.sourceId ? this.sources.get(latest.sourceId) : this.sources.find(name);
        if (!selectedSource) throw new AccessError(409, '来源已改为列表选择，请刷新页面后选择已有来源');
      }
      if (selectedSource && !selectedSource.active && selectedSource.id !== latest?.sourceId) throw new AccessError(422, '此来源已停用，请选择其他来源或留空');
      const questionId = id ?? randomUUID();
      if (!id) this.db.prepare("INSERT INTO questions (id, libraryId, learnerId, originalPageId, revision, state, createdAt, updatedAt) VALUES (?, ?, ?, ?, 1, 'draft', ?, ?)").run(questionId, home.library.id, home.library.learnerId, parts[0]!.pageId, this.now(), this.now());
      this.db.prepare(`UPDATE questions SET revision = @revision, state = @state, subjectId = @subjectId, region = @region, originalPageId = @originalPageId,
        sourceId = @sourceId, source = @source, pageNumber = @pageNumber, questionNumber = @questionNumber, note = @note, updatedAt = @updatedAt, collectedAt = @collectedAt,
        schoolYear = @schoolYear, grade = @grade, term = @term
        WHERE id = @id AND libraryId = @libraryId`).run({
        id: questionId, revision: latest ? latest.revision + 1 : 1, originalPageId: parts[0]!.pageId, libraryId: home.library.id, ...content, region: content.region ? JSON.stringify(content.region) : null,
        sourceId: selectedSource?.id ?? null, source: selectedSource?.name ?? '',
        ...(providedStage ?? latest?.studyStage ?? new Study(this.db).settings().stage),
        updatedAt: this.now(), collectedAt: latest?.collectedAt ?? (input.state === 'collected' ? this.now() : null)
      });
      this.db.prepare('DELETE FROM questionParts WHERE questionId = ?').run(questionId);
      const addPart = this.db.prepare('INSERT INTO questionParts (questionId, id, pageId, position, region, transcription, recognition) VALUES (?, ?, ?, ?, ?, ?, ?)');
      parts.forEach((part, index) => {
        const previous = latest?.parts.find(item => item.id === part.id && item.originalPage.id === part.pageId);
        const reference = part.recognition === undefined ? previous?.recognition : part.recognition;
        if (reference) {
          const run = this.db.prepare<[string, string, string], { candidates: string }>("SELECT candidates FROM ocrTests WHERE id = ? AND pageId = ? AND libraryId = ? AND status = 'succeeded'").get(reference.runId, part.pageId, home.library.id);
          if (!run || (reference.candidateId !== null && !JSON.parse(run.candidates).some((candidate: { id: string }) => candidate.id === reference.candidateId))) throw new AccessError(422, '所选识别结果不属于这个题目区，请重新选择');
        }
        addPart.run(questionId, part.id, part.pageId, index, part.region ? JSON.stringify(part.region) : null, part.transcription ?? previous?.transcription ?? '', reference ? JSON.stringify(reference) : null);
      });
      if (input.readingMaterialId !== undefined) {
        this.db.prepare('DELETE FROM questionReadings WHERE questionId = ?').run(questionId);
        if (reading) this.db.prepare('INSERT INTO questionReadings VALUES (?, ?)').run(questionId, reading.id);
      }
      this.db.prepare('INSERT INTO collectionOperations VALUES (?, ?, ?, ?, ?)').run(home.library.id, home.account.id, input.operationId, requestHash, questionId);
      return this.get(home.library.id, questionId);
    })();
    await this.verifyQuestion(saved); authorize();
    return saved;
  }
}
