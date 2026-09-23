import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { Home } from '../shared/contracts.ts';
import type { Question, QuestionCreate, QuestionEdit, QuestionList, QuestionPartEdit, Region, Subject } from '../shared/collection.ts';
import { validQuestionRegion } from '../shared/collection.ts';
import { AccessError } from './family-access.ts';
import { Attachments, fileHash } from './attachments.ts';
import type { StoredPage } from './attachments.ts';
import { Sources } from './sources.ts';
import { ReadingMaterials } from './reading-materials.ts';

interface QuestionRow extends Omit<Question, 'originalPage' | 'parts' | 'region' | 'syncState' | 'readingMaterial'> { originalPageId: string; region: string | null }
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
  private publicPage(libraryId: string, id: string) {
    const { previewSha256: _preview, libraryId: _libraryId, ...page } = this.page(libraryId, id);
    return page;
  }
  private async verifyPage(libraryId: string, id: string) {
    const page = this.page(libraryId, id);
    await this.files.read(page, 'original'); await this.files.read(page, 'preview');
  }
  get(libraryId: string, id: string): Question {
    const row = this.db.prepare<[string, string], QuestionRow>('SELECT * FROM questions WHERE libraryId = ? AND id = ?').get(libraryId, id);
    if (!row) throw new AccessError(404, '找不到这道题');
    const { originalPageId, region, ...rest } = row;
    const parts = this.db.prepare<[string], { id: string; pageId: string; region: string | null }>('SELECT id, pageId, region FROM questionParts WHERE questionId = ? ORDER BY position').all(id)
      .map(part => ({ id: part.id, originalPage: this.publicPage(libraryId, part.pageId), region: part.region ? JSON.parse(part.region) as Region : null }));
    const reading = this.db.prepare<[string], { materialId: string }>('SELECT materialId FROM questionReadings WHERE questionId = ?').get(id);
    return { ...rest, source: rest.sourceId ? this.sources.get(rest.sourceId).name : rest.source, region: region ? JSON.parse(region) as Region : null, originalPage: this.publicPage(libraryId, originalPageId), parts, readingMaterial: reading ? this.readings.get(libraryId, reading.materialId) : null, syncState: 'synced' };
  }
  list(libraryId: string, state: 'draft' | 'collected', offset: number): QuestionList {
    const ids = this.db.prepare<[string, string, number], { id: string }>('SELECT id FROM questions WHERE libraryId = ? AND state = ? ORDER BY createdAt DESC, id LIMIT 50 OFFSET ?').all(libraryId, state, offset);
    const total = this.db.prepare<[string, string], { count: number }>('SELECT COUNT(*) AS count FROM questions WHERE libraryId = ? AND state = ?').get(libraryId, state)!.count;
    return { items: ids.map(row => this.get(libraryId, row.id)), total, offset, limit: 50 };
  }
  private replay(home: Home, operationId: string, requestHash: string) {
    const operation = this.db.prepare<[string, string, string], { requestHash: string; questionId: string }>('SELECT requestHash, questionId FROM collectionOperations WHERE libraryId = ? AND accountId = ? AND operationId = ?').get(home.library.id, home.account.id, operationId);
    if (!operation) return null;
    if (operation.requestHash !== requestHash) throw new AccessError(409, '此次重试内容已改变，请重新确认后保存');
    return this.get(home.library.id, operation.questionId);
  }
  async upload(authorize: () => Home, operationId: string, bytes: Buffer) {
    const requestHash = `upload:${fileHash(bytes)}`;
    return this.storeUpload(authorize, bytes, home => {
      const result = this.replay(home, operationId, requestHash);
      return result ? { pageId: result.originalPage.id, result } : undefined;
    }, (home, page) => {
      const id = randomUUID();
      this.db.prepare("INSERT INTO questions (id, libraryId, learnerId, originalPageId, revision, state, createdAt, updatedAt) VALUES (?, ?, ?, ?, 1, 'draft', ?, ?)").run(id, home.library.id, home.library.learnerId, page.id, this.now(), this.now());
      this.db.prepare('INSERT INTO questionParts VALUES (?, ?, ?, 0, NULL)').run(id, randomUUID(), page.id);
      this.db.prepare('INSERT INTO collectionOperations VALUES (?, ?, ?, ?, ?)').run(home.library.id, home.account.id, operationId, requestHash, id);
      return this.get(home.library.id, id);
    });
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
    const requestHash = `save:${fileHash(Buffer.from(JSON.stringify({ id, pageId, expectedRevision: input.expectedRevision, ...content, ...(input.parts ? { parts: input.parts } : {}), ...(input.readingMaterialId !== undefined ? { readingMaterialId: input.readingMaterialId } : {}) })))}`;
    const readingId = input.readingMaterialId === undefined ? current?.readingMaterial?.id : input.readingMaterialId;
    const reading = readingId ? await this.readings.verify(home.library.id, readingId) : null;
    // Verify the actual required files before publishing a collected record or acknowledging a retry.
    for (const required of new Set(parts.map(part => part.pageId))) {
      await this.verifyPage(home.library.id, required);
    }
    return this.db.transaction(() => {
      authorize();
      const duplicate = this.replay(home, input.operationId, requestHash);
      if (duplicate) return duplicate;
      const latest = id ? this.get(home.library.id, id) : undefined;
      if (latest?.state === 'collected' && input.state === 'draft') throw new AccessError(409, '已收集的题目不能改回草稿');
      if (latest && latest.revision !== input.expectedRevision) throw new AccessError(409, '这道题已在其他页面更新。你的修改仍在当前页面，请先重新读取并核对');
      if (reading && this.readings.get(home.library.id, reading.id).revision !== reading.revision) throw new AccessError(409, '阅读材料已更新，请核对后重试');
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
        sourceId = @sourceId, source = @source, pageNumber = @pageNumber, questionNumber = @questionNumber, note = @note, updatedAt = @updatedAt, collectedAt = @collectedAt
        WHERE id = @id AND libraryId = @libraryId`).run({
        id: questionId, revision: latest ? latest.revision + 1 : 1, originalPageId: parts[0]!.pageId, libraryId: home.library.id, ...content, region: content.region ? JSON.stringify(content.region) : null,
        sourceId: selectedSource?.id ?? null, source: selectedSource?.name ?? '',
        updatedAt: this.now(), collectedAt: latest?.collectedAt ?? (input.state === 'collected' ? this.now() : null)
      });
      this.db.prepare('DELETE FROM questionParts WHERE questionId = ?').run(questionId);
      const addPart = this.db.prepare('INSERT INTO questionParts VALUES (?, ?, ?, ?, ?)');
      parts.forEach((part, index) => addPart.run(questionId, part.id, part.pageId, index, part.region ? JSON.stringify(part.region) : null));
      if (input.readingMaterialId !== undefined) {
        this.db.prepare('DELETE FROM questionReadings WHERE questionId = ?').run(questionId);
        if (reading) this.db.prepare('INSERT INTO questionReadings VALUES (?, ?)').run(questionId, reading.id);
      }
      this.db.prepare('INSERT INTO collectionOperations VALUES (?, ?, ?, ?, ?)').run(home.library.id, home.account.id, input.operationId, requestHash, questionId);
      return this.get(home.library.id, questionId);
    })();
  }
}
