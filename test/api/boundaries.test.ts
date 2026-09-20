import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../../src/server/app.ts';
import { auth, familyFixture } from './fixture.ts';

test('公开接口严格检查来源、凭据格式和字段，恢复尝试限速跨重启保留', async () => {
  const f = await familyFixture();
  try {
    const untrusted = await f.app.inject({ url: '/api/v1/home', headers: { ...auth(f.first.token), origin: 'https://untrusted.example' } });
    assert.equal(untrusted.statusCode, 403);
    const rawToken = await f.app.inject({ url: '/api/v1/home', headers: { authorization: f.first.token } });
    assert.equal(rawToken.statusCode, 401);
    const invalid = await f.app.inject({ method: 'POST', url: '/api/v1/sessions', payload: { username: 'parent', password: 'short', deviceName: '电脑', isAdmin: true } });
    assert.equal(invalid.statusCode, 400);
    const home = await f.app.inject({ url: '/api/v1/home', headers: auth(f.first.token) });
    assert.equal(home.headers['cache-control'], 'no-store');
    const input = { method: 'POST' as const, url: '/api/v1/recovery', payload: { recoveryCode: 'wrong', newPassword: 'long enough password', deviceName: '电脑' } };
    for (let i = 0; i < 10; i++) assert.equal((await f.app.inject(input)).statusCode, 401);
    assert.equal((await f.app.inject(input)).statusCode, 429);
    await f.app.close();
    const restarted = createApp({ dataDir: f.dataDir });
    try { assert.equal((await restarted.inject(input)).statusCode, 429); }
    finally { await restarted.close(); }
  } finally { await f.close(); }
});

test('到期设备不能读取资料或取得管理权限', async () => {
  const f = await familyFixture();
  try {
    f.advance(30 * 86400000);
    assert.equal((await f.app.inject({ url: '/api/v1/home', headers: auth(f.first.token) })).statusCode, 401);
  } finally { await f.close(); }
});
