import type Database from 'better-sqlite3';
import type { Home } from '../shared/contracts.ts';
import type { Source, SourceEdit } from '../shared/sources.ts';
import { AccessError } from './family-access.ts';
import { digest } from './secrets.ts';

interface SourceRow extends Omit<Source, 'active'> { active: number }
const source = (row: SourceRow): Source => ({ ...row, active: row.active === 1 });

export class Sources {
  private db: Database.Database;
  constructor(db: Database.Database) { this.db = db; }
  list(includeInactive = false): Source[] {
    return this.db.prepare<[number], SourceRow>('SELECT * FROM sources WHERE active = 1 OR ? = 1 ORDER BY active DESC, name, id').all(Number(includeInactive)).map(source);
  }
  get(id: string): Source {
    const row = this.db.prepare<[string], SourceRow>('SELECT * FROM sources WHERE id = ?').get(id);
    if (!row) throw new AccessError(422, '来源不存在，请重新选择');
    return source(row);
  }
  find(name: string): Source | undefined {
    const row = this.db.prepare<[string], SourceRow>('SELECT * FROM sources WHERE name = ?').get(name);
    return row ? source(row) : undefined;
  }
  save(authorize: () => Home, id: string, input: SourceEdit): Source {
    const name = input.name.trim();
    if (!name) throw new AccessError(422, '请填写来源名称');
    const requestHash = digest(JSON.stringify({ id, expectedRevision: input.expectedRevision, name, active: input.active }));
    return this.db.transaction(() => {
      const home = authorize();
      const previous = this.db.prepare<[string, string, string], { requestHash: string; sourceId: string }>('SELECT requestHash, sourceId FROM sourceOperations WHERE libraryId = ? AND accountId = ? AND operationId = ?').get(home.library.id, home.account.id, input.operationId);
      if (previous) {
        if (previous.requestHash !== requestHash) throw new AccessError(409, '此次重试内容已改变，请重新确认');
        return this.get(previous.sourceId);
      }
      const current = this.db.prepare<[string], SourceRow>('SELECT * FROM sources WHERE id = ?').get(id);
      if ((current?.revision ?? 0) !== input.expectedRevision) throw new AccessError(409, '来源已被修改，请刷新来源列表后重试');
      const duplicate = this.find(name);
      if (duplicate && duplicate.id !== id) throw new AccessError(409, '已有同名来源，请选择已有来源或修改名称');
      if (!current) this.db.prepare('INSERT INTO sources VALUES (?, ?, ?, 1)').run(id, name, Number(input.active));
      else this.db.prepare('UPDATE sources SET name = ?, active = ?, revision = revision + 1 WHERE id = ?').run(name, Number(input.active), id);
      this.db.prepare('INSERT INTO sourceOperations VALUES (?, ?, ?, ?, ?)').run(home.library.id, home.account.id, input.operationId, requestHash, id);
      return this.get(id);
    })();
  }
}
