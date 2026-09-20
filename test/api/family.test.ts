import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApp } from '../../src/server/app.ts';

test('初始化需要本机设置码，首页只向登录设备返回持久家庭资料', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'klbook-api-'));
  const app = createApp({ dataDir });
  try {
    const info = await app.inject('/api/v1/info');
    assert.equal(info.statusCode, 200);
    assert.equal(info.json().initialized, false);
    assert.equal((await app.inject('/api/v1/home')).statusCode, 401);
    const details = { username: '家长', password: 'a long family password', learnerName: '小明', deviceName: '家庭电脑' };
    const denied = await app.inject({ method: 'POST', url: '/api/v1/setup', payload: { ...details, setupCode: 'wrong' } });
    assert.equal(denied.statusCode, 401);
    const setupCode = (await readFile(join(dataDir, 'setup-code.txt'), 'utf8')).trim();
    const setup = await app.inject({ method: 'POST', url: '/api/v1/setup', payload: { ...details, setupCode } });
    assert.equal(setup.statusCode, 201, setup.body);
    const session = setup.json();
    assert.ok(session.recoveryCode.length > 30);
    const home = await app.inject({ url: '/api/v1/home', headers: { authorization: `Bearer ${session.token}` } });
    assert.equal(home.statusCode, 200);
    assert.equal(home.json().library.learnerName, '小明');
    assert.equal(home.json().account.username, '家长');
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/setup', payload: { ...details, setupCode } })).statusCode, 409);
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('重启保留同一资料库和设备会话，密码登录及退出都由本地服务验证', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'klbook-api-'));
  let app = createApp({ dataDir });
  try {
    const setupCode = (await readFile(join(dataDir, 'setup-code.txt'), 'utf8')).trim();
    const setup = await app.inject({ method: 'POST', url: '/api/v1/setup', payload: { setupCode, username: 'parent', password: 'family password 123', learnerName: '小明', deviceName: '电脑' } });
    const initial = setup.json();
    await app.close();
    app = createApp({ dataDir });
    const home = await app.inject({ url: '/api/v1/home', headers: { authorization: `Bearer ${initial.token}` } });
    assert.equal(home.statusCode, 200);
    assert.deepEqual(home.json().library, initial.library);
    const login = (password: string) => app.inject({ method: 'POST', url: '/api/v1/sessions', payload: { username: 'parent', password, deviceName: '平板' } });
    assert.equal((await login('incorrect password')).statusCode, 401);
    const signedIn = await login('family password 123');
    assert.equal(signedIn.statusCode, 201, signedIn.body);
    assert.deepEqual(signedIn.json().library, initial.library);
    const headers = { authorization: `Bearer ${signedIn.json().token}` };
    assert.equal((await app.inject({ method: 'DELETE', url: '/api/v1/sessions/current', headers })).statusCode, 204);
    assert.equal((await app.inject({ url: '/api/v1/home', headers })).statusCode, 401);
    assert.equal((await app.inject({ url: '/api/v1/home', headers: { authorization: `Bearer ${initial.token}` } })).statusCode, 200);
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
