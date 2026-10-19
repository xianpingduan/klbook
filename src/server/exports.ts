import type Database from 'better-sqlite3';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { ZipFile } from 'yazl';
import type { Home } from '../shared/contracts.ts';
import type { ExportJob, LearningPackageManifest } from '../shared/learning-package.ts';
import { Attachments, fileHash } from './attachments.ts';
import { AccessError } from './family-access.ts';
import type { CollectionStore } from './collection-store.ts';
import { exportSnapshot } from './export-snapshot.ts';

interface Job { public: ExportJob; libraryId: string; accountId: string; token: string; task?: Promise<void>; readers: number }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export class Exports {
  private db: Database.Database;
  private collection: CollectionStore;
  private files: Attachments;
  private root: string;
  private now: () => number;
  private jobs = new Map<string, Job>();
  constructor(db: Database.Database, collection: CollectionStore, dataDir: string, now = Date.now) {
    this.db = db; this.collection = collection; this.files = new Attachments(dataDir); this.root = resolve(dataDir, 'export-work'); this.now = now;
  }
  private directory(id: string) {
    const target = resolve(this.root, id);
    if (!uuid.test(id) || dirname(target) !== this.root) throw new Error('Invalid export directory');
    return target;
  }
  async initialize() {
    await mkdir(this.root, { recursive: true });
    // Temporary packages never survive restart. Clear stale leases before trash maintenance.
    for (const entry of await readdir(this.root, { withFileTypes: true })) if (entry.isDirectory() && uuid.test(entry.name)) await rm(this.directory(entry.name), { recursive: true, force: true });
    this.db.prepare('DELETE FROM exportPagePins').run();
  }
  preview(authorize: () => Home) { return this.db.transaction(() => exportSnapshot(this.db, this.collection, authorize(), this.now()).preview)(); }
  async prune() {
    for (const [id, job] of this.jobs) if (job.public.status !== 'preparing' && job.readers === 0 && job.public.expiresAt <= this.now()) {
      await rm(this.directory(id), { recursive: true, force: true }); this.jobs.delete(id);
    }
  }
  async start(authorize: () => Home, id: string, token: string) {
    await this.prune();
    const home = authorize(), previous = this.jobs.get(id);
    if (previous) {
      this.owned(home, id);
      if (previous.token !== token) throw new AccessError(409, '导出范围已改变，请重新核对');
      return previous.public;
    }
    if ([...this.jobs.values()].some(job => job.public.status === 'preparing')) throw new AccessError(409, '正在生成另一份资料包，请稍后再试');
    if (this.jobs.size >= 3) throw new AccessError(429, '暂存的导出包较多，请稍后再试；旧包会在 15 分钟后清理');
    const snapshot = this.db.transaction(() => {
      const snap = exportSnapshot(this.db, this.collection, authorize(), this.now());
      if (snap.preview.token !== token) throw new AccessError(409, '资料已在其他页面更新，请刷新导出范围并重新核对');
      if (!snap.preview.questionCount) throw new AccessError(422, '还没有已同步的已收集题目可导出');
      for (const page of snap.storedPages) this.db.prepare('INSERT INTO exportPagePins VALUES (?, ?)').run(id, page.id);
      return snap;
    })();
    const job: Job = { libraryId: home.library.id, accountId: home.account.id, token, readers: 0, public: {
      id, status: 'preparing', snapshotAt: snapshot.preview.checkedAt, expiresAt: this.now() + 15 * 60_000, questionCount: snapshot.preview.questionCount,
      filename: `klbook-learning-${id}.zip`, message: '正在生成资料包，请稍候' } };
    this.jobs.set(id, job);
    job.task = this.build(job, snapshot).finally(() => { job.task = undefined; });
    return job.public;
  }
  private owned(home: Home, id: string) {
    const job = this.jobs.get(id);
    if (!job || job.libraryId !== home.library.id || job.accountId !== home.account.id || (job.public.status !== 'preparing' && job.public.expiresAt <= this.now())) throw new AccessError(404, '这份临时资料包已过期或服务已重启，请重新核对并生成');
    return job;
  }
  status(home: Home, id: string) { return this.owned(home, id).public; }
  download(home: Home, id: string) {
    const job = this.owned(home, id);
    if (job.public.status !== 'ready') throw new AccessError(409, job.public.message);
    const stream = createReadStream(join(this.directory(id), 'package.zip'));
    job.readers++;
    stream.once('close', () => { job.readers--; });
    return { stream, info: job.public };
  }
  async close() { await Promise.all([...this.jobs.values()].map(job => job.task)); }
  private async build(job: Job, snapshot: ReturnType<typeof exportSnapshot>) {
    const id = job.public.id, directory = this.directory(id);
    try {
      await mkdir(join(directory, 'images'), { recursive: true });
      for (let index = 0; index < snapshot.storedPages.length; index++) {
        const bytes = await this.files.read(snapshot.storedPages[index]!, 'original');
        await writeFile(join(directory, snapshot.data.pages[index]!.path), bytes, { flag: 'wx' });
      }
      const manifest: LearningPackageManifest = { format: 'klbook-learning-package', version: 1, packageId: id, snapshotAt: job.public.snapshotAt,
        sourceLibraryId: job.libraryId, questionCount: job.public.questionCount,
        files: [{ path: 'data.json', byteLength: snapshot.bytes.length, sha256: fileHash(snapshot.bytes) }, ...snapshot.data.pages.map(p => ({ path: p.path, byteLength: p.byteLength, sha256: p.sha256 }))] };
      const manifestBytes = Buffer.from(JSON.stringify(manifest));
      const zip = new ZipFile();
      const controller = new AbortController();
      zip.on('error', error => controller.abort(error));
      const written = pipeline(zip.outputStream, createWriteStream(join(directory, 'package.zip'), { flags: 'wx' }), { signal: controller.signal });
      zip.addBuffer(manifestBytes, 'manifest.json'); zip.addBuffer(Buffer.from(fileHash(manifestBytes) + '\n'), 'manifest.sha256'); zip.addBuffer(snapshot.bytes, 'data.json');
      for (const page of snapshot.data.pages) zip.addFile(join(directory, page.path), page.path, { compress: false });
      zip.end(); await written;
      job.public = { ...job.public, status: 'ready', byteLength: (await stat(join(directory, 'package.zip'))).size, expiresAt: this.now() + 15 * 60_000, message: '资料包已生成，可下载保存' };
      await rm(join(directory, 'images'), { recursive: true, force: true });
    } catch {
      job.public = { ...job.public, status: 'failed', message: '资料包未能完整生成，请检查原图、磁盘空间及数据目录后重新生成。已有学习资料未改变。' };
      await rm(directory, { recursive: true, force: true }).catch(() => {});
    } finally { this.db.prepare('DELETE FROM exportPagePins WHERE exportId = ?').run(id); }
  }
}
