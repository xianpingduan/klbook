import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { familyFixture, auth, password } from './fixture.ts';
import { createApp } from '../../src/server/app.ts';

const root = '/api/v1/admin/backups', exec = promisify(execFile);
async function parent(app: ReturnType<typeof createApp>, token: string) {
  const response = await app.inject({ method: 'POST', url: '/api/v1/admin/grants', headers: auth(token), payload: { password } });
  assert.equal(response.statusCode, 201, response.body);
  return auth(token, response.json().token);
}
async function settled(app: ReturnType<typeof createApp>, headers: ReturnType<typeof auth>, checkedAt: number) {
  for (let i = 0; i < 500; i++) {
    const response = await app.inject({ url: root, headers });
    assert.equal(response.statusCode, 200, response.body);
    const settings = response.json();
    if (settings.automatic?.lastCheckedAt === checkedAt && !['checking', 'running', 'pruning'].includes(settings.automatic.status) && settings.latest?.status !== 'running') return settings;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw Error('Scheduled backup did not finish checking');
}

test('按日自动备份有变化的资料，无变化及重新登录不重复；自动备份可恢复登录并保留原图', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = await familyFixture(), directory = await mkdtemp(join(tmpdir(), 'klbook-daily-'));
  let restored: ReturnType<typeof createApp> | undefined;
  let now = new Date(2027, 0, 10, 12).getTime(); f.setTime(now);
  try {
    const currentToken = (await f.login('自动备份验证')).json().token;
    let headers = await parent(f.app, currentToken);
    const bytes = await sharp({ create: { width: 80, height: 100, channels: 3, background: 'white' } }).png().toBuffer();
    const draft = (await f.app.inject({ method: 'POST', url: '/api/v1/collection/drafts', headers: { ...auth(currentToken), 'content-type': 'image/png', 'idempotency-key': randomUUID() }, payload: bytes })).json();
    const configured = await f.app.inject({ method: 'PUT', url: `${root}/settings`, headers, payload: { directory, expectedRevision: 0 } });
    assert.equal(configured.statusCode, 200, configured.body);
    assert.equal(configured.json().automatic?.enabled, true);
    t.mock.timers.tick(60_000);
    const first = await settled(f.app, headers, now);
    assert.equal(first.lastSuccess.trigger, 'automatic');
    assert.equal(first.automatic.status, 'succeeded');
    now = new Date(2027, 0, 11, 12).getTime(); f.setTime(now);
    assert.equal((await f.login('第二个设备')).statusCode, 201);
    headers = await parent(f.app, currentToken);
    t.mock.timers.tick(60_000);
    const unchanged = await settled(f.app, headers, now);
    assert.equal(unchanged.automatic.status, 'unchanged');
    assert.equal(unchanged.lastSuccess.id, first.lastSuccess.id);
    assert.equal((await readdir(directory)).length, 1);
    const target = join(directory, 'restored');
    await exec(process.execPath, [resolve('src/server/backup-cli.ts'), 'restore', '--source', first.lastSuccess.path, '--target', target, '--with-system']);
    restored = createApp({ dataDir: target, now: () => new Date(2027, 0, 20, 12).getTime() });
    const login = await restored.inject({ method: 'POST', url: '/api/v1/sessions', payload: { username: 'parent', password, deviceName: '自动备份恢复验收' } });
    assert.equal(login.statusCode, 201, login.body);
    const token = login.json().token, restoredHeaders = await parent(restored, token);
    assert.deepEqual((await restored.inject({ url: `/api/v1/collection/pages/${draft.originalPage.id}/original`, headers: auth(token) })).rawPayload, bytes);
    assert.equal((await restored.inject({ url: root, headers: restoredHeaders })).json().automatic.enabled, false);
    t.mock.timers.tick(60_000);
    assert.equal((await restored.inject({ method: 'PUT', url: `${root}/runs/${randomUUID()}`, headers: restoredHeaders, payload: { expectedRevision: 1 } })).statusCode, 422);
    assert.equal((await restored.inject({ method: 'PUT', url: `${root}/settings`, headers: restoredHeaders, payload: { directory, expectedRevision: 1 } })).statusCode, 422);
    assert.equal((await readdir(directory)).length, 2); // One original backup plus the isolated restore directory.
  } finally { await restored?.close(); await f.close(); await rm(directory, { recursive: true, force: true }); }
});

test('新成功备份校验后只保留七份受管理备份，不删除目录内的其他文件或伪同名备份', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = await familyFixture(), directory = await mkdtemp(join(tmpdir(), 'klbook-retention-'));
  let now = new Date(2027, 1, 1, 12).getTime(); f.setTime(now);
  const token = (await f.login('轮换验证')).json().token;
  const created: { id: string; path: string }[] = [];
  try {
    let headers = await parent(f.app, token);
    await f.app.inject({ method: 'PUT', url: `${root}/settings`, headers, payload: { directory, expectedRevision: 0 } });
    const foreign = join(directory, `klbook-backup-${randomUUID()}`);
    await mkdir(foreign); await writeFile(join(foreign, 'keep.txt'), 'other family');
    await writeFile(join(directory, 'keep.txt'), 'unrelated file');
    const bytes = await sharp({ create: { width: 30, height: 40, channels: 3, background: 'white' } }).png().toBuffer();
    for (let day = 1; day <= 9; day++) {
      now = new Date(2027, 1, day, 12).getTime(); f.setTime(now);
      headers = await parent(f.app, token);
      const draft = await f.app.inject({ method: 'POST', url: '/api/v1/collection/drafts', headers: { ...auth(token), 'content-type': 'image/png', 'idempotency-key': randomUUID() }, payload: bytes });
      assert.equal(draft.statusCode, 201, draft.body);
      t.mock.timers.tick(60_000);
      const state = await settled(f.app, headers, now);
      assert.equal(state.lastSuccess.trigger, 'automatic');
      assert.equal(state.latest.status, 'succeeded', state.latest.message);
      created.push(state.lastSuccess);
    }
    const state = (await f.app.inject({ url: root, headers })).json();
    assert.equal(state.successful.length, 7, state.automatic.cleanupMessage);
    assert.deepEqual(state.successful.map((job: { id: string }) => job.id), created.slice(2).reverse().map(job => job.id));
    assert.equal(await readFile(join(foreign, 'keep.txt'), 'utf8'), 'other family');
    assert.equal(await readFile(join(directory, 'keep.txt'), 'utf8'), 'unrelated file');
    await assert.rejects(readFile(join(created[0]!.path, 'complete.json')), { code: 'ENOENT' });
    assert.equal((await f.app.inject({ url: `${root}/runs/${created[0]!.id}`, headers })).json().removedAt !== null, true);
    for (const job of created.slice(2)) assert.equal(JSON.parse((await exec(process.execPath, [resolve('src/server/backup-cli.ts'), 'verify', '--source', job.path])).stdout).status, 'verified');
    const extra = join(created[2]!.path, 'parent-notes.txt');
    await writeFile(extra, 'keep my notes');
    now = new Date(2027, 1, 10, 12).getTime(); f.setTime(now); headers = await parent(f.app, token);
    await f.app.inject({ method: 'POST', url: '/api/v1/collection/drafts', headers: { ...auth(token), 'content-type': 'image/png', 'idempotency-key': randomUUID() }, payload: bytes });
    t.mock.timers.tick(60_000);
    const protectedState = await settled(f.app, headers, now);
    assert.equal(protectedState.latest.status, 'succeeded');
    assert.equal(protectedState.successful.length, 8);
    assert.match(protectedState.automatic.cleanupMessage, /其他文件/);
    assert.equal(await readFile(extra, 'utf8'), 'keep my notes');
    assert.equal(JSON.parse((await exec(process.execPath, [resolve('src/server/backup-cli.ts'), 'verify', '--source', created[2]!.path])).stdout).status, 'verified');
    await rm(extra);
    now = new Date(2027, 1, 11, 12).getTime(); f.setTime(now); headers = await parent(f.app, token);
    const damaged = (await f.app.inject({ method: 'POST', url: '/api/v1/collection/drafts', headers: { ...auth(token), 'content-type': 'image/png', 'idempotency-key': randomUUID() }, payload: bytes })).json();
    const original = join(f.dataDir, 'attachments/pages', damaged.originalPage.id, 'original');
    await writeFile(original, 'damaged image');
    t.mock.timers.tick(60_000);
    const failed = await settled(f.app, headers, now);
    assert.equal(failed.latest.status, 'failed');
    assert.equal(failed.lastSuccess.id, protectedState.lastSuccess.id);
    assert.equal(failed.successful.length, 8);
    assert.equal(JSON.parse((await exec(process.execPath, [resolve('src/server/backup-cli.ts'), 'verify', '--source', created[2]!.path])).stdout).status, 'verified');
    await writeFile(original, bytes);
    now += 60 * 60_000; f.setTime(now); headers = await parent(f.app, token);
    t.mock.timers.tick(60_000);
    const repaired = await settled(f.app, headers, now);
    assert.equal(repaired.latest.status, 'succeeded', repaired.latest.message);
    assert.equal(repaired.successful.length, 7);
    assert.equal(repaired.automatic.cleanupMessage, '');
  } finally { await f.close(); await rm(directory, { recursive: true, force: true }); }
});

test('当天只检查一次，停机跨日后只补做当前一份；缺盘失败保留成功基准，修复后重试', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = await familyFixture(), directory = await mkdtemp(join(tmpdir(), 'klbook-catchup-'));
  let now = new Date(2027, 2, 1, 12).getTime(); f.setTime(now);
  let app = f.app;
  const token = (await f.login('停机验证')).json().token;
  const bytes = await sharp({ create: { width: 40, height: 50, channels: 3, background: 'white' } }).png().toBuffer();
  const add = () => app.inject({ method: 'POST', url: '/api/v1/collection/drafts', headers: { ...auth(token), 'content-type': 'image/png', 'idempotency-key': randomUUID() }, payload: bytes });
  try {
    let headers = await parent(app, token);
    await app.inject({ method: 'PUT', url: `${root}/settings`, headers, payload: { directory, expectedRevision: 0 } });
    t.mock.timers.tick(60_000);
    const first = await settled(app, headers, now);
    assert.equal(first.latest.status, 'succeeded');
    assert.equal((await add()).statusCode, 201);
    t.mock.timers.tick(60_000);
    assert.equal((await app.inject({ url: root, headers })).json().latest.id, first.latest.id);
    await app.close();
    now = new Date(2027, 2, 5, 12).getTime();
    app = createApp({ dataDir: f.dataDir, now: () => now });
    headers = await parent(app, token);
    const catchup = await settled(app, headers, now);
    assert.equal(catchup.latest.status, 'succeeded');
    assert.equal(catchup.successful.length, 2);
    assert.equal(catchup.lastSuccess.createdAt, now);
    await app.close();
    app = createApp({ dataDir: f.dataDir, now: () => now });
    headers = await parent(app, token);
    assert.equal((await app.inject({ url: root, headers })).json().successful.length, 2);
    assert.equal((await add()).statusCode, 201);
    await rename(directory, `${directory}-offline`);
    try {
      now = new Date(2027, 2, 6, 12).getTime();
      headers = await parent(app, token);
      t.mock.timers.tick(60_000);
      const failed = await settled(app, headers, now);
      assert.equal(failed.latest.status, 'failed');
      assert.match(failed.latest.message, /目标盘|目录/);
      assert.equal(failed.lastSuccess.id, catchup.lastSuccess.id);
      assert.equal(failed.successful.length, 2);
      t.mock.timers.tick(60_000);
      assert.equal((await app.inject({ url: root, headers })).json().latest.id, failed.latest.id);
    } finally { await rename(`${directory}-offline`, directory); }
    now += 60 * 60_000; headers = await parent(app, token);
    t.mock.timers.tick(60_000); t.mock.timers.tick(60_000);
    const retried = await settled(app, headers, now);
    assert.equal(retried.latest.status, 'succeeded', retried.latest.message);
    assert.equal(retried.successful.length, 3);
    assert.equal((await readdir(directory)).length, 3);
  } finally { if (app !== f.app) await app.close(); await f.close(); await rm(directory, { recursive: true, force: true }); }
});

test('自动备份进程中断后保留旧成功备份，重启仅补做一次', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = await familyFixture(), directory = await mkdtemp(join(tmpdir(), 'klbook-auto-interrupt-'));
  let now = new Date(2027, 3, 1, 12).getTime(); f.setTime(now);
  const token = (await f.login('中断验证')).json().token;
  let child: ReturnType<typeof spawn> | undefined, exited: Promise<unknown> | undefined, reopened: ReturnType<typeof createApp> | undefined;
  try {
    let headers = await parent(f.app, token);
    await f.app.inject({ method: 'PUT', url: `${root}/settings`, headers, payload: { directory, expectedRevision: 0 } });
    t.mock.timers.tick(60_000);
    const first = await settled(f.app, headers, now);
    const bytes = await sharp({ create: { width: 80, height: 100, channels: 3, background: 'white' } }).png().toBuffer();
    await f.app.inject({ method: 'POST', url: '/api/v1/collection/drafts', headers: { ...auth(token), 'content-type': 'image/png', 'idempotency-key': randomUUID() }, payload: bytes });
    now = new Date(2027, 3, 2, 12).getTime(); f.setTime(now); headers = await parent(f.app, token);
    await f.app.close();
    const script = `import { createApp } from ${JSON.stringify(pathToFileURL(resolve('src/server/app.ts')).href)};
      const app = createApp({dataDir:process.env.KLBOOK_TEST_DATA, now:()=>Number(process.env.KLBOOK_TEST_NOW)});
      const headers = JSON.parse(process.env.KLBOOK_TEST_HEADERS);
      await app.listen({port:0,host:'127.0.0.1'});
      for(let i=0;i<500;i++) {
        const state=(await app.inject({url:'/api/v1/admin/backups',headers})).json();
        if(state.latest?.trigger==='automatic' && state.latest.status==='running') { console.log(JSON.stringify({running:state.latest.id})); break; }
        await new Promise(resolve=>setTimeout(resolve,2));
      }`;
    child = spawn(process.execPath, ['--input-type=module', '-e', script], { windowsHide: true, env: { ...process.env, KLBOOK_TEST_DATA: f.dataDir, KLBOOK_TEST_NOW: String(now), KLBOOK_TEST_HEADERS: JSON.stringify(headers) }, stdio: ['ignore', 'pipe', 'pipe'] });
    const running = child;
    exited = new Promise(resolve => running.once('close', resolve));
    const interruptedId = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error('Automatic backup not observed running')), 15000);
      let output = '';
      running.stdout!.on('data', data => {
        output += String(data);
        if (!output.includes('\n')) return;
        const event = JSON.parse(output.trim());
        clearTimeout(timeout); running.kill('SIGKILL'); resolve(event.running);
      });
      running.once('error', error => { clearTimeout(timeout); reject(error); });
      running.stderr!.on('data', () => {});
    });
    await exited; child = undefined;
    reopened = createApp({ dataDir: f.dataDir, now: () => now });
    headers = await parent(reopened, token);
    const interrupted = await reopened.inject({ url: `${root}/runs/${interruptedId}`, headers });
    assert.equal(interrupted.json().status, 'failed'); assert.match(interrupted.json().message, /中断/);
    const final = await settled(reopened, headers, now);
    assert.equal(final.latest.status, 'succeeded', final.latest.message);
    assert.equal(final.successful.length, 2);
    assert.equal(JSON.parse((await exec(process.execPath, [resolve('src/server/backup-cli.ts'), 'verify', '--source', first.lastSuccess.path])).stdout).status, 'verified');
    t.mock.timers.tick(60_000);
    assert.equal((await reopened.inject({ url: root, headers })).json().latest.id, final.latest.id);
  } finally { child?.kill('SIGKILL'); await exited; await reopened?.close(); await f.close(); await rm(directory, { recursive: true, force: true }); }
});
