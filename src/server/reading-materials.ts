import type Database from 'better-sqlite3';
import type { Home } from '../shared/contracts.ts';
import type { OriginalPage, Region } from '../shared/collection.ts';
import { validQuestionRegion } from '../shared/collection.ts';
import type { ReadingMaterial, ReadingMaterialEdit, ReadingMaterialList, ReadingMaterialSummary } from '../shared/reading-materials.ts';
import { AccessError } from './family-access.ts';
import { fileHash } from './attachments.ts';

interface ReadingRow { id: string; libraryId: string; title: string; revision: number; createdAt: number; updatedAt: number }
interface Pages { get(libraryId: string, pageId: string): OriginalPage; verify(libraryId: string, pageId: string): Promise<void> }

export class ReadingMaterials {
  private db: Database.Database;
  private pages: Pages;
  private now: () => number;
  constructor(db: Database.Database, pages: Pages, now = Date.now) { this.db = db; this.pages = pages; this.now = now; }
  get(libraryId: string, id: string): ReadingMaterial {
    const row = this.db.prepare<[string, string], ReadingRow>('SELECT * FROM readingMaterials WHERE libraryId = ? AND id = ?').get(libraryId, id);
    if (!row) throw new AccessError(404, '找不到共享阅读材料');
    const parts = this.db.prepare<[string], { id: string; pageId: string; region: string }>('SELECT id, pageId, region FROM readingParts WHERE materialId = ? ORDER BY position').all(id)
      .map(part => ({ id: part.id, originalPage: this.pages.get(libraryId, part.pageId), region: JSON.parse(part.region) as Region }));
    const referenceCount = this.db.prepare<[string], { count: number }>('SELECT COUNT(*) AS count FROM questionReadings WHERE materialId = ?').get(id)!.count;
    return { ...row, parts, referenceCount, partCount: parts.length };
  }
  list(libraryId: string, offset: number): ReadingMaterialList {
    const items = this.db.prepare<[string, number], ReadingMaterialSummary>(`SELECT id, title, revision,
      (SELECT COUNT(*) FROM readingParts WHERE materialId = readingMaterials.id) AS partCount,
      (SELECT COUNT(*) FROM questionReadings WHERE materialId = readingMaterials.id) AS referenceCount
      FROM readingMaterials WHERE libraryId = ? ORDER BY createdAt DESC, id LIMIT 50 OFFSET ?`).all(libraryId, offset);
    const total = this.db.prepare<[string], { count: number }>('SELECT COUNT(*) AS count FROM readingMaterials WHERE libraryId = ?').get(libraryId)!.count;
    return { items, total, offset, limit: 50 };
  }
  async verify(libraryId: string, id: string) {
    const material = this.get(libraryId, id);
    for (const pageId of new Set(material.parts.map(part => part.originalPage.id))) await this.pages.verify(libraryId, pageId);
    return material;
  }
  async save(authorize: () => Home, id: string, input: ReadingMaterialEdit) {
    const home = authorize();
    const title = input.title.trim();
    if (!title || title.length > 120) throw new AccessError(422, '请填写 1～120 字的阅读材料名称');
    if (!input.parts.length || input.parts.length > 50 || new Set(input.parts.map(part => part.id)).size !== input.parts.length
      || input.parts.some(part => !validQuestionRegion(part.region))) throw new AccessError(422, '请确认 1～50 个不重复的原文区，范围需在图片内');
    const parts = input.parts.map(part => ({ id: part.id, pageId: part.pageId, region: { x: part.region!.x, y: part.region!.y, width: part.region!.width, height: part.region!.height } }));
    const requestHash = fileHash(Buffer.from(JSON.stringify({ id, expectedRevision: input.expectedRevision, title, parts })));
    for (const pageId of new Set(parts.map(part => part.pageId))) await this.pages.verify(home.library.id, pageId);
    const saved = this.db.transaction(() => {
      authorize();
      const previous = this.db.prepare<[string, string, string], { requestHash: string; materialId: string }>('SELECT requestHash, materialId FROM readingOperations WHERE libraryId = ? AND accountId = ? AND operationId = ?').get(home.library.id, home.account.id, input.operationId);
      if (previous) {
        if (previous.requestHash !== requestHash) throw new AccessError(409, '此次重试内容已改变，请重新确认后保存');
        return this.get(home.library.id, previous.materialId);
      }
      const current = this.db.prepare<[string, string], ReadingRow>('SELECT * FROM readingMaterials WHERE libraryId = ? AND id = ?').get(home.library.id, id);
      if ((current?.revision ?? 0) !== input.expectedRevision) throw new AccessError(409, '阅读材料已更新，你的修改仍保留，请返回题目重新打开后核对');
      if (current) this.db.prepare('UPDATE readingMaterials SET title = ?, revision = revision + 1, updatedAt = ? WHERE id = ?').run(title, this.now(), id);
      else this.db.prepare('INSERT INTO readingMaterials VALUES (?, ?, ?, 1, ?, ?)').run(id, home.library.id, title, this.now(), this.now());
      this.db.prepare('DELETE FROM readingParts WHERE materialId = ?').run(id);
      const add = this.db.prepare('INSERT INTO readingParts VALUES (?, ?, ?, ?, ?)');
      parts.forEach((part, position) => add.run(id, part.id, part.pageId, position, JSON.stringify(part.region)));
      this.db.prepare('INSERT INTO readingOperations VALUES (?, ?, ?, ?, ?)').run(home.library.id, home.account.id, input.operationId, requestHash, id);
      return this.get(home.library.id, id);
    })();
    // Replaying an older operation returns the current snapshot, which may include newer pages.
    if (saved.revision !== input.expectedRevision + 1) {
      for (const pageId of new Set(saved.parts.map(part => part.originalPage.id))) await this.pages.verify(home.library.id, pageId);
      authorize();
    }
    return saved;
  }
}
