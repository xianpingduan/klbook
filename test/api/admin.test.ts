import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auth, familyFixture, password } from './fixture.ts';

test('家长二次验证绑定当前设备、短期有效；撤销立即阻止原设备访问', async () => {
  const f = await familyFixture();
  try {
    const second = (await f.login('平板')).json();
    const devices = (token: string, grant?: string) => f.app.inject({ url: '/api/v1/admin/devices', headers: auth(token, grant) });
    assert.equal((await devices(f.first.token)).statusCode, 403);
    assert.equal((await f.app.inject({ method: 'DELETE', url: `/api/v1/admin/devices/${second.session.id}`, headers: auth(f.first.token) })).statusCode, 403);
    const unlock = (token: string, value = password) => f.app.inject({ method: 'POST', url: '/api/v1/admin/grants', headers: auth(token), payload: { password: value } });
    assert.equal((await unlock(f.first.token, 'incorrect password')).statusCode, 403);
    const grantResponse = await unlock(f.first.token);
    assert.equal(grantResponse.statusCode, 201, grantResponse.body);
    const grant = grantResponse.json().token;
    const list = await devices(f.first.token, grant);
    assert.equal(list.statusCode, 200, list.body);
    assert.deepEqual(list.json().map((d: { deviceName: string }) => d.deviceName).sort(), ['平板', '电脑']);
    assert.equal((await devices(second.token, grant)).statusCode, 403);
    f.advance(5 * 60 * 1000);
    assert.equal((await devices(f.first.token, grant)).statusCode, 403);
    const newGrant = (await unlock(f.first.token)).json().token;
    const revoke = await f.app.inject({ method: 'DELETE', url: `/api/v1/admin/devices/${second.session.id}`, headers: auth(f.first.token, newGrant) });
    assert.equal(revoke.statusCode, 204);
    assert.equal((await f.app.inject({ url: '/api/v1/home', headers: auth(second.token) })).statusCode, 401);
    assert.equal((await devices(f.first.token, newGrant)).json().length, 1);
    assert.equal((await f.app.inject({ method: 'DELETE', url: '/api/v1/admin/grants', headers: auth(f.first.token, newGrant) })).statusCode, 204);
    assert.equal((await devices(f.first.token, newGrant)).statusCode, 403);
  } finally { await f.close(); }
});
