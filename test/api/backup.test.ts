import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, rename, writeFile, stat, mkdir, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { familyFixture, auth, password } from './fixture.ts';
import { createApp } from '../../src/server/app.ts';
import type { Question } from '../../src/shared/collection.ts';

const exec = promisify(execFile), root = '/api/v1/admin/backups';
async function parent(f: Awaited<ReturnType<typeof familyFixture>>) {
  const response = await f.app.inject({ method: 'POST', url: '/api/v1/admin/grants', headers: auth(f.first.token), payload: { password } });
  return auth(f.first.token, response.json().token);
}
async function finished(f: Awaited<ReturnType<typeof familyFixture>>, headers: ReturnType<typeof auth>, id: string) {
  for (let i = 0; i < 500; i++) {
    const response = await f.app.inject({ url: `${root}/runs/${id}`, headers });
    assert.equal(response.statusCode, 200, response.body);
    const job = response.json();
    if (job.status !== 'running') return job;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw Error('Backup timed out');
}
test('家长生成完整备份，恢复到新目录后仍可登录、管理并读取服务器草稿与原图', async () => {
  const f = await familyFixture(), directory = await mkdtemp(join(tmpdir(), 'klbook-backup-test-'));
  let restored: ReturnType<typeof createApp> | undefined;
  try {
    const headers = await parent(f), id = randomUUID();
    assert.equal((await f.app.inject({ url: root })).statusCode, 401);
    assert.equal((await f.app.inject({ url: root, headers: auth(f.first.token) })).statusCode, 403);
    const bytes = await sharp({ create: { width: 80, height: 120, channels: 3, background: 'white' } }).png().toBuffer();
    const draft = (await f.app.inject({ method: 'POST', url: '/api/v1/collection/drafts', headers: { ...auth(f.first.token), 'content-type': 'image/png', 'idempotency-key': randomUUID() }, payload: bytes })).json();
    const configured = await f.app.inject({ method: 'PUT', url: `${root}/settings`, headers, payload: { directory, expectedRevision: 0 } });
    assert.equal(configured.statusCode, 200, configured.body);
    assert.equal(configured.json().revision, 1);
    const started = await f.app.inject({ method: 'PUT', url: `${root}/runs/${id}`, headers, payload: { expectedRevision: 1 } });
    assert.equal(started.statusCode, 202, started.body);
    const job = await finished(f, headers, id);
    assert.equal(job.status, 'succeeded', job.message);
    assert.equal((await f.app.inject({ method: 'PUT', url: `${root}/runs/${id}`, headers, payload: { expectedRevision: 1 } })).json().id, id);
    const target = join(directory, 'restored');
    const { stdout } = await exec(process.execPath, [resolve('src/server/backup-cli.ts'), 'restore', '--source', job.path, '--target', target, '--with-system']);
    assert.equal(JSON.parse(stdout).status, 'restored');
    restored = createApp({ dataDir: target });
    const login = await restored.inject({ method: 'POST', url: '/api/v1/sessions', payload: { username: 'parent', password, deviceName: '恢复演练' } });
    assert.equal(login.statusCode, 201, login.body);
    assert.equal(login.json().library.id, f.first.library.id);
    const token = login.json().token;
    assert.equal((await restored.inject({ method: 'POST', url: '/api/v1/admin/grants', headers: auth(token), payload: { password } })).statusCode, 201);
    const saved = await restored.inject({ url: `/api/v1/collection/questions/${draft.id}`, headers: auth(token) });
    assert.equal(saved.statusCode, 200, saved.body); assert.equal(saved.json().state, 'draft');
    assert.deepEqual((await restored.inject({ url: `/api/v1/collection/pages/${draft.originalPage.id}/original`, headers: auth(token) })).rawPayload, bytes);
    assert.equal((await f.app.inject({ url: root, headers })).json().lastSuccess.id, id);
    assert.ok((await readFile(join(job.path, 'manifest.json'), 'utf8')).includes('klbook-runtime-backup'));
  } finally { await restored?.close(); await f.close(); await rm(directory, { recursive: true, force: true }); }
});

test('目标盘离线及文件损坏明确失败，成功备份保留；恢复拒绝损坏文件和覆盖已有目录', async () => {
  const f = await familyFixture(), directory = await mkdtemp(join(tmpdir(), 'klbook-backup-fault-'));
  try {
    const headers = await parent(f), bytes = await sharp({ create: { width: 100, height: 140, channels: 3, background: 'white' } }).png().toBuffer();
    const draft = (await f.app.inject({ method: 'POST', url: '/api/v1/collection/drafts', headers: { ...auth(f.first.token), 'content-type': 'image/png', 'idempotency-key': randomUUID() }, payload: bytes })).json();
    const configure = (path: string, revision = 0) => f.app.inject({ method: 'PUT', url: `${root}/settings`, headers, payload: { directory: path, expectedRevision: revision } });
    assert.equal((await configure(f.dataDir)).statusCode, 422);
    assert.equal((await configure(join(directory, 'missing'))).statusCode, 422);
    assert.equal((await configure(directory)).statusCode, 200);
    const make = async () => {
      const id = randomUUID();
      assert.equal((await f.app.inject({ method: 'PUT', url: `${root}/runs/${id}`, headers, payload: { expectedRevision: 1 } })).statusCode, 202);
      return finished(f, headers, id);
    };
    const good = await make(); assert.equal(good.status, 'succeeded', good.message);
    await rename(directory, `${directory}-offline`);
    try { const missing = await make(); assert.equal(missing.status, 'failed'); assert.match(missing.message, /目录|目标盘/); }
    finally { await rename(`${directory}-offline`, directory); }
    const original = join(f.dataDir, 'attachments/pages', draft.originalPage.id, 'original');
    await writeFile(original, 'broken');
    const broken = await make(); assert.equal(broken.status, 'failed'); assert.match(broken.message, /校验/);
    assert.equal((await f.app.inject({ url: root, headers })).json().lastSuccess.id, good.id);
    await writeFile(original, bytes);
    assert.equal((await make()).status, 'succeeded');
    const target = join(directory, 'must-not-overwrite');
    await writeFile(target, 'keep');
    await assert.rejects(exec(process.execPath, [resolve('src/server/backup-cli.ts'), 'restore', '--source', good.path, '--target', target, '--with-system']), /不能覆盖/);
    assert.equal(await readFile(target, 'utf8'), 'keep');
    await writeFile(join(good.path, 'data/attachments/pages', draft.originalPage.id, 'original'), 'corrupt backup');
    await assert.rejects(exec(process.execPath, [resolve('src/server/backup-cli.ts'), 'restore', '--source', good.path, '--target', join(directory, 'invalid'), '--with-system']), /校验失败/);
    assert.equal(await stat(join(directory, 'invalid')).then(() => true, () => false), false);
  } finally { await f.close(); await rm(directory, { recursive: true, force: true }); }
});

test('受保护服务密钥单独保存，恢复后仍可解密配置，缺少配套密钥的备份拒绝恢复', async () => {
  let calls = 0;
  const f = await familyFixture({ ocrHttp: async () => { calls++; throw Error('No supplier calls during backup'); } });
  const directory = await mkdtemp(join(tmpdir(), 'klbook-backup-system-'));
  let restored: ReturnType<typeof createApp> | undefined;
  try {
    const headers = await parent(f);
    const config = { provider: 'baidu', name: '保留的识别配置', enabled: false, language: 'CHN_ENG', handwriting: true, formulas: false, timeoutSeconds: 10, retries: 0, monthlyLimit: 300, monthlyBudgetCents: 5000, priceCents: 16 };
    const saved = await f.app.inject({ method: 'PUT', url: '/api/v1/admin/ocr', headers, payload: { operationId: randomUUID(), expectedRevision: 0, config, credentials: { apiKey: 'synthetic-key', secretKey: 'synthetic-secret' } } });
    assert.equal(saved.statusCode, 200, saved.body);
    await f.app.inject({ method: 'PUT', url: `${root}/settings`, headers, payload: { directory, expectedRevision: 0 } });
    const id = randomUUID();
    await f.app.inject({ method: 'PUT', url: `${root}/runs/${id}`, headers, payload: { expectedRevision: 1 } });
    const job = await finished(f, headers, id); assert.equal(job.status, 'succeeded', job.message);
    assert.equal(await stat(join(job.path, 'data/service-credentials.key')).then(() => true, () => false), false);
    await assert.rejects(exec(process.execPath, [resolve('src/server/backup-cli.ts'), 'restore', '--source', job.path, '--target', join(directory, 'unconfirmed')]), /with-system/);
    const target = join(directory, 'restored');
    await exec(process.execPath, [resolve('src/server/backup-cli.ts'), 'restore', '--source', job.path, '--target', target, '--with-system']);
    restored = createApp({ dataDir: target, ocrHttp: async () => { calls++; throw Error('No external calls'); } });
    const login = (await restored.inject({ method: 'POST', url: '/api/v1/sessions', payload: { username: 'parent', password, deviceName: '恢复配置' } })).json();
    const grant = (await restored.inject({ method: 'POST', url: '/api/v1/admin/grants', headers: auth(login.token), payload: { password } })).json();
    const settings = (await restored.inject({ url: '/api/v1/admin/ocr', headers: auth(login.token, grant.token) })).json();
    assert.equal(settings.credentialAvailable, true); assert.deepEqual(settings.config, saved.json().config);
    assert.equal(calls, 0);
    const manifestPath = join(job.path, 'manifest.json'), manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.files = manifest.files.filter((file: { path: string }) => file.path !== 'system/service-credentials.key');
    const bytes = Buffer.from(JSON.stringify(manifest));
    await writeFile(manifestPath, bytes);
    await writeFile(join(job.path, 'complete.json'), JSON.stringify({ manifestSha256: createHash('sha256').update(bytes).digest('hex') }));
    await assert.rejects(exec(process.execPath, [resolve('src/server/backup-cli.ts'), 'verify', '--source', job.path]), /密钥/);
  } finally { await restored?.close(); await f.close(); await rm(directory, { recursive: true, force: true }); }
});

test('恢复保留跨页、答案、共享原文、手动更正、学习阶段、回收站和导入身份，重复导入仍跳过', async () => {
  const source = await familyFixture(), f = await familyFixture(), directory = await mkdtemp(join(tmpdir(), 'klbook-backup-material-'));
  let restored: ReturnType<typeof createApp> | undefined;
  const whole = { x: 0, y: 0, width: 1, height: 1 };
  try {
    const bytes = await sharp({ create: { width: 100, height: 140, channels: 3, background: 'white' } }).png().toBuffer();
    const sourceParent = await parent(source), headers = await parent(f);
    const makeDraft = async (family: typeof f) => {
      const response = await family.app.inject({ method: 'POST', url: '/api/v1/collection/drafts', headers: { ...auth(family.first.token), 'content-type': 'image/png', 'idempotency-key': randomUUID() }, payload: bytes });
      assert.equal(response.statusCode, 201, response.body); return response.json<Question>();
    };
    const fields = { state: 'collected', subjectId: 'math', region: whole, sourceId: null, pageNumber: '3', questionNumber: '2', note: '完整备份保留备注', studyStage: { schoolYear: '2025-2026', grade: '四年级', term: 'second' } };
    const incoming = await makeDraft(source);
    await source.app.inject({ method: 'PUT', url: `/api/v1/collection/questions/${incoming.id}`, headers: sourceParent, payload: { ...fields, expectedRevision: 1, operationId: randomUUID() } });
    const preview = (await source.app.inject({ url: '/api/v1/admin/exports', headers: sourceParent })).json(), exportId = randomUUID();
    await source.app.inject({ method: 'PUT', url: `/api/v1/admin/exports/${exportId}`, headers: sourceParent, payload: { previewToken: preview.token } });
    for (let i = 0; i < 200; i++) {
      if ((await source.app.inject({ url: `/api/v1/admin/exports/${exportId}`, headers: sourceParent })).json().status === 'ready') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const pack = (await source.app.inject({ url: `/api/v1/admin/exports/${exportId}/file`, headers: sourceParent })).rawPayload;
    const importId = randomUUID(), imported = await f.app.inject({ method: 'PUT', url: `/api/v1/admin/imports/${importId}`, headers: { ...headers, 'content-type': 'application/zip' }, payload: pack });
    assert.equal(imported.statusCode, 200, imported.body);
    const receipt = await f.app.inject({ method: 'POST', url: `/api/v1/admin/imports/${importId}/confirm`, headers, payload: { previewToken: imported.json().token } });
    assert.equal(receipt.statusCode, 200, receipt.body);
    const importedId = receipt.json().questionIds[0];
    const draft = await makeDraft(f), extra = await makeDraft(f), removed = await makeDraft(f), readingId = randomUUID();
    const reading = await f.app.inject({ method: 'PUT', url: `/api/v1/collection/reading-materials/${readingId}`, headers, payload: { operationId: randomUUID(), expectedRevision: 0, title: '共同原文', parts: [{ id: randomUUID(), pageId: extra.originalPage.id, region: whole }] } });
    assert.equal(reading.statusCode, 200, reading.body);
    const changed = await f.app.inject({ method: 'PUT', url: `/api/v1/collection/questions/${draft.id}`, headers, payload: { ...fields, expectedRevision: 1, operationId: randomUUID(), readingMaterialId: readingId,
      parts: [{ id: randomUUID(), pageId: extra.originalPage.id, region: whole, transcription: '第二页在前' }, { id: draft.parts[0]!.id, pageId: draft.originalPage.id, region: whole, transcription: '已手动更正 12 × 3' }] } });
    assert.equal(changed.statusCode, 200, changed.body);
    const answer = await f.app.inject({ method: 'PUT', url: `/api/v1/collection/questions/${draft.id}/answers`, headers, payload: { operationId: randomUUID(), expectedRevision: changed.json().revision, parts: [{ id: randomUUID(), pageId: extra.originalPage.id, region: whole }] } });
    assert.equal(answer.statusCode, 200, answer.body);
    const trash = await f.app.inject({ method: 'PUT', url: `/api/v1/admin/trash/${removed.id}`, headers, payload: { action: 'trash', operationId: randomUUID(), expectedRevision: 1 } });
    assert.equal(trash.statusCode, 200, trash.body);
    const before = await Promise.all([draft.id, importedId].map(async id => (await f.app.inject({ url: `/api/v1/collection/questions/${id}`, headers })).json()));
    const trashBefore = (await f.app.inject({ url: '/api/v1/admin/trash', headers })).json();
    await f.app.inject({ method: 'PUT', url: `${root}/settings`, headers, payload: { directory, expectedRevision: 0 } });
    const id = randomUUID();
    await f.app.inject({ method: 'PUT', url: `${root}/runs/${id}`, headers, payload: { expectedRevision: 1 } });
    const job = await finished(f, headers, id); assert.equal(job.status, 'succeeded', job.message);
    const target = join(directory, 'restored');
    await exec(process.execPath, [resolve('src/server/backup-cli.ts'), 'restore', '--source', job.path, '--target', target, '--with-system']);
    restored = createApp({ dataDir: target });
    const login = (await restored.inject({ method: 'POST', url: '/api/v1/sessions', payload: { username: 'parent', password, deviceName: '验收恢复' } })).json();
    const grant = (await restored.inject({ method: 'POST', url: '/api/v1/admin/grants', headers: auth(login.token), payload: { password } })).json();
    const restoredHeaders = auth(login.token, grant.token);
    for (const q of before) assert.deepEqual((await restored.inject({ url: `/api/v1/collection/questions/${q.id}`, headers: restoredHeaders })).json(), q);
    assert.deepEqual((await restored.inject({ url: '/api/v1/admin/trash', headers: restoredHeaders })).json(), trashBefore);
    const again = await restored.inject({ method: 'PUT', url: `/api/v1/admin/imports/${randomUUID()}`, headers: { ...restoredHeaders, 'content-type': 'application/zip' }, payload: pack });
    assert.equal(again.statusCode, 200, again.body); assert.equal(again.json().skipped, 1); assert.equal(again.json().conflicts, 0);
    const oldReceipt = await restored.inject({ method: 'POST', url: `/api/v1/admin/imports/${importId}/confirm`, headers: restoredHeaders, payload: { previewToken: imported.json().token } });
    assert.deepEqual(oldReceipt.json(), receipt.json());
  } finally { await restored?.close(); await source.close(); await f.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Windows 无写权限目录和目录联接被拒绝，重新授权后可正常设置', { skip: process.platform !== 'win32' }, async () => {
  const f = await familyFixture(), rootDir = await mkdtemp(join(tmpdir(), 'klbook-backup-acl-'));
  const target = join(rootDir, 'target'), link = join(rootDir, 'link');
  const { stdout } = await exec('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true });
  const sid = stdout.match(/S-1-(?:\d+-)*\d+/)![0];
  try {
    await mkdir(target); await symlink(target, link, 'junction');
    const headers = await parent(f);
    const configure = (directory: string) => f.app.inject({ method: 'PUT', url: `${root}/settings`, headers, payload: { directory, expectedRevision: 0 } });
    assert.equal((await configure(link)).statusCode, 422);
    await exec('icacls.exe', [target, '/deny', `*${sid}:(WD,AD)`], { windowsHide: true });
    assert.equal((await configure(target)).statusCode, 422);
    await exec('icacls.exe', [target, '/remove:d', `*${sid}`], { windowsHide: true });
    assert.equal((await configure(target)).statusCode, 200);
  } finally {
    await exec('icacls.exe', [target, '/remove:d', `*${sid}`], { windowsHide: true }).catch(() => {});
    await f.close(); await rm(rootDir, { recursive: true, force: true });
  }
});

test('备份从只读介质恢复，校验不要求修改备份目录', { skip: process.platform !== 'win32' }, async () => {
  const f = await familyFixture(), directory = await mkdtemp(join(tmpdir(), 'klbook-backup-readonly-'));
  let backupPath: string | undefined;
  const { stdout } = await exec('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true });
  const sid = stdout.match(/S-1-(?:\d+-)*\d+/)![0];
  try {
    const headers = await parent(f);
    await f.app.inject({ method: 'PUT', url: `${root}/settings`, headers, payload: { directory, expectedRevision: 0 } });
    const id = randomUUID();
    await f.app.inject({ method: 'PUT', url: `${root}/runs/${id}`, headers, payload: { expectedRevision: 1 } });
    const job = await finished(f, headers, id); assert.equal(job.status, 'succeeded', job.message); backupPath = job.path;
    await exec('icacls.exe', [job.path, '/deny', `*${sid}:(OI)(CI)(WD,AD)`], { windowsHide: true });
    const result = await exec(process.execPath, [resolve('src/server/backup-cli.ts'), 'restore', '--source', job.path, '--target', join(directory, 'restored'), '--with-system']);
    assert.equal(JSON.parse(result.stdout).status, 'restored');
  } finally {
    if (backupPath) await exec('icacls.exe', [backupPath, '/remove:d', `*${sid}`], { windowsHide: true }).catch(() => {});
    await f.close(); await rm(directory, { recursive: true, force: true });
  }
});

test('备份进程被终止后重启报告中断，原成功备份保留且可再次生成', async () => {
  const f = await familyFixture(), directory = await mkdtemp(join(tmpdir(), 'klbook-backup-interrupt-'));
  let child: ReturnType<typeof spawn> | undefined, closed: Promise<unknown> | undefined, reopened: ReturnType<typeof createApp> | undefined;
  try {
    const headers = await parent(f);
    await f.app.inject({ method: 'PUT', url: `${root}/settings`, headers, payload: { directory, expectedRevision: 0 } });
    const goodId = randomUUID();
    await f.app.inject({ method: 'PUT', url: `${root}/runs/${goodId}`, headers, payload: { expectedRevision: 1 } });
    const good = await finished(f, headers, goodId); assert.equal(good.status, 'succeeded', good.message);
    await f.app.close();
    child = spawn(process.execPath, ['src/server/main.ts'], { windowsHide: true, env: { ...process.env, KLBOOK_DATA_DIR: f.dataDir, KLBOOK_PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const running = child;
    closed = new Promise(resolve => running.once('close', resolve));
    const address = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Start timed out')), 10000);
      running.once('error', error => { clearTimeout(timer); reject(error); });
      running.stdout!.on('data', data => {
        const match = /KLBOOK_LISTENING=(http:\/\/127.0.0.1:\d+)/.exec(String(data));
        if (match) { clearTimeout(timer); resolve(match[1]!); }
      });
      running.stderr!.on('data', () => {});
    });
    const id = randomUUID();
    const result = await fetch(`${address}${root}/runs/${id}`, { method: 'PUT', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: 1 }) });
    assert.equal(result.status, 202); assert.equal((await result.json() as { status: string }).status, 'running');
    running.kill('SIGKILL'); await closed; child = undefined;
    reopened = createApp({ dataDir: f.dataDir });
    const settings = (await reopened.inject({ url: root, headers })).json();
    assert.equal(settings.latest.status, 'failed'); assert.match(settings.latest.message, /中断/); assert.equal(settings.lastSuccess.id, goodId);
    assert.equal(JSON.parse((await exec(process.execPath, [resolve('src/server/backup-cli.ts'), 'verify', '--source', good.path])).stdout).status, 'verified');
    const nextId = randomUUID();
    assert.equal((await reopened.inject({ method: 'PUT', url: `${root}/runs/${nextId}`, headers, payload: { expectedRevision: 1 } })).statusCode, 202);
    const next = await finished({ ...f, app: reopened }, headers, nextId); assert.equal(next.status, 'succeeded', next.message);
  } finally {
    child?.kill('SIGKILL'); await closed; await reopened?.close(); await f.close(); await rm(directory, { recursive: true, force: true });
  }
});

test('快照完成后永久删除源题目，清理仍保护这次备份引用的附件', async () => {
  const f = await familyFixture(), directory = await mkdtemp(join(tmpdir(), 'klbook-backup-concurrent-'));
  let restored: ReturnType<typeof createApp> | undefined;
  try {
    const headers = await parent(f), bytes = await sharp({ create: { width: 80, height: 100, channels: 3, background: 'white' } }).png().toBuffer();
    let last: Question | undefined;
    for (let i = 0; i < 25; i++) last = (await f.app.inject({ method: 'POST', url: '/api/v1/collection/drafts', headers: { ...auth(f.first.token), 'content-type': 'image/png', 'idempotency-key': randomUUID() }, payload: bytes })).json<Question>();
    await f.app.inject({ method: 'PUT', url: `${root}/settings`, headers, payload: { directory, expectedRevision: 0 } });
    const id = randomUUID();
    await f.app.inject({ method: 'PUT', url: `${root}/runs/${id}`, headers, payload: { expectedRevision: 1 } });
    let copying = false;
    for (let i = 0; i < 300; i++) {
      const status = (await f.app.inject({ url: `${root}/runs/${id}`, headers })).json();
      if (status.message === '正在复制并校验附件') { copying = true; break; }
      if (status.status !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    assert.equal(copying, true, '应能观察到快照完成后的复制阶段');
    assert.equal((await f.app.inject({ method: 'PUT', url: `/api/v1/admin/trash/${last!.id}`, headers, payload: { action: 'trash', operationId: randomUUID(), expectedRevision: 1 } })).statusCode, 200);
    assert.equal((await f.app.inject({ method: 'PUT', url: `/api/v1/admin/trash/${last!.id}`, headers, payload: { action: 'purge', confirm: true, operationId: randomUUID(), expectedRevision: 2 } })).statusCode, 200);
    await f.app.inject({ method: 'POST', url: '/api/v1/admin/trash/cleanup', headers });
    const job = await finished(f, headers, id); assert.equal(job.status, 'succeeded', job.message);
    const target = join(directory, 'restored');
    await exec(process.execPath, [resolve('src/server/backup-cli.ts'), 'restore', '--source', job.path, '--target', target, '--with-system']);
    restored = createApp({ dataDir: target });
    const read = await restored.inject({ url: `/api/v1/collection/questions/${last!.id}`, headers });
    assert.equal(read.statusCode, 200, read.body);
    assert.deepEqual((await restored.inject({ url: `/api/v1/collection/pages/${last!.originalPage.id}/original`, headers })).rawPayload, bytes);
  } finally { await restored?.close(); await f.close(); await rm(directory, { recursive: true, force: true }); }
});
