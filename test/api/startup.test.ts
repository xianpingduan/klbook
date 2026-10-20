import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, stat, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { familyFixture, auth, password } from './fixture.ts';

test('常驻启动时资料库目录丢失会退出并记录原因，不创建空资料库或提供业务接口', async () => {
  const root = await mkdtemp(join(tmpdir(), 'klbook-startup-'));
  const dataDir = join(root, 'missing-data'), stateFile = join(root, 'startup.json');
  const child = spawn(process.execPath, ['src/server/main.ts'], { windowsHide: true, env: { ...process.env, KLBOOK_PORT: '0', KLBOOK_DATA_DIR: dataDir, KLBOOK_REQUIRE_EXISTING: '1', KLBOOK_STARTUP_STATE: stateFile } });
  let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', () => {});
  const closed = new Promise<number | null>(resolve => child.once('close', resolve));
  try {
    const exitCode = await Promise.race([closed, new Promise<'timeout'>(resolve => { const timer = setTimeout(() => resolve('timeout'), 4000); timer.unref(); })]);
    assert.notEqual(exitCode, 'timeout', '常驻模式不能把丢失的资料目录当作首次初始化');
    assert.notEqual(exitCode, 0); assert.doesNotMatch(output, /KLBOOK_LISTENING=/);
    assert.equal(await stat(dataDir).then(() => true, () => false), false);
    const state = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.equal(state.phase, 'failed'); assert.match(state.message, /数据目录.*不存在/);
  } finally { if (child.exitCode === null) child.kill(); await closed; await rm(root, { recursive: true, force: true }); }
});

test('独立维护探测区分应用就绪与 HTTPS 未就绪，后端停止后仍能返回状态', async () => {
  const f = await familyFixture();
  try {
    const address = await f.app.listen({ host: '127.0.0.1', port: 0 }), config = join(f.dataDir, 'deployment.json');
    await writeFile(config, JSON.stringify({ backendPort: Number(new URL(address).port), origin: 'https://127.0.0.1:1', rootCertificate: join(f.dataDir, 'missing-root.crt') }));
    const probe = async () => JSON.parse((await promisify(execFile)(process.execPath, ['src/server/maintenance-cli.ts', 'probe', config], { windowsHide: true })).stdout);
    const partial = await probe(); assert.equal(partial.app, true); assert.equal(partial.gateway, false); assert.match(partial.message, /HTTPS.*尚未就绪/);
    await f.app.close();
    const stopped = await probe(); assert.equal(stopped.app, false); assert.equal(stopped.gateway, false); assert.match(stopped.message, /尚未就绪|无法连接/);
  } finally { await f.close(); }
});

test('常驻启动拒绝缺失原图和错误资料库，恢复文件后重启可登录并找回原始字节', async () => {
  const f = await familyFixture(), stateFile = join(f.dataDir, 'startup-state.json');
  const bytes = await sharp({ create: { width: 120, height: 180, channels: 3, background: 'white' } }).png().toBuffer();
  const draft = (await f.app.inject({ method: 'POST', url: '/api/v1/collection/drafts', headers: { ...auth(f.first.token), 'content-type': 'image/png', 'idempotency-key': randomUUID() }, payload: bytes })).json();
  const original = join(f.dataDir, 'attachments', 'pages', draft.originalPage.id, 'original');
  await f.app.close();
  const launch = (libraryId = f.first.library.id) => {
    const child = spawn(process.execPath, ['src/server/main.ts'], { windowsHide: true, env: { ...process.env, KLBOOK_PORT: '0', KLBOOK_DATA_DIR: f.dataDir, KLBOOK_REQUIRE_EXISTING: '1', KLBOOK_EXPECTED_LIBRARY_ID: libraryId, KLBOOK_STARTUP_STATE: stateFile } });
    let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', () => {});
    const closed = new Promise<number | null>(resolve => child.once('close', resolve));
    return { child, closed, async result() {
      for (let i = 0; i < 150; i++) {
        const address = /KLBOOK_LISTENING=(http:\/\/[^\s]+)/.exec(output)?.[1];
        if (address) return address;
        if (child.exitCode !== null) return null;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw Error('Startup did not settle');
    }, async stop() { if (child.exitCode === null) child.kill(); await closed; } };
  };
  try {
    await rename(original, original + '.held');
    const missing = launch();
    try { assert.equal(await missing.result(), null, '原图缺失时不能标记就绪'); assert.match(JSON.parse(await readFile(stateFile, 'utf8')).message, /附件/); }
    finally { await missing.stop(); }
    await rename(original + '.held', original);
    const wrong = launch(randomUUID());
    try { assert.equal(await wrong.result(), null); assert.match(JSON.parse(await readFile(stateFile, 'utf8')).message, /资料库.*不符/); }
    finally { await wrong.stop(); }
    for (let attempt = 0; attempt < 2; attempt++) {
      const running = launch();
      try {
        const address = await running.result(); assert.ok(address);
        assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).phase, 'ready');
        const login = await fetch(`${address}/api/v1/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'parent', password, deviceName: '重启后设备' }) });
        assert.equal(login.status, 201); const session = await login.json(); assert.equal(session.library.id, f.first.library.id);
        const image = await fetch(`${address}/api/v1/collection/pages/${draft.originalPage.id}/original`, { headers: auth(session.token) });
        assert.equal(image.status, 200); assert.deepEqual(Buffer.from(await image.arrayBuffer()), bytes);
      } finally { await running.stop(); }
    }
  } finally { await f.close(); }
});
