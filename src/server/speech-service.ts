import type Database from 'better-sqlite3';
import type { Home } from '../shared/contracts.ts';
import { defaultSpeechConfig, type SpeechConfig, type SpeechEdit, type SpeechSettings, type SpeechCredentials, type SpeechTest } from '../shared/speech.ts';
import { AccessError } from './family-access.ts';
import { CredentialVault } from './credential-vault.ts';
import { digest } from './secrets.ts';
import { speechAudio, type SpeechAudio } from './speech-audio.ts';
import { XfyunSpeech, SpeechFailure, type SpeechSocketFactory } from './xfyun-speech.ts';
import { setTimeout as pause } from 'node:timers/promises';
import type { ServiceUsageStore } from './service-usage.ts';

type SettingsRow = { revision: number; config: string; credentials: string | null };
export class SpeechService {
  private db: Database.Database;
  private vault: CredentialVault;
  private now: () => number;
  private vendor: XfyunSpeech;
  private budget: ServiceUsageStore;
  private work?: Promise<void>;
  private stopping = new AbortController();
  constructor(db: Database.Database, dataDir: string, budget: ServiceUsageStore, now = Date.now, socket?: SpeechSocketFactory) {
    this.db = db; this.vault = new CredentialVault(db, dataDir, 'speech'); this.now = now;
    this.vendor = new XfyunSpeech(socket, now);
    this.budget = budget;
    db.prepare('INSERT OR IGNORE INTO speechSettings VALUES (1, 0, ?, NULL)').run(JSON.stringify(defaultSpeechConfig));
    db.prepare("UPDATE speechTests SET status = 'interrupted', finishedAt = ?, message = ? WHERE status = 'running'").run(now(), '电脑服务曾中断，结果不确定；不会自动重新发送');
    db.prepare("UPDATE speechAttempts SET status = 'unknown', finishedAt = ?, message = ? WHERE status = 'running'").run(now(), '服务中断，保留估算费用');
  }
  private row() { return this.db.prepare<[], SettingsRow>('SELECT revision, config, credentials FROM speechSettings WHERE singleton = 1').get()!; }
  private month() { return new Date(this.now() + 8 * 3600_000).toISOString().slice(0, 7); }
  private usage() {
    return { month: this.month(), ...this.db.prepare<[string], { attempts: number; audioMs: number; estimatedCents: number }>('SELECT COUNT(*) AS attempts, COALESCE(SUM(audioMs), 0) AS audioMs, COALESCE(SUM(estimatedMills), 0) / 10.0 AS estimatedCents FROM speechAttempts WHERE month = ?').get(this.month())! };
  }
  settings(): SpeechSettings {
    const row = this.row(); let available = false;
    if (row.credentials) { try { this.vault.open(row.credentials); available = true; } catch { /* Still allow disabling with a missing key. */ } }
    return { revision: row.revision, config: JSON.parse(row.config), credentialsConfigured: !!row.credentials, credentialAvailable: available,
      usage: this.usage(), tests: this.db.prepare<[], SpeechSettings['tests'][number]>('SELECT id, revision, status, createdAt, finishedAt, durationMs, attempts, audioMs, audioBytes, sampleRate, message, text FROM speechTests ORDER BY createdAt DESC, rowid DESC LIMIT 20').all(),
      audit: this.db.prepare<[], SpeechSettings['audit'][number]>("SELECT actor, at, action FROM serviceAudit WHERE capability = 'speech' ORDER BY id DESC LIMIT 30").all() };
  }
  save(authorize: () => Home, input: SpeechEdit) {
    const priceMills = Math.round(input.config.priceCents * 10);
    if (Math.abs(priceMills - input.config.priceCents * 10) > 1e-8) throw new AccessError(422, '单价最多保留三位元小数');
    const config: SpeechConfig = { ...input.config, name: input.config.name.trim(), priceCents: priceMills / 10 };
    if (!config.name) throw new AccessError(422, '请填写服务名称');
    const credentials = input.credentials && { appId: input.credentials.appId.trim(), apiKey: input.credentials.apiKey.trim(), secretKey: input.credentials.secretKey.trim() };
    if (credentials && (!/^[A-Za-z0-9_-]{1,64}$/.test(credentials.appId) || !/^[A-Za-z0-9]{32}$/.test(credentials.apiKey) || !/^[A-Za-z0-9]{32}$/.test(credentials.secretKey))) throw new AccessError(422, '请填写讯飞 APPID、32 位 APIKey 和 32 位 APISecret');
    const hash = digest(JSON.stringify({ expectedRevision: input.expectedRevision, config, credentials }));
    return this.db.transaction(() => {
      const home = authorize();
      const previous = this.db.prepare<[string, string], { requestHash: string }>("SELECT requestHash FROM serviceOperations WHERE capability = 'speech' AND accountId = ? AND operationId = ?").get(home.account.id, input.operationId);
      if (previous) {
        if (previous.requestHash !== hash) throw new AccessError(409, '此次重试内容已改变，请重新读取配置后核对');
        return this.settings();
      }
      const row = this.row();
      if (row.revision !== input.expectedRevision) throw new AccessError(409, '配置已在其他页面更新，请重新读取配置后核对');
      const sealed = credentials ? this.vault.seal(JSON.stringify(credentials)) : row.credentials;
      if (config.enabled) {
        if (!sealed) throw new AccessError(422, '请先保存语音听写服务凭据');
        this.vault.open(sealed);
      }
      this.db.prepare('UPDATE speechSettings SET revision = revision + 1, config = ?, credentials = ? WHERE singleton = 1').run(JSON.stringify(config), sealed);
      this.db.prepare("INSERT INTO serviceOperations VALUES ('speech', ?, ?, ?)").run(home.account.id, input.operationId, hash);
      const old: SpeechConfig = JSON.parse(row.config);
      const action = [credentials && '更换凭据', old.enabled !== config.enabled && (config.enabled ? '启用' : '停用'), '保存配置'].filter(Boolean).join('、');
      this.db.prepare("INSERT INTO serviceAudit (capability, actor, at, action) VALUES ('speech', ?, ?, ?)").run(home.account.username, this.now(), action);
      return this.settings();
    })();
  }
  private result(id: string) { return this.db.prepare<[string], SpeechTest>('SELECT id, revision, status, createdAt, finishedAt, durationMs, attempts, audioMs, audioBytes, sampleRate, message, text FROM speechTests WHERE id = ?').get(id)!; }
  startTest(authorize: () => Home, id: string, revision: number, bytes: Buffer) {
    const audio = speechAudio(bytes), hash = digest(Buffer.concat([Buffer.from(`${revision}:`), bytes]).toString('base64'));
    this.db.transaction(() => {
      const home = authorize();
      const previous = this.db.prepare<[string], { accountId: string; requestHash: string }>('SELECT accountId, requestHash FROM speechTests WHERE id = ?').get(id);
      if (previous) {
        if (previous.accountId !== home.account.id || previous.requestHash !== hash) throw new AccessError(409, '此测试请求已用于其他音频或配置，请重新读取记录');
        return;
      }
      if (this.work || this.stopping.signal.aborted) throw new AccessError(409, '已有语音转写测试正在进行，请等待结果');
      const row = this.row(), config: SpeechConfig = JSON.parse(row.config);
      if (row.revision !== revision) throw new AccessError(409, '配置已更新，请重新读取后测试');
      if (!config.enabled) throw new AccessError(422, '语音转写已停用，请先启用并保存配置');
      if (!row.credentials) throw new AccessError(422, '请先保存语音听写服务凭据');
      const credentials: SpeechCredentials = JSON.parse(this.vault.open(row.credentials));
      this.checkQuota(config);
      this.db.prepare("INSERT INTO speechTests (id, accountId, requestHash, revision, status, createdAt, audioMs, audioBytes, sampleRate) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?)").run(id, home.account.id, hash, revision, this.now(), audio.durationMs, bytes.length, audio.sampleRate);
      this.db.prepare("INSERT INTO serviceAudit (capability, actor, at, action) VALUES ('speech', ?, ?, '主动上传音频测试')").run(home.account.username, this.now());
      this.work = Promise.resolve().then(() => this.run(id, row, credentials, audio, authorize)).catch(() => {
        try { this.db.prepare("UPDATE speechTests SET status = 'interrupted', finishedAt = ?, message = ? WHERE id = ? AND status = 'running'").run(this.now(), '本地结果无法完整保存，请检查磁盘后读取记录', id); }
        catch { /* Startup reconciles work once storage is available. */ }
      }).finally(() => { this.work = undefined; });
    })();
    return this.result(id);
  }
  private checkQuota(config: SpeechConfig) {
    const usage = this.usage();
    if (usage.attempts >= config.monthlyLimit) throw new AccessError(422, '已达到语音转写本月次数上限');
    if (Math.round(usage.estimatedCents * 10) + Math.round(config.priceCents * 10) > config.monthlyBudgetCents * 10) throw new AccessError(422, '本次调用会超过语音转写本月估算预算');
    this.budget.checkReservation(Math.round(config.priceCents * 10000));
  }
  private async run(id: string, row: SettingsRow, credentials: SpeechCredentials, audio: SpeechAudio, authorize: () => Home) {
    const started = performance.now(), config: SpeechConfig = JSON.parse(row.config);
    let failure = new SpeechFailure('语音转写未完成'), stopped = false;
    for (let retry = 0; retry <= config.retries; retry++) {
      let attemptId: number;
      try {
        attemptId = this.db.transaction(() => {
          authorize();
          if (this.stopping.signal.aborted || this.row().revision !== row.revision || !JSON.parse(this.row().config).enabled) throw new AccessError(422, '配置已更改或语音转写已停用，尚未发出的调用已停止');
          this.checkQuota(config);
          const attempt = this.db.prepare("INSERT INTO speechAttempts (testId, month, startedAt, status, audioMs, estimatedMills) VALUES (?, ?, ?, 'running', ?, ?)").run(id, this.month(), this.now(), audio.durationMs, Math.round(config.priceCents * 10));
          this.db.prepare('UPDATE speechTests SET attempts = attempts + 1 WHERE id = ?').run(id);
          return Number(attempt.lastInsertRowid);
        })();
      } catch (error) { failure = new SpeechFailure(error instanceof AccessError ? error.message : '本地调用记录无法保存'); stopped = true; break; }
      try {
        // Once dispatched, keep the real result even if a parent disables the service meanwhile.
        const text = await this.vendor.transcribe(credentials, config, audio, this.stopping.signal);
        this.db.transaction(() => {
          this.db.prepare("UPDATE speechAttempts SET status = 'succeeded', finishedAt = ?, message = '转写完成' WHERE id = ?").run(this.now(), attemptId);
          this.db.prepare("UPDATE speechTests SET status = 'succeeded', finishedAt = ?, durationMs = ?, text = ?, message = ? WHERE id = ?").run(this.now(), Math.round(performance.now() - started), text, text.trim() ? '测试成功，请核对转写文字' : '转写完成，但未识别出文字；请检查音量、语言或静音片段', id);
        })();
        return;
      } catch (error) {
        failure = error instanceof SpeechFailure ? error : new SpeechFailure('本地结果无法完整保存，请检查磁盘后读取记录', false, true);
        this.db.prepare('UPDATE speechAttempts SET status = ?, finishedAt = ?, estimatedMills = CASE WHEN ? THEN estimatedMills ELSE 0 END, message = ? WHERE id = ?').run(failure.uncertain ? 'unknown' : 'failed', this.now(), Number(failure.uncertain), failure.message, attemptId);
        if (!failure.retryable || retry >= config.retries) break;
        await pause(500 * (retry + 1), undefined, { signal: this.stopping.signal }).catch(() => undefined);
      }
    }
    this.db.prepare('UPDATE speechTests SET status = ?, finishedAt = ?, durationMs = ?, message = ? WHERE id = ?').run(this.stopping.signal.aborted ? 'interrupted' : stopped ? 'stopped' : 'failed', this.now(), Math.round(performance.now() - started), failure.message, id);
  }
  async close() { this.stopping.abort(); await this.work; }
}
