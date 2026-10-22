import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { familyFixture, auth, password } from './fixture.ts';
import { createApp } from '../../src/server/app.ts';

const endpoint = '/api/v1/admin/backups', exec = promisify(execFile);
async function parent(app: ReturnType<typeof createApp>, token: string) {
  const grant = await app.inject({ method: 'POST', url: '/api/v1/admin/grants', headers: auth(token), payload: { password } });
  assert.equal(grant.statusCode, 201, grant.body);
  return auth(token, grant.json().token);
}
async function backup(app: ReturnType<typeof createApp>, headers: ReturnType<typeof auth>) {
  const id = randomUUID();
  const state = (await app.inject({ url: endpoint, headers })).json();
  const started = await app.inject({ method: 'PUT', url: `${endpoint}/runs/${id}`, headers, payload: { expectedRevision: state.revision } });
  assert.equal(started.statusCode, 202, started.body);
  for (let i = 0; i < 500; i++) {
    const result = (await app.inject({ url: endpoint, headers })).json();
    if (result.latest.id === id && !['checking', 'running', 'pruning'].includes(result.automatic.status)) {
      assert.equal(result.latest.status, 'succeeded', result.latest.message);
      return result;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw Error('Backup did not settle');
}

test('恢复副本并发配置仅接受一个修订；恢复标记移除失败时暂停，重试不重复递增', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = await familyFixture(), area = await mkdtemp(join(tmpdir(), 'klbook-backup-config-'));
  let restored: ReturnType<typeof createApp> | undefined;
  try {
    const directory = join(area, 'original'); await mkdir(directory);
    const headers = await parent(f.app, f.first.token);
    assert.equal((await f.app.inject({ method: 'PUT', url: `${endpoint}/settings`, headers, payload: { directory, expectedRevision: 0 } })).statusCode, 200);
    const first = await backup(f.app, headers), target = join(area, 'restored');
    await exec(process.execPath, [resolve('src/server/backup-cli.ts'), 'restore', '--source', first.latest.path, '--target', target]);
    restored = createApp({ dataDir: target });
    const login = await restored.inject({ method: 'POST', url: '/api/v1/sessions', payload: { username: 'parent', password, deviceName: '配置并发测试' } });
    const restoredHeaders = await parent(restored, login.json().token);
    const candidates = Array.from({ length: 12 }, (_, i) => join(area, `candidate-${i}`));
    await Promise.all(candidates.map(path => mkdir(path)));
    const results = await Promise.all(candidates.map(directory => restored!.inject({ method: 'PUT', url: `${endpoint}/settings`, headers: restoredHeaders, payload: { directory, expectedRevision: 1 } })));
    assert.equal(results.filter(result => result.statusCode === 200).length, 1, results.map(result => result.statusCode).join(','));
    assert.equal(results.filter(result => result.statusCode === 409).length, 11);
    const state = (await restored.inject({ url: endpoint, headers: restoredHeaders })).json();
    assert.equal(state.revision, 2);
    assert.equal(state.directory, candidates[results.findIndex(result => result.statusCode === 200)]);
    // A real filesystem error must not enable backup to the original directory or lose the committed setting.
    const marker = join(target, 'backup-restore.json'); await mkdir(marker);
    const next = join(area, 'after-error'); await mkdir(next);
    const save = () => restored!.inject({ method: 'PUT', url: `${endpoint}/settings`, headers: restoredHeaders, payload: { directory: next, expectedRevision: 2 } });
    assert.equal((await save()).statusCode, 422);
    const paused = (await restored.inject({ url: endpoint, headers: restoredHeaders })).json();
    assert.equal(paused.directory, next); assert.equal(paused.revision, 3); assert.equal(paused.automatic.enabled, false);
    t.mock.timers.tick(60_000);
    assert.deepEqual(await readdir(next), []);
    await rm(marker, { recursive: true }); await writeFile(marker, '{}');
    const retried = await save();
    assert.equal(retried.statusCode, 200, retried.body);
    assert.equal(retried.json().revision, 3); assert.equal(retried.json().automatic.enabled, true);
    assert.equal((await backup(restored, restoredHeaders)).successful.length, 1);
    assert.equal(JSON.parse((await exec(process.execPath, [resolve('src/server/backup-cli.ts'), 'verify', '--source', first.latest.path])).stdout).status, 'verified');
  } finally { await restored?.close(); await f.close(); await rm(area, { recursive: true, force: true }); }
});

test('无图片资料库保留七份；旧备份占用导致部分清理后退出成功列表，重启解锁后可续清理', { skip: process.platform !== 'win32' }, async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = await familyFixture(), area = await mkdtemp(join(tmpdir(), 'klbook-backup-locked-'));
  let app = f.app, lock: ReturnType<typeof spawn> | undefined, exited: Promise<unknown> | undefined;
  try {
    let headers = await parent(app, f.first.token);
    await app.inject({ method: 'PUT', url: `${endpoint}/settings`, headers, payload: { directory: area, expectedRevision: 0 } });
    const first = await backup(app, headers);
    for (let i = 1; i < 8; i++) await backup(app, headers);
    const rotated = (await app.inject({ url: endpoint, headers })).json();
    assert.equal(rotated.successful.length, 7, rotated.automatic.cleanupMessage);
    await assert.rejects(readFile(join(first.latest.path, 'complete.json')), { code: 'ENOENT' });
    const oldest = rotated.successful.at(-1);
    // Allow reads for verification, but deny deleting the manifest during actual retention.
    lock = spawn('powershell.exe', ['-NoProfile', '-Command', '$handle = [IO.File]::Open($env:KLBOOK_TEST_LOCK_FILE, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read); try { [Console]::WriteLine("READY"); [Console]::ReadLine() | Out-Null } finally { $handle.Dispose() }'], { windowsHide: true, env: { ...process.env, KLBOOK_TEST_LOCK_FILE: join(oldest.path, 'manifest.json') }, stdio: ['pipe', 'pipe', 'pipe'] });
    const child = lock;
    exited = new Promise(resolve => child.once('close', resolve));
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error('File lock did not start')), 10000);
      child.stdout!.once('data', data => { clearTimeout(timeout); if (String(data).includes('READY')) resolve(); else reject(Error('Unexpected file lock output')); });
      child.once('error', error => { clearTimeout(timeout); reject(error); });
    });
    const partial = await backup(app, headers);
    assert.equal(partial.successful.length, 7);
    assert.ok(!partial.successful.some((job: { id: string }) => job.id === oldest.id));
    assert.match(partial.automatic.cleanupMessage, /下次成功备份/);
    await assert.rejects(readFile(join(oldest.path, 'complete.json')), { code: 'ENOENT' });
    const retired = (await app.inject({ url: `${endpoint}/runs/${oldest.id}`, headers })).json();
    assert.ok(retired.retiredAt); assert.equal(retired.removedAt, null);
    await app.close();
    child.stdin!.end('\n'); await exited; lock = undefined;
    app = createApp({ dataDir: f.dataDir }); headers = await parent(app, f.first.token);
    const retried = await backup(app, headers);
    assert.equal(retried.successful.length, 7); assert.equal(retried.automatic.cleanupMessage, '');
    await assert.rejects(readdir(oldest.path), { code: 'ENOENT' });
    assert.ok((await app.inject({ url: `${endpoint}/runs/${oldest.id}`, headers })).json().removedAt);
    assert.equal((await readdir(area)).length, 7);
    assert.equal(JSON.parse((await exec(process.execPath, [resolve('src/server/backup-cli.ts'), 'verify', '--source', retried.lastSuccess.path])).stdout).status, 'verified');
  } finally { lock?.stdin!.end('\n'); await exited; if (app !== f.app) await app.close(); await f.close(); await rm(area, { recursive: true, force: true }); }
});
