import type Database from 'better-sqlite3';
import type { Home } from '../shared/contracts.ts';
import type { Subject } from '../shared/collection.ts';
import type { StudySettings, StudySettingsEdit, StudyStage } from '../shared/study.ts';
import { validStage } from '../shared/study.ts';
import { AccessError } from './family-access.ts';
import { digest } from './secrets.ts';

export function normalizeStage(stage: unknown): StudyStage {
  if (!validStage(stage)) throw new AccessError(422, '请填写连续两年的学年（例如 2026-2027）、年级和上／下学期，也可以留空');
  return { schoolYear: stage.schoolYear, grade: stage.grade?.trim() ?? null, term: stage.term };
}
export class Study {
  private db: Database.Database;
  constructor(db: Database.Database) { this.db = db; }
  settings(): StudySettings {
    const { revision, ...stage } = this.db.prepare<[], StudyStage & { revision: number }>('SELECT revision, schoolYear, grade, term FROM studySettings WHERE singleton = 1').get()!;
    return { revision, stage };
  }
  addSubject(authorize: () => Home, id: string, value: string): Subject {
    const name = value.trim();
    if (!name) throw new AccessError(422, '请填写学科名称');
    return this.db.transaction(() => {
      authorize();
      const current = this.db.prepare<[string], Subject>('SELECT id, name FROM subjects WHERE id = ?').get(id);
      if (current) {
        if (current.name !== name) throw new AccessError(409, '此学科已保存，请刷新列表核对');
        return current;
      }
      if (this.db.prepare('SELECT 1 FROM subjects WHERE name = ? COLLATE NOCASE').get(name)) throw new AccessError(409, '已有同名学科，请使用列表中的学科');
      this.db.prepare('INSERT INTO subjects (id, name, position) SELECT ?, ?, COALESCE(MAX(position), -1) + 1 FROM subjects').run(id, name);
      return { id, name };
    })();
  }
  save(authorize: () => Home, input: StudySettingsEdit): StudySettings {
    const stage = normalizeStage(input.stage);
    const requestHash = digest(JSON.stringify({ expectedRevision: input.expectedRevision, stage }));
    return this.db.transaction(() => {
      const home = authorize();
      const previous = this.db.prepare<[string, string, string], { requestHash: string }>('SELECT requestHash FROM studyOperations WHERE libraryId = ? AND accountId = ? AND operationId = ?').get(home.library.id, home.account.id, input.operationId);
      if (previous) {
        if (previous.requestHash !== requestHash) throw new AccessError(409, '此次重试内容已改变，请核对后重新保存');
        return this.settings();
      }
      if (this.settings().revision !== input.expectedRevision) throw new AccessError(409, '学习阶段设置已在其他页面更新，请重新读取后核对');
      this.db.prepare('UPDATE studySettings SET revision = revision + 1, schoolYear = @schoolYear, grade = @grade, term = @term WHERE singleton = 1').run(stage);
      this.db.prepare('INSERT INTO studyOperations VALUES (?, ?, ?, ?)').run(home.library.id, home.account.id, input.operationId, requestHash);
      return this.settings();
    })();
  }
}
