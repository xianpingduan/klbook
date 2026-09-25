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

type SettingsRow = { revision: number; config: string };
type TestRow = Omit<OcrTest, 'lines'> & { lines: string };
const testFields = 'id, revision, provider, sample, status, createdAt, finishedAt, durationMs, attempts, message, lines';
const testResult = (row: TestRow): OcrTest => ({ ...row, lines: JSON.parse(row.lines) });
export class OcrService {
  private db: Database.Database;
  private vault: CredentialVault;
  private now: () => number;
  private vendors: Record<OcrProvider, BaiduOcr | XfyunOcr>;
  private work?: Promise<void>;
  private stopping = new AbortController();
  constructor(db: Database.Database, dataDir: string, now = Date.now, http?: VendorHttp) {
    this.db = db; this.vault = new CredentialVault(dataDir); this.now = now;
    this.vendors = { baidu: new BaiduOcr(http), xfyun: new XfyunOcr(http, now) };
    db.prepare('INSERT OR IGNORE INTO ocrSettings VALUES (1, 0, ?, NULL)').run(JSON.stringify(defaultOcrConfig));
    db.prepare('UPDATE ocrTests SET status = \'interrupted\', finishedAt = ?, message = ? WHERE status = \'running\'').run(now(), '电脑服务曾中断，结果不确定；不会自动重新发送');
    db.prepare('UPDATE serviceAttempts SET status = \'unknown\', finishedAt = ?, message = ? WHERE capability = \'ocr\' AND status = \'running\'').run(now(), '服务中断，保留估算费用');
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
    const tests = this.db.prepare<[], TestRow>(`SELECT ${testFields} FROM ocrTests ORDER BY createdAt DESC, rowid DESC LIMIT 20`).all().map(testResult);
    const audit = this.db.prepare<[], OcrSettings['audit'][number]>('SELECT actor, at, action FROM serviceAudit WHERE capability = \'ocr\' ORDER BY id DESC LIMIT 30').all();
    return { revision: row.revision, config, credentialsConfigured: credentialStatus[config.provider].configured, credentialAvailable: credentialStatus[config.provider].available, credentialStatus, usage: this.usage(), tests, audit };
  }
  save(authorize: () => Home, input: OcrEdit) {
    const config: OcrConfig = { ...input.config, name: input.config.name.trim() };
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
      this.work = Promise.resolve().then(() => this.runTest(id, row, sealed)).catch(() => {
        try { this.db.prepare('UPDATE ocrTests SET status = \'interrupted\', finishedAt = ?, message = ? WHERE id = ? AND status = \'running\'').run(this.now(), '本地测试被中断，请读取记录后再决定是否测试', id); }
        catch { /* A failed disk must not cause an unhandled rejection; startup reconciles unfinished calls. */ }
      }).finally(() => { this.work = undefined; });
    })();
    return testResult(this.db.prepare<[string], TestRow>(`SELECT ${testFields} FROM ocrTests WHERE id = ?`).get(id)!);
  }
  private checkQuota(config: OcrConfig) {
    const usage = this.usage();
    if (usage.attempts >= config.monthlyLimit) throw new AccessError(422, '已达到图片识别本月次数上限');
    if (Math.round(usage.estimatedCents * 10) + Math.round(config.priceCents * 10) > config.monthlyBudgetCents * 10) throw new AccessError(422, '本次调用会超过图片识别本月估算预算');
  }
  private permit(revision: number) {
    if (this.stopping.signal.aborted || this.row().revision !== revision) throw new OcrFailure('配置已更改或服务已停用，尚未发送的调用已停止');
  }
  private async runTest(id: string, row: SettingsRow, sealed: string) {
    const started = performance.now(); const config: OcrConfig = JSON.parse(row.config);
    const credentials: OcrCredentials = JSON.parse(this.vault.open(sealed));
    const image = await ocrSample();
    let failure = new OcrFailure('测试未完成');
    for (let retry = 0; retry <= config.retries; retry++) {
      let attemptId: number;
      try {
        attemptId = this.db.transaction(() => {
          this.permit(row.revision); this.checkQuota(config);
          const result = this.db.prepare('INSERT INTO serviceAttempts (capability, testId, month, startedAt, status, estimatedMills) VALUES (\'ocr\', ?, ?, ?, \'running\', ?)').run(id, this.month(), this.now(), Math.round(config.priceCents * 10));
          this.db.prepare('UPDATE ocrTests SET attempts = attempts + 1 WHERE id = ?').run(id);
          return Number(result.lastInsertRowid);
        })();
      } catch (error) { failure = new OcrFailure(error instanceof AccessError || error instanceof OcrFailure ? error.message : '本地调用记录无法保存'); break; }
      try {
        const lines = await this.vendors[config.provider].recognize(credentials, config, image, this.stopping.signal, () => this.permit(row.revision));
        this.db.transaction(() => {
          this.db.prepare('UPDATE serviceAttempts SET status = \'succeeded\', finishedAt = ?, message = \'识别成功\' WHERE id = ?').run(this.now(), attemptId);
          this.db.prepare('UPDATE ocrTests SET status = \'succeeded\', finishedAt = ?, durationMs = ?, message = \'测试成功，请核对识别文字\', lines = ? WHERE id = ?').run(this.now(), Math.round(performance.now() - started), JSON.stringify(lines), id);
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
