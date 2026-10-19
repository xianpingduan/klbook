import type Database from 'better-sqlite3';
import type { Home } from '../shared/contracts.ts';
import { aiInputTokenLimits, aiModels, defaultAiConfig, type AiConfig, type AiCredentials, type AiEdit, type AiModel, type AiSettings, type AiTest } from '../shared/ai.ts';
import { AccessError } from './family-access.ts';
import { CredentialVault } from './credential-vault.ts';
import { digest } from './secrets.ts';
import { AiFailure, XfyunAi, type AiHttp, type AiMeter } from './xfyun-ai.ts';
import { setTimeout as pause } from 'node:timers/promises';
import type { ServiceUsageStore } from './service-usage.ts';

type SettingsRow = { revision: number; config: string };
const testFields = `id, revision, model, prompt, status, createdAt, finishedAt, durationMs, attempts, message, text, promptTokens, completionTokens, totalTokens,
  (SELECT COALESCE(SUM(estimatedMicros), 0) / 10000.0 FROM aiAttempts WHERE testId = aiTests.id) AS estimatedCents,
  (SELECT COALESCE(SUM(estimatedMicros), 0) / 10000.0 FROM aiAttempts WHERE testId = aiTests.id AND costBasis = 'reserved') AS reservedCents`;
// Integer micro-yuan preserve small token charges; round upward by at most one micro-yuan per attempt.
function costMicros(config: AiConfig, inputTokens: number, outputTokens: number) {
  const price = config.modelPrices[config.model];
  return Math.ceil((inputTokens * price.inputCentsPerMillion + outputTokens * price.outputCentsPerMillion) / 100);
}
function reservedMicros(config: AiConfig) { return costMicros(config, aiInputTokenLimits[config.model], config.maxOutputTokens); }
export class AiService {
  private db: Database.Database;
  private vault: CredentialVault;
  private now: () => number;
  private vendor: XfyunAi;
  private budget: ServiceUsageStore;
  private work?: Promise<void>;
  private stopping = new AbortController();
  constructor(db: Database.Database, dataDir: string, budget: ServiceUsageStore, now = Date.now, http?: AiHttp) {
    this.db = db; this.vault = new CredentialVault(db, dataDir, 'ai'); this.now = now;
    this.vendor = new XfyunAi(http);
    this.budget = budget;
    db.prepare('INSERT OR IGNORE INTO aiSettings VALUES (1, 0, ?)').run(JSON.stringify(defaultAiConfig));
    db.prepare("UPDATE aiTests SET status = 'interrupted', finishedAt = ?, message = ? WHERE status = 'running'").run(now(), '电脑服务曾中断，结果不确定；不会自动重新发送');
    db.prepare("UPDATE aiAttempts SET status = 'unknown', finishedAt = ?, message = ? WHERE status = 'running'").run(now(), '服务中断，保留估算费用');
  }
  private row() { return this.db.prepare<[], SettingsRow>('SELECT revision, config FROM aiSettings WHERE singleton = 1').get()!; }
  private sealed(model: AiModel) { return this.db.prepare<[string], { credentials: string }>('SELECT credentials FROM aiModelCredentials WHERE model = ?').get(model)?.credentials ?? null; }
  private month() { return new Date(this.now() + 8 * 3600_000).toISOString().slice(0, 7); }
  private usage(): AiSettings['usage'] {
    return { month: this.month(), ...this.db.prepare<[string], Omit<AiSettings['usage'], 'month'>>(`SELECT COUNT(*) AS attempts, COUNT(totalTokens) AS reportedAttempts,
      COALESCE(SUM(promptTokens), 0) AS promptTokens, COALESCE(SUM(completionTokens), 0) AS completionTokens, COALESCE(SUM(totalTokens), 0) AS totalTokens,
      COALESCE(SUM(estimatedMicros), 0) / 10000.0 AS estimatedCents FROM aiAttempts WHERE month = ?`).get(this.month())! };
  }
  private credentialState(model: AiModel) {
    const sealed = this.sealed(model); let available = false;
    if (sealed) { try { this.vault.open(sealed); available = true; } catch { /* Still allow disabling with a missing key. */ } }
    return { credentialsConfigured: !!sealed, credentialAvailable: available };
  }
  settings(): AiSettings {
    const row = this.row(), config: AiConfig = JSON.parse(row.config);
    return { revision: row.revision, config, ...this.credentialState(config.model),
      models: { lite: this.credentialState('lite'), '4.0Ultra': this.credentialState('4.0Ultra') },
      usage: this.usage(), tests: this.db.prepare<[], AiTest>(`SELECT ${testFields} FROM aiTests ORDER BY createdAt DESC, rowid DESC LIMIT 20`).all(),
      audit: this.db.prepare<[], AiSettings['audit'][number]>("SELECT actor, at, action FROM serviceAudit WHERE capability = 'ai' ORDER BY id DESC LIMIT 30").all() };
  }
  save(authorize: () => Home, input: AiEdit) {
    const config: AiConfig = { ...input.config, name: input.config.name.trim() };
    if (!config.name) throw new AccessError(422, '请填写服务名称');
    const credentials = input.credentials && { apiPassword: input.credentials.apiPassword.trim() };
    if (credentials && !/^[\x21-\x7e]{1,512}$/.test(credentials.apiPassword)) throw new AccessError(422, '请填写所选模型 HTTP 接口的 APIPassword，不包含空格或换行');
    const hash = digest(JSON.stringify({ expectedRevision: input.expectedRevision, config, credentials }));
    return this.db.transaction(() => {
      const home = authorize();
      const previous = this.db.prepare<[string, string], { requestHash: string }>("SELECT requestHash FROM serviceOperations WHERE capability = 'ai' AND accountId = ? AND operationId = ?").get(home.account.id, input.operationId);
      if (previous) {
        if (previous.requestHash !== hash) throw new AccessError(409, '此次重试内容已改变，请重新读取配置后核对');
        return this.settings();
      }
      const row = this.row();
      if (row.revision !== input.expectedRevision) throw new AccessError(409, '配置已在其他页面更新，请重新读取配置后核对');
      const sealed = credentials ? this.vault.seal(JSON.stringify(credentials)) : this.sealed(config.model);
      if (config.enabled) {
        if (!config.modelPrices[config.model].confirmed) throw new AccessError(422, '请先核对所选模型的输入、输出计费单价；免费额度内也需明确确认');
        if (!sealed) throw new AccessError(422, '请先保存所选模型的 APIPassword');
        this.vault.open(sealed);
      }
      if (credentials) this.db.prepare('INSERT INTO aiModelCredentials VALUES (?, ?) ON CONFLICT(model) DO UPDATE SET credentials = excluded.credentials').run(config.model, sealed);
      this.db.prepare('UPDATE aiSettings SET revision = revision + 1, config = ? WHERE singleton = 1').run(JSON.stringify(config));
      this.db.prepare("INSERT INTO serviceOperations VALUES ('ai', ?, ?, ?)").run(home.account.id, input.operationId, hash);
      const old: AiConfig = JSON.parse(row.config);
      const action = [credentials && '更换凭据', old.model !== config.model && `切换模型至 ${aiModels[config.model]}`, old.enabled !== config.enabled && (config.enabled ? '启用' : '停用'), '保存配置'].filter(Boolean).join('、');
      this.db.prepare("INSERT INTO serviceAudit (capability, actor, at, action) VALUES ('ai', ?, ?, ?)").run(home.account.username, this.now(), action);
      return this.settings();
    })();
  }
  private result(id: string) { return this.db.prepare<[string], AiTest>(`SELECT ${testFields} FROM aiTests WHERE id = ?`).get(id)!; }
  startTest(authorize: () => Home, id: string, revision: number, prompt: string) {
    const hash = digest(JSON.stringify({ revision, prompt }));
    this.db.transaction(() => {
      const home = authorize();
      const previous = this.db.prepare<[string], { accountId: string; requestHash: string }>('SELECT accountId, requestHash FROM aiTests WHERE id = ?').get(id);
      if (previous) {
        if (previous.accountId !== home.account.id || previous.requestHash !== hash) throw new AccessError(409, '此测试请求已用于其他文字或配置，请重新读取记录');
        return;
      }
      if (this.work || this.stopping.signal.aborted) throw new AccessError(409, '已有 AI 学习测试正在进行，请等待结果');
      const row = this.row(), config: AiConfig = JSON.parse(row.config);
      if (row.revision !== revision) throw new AccessError(409, '配置已更新，请重新读取后测试');
      if (!config.enabled) throw new AccessError(422, 'AI 学习已停用，请先启用并保存配置');
      const sealed = this.sealed(config.model);
      if (!sealed) throw new AccessError(422, '请先保存所选模型的 APIPassword');
      const credentials: AiCredentials = JSON.parse(this.vault.open(sealed));
      this.checkQuota(config);
      this.db.prepare("INSERT INTO aiTests (id, accountId, requestHash, revision, model, prompt, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, 'running', ?)").run(id, home.account.id, hash, revision, config.model, prompt, this.now());
      this.db.prepare("INSERT INTO serviceAudit (capability, actor, at, action) VALUES ('ai', ?, ?, '主动发送文字测试')").run(home.account.username, this.now());
      this.work = Promise.resolve().then(() => this.run(id, row, credentials, prompt, authorize)).catch(() => {
        try { this.db.prepare("UPDATE aiTests SET status = 'interrupted', finishedAt = ?, message = ? WHERE id = ? AND status = 'running'").run(this.now(), '本地结果无法完整保存，请检查磁盘后读取记录', id); }
        catch { /* Startup reconciles work once storage is available. */ }
      }).finally(() => { this.work = undefined; });
    })();
    return this.result(id);
  }
  private checkQuota(config: AiConfig) {
    const usage = this.usage();
    if (!config.modelPrices[config.model].confirmed) throw new AccessError(422, '请先核对所选模型的计费单价');
    if (usage.attempts >= config.monthlyLimit) throw new AccessError(422, '已达到 AI 学习本月次数上限');
    if (Math.round(usage.estimatedCents * 10000) + reservedMicros(config) > config.monthlyBudgetCents * 10000) throw new AccessError(422, '本次预留会超过 AI 学习本月估算预算');
    this.budget.checkReservation(reservedMicros(config));
  }
  private settleAttempt(id: number, config: AiConfig, status: string, message: string, meter: AiMeter, retainReservation: boolean) {
    const reported = meter.promptTokens !== null && meter.completionTokens !== null;
    const estimate = reported ? costMicros(config, meter.promptTokens!, meter.completionTokens!) : retainReservation ? reservedMicros(config) : 0;
    this.db.prepare('UPDATE aiAttempts SET status = ?, finishedAt = ?, estimatedMicros = ?, costBasis = ?, message = ?, promptTokens = ?, completionTokens = ?, totalTokens = ? WHERE id = ?')
      .run(status, this.now(), estimate, reported ? 'reported' : retainReservation ? 'reserved' : 'none', message, meter.promptTokens, meter.completionTokens, meter.totalTokens, id);
  }
  private async run(id: string, row: SettingsRow, credentials: AiCredentials, prompt: string, authorize: () => Home) {
    const started = performance.now(), config: AiConfig = JSON.parse(row.config);
    let failure = new AiFailure('AI 学习测试未完成'), stopped = false;
    for (let retry = 0; retry <= config.retries; retry++) {
      let attemptId: number;
      try {
        attemptId = this.db.transaction(() => {
          authorize();
          if (this.stopping.signal.aborted || this.row().revision !== row.revision || !JSON.parse(this.row().config).enabled) throw new AccessError(422, '配置已更改或 AI 学习已停用，尚未发出的调用已停止');
          this.checkQuota(config);
          const attempt = this.db.prepare("INSERT INTO aiAttempts (testId, model, month, startedAt, status, estimatedMicros) VALUES (?, ?, ?, ?, 'running', ?)").run(id, config.model, this.month(), this.now(), reservedMicros(config));
          this.db.prepare('UPDATE aiTests SET attempts = attempts + 1 WHERE id = ?').run(id);
          return Number(attempt.lastInsertRowid);
        })();
      } catch (error) { failure = new AiFailure(error instanceof AccessError ? error.message : '本地调用记录无法保存'); stopped = true; break; }
      try {
        const result = await this.vendor.complete(credentials, config, prompt, this.stopping.signal);
        const { promptTokens, completionTokens, totalTokens } = result.meter;
        this.db.transaction(() => {
          this.settleAttempt(attemptId, config, 'succeeded', result.message, result.meter, true);
          this.db.prepare("UPDATE aiTests SET status = 'succeeded', finishedAt = ?, durationMs = ?, text = ?, message = ?, promptTokens = ?, completionTokens = ?, totalTokens = ? WHERE id = ?").run(this.now(), Math.round(performance.now() - started), result.text, result.message, promptTokens, completionTokens, totalTokens, id);
        })();
        return;
      } catch (error) {
        failure = error instanceof AiFailure ? error : new AiFailure('本地结果无法完整保存，请检查磁盘后读取记录', false, true);
        this.settleAttempt(attemptId, config, failure.uncertain ? 'unknown' : 'failed', failure.message, failure.meter, failure.uncertain);
        if (!failure.retryable || retry >= config.retries) break;
        await pause(500 * (retry + 1), undefined, { signal: this.stopping.signal }).catch(() => undefined);
      }
    }
    this.db.prepare('UPDATE aiTests SET status = ?, finishedAt = ?, durationMs = ?, message = ?, promptTokens = ?, completionTokens = ?, totalTokens = ? WHERE id = ?').run(this.stopping.signal.aborted ? 'interrupted' : stopped ? 'stopped' : 'failed', this.now(), Math.round(performance.now() - started), failure.message, failure.meter.promptTokens, failure.meter.completionTokens, failure.meter.totalTokens, id);
  }
  async close() { this.stopping.abort(); await this.work; }
}
