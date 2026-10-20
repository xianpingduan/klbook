import type Database from 'better-sqlite3';
import type { Readable } from 'node:stream';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Home } from '../shared/contracts.ts';
import type { ImportBatch, ImportReceipt, ImportDecisions } from '../shared/imports.ts';
import { AccessError } from './family-access.ts';
import { Attachments, type StoredPage } from './attachments.ts';
import type { CollectionStore } from './collection-store.ts';
import { preparedOriginal, receivePackage, type PreparedPackage } from './package-reader.ts';
import { applyImport, importPlan } from './import-plan.ts';
import { fingerprint, noDecisions } from './import-resolution.ts';

interface Job { owner: string; prepared: PreparedPackage; expiresAt: number; targets: Map<string, string>; decisions: ImportDecisions; choiceContext?: string; choicesReset?: boolean; choiceRequest?: { token: string; hash: string; resultToken: string } }
interface ReceiptRow { accountId: string; libraryId: string; packageHash: string; previewToken: string; result: string }
export class Imports {
  private db: Database.Database;
  private collection: CollectionStore;
  private files: Attachments;
  private root: string;
  private now: () => number;
  private jobs = new Map<string, Job>();
  private work: Promise<unknown> | undefined;
  constructor(db: Database.Database, collection: CollectionStore, dataDir: string, now = Date.now) {
    this.db = db; this.collection = collection; this.files = new Attachments(dataDir); this.root = join(dataDir, 'import-work'); this.now = now;
  }
  private directory(id: string) {
    const path = resolve(this.root, id);
    if (!/^[0-9a-f-]{36}$/.test(id) || dirname(path) !== resolve(this.root)) throw new AccessError(400, '导入批次格式不正确');
    return path;
  }
  async initialize() {
    await mkdir(this.root, { recursive: true });
    for (const entry of await readdir(this.root, { withFileTypes: true })) if (/^[0-9a-f-]{36}$/.test(entry.name)) await rm(this.directory(entry.name), { recursive: true, force: true });
    await this.cleanupPages();
  }
  private async cleanupPages() {
    for (const { id } of this.db.prepare<[], { id: string }>('SELECT id FROM importPendingPages').all()) {
      if (!this.db.prepare('SELECT 1 FROM originalPages WHERE id = ?').get(id)) {
        try { await this.files.remove(id); } catch { continue; }
      }
      this.db.prepare('DELETE FROM importPendingPages WHERE id = ?').run(id);
    }
  }
  async prune() {
    if (this.work) return;
    for (const [id, job] of this.jobs) if (job.expiresAt <= this.now()) { await rm(this.directory(id), { recursive: true, force: true }); this.jobs.delete(id); }
  }
  async close() { await this.work?.catch(() => {}); }
  private owner(home: Home) { return `${home.library.id}:${home.account.id}`; }
  private receipt(home: Home, id: string) {
    const row = this.db.prepare<[string], ReceiptRow>('SELECT * FROM importReceipts WHERE id = ?').get(id);
    if (row && (row.accountId !== home.account.id || row.libraryId !== home.library.id)) throw new AccessError(404, '找不到此导入批次');
    return row;
  }
  private job(home: Home, id: string) {
    const job = this.jobs.get(id);
    if (!job || job.owner !== this.owner(home) || job.expiresAt <= this.now()) throw new AccessError(404, '导入预览已失效或电脑服务已重启，请重新选择资料包校验');
    return job;
  }
  status(authorize: () => Home, id: string): ImportBatch {
    const home = authorize(), receipt = this.receipt(home, id);
    if (receipt) return JSON.parse(receipt.result);
    const job = this.job(home, id);
    return this.plan(home, job, id).preview;
  }
  async previewImage(authorize: () => Home, id: string, pageId: string) {
    const home = authorize(), job = this.job(home, id);
    const page = job.prepared.data.pages.find(p => p.id === pageId);
    if (!page) throw new AccessError(404, '资料包中没有这张图片');
    const bytes = await new Attachments(job.prepared.directory).read(job.prepared.images.get(page.path)!, 'preview');
    const fresh = authorize();
    if (this.owner(fresh) !== this.owner(home) || this.job(fresh, id) !== job) throw new AccessError(409, '资料包已变化，请刷新预览');
    return bytes;
  }
  private plan(home: Home, job: Job, id: string) {
    let plan = importPlan(this.db, this.collection, home, job.prepared, id, job.expiresAt, job.targets, job.decisions, this.now());
    if (job.choiceContext && job.choiceContext !== plan.contextToken) {
      job.decisions = noDecisions(); job.choiceContext = undefined; job.choiceRequest = undefined; job.choicesReset = true;
      plan = importPlan(this.db, this.collection, home, job.prepared, id, job.expiresAt, job.targets, job.decisions, this.now());
    }
    plan.preview.choicesReset = job.choicesReset;
    return plan;
  }
  decide(authorize: () => Home, id: string, previewToken: string, decisions: ImportDecisions) {
    if (this.work) throw new AccessError(409, '资料包正在处理，请等待后重试');
    const home = authorize(), job = this.job(home, id), previous = this.plan(home, job, id);
    const hash = fingerprint(decisions);
    if (job.choiceRequest?.token === previewToken && job.choiceRequest.hash === hash && job.choiceRequest.resultToken === previous.preview.token) return previous.preview;
    if (previewToken !== previous.preview.token) throw new AccessError(409, '家庭资料已变化，请刷新预览后重新选择');
    for (const kind of ['questions', 'subjects'] as const) {
      const values = decisions[kind];
      if (new Set(values.map(v => v.id)).size !== values.length || values.some(v => !job.prepared.data[kind].some(e => e.id === v.id))) throw new AccessError(422, '所选记录不在当前资料包中');
    }
    job.decisions = decisions; job.choiceContext = previous.contextToken; job.choicesReset = false;
    const preview = this.plan(home, job, id).preview;
    job.choiceRequest = { token: previewToken, hash, resultToken: preview.token };
    return preview;
  }
  private run<T>(task: () => Promise<T>) {
    if (this.work) throw new AccessError(409, '已有资料包正在处理，请等待结果后重试');
    const promise = task(); this.work = promise;
    return promise.finally(() => { if (this.work === promise) this.work = undefined; });
  }
  upload(authorize: () => Home, id: string, input: Readable): Promise<ImportBatch> {
    return this.run(async () => {
      const home = authorize(), directory = this.directory(id);
      // A retry revalidates the bytes rather than trusting the browser's file name.
      const previous = this.jobs.get(id);
      if (previous && previous.owner !== this.owner(home)) throw new AccessError(404, '找不到此导入批次');
      if (previous) { await rm(directory, { recursive: true, force: true }); this.jobs.delete(id); }
      for (const [oldId, old] of this.jobs) if (old.expiresAt <= this.now()) { await rm(this.directory(oldId), { recursive: true, force: true }); this.jobs.delete(oldId); }
      if (this.jobs.size >= 2) throw new AccessError(429, '请先完成或移除已有导入预览，再选择其他资料包');
      await mkdir(directory, { recursive: true });
      let keep = false;
      try {
        const prepared = await receivePackage(input, directory, home.library.id);
        const fresh = authorize();
        if (this.owner(home) !== this.owner(fresh)) throw new AccessError(403, '账号已变化，请重新验证');
        const receipt = this.receipt(fresh, id);
        if (receipt) {
          if (receipt.packageHash !== prepared.packageHash) throw new AccessError(409, '同一导入操作的文件已改变，请重新选择并核对');
          return JSON.parse(receipt.result) as ImportReceipt;
        }
        if (previous && previous.prepared.packageHash !== prepared.packageHash) throw new AccessError(409, '重试文件已改变，请重新选择并核对');
        const job: Job = { owner: this.owner(home), prepared, expiresAt: this.now() + 30 * 60000, targets: previous?.targets ?? new Map<string, string>(), decisions: previous?.decisions ?? noDecisions(), choiceContext: previous?.choiceContext, choiceRequest: previous?.choiceRequest };
        this.jobs.set(id, job); keep = true;
        return this.status(authorize, id);
      } finally { if (!keep) await rm(directory, { recursive: true, force: true }); }
    });
  }
  confirm(authorize: () => Home, id: string, previewToken: string): Promise<ImportReceipt> {
    return this.run(async () => {
      const home = authorize(), receipt = this.receipt(home, id);
      if (receipt) {
        if (receipt.previewToken !== previewToken) throw new AccessError(409, '此次重试的预览已改变，请核对导入结果');
        return JSON.parse(receipt.result);
      }
      const job = this.job(home, id);
      const plan = this.plan(home, job, id);
      const check = (token: string, blockers: string[]) => {
        if (blockers.length) throw new AccessError(409, '本批包含修改、已删记录或待核对的学科对应，未导入任何资料；请刷新预览查看');
        if (token !== previewToken) throw new AccessError(409, '家庭资料已变化，请刷新预览后重新确认');
      };
      check(plan.preview.token, plan.preview.blockers);
      await this.cleanupPages();
      try {
        for (const e of plan.entities.filter(e => e.kind === 'pages')) {
          if (e.isNew) {
            const source = job.prepared.data.pages.find(p => p.id === e.sourceId)!;
            this.db.prepare('INSERT OR IGNORE INTO importPendingPages VALUES (?)').run(e.targetId);
            const saved = await this.files.save(e.targetId, home.library.id, await preparedOriginal(job.prepared, source.path));
            if (saved.sha256 !== source.sha256 || saved.previewSha256 !== job.prepared.images.get(source.path)!.previewSha256) throw new AccessError(422, '暂存原图已改变，请重新选择资料包校验');
          } else {
            const page = this.db.prepare<[string], StoredPage>('SELECT * FROM originalPages WHERE id = ?').get(e.targetId)!;
            await this.files.read(page, 'original'); await this.files.read(page, 'preview');
          }
        }
        const result = this.db.transaction((): ImportReceipt => {
          const fresh = authorize();
          if (this.owner(home) !== this.owner(fresh)) throw new AccessError(403, '账号已变化，请重新验证');
          this.job(fresh, id);
          const latest = this.plan(fresh, job, id);
          check(latest.preview.token, latest.preview.blockers);
          const importedAt = this.now();
          applyImport(this.db, home, job.prepared, latest, importedAt);
          const result: ImportReceipt = { id, status: 'complete', added: latest.preview.added, skipped: latest.preview.skipped, kept: latest.preview.kept, copied: latest.preview.copied, restored: latest.preview.restored, importedAt, questionIds: latest.entities.filter(e => e.kind === 'questions').map(e => e.targetId) };
          this.db.prepare('INSERT INTO importReceipts VALUES (?, ?, ?, ?, ?, ?)').run(id, home.library.id, home.account.id, job.prepared.packageHash, previewToken, JSON.stringify(result));
          for (const e of latest.entities.filter(e => e.kind === 'pages' && e.isNew)) this.db.prepare('DELETE FROM importPendingPages WHERE id = ?').run(e.targetId);
          return result;
        })();
        this.jobs.delete(id); await rm(this.directory(id), { recursive: true, force: true }).catch(() => {});
        return result;
      } finally { await this.cleanupPages(); }
    });
  }
  remove(authorize: () => Home, id: string) {
    return this.run(async () => { const home = authorize(); if (this.receipt(home, id)) return; this.job(home, id); await rm(this.directory(id), { recursive: true, force: true }); this.jobs.delete(id); });
  }
}
