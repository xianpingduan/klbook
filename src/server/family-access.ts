import type Database from 'better-sqlite3';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Device, Home, LoginInput, RecoveryInput, SetupInput } from '../shared/contracts.ts';
import { digest, hashPassword, newSecret, verifyPassword } from './secrets.ts';

interface Family {
  libraryId: string; learnerId: string; learnerName: string;
  accountId: string; username: string; passwordHash: string; recoveryHash: string;
}
interface Session {
  id: string; tokenHash: string; deviceName: string; createdAt: number; expiresAt: number;
}

export class AccessError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export class FamilyAccess {
  private db: Database.Database;
  private setupPath: string;
  private now: () => number;

  constructor(db: Database.Database, dataDir: string, now = Date.now) {
    this.setupPath = join(dataDir, 'setup-code.txt');
    this.now = now;
    this.db = db;
    try {
      if (!this.family()) {
        try { writeFileSync(this.setupPath, newSecret(), { flag: 'wx', mode: 0o600 }); }
        catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
      }
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private family() { return this.db.prepare<[], Family>('SELECT * FROM family WHERE singleton = 1').get(); }
  info() { return { app: 'klbook' as const, apiVersion: 1 as const, initialized: Boolean(this.family()) }; }

  limitAttempt(scope: string, address: string) {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM attempts WHERE expiresAt <= ?').run(this.now());
      const key = digest(`${scope}:${address}`);
      const previous = this.db.prepare<[string], { count: number }>('SELECT count FROM attempts WHERE key = ?').get(key);
      if (previous && previous.count >= 10) throw new AccessError(429, '尝试过于频繁，请一分钟后再试');
      this.db.prepare('INSERT INTO attempts VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = count + 1').run(key, this.now() + 60000);
    })();
  }

  private newSession(deviceName: string) {
    this.db.prepare('DELETE FROM sessions WHERE expiresAt <= ?').run(this.now());
    const token = newSecret();
    const session = { id: randomUUID(), tokenHash: digest(token), deviceName, createdAt: this.now(), expiresAt: this.now() + 30 * 86400000 };
    this.db.prepare('INSERT INTO sessions VALUES (@id, @tokenHash, @deviceName, @createdAt, @expiresAt)').run(session);
    return { token, ...this.home(token) };
  }

  async setup(input: SetupInput) {
    if (this.family()) throw new AccessError(409, '家庭资料库已初始化，请登录');
    if (digest(input.setupCode) !== digest(readFileSync(this.setupPath, 'utf8').trim())) throw new AccessError(401, '设置码不正确');
    const passwordHash = await hashPassword(input.password);
    const recoveryCode = newSecret();
    const result = this.db.transaction(() => {
      if (this.family()) throw new AccessError(409, '家庭资料库已初始化，请登录');
      this.db.prepare('INSERT INTO family VALUES (1, ?, ?, ?, ?, ?, ?, ?)').run(
        randomUUID(), randomUUID(), input.learnerName.trim(), randomUUID(), input.username.trim(), passwordHash, digest(recoveryCode)
      );
      return { ...this.newSession(input.deviceName.trim()), recoveryCode };
    })();
    // A leftover provisioning file cannot initialize an existing library again.
    try { rmSync(this.setupPath, { force: true }); } catch { /* Safe to remove during maintenance. */ }
    return result;
  }

  private session(token: string) {
    const session = this.db.prepare<[string, number], Session>('SELECT * FROM sessions WHERE tokenHash = ? AND expiresAt > ?').get(digest(token), this.now());
    if (!session) throw new AccessError(401, '请重新登录此设备');
    return session;
  }

  async login(input: LoginInput) {
    const family = this.family();
    // Use a real-cost dummy hash for unknown accounts, too.
    const expected = family?.passwordHash ?? `${'0'.repeat(32)}:${'0'.repeat(64)}`;
    const verified = await verifyPassword(input.password, expected);
    return this.db.transaction(() => {
      if (!family || !verified || family.username !== input.username.trim() || this.family()?.passwordHash !== expected) {
        throw new AccessError(401, '账号或密码不正确');
      }
      return this.newSession(input.deviceName.trim());
    })();
  }

  logout(token: string) {
    const session = this.session(token);
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(session.id);
  }

  async unlock(token: string, password: string) {
    this.session(token);
    const expected = this.family()!.passwordHash;
    const verified = await verifyPassword(password, expected);
    return this.db.transaction(() => {
      const session = this.session(token);
      if (!verified || this.family()?.passwordHash !== expected) throw new AccessError(403, '家长密码不正确');
      const grant = { token: newSecret(), expiresAt: this.now() + 5 * 60000 };
      this.db.prepare('DELETE FROM parentGrants WHERE sessionId = ? OR expiresAt <= ?').run(session.id, this.now());
      this.db.prepare('INSERT INTO parentGrants VALUES (?, ?, ?)').run(digest(grant.token), session.id, grant.expiresAt);
      return grant;
    })();
  }

  private parent(token: string, grant: string) {
    const session = this.session(token);
    const valid = this.db.prepare('SELECT 1 FROM parentGrants WHERE tokenHash = ? AND sessionId = ? AND expiresAt > ?').get(digest(grant), session.id, this.now());
    if (!valid) throw new AccessError(403, '请先验证家长身份');
    return session;
  }

  lock(token: string, grant: string) {
    this.parent(token, grant);
    this.db.prepare('DELETE FROM parentGrants WHERE tokenHash = ?').run(digest(grant));
  }

  devices(token: string, grant: string): Device[] {
    const current = this.parent(token, grant);
    return this.db.prepare<[number], Session>('SELECT * FROM sessions WHERE expiresAt > ? ORDER BY createdAt, id').all(this.now())
      .map(({ id, deviceName, createdAt, expiresAt }) => ({ id, deviceName, createdAt, expiresAt, current: id === current.id }));
  }

  revoke(token: string, grant: string, id: string) {
    this.parent(token, grant);
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }

  rotateRecoveryCode(token: string, grant: string) {
    return this.db.transaction(() => {
      const session = this.parent(token, grant);
      const recoveryCode = newSecret();
      this.db.prepare('UPDATE family SET recoveryHash = ? WHERE singleton = 1').run(digest(recoveryCode));
      this.db.prepare('DELETE FROM parentGrants WHERE sessionId = ?').run(session.id);
      return { recoveryCode };
    })();
  }

  async recover(input: RecoveryInput) {
    const family = this.family();
    const expected = digest(input.recoveryCode.trim());
    if (!family || family.recoveryHash !== expected) throw new AccessError(401, '恢复码不正确或已失效');
    const passwordHash = await hashPassword(input.newPassword);
    const recoveryCode = newSecret();
    return this.db.transaction(() => {
      // Check again after hashing: a recovery code is single-use even under concurrent requests.
      if (this.family()?.recoveryHash !== expected) throw new AccessError(401, '恢复码不正确或已失效');
      this.db.prepare('UPDATE family SET passwordHash = ?, recoveryHash = ? WHERE singleton = 1').run(passwordHash, digest(recoveryCode));
      this.db.prepare('DELETE FROM sessions').run();
      return { ...this.newSession(input.deviceName.trim()), recoveryCode };
    })();
  }

  home(token: string): Home {
    const session = this.session(token);
    const family = this.family();
    if (!family) throw new AccessError(401, '请先初始化家庭资料库');
    return {
      library: { id: family.libraryId, learnerId: family.learnerId, learnerName: family.learnerName },
      account: { id: family.accountId, username: family.username },
      session: { id: session.id, deviceName: session.deviceName, expiresAt: session.expiresAt }
    };
  }
}
