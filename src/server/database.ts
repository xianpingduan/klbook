import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const migrations = [
  `CREATE TABLE family (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    libraryId TEXT NOT NULL, learnerId TEXT NOT NULL, learnerName TEXT NOT NULL,
    accountId TEXT NOT NULL, username TEXT NOT NULL, passwordHash TEXT NOT NULL, recoveryHash TEXT NOT NULL
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY, tokenHash TEXT NOT NULL UNIQUE, deviceName TEXT NOT NULL,
    createdAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL
  );`,
  `CREATE TABLE parentGrants (
    tokenHash TEXT PRIMARY KEY, sessionId TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    expiresAt INTEGER NOT NULL
  );`,
  `CREATE TABLE attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expiresAt INTEGER NOT NULL);`,
  `CREATE TABLE subjects (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, position INTEGER NOT NULL);
  INSERT INTO subjects VALUES ('chinese', '语文', 0), ('math', '数学', 1), ('english', '英语', 2), ('science', '科学', 3);
  CREATE TABLE originalPages (
    id TEXT PRIMARY KEY, libraryId TEXT NOT NULL, mimeType TEXT NOT NULL, byteLength INTEGER NOT NULL,
    sha256 TEXT NOT NULL, previewSha256 TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL
  );
  CREATE TABLE questions (
    id TEXT PRIMARY KEY, libraryId TEXT NOT NULL, learnerId TEXT NOT NULL,
    originalPageId TEXT NOT NULL REFERENCES originalPages(id), revision INTEGER NOT NULL CHECK(revision > 0),
    state TEXT NOT NULL CHECK(state IN ('draft', 'collected')), subjectId TEXT REFERENCES subjects(id), region TEXT,
    source TEXT NOT NULL DEFAULT '', pageNumber TEXT NOT NULL DEFAULT '', questionNumber TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
    createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, collectedAt INTEGER,
    CHECK(state = 'draft' OR (subjectId IS NOT NULL AND region IS NOT NULL AND collectedAt IS NOT NULL))
  );
  CREATE INDEX questionsByState ON questions(libraryId, state, createdAt DESC, id);
  CREATE TABLE collectionOperations (
    libraryId TEXT NOT NULL, accountId TEXT NOT NULL, operationId TEXT NOT NULL,
    requestHash TEXT NOT NULL, questionId TEXT NOT NULL REFERENCES questions(id),
    PRIMARY KEY(libraryId, accountId, operationId)
  );`,
  (db: Database.Database) => {
    db.exec(`CREATE TABLE sources (
      id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE,
      active INTEGER NOT NULL CHECK(active IN (0, 1)), revision INTEGER NOT NULL CHECK(revision > 0)
    );
    ALTER TABLE questions ADD COLUMN sourceId TEXT REFERENCES sources(id);
    CREATE INDEX questionsBySource ON questions(sourceId);
    CREATE TABLE sourceOperations (
      libraryId TEXT NOT NULL, accountId TEXT NOT NULL, operationId TEXT NOT NULL,
      requestHash TEXT NOT NULL, sourceId TEXT NOT NULL REFERENCES sources(id),
      PRIMARY KEY(libraryId, accountId, operationId)
    );`);
    const add = (name: string) => {
      db.prepare('INSERT OR IGNORE INTO sources VALUES (?, ?, 1, 1)').run(randomUUID(), name);
      return db.prepare<[string], { id: string }>('SELECT id FROM sources WHERE name = ?').get(name)!.id;
    };
    for (const name of ['课堂作业', '练习册', '试卷', '其他']) add(name);
    for (const question of db.prepare<[string], { id: string; source: string }>('SELECT id, source FROM questions WHERE source != ?').all('')) {
      const name = question.source.trim();
      if (name) db.prepare('UPDATE questions SET sourceId = ? WHERE id = ?').run(add(name), question.id);
    }
  }
];

export function openDatabase(dataDir: string) {
  if (!isAbsolute(dataDir)) throw new Error('KLBOOK_DATA_DIR 必须是绝对路径');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(dataDir, 'attachments'), { recursive: true });
  const db = new Database(join(dataDir, 'family.sqlite'));
  try {
    db.pragma('foreign_keys = ON');
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.pragma('busy_timeout = 5000');
    db.transaction(() => {
      const version = db.pragma('user_version', { simple: true });
      if (typeof version !== 'number' || version < 0 || version > migrations.length) throw new Error('资料库版本比当前程序新，请使用匹配的程序');
      for (let index = version; index < migrations.length; index++) {
        const migration = migrations[index]!;
        if (typeof migration === 'string') db.exec(migration);
        else migration(db);
        db.pragma(`user_version = ${index + 1}`);
      }
    })();
    return db;
  } catch (error) { db.close(); throw error; }
}
