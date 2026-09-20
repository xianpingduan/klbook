import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { Home } from '../shared/contracts.ts';
import type { Question, QuestionEdit, QuestionList, Region, Subject } from '../shared/collection.ts';
import { AccessError } from './family-access.ts';
import { Attachments, fileHash } from './attachments.ts';
import type { StoredPage } from './attachments.ts';

interface QuestionRow extends Omit<Question, 'originalPage' | 'region' | 'syncState'> { originalPageId: string; region: string | null }
export class CollectionStore {
  private db: Database.Database;
  private files: Attachments;
  private now: () => number;
  constructor(db: Database.Database, dataDir: string, now = Date.now) { this.db = db; this.files = new Attachments(dataDir); this.now = now; }
  subjects(): Subject[] { return this.db.prepare<[], Subject>('SELECT id, name FROM subjects ORDER BY position').all(); }
  private page(libraryId: string, id: string) {
    const page = this.db.prepare<[string, string], StoredPage>('SELECT * FROM originalPages WHERE libraryId = ? AND id = ?').get(libraryId, id);
    if (!page) throw new AccessError(404, '找不到原始页');
    return page;
  }
  get(libraryId: string, id: string): Question {
    const row = this.db.prepare<[string, string], QuestionRow>('SELECT * FROM questions WHERE libraryId = ? AND id = ?').get(libraryId, id);
    if (!row) throw new AccessError(404, '找不到这道题');
    const { originalPageId, region, ...rest } = row;
    const { previewSha256: _preview, libraryId: _libraryId, ...originalPage } = this.page(libraryId, originalPageId);
    return { ...rest, region: region ? JSON.parse(region) as Region : null, originalPage, syncState: 'synced' };
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
    const home = authorize();
    const requestHash = `upload:${fileHash(bytes)}`;
    const existing = this.replay(home, operationId, requestHash);
    if (existing) {
      const page = this.page(home.library.id, existing.originalPage.id);
      await this.files.read(page, 'original');
      await this.files.read(page, 'preview');
      authorize();
      return existing;
    }
    const page = await this.files.save(randomUUID(), home.library.id, bytes);
    try {
      return this.db.transaction(() => {
        authorize();
        const duplicate = this.replay(home, operationId, requestHash);
        if (duplicate) return duplicate;
        this.db.prepare('INSERT INTO originalPages VALUES (@id, @libraryId, @mimeType, @byteLength, @sha256, @previewSha256, @width, @height)').run(page);
        const id = randomUUID();
        this.db.prepare("INSERT INTO questions (id, libraryId, learnerId, originalPageId, revision, state, createdAt, updatedAt) VALUES (?, ?, ?, ?, 1, 'draft', ?, ?)").run(id, home.library.id, home.library.learnerId, page.id, this.now(), this.now());
        this.db.prepare('INSERT INTO collectionOperations VALUES (?, ?, ?, ?, ?)').run(home.library.id, home.account.id, operationId, requestHash, id);
        return this.get(home.library.id, id);
      })();
    } finally {
      const used = Boolean(this.db.prepare('SELECT 1 FROM originalPages WHERE id = ?').get(page.id));
      if (!used) await this.files.discard(page.id);
    }
  }
  async attachment(libraryId: string, pageId: string, variant: 'original' | 'preview') {
    const page = this.page(libraryId, pageId);
    return { bytes: await this.files.read(page, variant), mimeType: variant === 'original' ? page.mimeType : 'image/webp' };
  }

  async save(authorize: () => Home, id: string, input: QuestionEdit) {
    const home = authorize();
    const current = this.get(home.library.id, id);
    if (input.region && (input.region.x + input.region.width > 1.000001 || input.region.y + input.region.height > 1.000001)) throw new AccessError(422, '题目范围必须在原始页内');
    if (input.subjectId !== null && !this.db.prepare('SELECT 1 FROM subjects WHERE id = ?').get(input.subjectId)) throw new AccessError(422, '请选择有效学科');
    if (input.state === 'collected' && (!input.subjectId || !input.region)) throw new AccessError(422, '确认题目范围并选择学科后，才能完成收集');
    const content = {
      state: input.state, subjectId: input.subjectId, region: input.region ? { x: input.region.x, y: input.region.y, width: input.region.width, height: input.region.height } : null,
      source: input.source.trim(), pageNumber: input.pageNumber.trim(), questionNumber: input.questionNumber.trim(), note: input.note.trim()
    };
    const requestHash = `save:${fileHash(Buffer.from(JSON.stringify({ id, expectedRevision: input.expectedRevision, ...content })))}`;
    // Verify the actual required files before publishing a collected record or acknowledging a retry.
    const page = this.page(home.library.id, current.originalPage.id);
    await this.files.read(page, 'original');
    await this.files.read(page, 'preview');
    return this.db.transaction(() => {
      authorize();
      const duplicate = this.replay(home, input.operationId, requestHash);
      if (duplicate) return duplicate;
      const latest = this.get(home.library.id, id);
      if (latest.state === 'collected' && input.state === 'draft') throw new AccessError(409, '已收集的题目不能改回草稿');
      if (latest.revision !== input.expectedRevision) throw new AccessError(409, '这道题已在其他页面更新。你的修改仍在当前页面，请先重新读取并核对');
      this.db.prepare(`UPDATE questions SET revision = revision + 1, state = @state, subjectId = @subjectId, region = @region,
        source = @source, pageNumber = @pageNumber, questionNumber = @questionNumber, note = @note, updatedAt = @updatedAt, collectedAt = @collectedAt
        WHERE id = @id AND libraryId = @libraryId`).run({
        id, libraryId: home.library.id, ...content, region: content.region ? JSON.stringify(content.region) : null,
        updatedAt: this.now(), collectedAt: latest.collectedAt ?? (input.state === 'collected' ? this.now() : null)
      });
      this.db.prepare('INSERT INTO collectionOperations VALUES (?, ?, ?, ?, ?)').run(home.library.id, home.account.id, input.operationId, requestHash, id);
      return this.get(home.library.id, id);
    })();
  }
}
