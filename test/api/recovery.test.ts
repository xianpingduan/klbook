import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auth, familyFixture, password } from './fixture.ts';

test('恢复码重设密码并轮换，撤销全部旧设备与管理授权，保留家庭资料', async () => {
  const f = await familyFixture();
  try {
    const other = (await f.login('平板')).json();
    const grant = (await f.app.inject({ method: 'POST', url: '/api/v1/admin/grants', headers: auth(f.first.token), payload: { password } })).json().token;
    const newPassword = 'new family password 456';
    const recover = (recoveryCode: string) => f.app.inject({ method: 'POST', url: '/api/v1/recovery', payload: { recoveryCode, newPassword, deviceName: '恢复设备' } });
    assert.equal((await recover('invalid recovery code')).statusCode, 401);
    assert.equal((await f.app.inject({ url: '/api/v1/home', headers: auth(f.first.token) })).statusCode, 200);
    const recovered = await recover(f.first.recoveryCode!);
    assert.equal(recovered.statusCode, 201, recovered.body);
    const next = recovered.json();
    assert.deepEqual(next.library, f.first.library);
    assert.deepEqual(next.account, f.first.account);
    assert.notEqual(next.recoveryCode, f.first.recoveryCode);
    for (const token of [f.first.token, other.token]) {
      assert.equal((await f.app.inject({ url: '/api/v1/home', headers: auth(token) })).statusCode, 401);
    }
    assert.equal((await f.app.inject({ url: '/api/v1/admin/devices', headers: auth(next.token, grant) })).statusCode, 403);
    assert.equal((await recover(f.first.recoveryCode!)).statusCode, 401);
    assert.equal((await f.login('电脑')).statusCode, 401);
    assert.equal((await f.login('电脑', newPassword)).statusCode, 201);
    assert.equal((await recover(next.recoveryCode)).statusCode, 201);
  } finally { await f.close(); }
});

test('仍记得密码的家长可以补领恢复码，孩子会话不能补领，旧码立即失效', async () => {
  const f = await familyFixture();
  try {
    const rotate = (grant?: string) => f.app.inject({ method: 'POST', url: '/api/v1/admin/recovery-code', headers: auth(f.first.token, grant) });
    assert.equal((await rotate()).statusCode, 403);
    const grant = (await f.app.inject({ method: 'POST', url: '/api/v1/admin/grants', headers: auth(f.first.token), payload: { password } })).json().token;
    const replacement = await rotate(grant);
    assert.equal(replacement.statusCode, 200, replacement.body);
    const recover = (recoveryCode: string) => f.app.inject({ method: 'POST', url: '/api/v1/recovery', payload: { recoveryCode, newPassword: 'replacement password', deviceName: '电脑' } });
    assert.equal((await recover(f.first.recoveryCode!)).statusCode, 401);
    assert.equal((await recover(replacement.json().recoveryCode)).statusCode, 201);
  } finally { await f.close(); }
});
