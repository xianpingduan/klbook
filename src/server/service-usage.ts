import type Database from 'better-sqlite3';
import type { Home } from '../shared/contracts.ts';
import { capabilities, defaultServiceBudget, type Capability, type ServiceBudget, type ServiceBudgetEdit, type ServiceUsage, type UsageAttempt, type UsageCategory, type UsageQuery, type UsageTotals } from '../shared/service-usage.ts';
import { AccessError } from './family-access.ts';
import { digest } from './secrets.ts';

const summary = `COUNT(*) AS attempts, COALESCE(SUM(status = 'succeeded'), 0) AS succeeded, COALESCE(SUM(status = 'failed'), 0) AS failed,
  COALESCE(SUM(status = 'unknown'), 0) AS unknown, COALESCE(SUM(status = 'running'), 0) AS running,
  COALESCE(SUM(estimatedMicros), 0) AS estimatedMicros, COALESCE(SUM(CASE WHEN costBasis = 'reserved' THEN estimatedMicros ELSE 0 END), 0) AS reservedMicros`;
type Settings = { revision: number; config: string };
export class ServiceUsageStore {
  private db: Database.Database;
  private now: () => number;
  constructor(db: Database.Database, now = Date.now) {
    this.db = db; this.now = now;
    db.prepare('INSERT OR IGNORE INTO serviceBudget VALUES (1, 0, ?)').run(JSON.stringify(defaultServiceBudget));
  }
  private row() { return this.db.prepare<[], Settings>('SELECT revision, config FROM serviceBudget WHERE singleton = 1').get()!; }
  private month() { return new Date(this.now() + 8 * 3600_000).toISOString().slice(0, 7); }
  // Called inside the same short SQLite transaction that records a new attempt.
  // Reservations remain in the three existing ledgers, including after a restart.
  checkReservation(micros: number) {
    if (!this.db.inTransaction) throw new Error('Budget checks must share the attempt transaction');
    if (micros <= 0) return;
    const used = this.db.prepare<[string], { micros: number }>('SELECT COALESCE(SUM(estimatedMicros), 0) AS micros FROM serviceUsageAttempts WHERE month = ?').get(this.month())!.micros;
    const config: ServiceBudget = JSON.parse(this.row().config);
    if (used + micros > config.monthlyBudgetCents * 10000) throw new AccessError(422, '本次调用会超过三类服务的本月总预算；可以继续手动收集和查看资料');
  }
  // OCR may await a free authentication request before dispatching its paid request.
  // Recheck a lowered budget against the existing reservation without adding it twice.
  checkDispatch(capability: Capability, id: number) {
    this.db.transaction(() => {
      const attempt = this.db.prepare<[string, number], { month: string; estimatedMicros: number }>('SELECT month, estimatedMicros FROM serviceUsageAttempts WHERE capability = ? AND id = ?').get(capability, id);
      if (!attempt || attempt.estimatedMicros <= 0) return;
      const used = this.db.prepare<[string], { micros: number }>('SELECT COALESCE(SUM(estimatedMicros), 0) AS micros FROM serviceUsageAttempts WHERE month = ?').get(attempt.month)!.micros;
      const config: ServiceBudget = JSON.parse(this.row().config);
      if (used > config.monthlyBudgetCents * 10000) throw new AccessError(422, '总预算已调整，尚未发送的付费调用已停止；可以继续手动收集');
    })();
  }
  read(query: UsageQuery = {}): ServiceUsage {
    const row = this.row(), month = query.month ?? this.month(), offset = query.offset ?? 0;
    const totals = this.db.prepare<[string], UsageTotals>(`SELECT ${summary} FROM serviceUsageAttempts WHERE month = ?`).get(month)!;
    const categories = (Object.keys(capabilities) as Capability[]).map(capability => {
      const settings = this.db.prepare<[], Settings>(`SELECT revision, config FROM ${capability}Settings WHERE singleton = 1`).get();
      const config = settings ? JSON.parse(settings.config) : { enabled: false, monthlyBudgetCents: 0, monthlyLimit: 0 };
      const counts = this.db.prepare<[string, string], UsageTotals & Pick<UsageCategory, 'audioMs' | 'reportedAttempts' | 'promptTokens' | 'completionTokens' | 'totalTokens'>>(`SELECT ${summary},
        COALESCE(SUM(audioMs), 0) AS audioMs, COUNT(totalTokens) AS reportedAttempts, COALESCE(SUM(promptTokens), 0) AS promptTokens,
        COALESCE(SUM(completionTokens), 0) AS completionTokens, COALESCE(SUM(totalTokens), 0) AS totalTokens FROM serviceUsageAttempts WHERE month = ? AND capability = ?`).get(month, capability)!;
      return { capability, enabled: config.enabled, monthlyBudgetCents: config.monthlyBudgetCents, monthlyLimit: config.monthlyLimit, ...counts };
    });
    const filter = query.capability ? ' AND capability = ?' : '', params = [month, ...(query.capability ? [query.capability] : [])];
    const records = this.db.prepare<(string | number)[], UsageAttempt>(`SELECT capability, id, testId, provider, model, startedAt, finishedAt, status,
      CASE WHEN finishedAt IS NULL THEN NULL ELSE MAX(0, finishedAt - startedAt) END AS durationMs,
      estimatedMicros, costBasis, audioMs, promptTokens, completionTokens, totalTokens, message FROM serviceUsageAttempts
      WHERE month = ?${filter} ORDER BY startedAt DESC, capability, id DESC LIMIT 40 OFFSET ?`).all(...params, offset);
    const recordCount = this.db.prepare<string[], { count: number }>(`SELECT COUNT(*) AS count FROM serviceUsageAttempts WHERE month = ?${filter}`).get(...params)!.count;
    const audit = this.db.prepare<[string], ServiceUsage['audit'][number]>(`SELECT capability, actor, at, action FROM serviceAudit
      WHERE capability IN ('ocr', 'speech', 'ai', 'budget') AND strftime('%Y-%m', at / 1000, 'unixepoch', '+8 hours') = ? ORDER BY id DESC LIMIT 30`).all(month);
    return { revision: row.revision, config: JSON.parse(row.config), month, currentMonth: this.month(), totals, categories, records, recordCount, offset, audit };
  }
  save(authorize: () => Home, input: ServiceBudgetEdit) {
    const config: ServiceBudget = { ...input.config, capacityNote: input.config.capacityNote.trim() };
    const hash = digest(JSON.stringify({ expectedRevision: input.expectedRevision, config }));
    return this.db.transaction(() => {
      const home = authorize();
      const previous = this.db.prepare<[string, string], { requestHash: string }>("SELECT requestHash FROM serviceOperations WHERE capability = 'budget' AND accountId = ? AND operationId = ?").get(home.account.id, input.operationId);
      if (previous) {
        if (previous.requestHash !== hash) throw new AccessError(409, '此次重试内容已改变，请重新读取预算后核对');
        return this.read();
      }
      if (this.row().revision !== input.expectedRevision) throw new AccessError(409, '预算已在其他页面更新，请重新读取后核对');
      this.db.prepare('UPDATE serviceBudget SET revision = revision + 1, config = ? WHERE singleton = 1').run(JSON.stringify(config));
      this.db.prepare("INSERT INTO serviceOperations VALUES ('budget', ?, ?, ?)").run(home.account.id, input.operationId, hash);
      this.db.prepare("INSERT INTO serviceAudit (capability, actor, at, action) VALUES ('budget', ?, ?, '保存总预算与独立成本记录')").run(home.account.username, this.now());
      return this.read();
    })();
  }
}
