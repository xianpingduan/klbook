import type Database from 'better-sqlite3';
import type { Home } from '../shared/contracts.ts';
import { defaultOcrConfig, ocrProviders, type OcrProvider, type OcrConfig, type OcrCredentials, type OcrEdit, type OcrSettings, type OcrTest } from '../shared/ocr.ts';
import { AccessError } from './family-access.ts';
import { CredentialVault } from './credential-vault.ts';
import { digest } from './secrets.ts';
import { BaiduOcr } from './baidu-ocr.ts';
import { XfyunOcr } from './xfyun-ocr.ts';
import { OcrFailure, type VendorHttp } from './ocr-provider.ts';
import { ocrSample } from './ocr-sample.ts';
import { setTimeout as pause } from 'node:timers/promises';
import sharp from 'sharp';
import type { PageRecognition, PageRecognitions } from '../shared/ocr.ts';
import type { CollectionStore } from './collection-store.ts';
import { recognitionCandidates } from './recognition-candidates.ts';

type SettingsRow = { revision: number; config: string };
type RecognitionRow = Omit<PageRecognition, 'lines' | 'candidates'> & { lines: string; candidates: string };
const recognitionFields = 'id, revision, provider, sample, status, createdAt, finishedAt, durationMs, attempts, message, lines, pageId, inputWidth, inputHeight, candidates';
const recognitionResult = (row: RecognitionRow): PageRecognition => ({ ...row, lines: JSON.parse(row.lines), candidates: JSON.parse(row.candidates) });
export class OcrService {
  private db: Database.Database;
  private vault: CredentialVault;
  private now: () => number;
  private vendors: Record<OcrProvider, BaiduOcr | XfyunOcr>;
  private collection: CollectionStore;
  private work?: Promise<void>;
  private pendingCount = 0;
  private stopping = new AbortController();
  constructor(db: Database.Database, dataDir: string, collection: CollectionStore, now = Date.now, http?: VendorHttp) {
    this.db = db; this.vault = new CredentialVault(dataDir); this.now = now;
    this.collection = collection;
    this.vendors = { baidu: new BaiduOcr(http), xfyun: new XfyunOcr(http, now) };
    db.prepare('INSERT OR IGNORE INTO ocrSettings VALUES (1, 0, ?, NULL)').run(JSON.stringify(defaultOcrConfig));
    db.prepare('UPDATE ocrTests SET status = \'interrupted\', finishedAt = ?, message = ? WHERE status = \'running\'').run(now(), '电脑服务曾中断，结果不确定；不会自动重新发送');
    db.prepare('UPDATE serviceAttempts SET status = \'unknown\', finishedAt = ?, message = ? WHERE capability = \'ocr\' AND status = \'running\'').run(now(), '服务中断，保留估算费用');
  }
  pageRuns(authorize: () => Home, pageId: string): PageRecognitions {
    const home = authorize(); this.collection.publicPage(home.library.id, pageId);
    const { config, credentialAvailable } = this.settings();
    return { initialMessage: this.db.prepare<[string], { message: string }>('SELECT message FROM initialPageRecognition WHERE pageId = ?').get(pageId)?.message ?? '',
      service: { provider: config.provider, enabled: config.enabled, available: credentialAvailable, formulas: config.provider === 'baidu' && config.formulas },
      runs: this.db.prepare<[string, string], RecognitionRow>(`SELECT ${recognitionFields} FROM ocrTests WHERE libraryId = ? AND pageId = ? ORDER BY createdAt DESC, rowid DESC LIMIT 20`).all(home.library.id, pageId).map(recognitionResult) };
  }
  uploadedPage(authorize: () => Home, pageId: string) {
    try {
      const home = authorize(); this.collection.publicPage(home.library.id, pageId);
      if (!this.db.prepare('INSERT OR IGNORE INTO initialPageRecognition (pageId) VALUES (?)').run(pageId).changes) return;
      this.startPage(authorize, pageId, pageId);
    } catch (error) {
      // Original material is already durable; an optional external capability must not fail its upload.
      try { this.db.prepare('UPDATE initialPageRecognition SET message = ? WHERE pageId = ?').run(error instanceof AccessError ? error.message : '识别暂不可用，可以继续手动框题', pageId); }
      catch { /* Preserve the successful upload even if an auxiliary record cannot be written. */ }
    }
  }
  pageRun(authorize: () => Home, pageId: string, id: string) {
    const home = authorize(); this.collection.publicPage(home.library.id, pageId);
    const row = this.db.prepare<[string, string, string], RecognitionRow>(`SELECT ${recognitionFields} FROM ocrTests WHERE libraryId = ? AND pageId = ? AND id = ?`).get(home.library.id, pageId, id);
    if (!row) throw new AccessError(404, '找不到这次图片识别记录');
    return recognitionResult(row);
  }
  startPage(authorize: () => Home, pageId: string, id: string) {
    this.db.transaction(() => {
      const home = authorize(); this.collection.publicPage(home.library.id, pageId);
      const previous = this.db.prepare<[string], { pageId: string; libraryId: string }>('SELECT pageId, libraryId FROM ocrTests WHERE id = ?').get(id);
      if (previous) {
        if (previous.pageId !== pageId || previous.libraryId !== home.library.id) throw new AccessError(409, '此识别请求已属于其他材料');
        return;
      }
      if (this.pendingCount >= 10 || this.stopping.signal.aborted) throw new AccessError(409, '待识别材料较多，可以先手动框题，稍后重试');
      if (this.db.prepare("SELECT 1 FROM ocrTests WHERE pageId = ? AND status = 'running'").get(pageId)) throw new AccessError(409, '这张图片正在识别，请等待读取结果');
      const row = this.row(), config: OcrConfig = JSON.parse(row.config), sealed = this.sealed(config.provider);
      if (!config.enabled) throw new AccessError(422, '图片识别已停用，可以继续手动框题');
      if (!sealed) throw new AccessError(422, '尚未配置图片识别，可以继续手动框题');
      this.vault.open(sealed); this.checkQuota(config);
      this.db.prepare("INSERT INTO ocrTests (id, accountId, revision, provider, sample, status, createdAt, libraryId, pageId) VALUES (?, ?, ?, ?, 'original-page', 'running', ?, ?, ?)").run(id, home.account.id, row.revision, config.provider, this.now(), home.library.id, pageId);
      this.db.prepare("INSERT INTO serviceAudit (capability, actor, at, action) VALUES ('ocr', ?, ?, '识别收集材料')").run(home.account.username, this.now());
      this.schedule(id, () => this.runRecognition(id, row, sealed, { authorize, libraryId: home.library.id, pageId }));
    })();
    return this.pageRun(authorize, pageId, id);
  }
  private schedule(id: string, run: () => Promise<void>) {
    this.pendingCount++;
    const job = (this.work ?? Promise.resolve()).then(run).catch(() => {
      try { this.db.prepare("UPDATE ocrTests SET status = 'interrupted', finishedAt = ?, message = ? WHERE id = ? AND status = 'running'").run(this.now(), '本地识别被中断，请读取记录后再决定是否重试', id); }
      catch { /* Startup reconciles work if the disk cannot store the final status. */ }
    }).finally(() => { this.pendingCount--; if (this.work === job) this.work = undefined; });
    this.work = job;
  }
  private row() { return this.db.prepare<[], SettingsRow>('SELECT revision, config FROM ocrSettings WHERE singleton = 1').get()!; }
  private sealed(provider: OcrProvider) { return this.db.prepare<[string], { credentials: string }>('SELECT credentials FROM ocrProviderCredentials WHERE provider = ?').get(provider)?.credentials; }
  private month() { return new Date(this.now() + 8 * 3600_000).toISOString().slice(0, 7); }
  private usage() {
    const month = this.month();
    return { month, ...this.db.prepare<[string], { attempts: number; estimatedCents: number }>('SELECT COUNT(*) AS attempts, COALESCE(SUM(estimatedMills), 0) / 10.0 AS estimatedCents FROM serviceAttempts WHERE capability = \'ocr\' AND month = ?').get(month)! };
  }
  settings(): OcrSettings {
    const row = this.row(); const config: OcrConfig = JSON.parse(row.config);
    const status = (provider: OcrProvider) => {
      const sealed = this.sealed(provider); let available = false;
      if (sealed) { try { this.vault.open(sealed); available = true; } catch { /* Missing key still permits disabling service. */ } }
      return { configured: !!sealed, available };
    };
    const credentialStatus = { baidu: status('baidu'), xfyun: status('xfyun') };
    const tests = this.db.prepare<[], RecognitionRow>(`SELECT ${recognitionFields} FROM ocrTests ORDER BY createdAt DESC, rowid DESC LIMIT 20`).all().map(recognitionResult);
    const sample = this.db.prepare<[], RecognitionRow>(`SELECT ${recognitionFields} FROM ocrTests WHERE sample = 'school-v1' ORDER BY createdAt DESC, rowid DESC LIMIT 1`).get();
    const audit = this.db.prepare<[], OcrSettings['audit'][number]>('SELECT actor, at, action FROM serviceAudit WHERE capability = \'ocr\' ORDER BY id DESC LIMIT 30').all();
    return { revision: row.revision, config, credentialsConfigured: credentialStatus[config.provider].configured, credentialAvailable: credentialStatus[config.provider].available, credentialStatus, usage: this.usage(), tests, latestSample: sample ? recognitionResult(sample) : null, audit };
  }
  save(authorize: () => Home, input: OcrEdit) {
    const priceMills = Math.round(input.config.priceCents * 10);
    if (Math.abs(input.config.priceCents * 10 - priceMills) > 1e-8) throw new AccessError(422, '单价最多保留三位元小数');
    const config: OcrConfig = { ...input.config, name: input.config.name.trim(), priceCents: priceMills / 10 };
    if (!config.name) throw new AccessError(422, '请填写服务名称');
    if (config.provider === 'xfyun' && (config.language !== 'CHN_ENG' || !config.handwriting || config.formulas)) throw new AccessError(422, '讯飞通用文字识别固定处理中英文印刷与手写文字，请关闭公式识别');
    const credentials = input.credentials && { apiKey: input.credentials.apiKey.trim(), secretKey: input.credentials.secretKey.trim(), ...(config.provider === 'xfyun' ? { appId: input.credentials.appId?.trim() } : {}) };
    if (credentials && (!credentials.apiKey || !credentials.secretKey)) throw new AccessError(422, '请同时填写 API Key 和 Secret Key');
    if (credentials && config.provider === 'xfyun' && (!credentials.appId || !/^[A-Za-z0-9_-]{1,64}$/.test(credentials.appId) || !/^[A-Za-z0-9]{32}$/.test(credentials.apiKey) || !/^[A-Za-z0-9]{32}$/.test(credentials.secretKey))) throw new AccessError(422, '请填写讯飞 APPID、32 位 APIKey 和 32 位 APISecret');
    const hash = digest(JSON.stringify({ expectedRevision: input.expectedRevision, config, credentials }));
    return this.db.transaction(() => {
      const home = authorize();
      const previous = this.db.prepare<[string, string], { requestHash: string }>('SELECT requestHash FROM serviceOperations WHERE capability = \'ocr\' AND accountId = ? AND operationId = ?').get(home.account.id, input.operationId);
      if (previous) {
        if (previous.requestHash !== hash) throw new AccessError(409, '此次重试内容已改变，请重新读取配置后核对');
        return this.settings();
      }
      const current = this.row();
      if (current.revision !== input.expectedRevision) throw new AccessError(409, '配置已在其他页面更新，请重新读取配置后核对');
      const existingSecrets = !!this.db.prepare('SELECT 1 FROM ocrProviderCredentials LIMIT 1').get();
      const sealed = credentials ? this.vault.seal(JSON.stringify(credentials), existingSecrets) : this.sealed(config.provider);
      if (config.enabled) {
        if (!sealed) throw new AccessError(422, '请先填写识别服务凭据');
        this.vault.open(sealed);
      }
      if (credentials && sealed) this.db.prepare('INSERT INTO ocrProviderCredentials VALUES (?, ?) ON CONFLICT(provider) DO UPDATE SET credentials = excluded.credentials').run(config.provider, sealed);
      this.db.prepare('UPDATE ocrSettings SET revision = revision + 1, config = ? WHERE singleton = 1').run(JSON.stringify(config));
      this.db.prepare('INSERT INTO serviceOperations VALUES (\'ocr\', ?, ?, ?)').run(home.account.id, input.operationId, hash);
      const previousConfig: OcrConfig = JSON.parse(current.config);
      const action = `${ocrProviders[config.provider].label}：${[previousConfig.provider !== config.provider && '切换供应商', credentials && '更换凭据', previousConfig.enabled !== config.enabled && (config.enabled ? '启用' : '停用'), '保存配置'].filter(Boolean).join('、')}`;
      this.db.prepare('INSERT INTO serviceAudit (capability, actor, at, action) VALUES (\'ocr\', ?, ?, ?)').run(home.account.username, this.now(), action);
      return this.settings();
    })();
  }
  startTest(authorize: () => Home, id: string, revision: number) {
    this.db.transaction(() => {
      const home = authorize();
      const previous = this.db.prepare<[string], { accountId: string; revision: number }>('SELECT accountId, revision FROM ocrTests WHERE id = ?').get(id);
      if (previous) {
        if (previous.accountId !== home.account.id || previous.revision !== revision) throw new AccessError(409, '测试请求已存在，请重新读取结果');
        return;
      }
      if (this.work || this.stopping.signal.aborted) throw new AccessError(409, '已有识别测试正在进行，请等待结果');
      const row = this.row();
      if (row.revision !== revision) throw new AccessError(409, '配置已更新，请重新读取后测试');
      const config: OcrConfig = JSON.parse(row.config), sealed = this.sealed(config.provider);
      if (!sealed) throw new AccessError(422, '请先保存所选供应商的识别服务凭据');
      this.vault.open(sealed);
      this.checkQuota(config);
      this.db.prepare('INSERT INTO ocrTests (id, accountId, revision, provider, sample, status, createdAt) VALUES (?, ?, ?, ?, \'school-v1\', \'running\', ?)').run(id, home.account.id, revision, config.provider, this.now());
      this.db.prepare('INSERT INTO serviceAudit (capability, actor, at, action) VALUES (\'ocr\', ?, ?, \'主动测试合成材料\')').run(home.account.username, this.now());
      // Defer work until after the transaction commits. The operation ID survives a lost HTTP response.
      this.schedule(id, () => this.runRecognition(id, row, sealed));
    })();
    return recognitionResult(this.db.prepare<[string], RecognitionRow>(`SELECT ${recognitionFields} FROM ocrTests WHERE id = ?`).get(id)!);
  }
  private checkQuota(config: OcrConfig) {
    const usage = this.usage();
    if (usage.attempts >= config.monthlyLimit) throw new AccessError(422, '已达到图片识别本月次数上限');
    if (Math.round(usage.estimatedCents * 10) + Math.round(config.priceCents * 10) > config.monthlyBudgetCents * 10) throw new AccessError(422, '本次调用会超过图片识别本月估算预算');
  }
  private permit(revision: number, authorize?: () => Home) {
    if (this.stopping.signal.aborted || this.row().revision !== revision) throw new OcrFailure('配置已更改或服务已停用，尚未发送的调用已停止');
    if (authorize) {
      authorize();
      if (!JSON.parse(this.row().config).enabled) throw new OcrFailure('图片识别已停用，可以继续手动框题');
    }
  }
  private async runRecognition(id: string, row: SettingsRow, sealed: string, page?: { authorize: () => Home; libraryId: string; pageId: string }) {
    const started = performance.now(); const config: OcrConfig = JSON.parse(row.config);
    const credentials: OcrCredentials = JSON.parse(this.vault.open(sealed));
    let image: Buffer, width = 1000, height = 600;
    if (page) {
      const original = await this.collection.attachment(page.libraryId, page.pageId, 'original');
      let bound = 2800;
      for (;;) {
        const prepared = await sharp(original.bytes).autoOrient().resize({ width: bound, height: bound, fit: 'inside', withoutEnlargement: true }).png().toBuffer({ resolveWithObject: true });
        image = prepared.data; width = prepared.info.width; height = prepared.info.height;
        if (image.length <= 3 * 1024 * 1024) break;
        if (bound <= 700) throw new OcrFailure('材料暂无法转换为识别图片，可以继续手动框题');
        bound = Math.floor(bound * .75);
      }
      this.db.prepare('UPDATE ocrTests SET inputWidth = ?, inputHeight = ? WHERE id = ?').run(width, height, id);
    } else image = await ocrSample();
    let failure = new OcrFailure('测试未完成');
    for (let retry = 0; retry <= config.retries; retry++) {
      let attemptId: number;
      try {
        attemptId = this.db.transaction(() => {
          this.permit(row.revision, page?.authorize); this.checkQuota(config);
          const result = this.db.prepare('INSERT INTO serviceAttempts (capability, testId, month, startedAt, status, estimatedMills) VALUES (\'ocr\', ?, ?, ?, \'running\', ?)').run(id, this.month(), this.now(), Math.round(config.priceCents * 10));
          this.db.prepare('UPDATE ocrTests SET attempts = attempts + 1 WHERE id = ?').run(id);
          return Number(result.lastInsertRowid);
        })();
      } catch (error) { failure = new OcrFailure(error instanceof AccessError || error instanceof OcrFailure ? error.message : '本地调用记录无法保存'); break; }
      try {
        const lines = await this.vendors[config.provider].recognize(credentials, config, image, this.stopping.signal, () => this.permit(row.revision, page?.authorize));
        this.db.transaction(() => {
          this.db.prepare('UPDATE serviceAttempts SET status = \'succeeded\', finishedAt = ?, message = \'识别成功\' WHERE id = ?').run(this.now(), attemptId);
          this.db.prepare('UPDATE ocrTests SET status = \'succeeded\', finishedAt = ?, durationMs = ?, message = \'测试成功，请核对识别文字\', lines = ? WHERE id = ?').run(this.now(), Math.round(performance.now() - started), JSON.stringify(lines), id);
          if (page) this.db.prepare('UPDATE ocrTests SET message = ?, candidates = ? WHERE id = ?').run('识别完成，请确认题目范围和文字', JSON.stringify(recognitionCandidates(lines, width, height, this.collection.subjects())), id);
        })();
        return;
      } catch (error) {
        failure = error instanceof OcrFailure ? error : new OcrFailure('本地结果无法完整保存，请检查磁盘后读取记录', false, true);
        this.db.prepare('UPDATE serviceAttempts SET status = ?, finishedAt = ?, estimatedMills = CASE WHEN ? THEN estimatedMills ELSE 0 END, message = ? WHERE id = ?').run(failure.chargeable ? 'unknown' : 'failed', this.now(), Number(failure.chargeable), failure.message, attemptId);
        if (!failure.retryable) break;
        if (retry < config.retries) await pause(500 * (retry + 1), undefined, { signal: this.stopping.signal }).catch(() => undefined);
      }
    }
    const stopped = this.row().revision !== row.revision;
    this.db.prepare('UPDATE ocrTests SET status = ?, finishedAt = ?, durationMs = ?, message = ? WHERE id = ?').run(stopped ? 'stopped' : this.stopping.signal.aborted ? 'interrupted' : 'failed', this.now(), Math.round(performance.now() - started), failure.message, id);
  }
  async close() { this.stopping.abort(); await this.work; }
}
