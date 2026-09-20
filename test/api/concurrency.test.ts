import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApp } from '../../src/server/app.ts';
import { auth, familyFixture } from './fixture.ts';

test('并发初始化只创建一个家庭，并发恢复同一码只能使用一次', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'klbook-api-'));
  const app = createApp({ dataDir });
  try {
    const setupCode = (await readFile(join(dataDir, 'setup-code.txt'), 'utf8')).trim();
    const create = () => app.inject({ method: 'POST', url: '/api/v1/setup', payload: { setupCode, username: 'parent', password: 'family password 123', learnerName: '小明', deviceName: '电脑' } });
    const responses = await Promise.all([create(), create()]);
    assert.deepEqual(responses.map(r => r.statusCode).sort(), [201, 409]);
    const first = responses.find(r => r.statusCode === 201)!.json();
    const recover = () => app.inject({ method: 'POST', url: '/api/v1/recovery', payload: { recoveryCode: first.recoveryCode, newPassword: 'replacement password', deviceName: '恢复设备' } });
    const recovered = await Promise.all([recover(), recover()]);
    assert.deepEqual(recovered.map(r => r.statusCode).sort(), [201, 401]);
    assert.deepEqual(recovered.find(r => r.statusCode === 201)!.json().library, first.library);
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('登录与密码恢复交错时不能留下旧密码取得的有效会话', async () => {
  const f = await familyFixture();
  try {
    const [login, recovered] = await Promise.all([
      f.login('旧密码设备'),
      f.app.inject({ method: 'POST', url: '/api/v1/recovery', payload: { recoveryCode: f.first.recoveryCode, newPassword: 'replacement password', deviceName: '恢复设备' } })
    ]);
    assert.equal(recovered.statusCode, 201);
    assert.ok([201, 401].includes(login.statusCode));
    if (login.statusCode === 201) assert.equal((await f.app.inject({ url: '/api/v1/home', headers: auth(login.json().token) })).statusCode, 401);
  } finally { await f.close(); }
});
