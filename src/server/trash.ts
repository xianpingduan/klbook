import type Database from 'better-sqlite3';
import type { Home } from '../shared/contracts.ts';
import type { Deletion, TrashChange, TrashList, TrashReceipt } from '../shared/trash.ts';
import { AccessError } from './family-access.ts';
import { Attachments, fileHash } from './attachments.ts';
import type { CollectionStore } from './collection-store.ts';

export class TrashStore {
  private db: Database.Database;
  private collection: CollectionStore;
  private now: () => number;
  private files: Attachments;
  private maintenance: Promise<void> | null = null;
  constructor(db: Database.Database, collection: CollectionStore, dataDir: string, now = Date.now) { this.db = db; this.collection = collection; this.files = new Attachments(dataDir); this.now = now; }
  deleted(libraryId: string): Deletion[] {
    return this.db.prepare<[string], Deletion>('SELECT id, revision, deletedAt, expiresAt, purgedAt FROM questionDeletions WHERE libraryId = ? ORDER BY deletedAt DESC, id').all(libraryId);
  }
  list(libraryId: string, offset = 0): TrashList {
    const items = this.db.prepare<[string, number], Deletion>('SELECT id, revision, deletedAt, expiresAt, purgedAt FROM questionDeletions WHERE libraryId = ? AND purgedAt IS NULL ORDER BY deletedAt DESC, id LIMIT 50 OFFSET ?').all(libraryId, offset);
    const total = this.db.prepare<[string], { count: number }>('SELECT COUNT(*) AS count FROM questionDeletions WHERE libraryId = ? AND purgedAt IS NULL').get(libraryId)!.count;
    const cleanup = this.db.prepare<[string], { pending: number; failed: number }>("SELECT COUNT(*) AS pending, COALESCE(SUM(lastError != ''), 0) AS failed FROM pageCleanup WHERE libraryId = ?").get(libraryId)!;
    return { items: items.map(item => ({ ...item, question: this.collection.get(libraryId, item.id, true) })), total, offset, limit: 50, cleanup };
  }
  change(authorize: () => Home, id: string, input: TrashChange): TrashReceipt {
    return this.db.transaction(() => {
      const home = authorize();
      const hash = fileHash(Buffer.from(JSON.stringify({ id, ...input })));
      const previous = this.db.prepare<[string, string, string], { requestHash: string; receipt: string }>('SELECT requestHash, receipt FROM trashOperations WHERE libraryId = ? AND accountId = ? AND operationId = ?').get(home.library.id, home.account.id, input.operationId);
      if (previous) {
        if (previous.requestHash !== hash) throw new AccessError(409, '此次重试内容已改变，请刷新后核对');
        return JSON.parse(previous.receipt) as TrashReceipt;
      }
      const deletion = this.db.prepare<[string, string], Deletion>('SELECT * FROM questionDeletions WHERE libraryId = ? AND id = ?').get(home.library.id, id);
      if (deletion?.purgedAt !== null && deletion?.purgedAt !== undefined) throw new AccessError(410, '这道题已永久删除，无法恢复；请保留需要的本机材料');
      const question = this.collection.get(home.library.id, id, true);
      if (question.revision !== input.expectedRevision) throw new AccessError(409, '题目已在其他页面更新，请刷新并核对后再操作');
      const time = this.now(), revision = question.revision + 1;
      let receipt: TrashReceipt;
      if (input.action === 'trash') {
        if (deletion) throw new AccessError(409, '题目已在回收站，删除时间不会重新计算');
        receipt = { id, revision, deletedAt: time, expiresAt: time + 30 * 86400000, purgedAt: null };
        this.db.prepare('INSERT INTO questionDeletions VALUES (?, ?, ?, ?, ?, NULL)').run(id, home.library.id, revision, receipt.deletedAt, receipt.expiresAt);
      } else {
        if (!deletion) throw new AccessError(409, '题目不在回收站，请刷新核对');
        if (input.action === 'purge') {
          if (input.confirm !== true) throw new AccessError(422, '永久删除无法恢复，请先确认');
          receipt = this.purge(home.library.id, deletion);
        } else {
          if (deletion.expiresAt <= time) throw new AccessError(410, '已超过 30 天恢复期限，请刷新回收站查看清理状态');
          this.db.prepare('DELETE FROM questionDeletions WHERE id = ?').run(id);
          receipt = { id, revision, deletedAt: null, expiresAt: null, purgedAt: null };
        }
      }
      this.db.prepare('UPDATE questions SET revision = ?, updatedAt = ? WHERE id = ?').run(revision, time, id);
      this.db.prepare('INSERT INTO trashOperations VALUES (?, ?, ?, ?, ?)').run(home.library.id, home.account.id, input.operationId, hash, JSON.stringify(receipt));
      return receipt;
    })();
  }
  // Called inside a transaction. Content and cleanup intent commit together; receipts remain.
  private purge(libraryId: string, deletion: Deletion): TrashReceipt {
    const id = deletion.id;
    const candidates = this.db.prepare<[string, string, string], { pageId: string }>(`SELECT originalPageId AS pageId FROM questions WHERE id = ?
      UNION SELECT pageId FROM questionParts WHERE questionId = ? UNION SELECT pageId FROM answerParts WHERE questionId = ?`).all(id, id, id);
    const reading = this.db.prepare<[string], { materialId: string }>('SELECT materialId FROM questionReadings WHERE questionId = ?').get(id);
    for (const table of ['questionParts', 'answerParts', 'questionReadings']) this.db.prepare(`DELETE FROM ${table} WHERE questionId = ?`).run(id);
    this.db.prepare('DELETE FROM questions WHERE id = ?').run(id);
    if (reading && !this.db.prepare('SELECT 1 FROM questionReadings WHERE materialId = ?').get(reading.materialId)) {
      candidates.push(...this.db.prepare<[string], { pageId: string }>('SELECT pageId FROM readingParts WHERE materialId = ?').all(reading.materialId));
      this.db.prepare('DELETE FROM readingParts WHERE materialId = ?').run(reading.materialId);
      this.db.prepare('DELETE FROM readingMaterials WHERE id = ?').run(reading.materialId);
      this.db.prepare('INSERT INTO retiredReadings VALUES (?, ?, ?)').run(reading.materialId, libraryId, this.now());
    }
    for (const { pageId } of candidates) this.db.prepare('INSERT OR IGNORE INTO pageCleanup (pageId, libraryId, queuedAt) VALUES (?, ?, ?)').run(pageId, libraryId, this.now());
    const receipt = { ...deletion, revision: deletion.revision + 1, purgedAt: this.now() };
    this.db.prepare('UPDATE questionDeletions SET revision = ?, purgedAt = ? WHERE id = ?').run(receipt.revision, receipt.purgedAt, id);
    return receipt;
  }
  sweep(): Promise<void> {
    // Serialize file work. A failed unlink retains its committed intent across restart.
    if (!this.maintenance) this.maintenance = this.maintain().finally(() => { this.maintenance = null; });
    return this.maintenance;
  }
  async close() { await this.maintenance; }
  private async maintain() {
    this.db.transaction(() => {
      const expired = this.db.prepare<[number], Deletion & { libraryId: string }>('SELECT * FROM questionDeletions WHERE purgedAt IS NULL AND expiresAt <= ?').all(this.now());
      for (const deletion of expired) this.purge(deletion.libraryId, deletion);
    })();
    const jobs = this.db.prepare<[], { pageId: string; libraryId: string }>('SELECT pageId, libraryId FROM pageCleanup ORDER BY queuedAt, pageId').all();
    for (const job of jobs) {
      try {
        const ready = this.db.transaction(() => {
          const id = job.pageId;
          // An online database snapshot may refer to any committed page. Keep
          // its files until backup verification finishes, including new pages.
          if (this.db.prepare("SELECT 1 FROM backupJobs WHERE status = 'running' LIMIT 1").get()) return false;
          const referenced = this.db.prepare(`SELECT 1 FROM questions WHERE originalPageId = ? UNION ALL SELECT 1 FROM questionParts WHERE pageId = ?
            UNION ALL SELECT 1 FROM answerParts WHERE pageId = ? UNION ALL SELECT 1 FROM readingParts WHERE pageId = ? LIMIT 1`).get(id, id, id, id);
          if (referenced) { this.db.prepare('DELETE FROM pageCleanup WHERE pageId = ?').run(id); return false; }
          if (this.db.prepare("SELECT 1 FROM ocrTests WHERE pageId = ? AND status = 'running'").get(id)) return false;
          if (this.db.prepare('SELECT 1 FROM exportPagePins WHERE pageId = ?').get(id)) return false;
          this.db.prepare('INSERT OR IGNORE INTO retiredPages VALUES (?, ?, ?)').run(id, job.libraryId, this.now());
          this.db.prepare('DELETE FROM initialPageRecognition WHERE pageId = ?').run(id);
          this.db.prepare('DELETE FROM automaticRegionRecognitions WHERE pageId = ?').run(id);
          // Keep billing history, but remove recognition content and its file reference.
          this.db.prepare("UPDATE ocrTests SET pageId = NULL, lines = '[]', candidates = '[]', inputRegion = NULL, inputWidth = NULL, inputHeight = NULL, message = '原始材料已永久删除' WHERE pageId = ?").run(id);
          this.db.prepare('DELETE FROM originalPages WHERE id = ?').run(id);
          return true;
        })();
        if (!ready) continue;
        await this.files.remove(job.pageId);
        this.db.prepare('DELETE FROM pageCleanup WHERE pageId = ?').run(job.pageId);
      } catch {
        this.db.prepare("UPDATE pageCleanup SET lastError = '清理尚未完成，请检查数据目录的访问权限后重试' WHERE pageId = ?").run(job.pageId);
      }
    }
  }
}
