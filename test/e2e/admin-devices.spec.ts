import { expect, test } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { startServer } from './server.ts';

async function fixture(request: APIRequestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'klbook-admin-devices-'));
  const server = await startServer(dir);
  const setupCode = (await readFile(join(dir, 'setup-code.txt'), 'utf8')).trim();
  const initial = await (await request.post(`${server.url}/api/v1/setup`, { data: { setupCode, username: 'parent', password: 'family password 123', learnerName: '小明', deviceName: '设置电脑' } })).json();
  return { ...server, initial, headers: { Authorization: `Bearer ${initial.token}` }, async close() { await server.stop(); await rm(dir, { recursive: true, force: true }); } };
}
async function login(page: Page, url: string) {
  await page.goto(url);
  await page.getByLabel('家长账号').fill('parent');
  await page.getByLabel('家长密码', { exact: true }).fill('family password 123');
  await page.getByLabel('设备名称', { exact: true }).fill('管理电脑');
  const response = page.waitForResponse(response => response.url().endsWith('/api/v1/sessions') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '登录此设备', exact: true }).click();
  return (await response).json();
}
async function unlock(page: Page) {
  await page.getByLabel('家长密码', { exact: true }).fill('family password 123');
  const response = page.waitForResponse(response => response.url().endsWith('/api/v1/admin/grants') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '验证并进入管理', exact: true }).click();
  return (await response).json();
}
async function holdResponse(page: Page, pattern: string) {
  let received = () => {};
  let release = () => {};
  const seen = new Promise<void>(resolve => { received = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route(pattern, async route => { const response = await route.fetch(); received(); await held; await route.fulfill({ response }); }, { times: 1 });
  return { seen, release };
}

test('设备表格显示真实会话，响应丢失后撤销可重试，当前设备撤销后旧权限失效', async ({ page, request }) => {
  const f = await fixture(request);
  try {
    const other = await (await request.post(`${f.url}/api/v1/sessions`, { data: { username: 'parent', password: 'family password 123', deviceName: '学习平板' } })).json();
    const current = await login(page, `${f.url}/admin/devices`);
    const grant = await unlock(page);
    const table = page.getByRole('table', { name: '有效设备' });
    await expect(table.getByRole('row')).toHaveCount(4);
    await expect(table.getByRole('row').filter({ hasText: '管理电脑' })).toContainText('当前设备');
    await expect(page.getByRole('region', { name: '恢复码保管' })).toBeVisible();
    await expect(page.getByRole('button', { name: '结束管理', exact: true })).toHaveCount(1);
    await page.route('**/api/v1/admin/devices/*', async route => { await route.fetch(); await route.abort(); }, { times: 1 });
    await page.getByRole('button', { name: '撤销 学习平板', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('重试');
    expect((await request.get(`${f.url}/api/v1/home`, { headers: { Authorization: `Bearer ${other.token}` } })).status()).toBe(401);
    await page.getByRole('button', { name: '撤销 学习平板', exact: true }).click();
    await expect(table.getByRole('row')).toHaveCount(3);
    await expect(page.getByRole('status')).toContainText('已撤销');
    await page.getByRole('button', { name: '管理概览', exact: true }).click();
    await expect(page.getByRole('region', { name: '有效设备数' }).locator('strong')).toHaveText('2');
    await page.getByRole('button', { name: '设备与账号', exact: true }).click();
    await page.route('**/api/v1/admin/devices', route => route.abort());
    await page.getByRole('button', { name: '刷新设备列表' }).click();
    await expect(page.getByRole('alert')).toContainText('暂不可用');
    await expect(table).toHaveCount(0);
    await page.unroute('**/api/v1/admin/devices');
    await page.getByRole('button', { name: '重试读取设备' }).click();
    await expect(table.getByRole('row')).toHaveCount(3);
    for (const width of [1440, 820, 390]) {
      await page.setViewportSize({ width, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `test-results/admin-devices-${width}-${test.info().project.name}.png`, fullPage: true });
    }
    await page.getByRole('button', { name: '管理菜单', exact: true }).click();
    await page.getByRole('button', { name: '管理概览', exact: true }).click();
    await expect(page.getByRole('heading', { name: '管理概览', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '管理菜单', exact: true }).click();
    await page.getByRole('button', { name: '设备与账号', exact: true }).click();
    await page.evaluate(() => { const remove = Storage.prototype.removeItem; Storage.prototype.removeItem = function(key: string) { if (key.startsWith('klbook.credential:')) throw new Error('credential storage unavailable'); return remove.call(this, key); }; });
    await page.getByRole('button', { name: '撤销 管理电脑', exact: true }).click();
    await expect(page.getByRole('heading', { name: '登录家庭资料库' })).toBeVisible();
    await expect(page.getByRole('table')).toHaveCount(0);
    expect((await request.get(`${f.url}/api/v1/home`, { headers: { Authorization: `Bearer ${current.token}` } })).status()).toBe(401);
    expect((await request.get(`${f.url}/api/v1/admin/devices`, { headers: { Authorization: `Bearer ${current.token}`, 'X-Parent-Authorization': grant.token } })).status()).toBe(401);
    expect((await request.get(`${f.url}/api/v1/home`, { headers: f.headers })).status()).toBe(200);
  } finally { await f.close(); }
});

test('恢复码轮换期间不能切页，保存确认前后退受保护，恢复账号保留资料并返回管理目标', async ({ page, request }) => {
  const f = await fixture(request);
  let release = () => {};
  try {
    const image = await sharp({ create: { width: 100, height: 80, channels: 3, background: '#fafaf5' } }).png().toBuffer();
    const draft = await (await request.post(`${f.url}/api/v1/collection/drafts`, { headers: { ...f.headers, 'Content-Type': 'image/png', 'Idempotency-Key': crypto.randomUUID() }, data: image })).json();
    const current = await login(page, `${f.url}/admin`);
    const grant = await unlock(page);
    await page.getByRole('button', { name: '设备与账号', exact: true }).click();
    const pending = await holdResponse(page, '**/api/v1/admin/recovery-code'); release = pending.release;
    await page.getByRole('button', { name: '重新生成恢复码' }).click(); await pending.seen;
    await page.getByRole('button', { name: '来源管理', exact: true }).click();
    await expect(page).toHaveURL(`${f.url}/admin/devices`);
    await expect(page.getByRole('alert')).toContainText('请稍候');
    release();
    await expect(page.getByRole('heading', { name: '请保存恢复码' })).toBeVisible();
    const code = await page.getByLabel('恢复码', { exact: true }).inputValue();
    expect(code).not.toBe(f.initial.recoveryCode);
    expect((await request.post(`${f.url}/api/v1/recovery`, { data: { recoveryCode: f.initial.recoveryCode, newPassword: 'new family password 456', deviceName: '旧码验证' } })).status()).toBe(401);
    expect((await request.get(`${f.url}/api/v1/admin/devices`, { headers: { Authorization: `Bearer ${current.token}`, 'X-Parent-Authorization': grant.token } })).status()).toBe(403);
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain(code);
    await expect(page.getByRole('button', { name: '进入错题集' })).toBeDisabled();
    await page.goBack();
    await expect(page).toHaveURL(`${f.url}/admin/devices`);
    await expect(page.getByRole('alert')).toContainText('保存恢复码');
    await page.getByLabel('我已将恢复码保存在安全的地方').check();
    await page.getByRole('button', { name: '进入错题集' }).click();
    await expect(page.getByRole('heading', { name: '验证家长身份' })).toBeVisible();
    await expect(page.getByLabel('恢复码', { exact: true })).toHaveCount(0);
    await unlock(page);
    await page.getByRole('button', { name: '管理概览', exact: true }).click();
    await page.goBack();
    await expect(page.getByRole('heading', { name: '设备与账号', exact: true })).toBeVisible();
    await expect(page.getByLabel('恢复码', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '撤销 管理电脑', exact: true }).click();
    await page.getByRole('button', { name: '忘记密码，使用恢复码' }).click();
    await page.getByLabel('恢复码', { exact: true }).fill(code);
    await page.getByLabel('新的家长密码').fill('new family password 456');
    const recoveryResponse = page.waitForResponse(response => response.url().endsWith('/api/v1/recovery') && response.request().method() === 'POST');
    await page.getByRole('button', { name: '重设密码并登录' }).click();
    const recovered = await (await recoveryResponse).json();
    expect(recovered.library).toEqual(f.initial.library);
    const newHeaders = { Authorization: `Bearer ${recovered.token}` };
    expect((await (await request.get(`${f.url}/api/v1/collection/questions/${draft.id}`, { headers: newHeaders })).json()).id).toBe(draft.id);
    expect(await (await request.get(`${f.url}/api/v1/collection/pages/${draft.originalPage.id}/original`, { headers: newHeaders })).body()).toEqual(image);
    await expect(page.getByRole('heading', { name: '请保存恢复码' })).toBeVisible();
    await expect(page.getByLabel('恢复码', { exact: true })).not.toHaveValue(code);
    await page.getByLabel('我已将恢复码保存在安全的地方').check();
    await page.getByRole('button', { name: '进入错题集' }).click();
    await expect(page).toHaveURL(`${f.url}/admin/devices`);
    expect((await request.get(`${f.url}/api/v1/home`, { headers: f.headers })).status()).toBe(401);
    await page.getByLabel('家长密码', { exact: true }).fill('new family password 456');
    await page.getByRole('button', { name: '验证并进入管理' }).click();
    await expect(page.getByRole('table', { name: '有效设备' }).getByRole('row')).toHaveCount(2);
  } finally { release(); await f.close(); }
});

test('结束管理失败留在原页可重试，再进入需验证，服务端拒绝和本地到期立即锁定设备页', async ({ page, request }) => {
  const f = await fixture(request);
  try {
    await page.clock.install();
    const current = await login(page, `${f.url}/admin/devices`);
    const firstGrant = await unlock(page);
    const parentHeaders = { Authorization: `Bearer ${current.token}`, 'X-Parent-Authorization': firstGrant.token };
    await page.route('**/api/v1/admin/grants', async route => { if (route.request().method() === 'DELETE') await route.abort(); else await route.continue(); });
    await page.getByRole('button', { name: '结束管理', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('无法连接');
    await expect(page).toHaveURL(`${f.url}/admin/devices`);
    expect((await request.get(`${f.url}/api/v1/admin/devices`, { headers: parentHeaders })).status()).toBe(200);
    await page.unroute('**/api/v1/admin/grants');
    await page.getByRole('button', { name: '结束管理', exact: true }).click();
    await expect(page).toHaveURL(`${f.url}/learn`);
    expect((await request.get(`${f.url}/api/v1/admin/devices`, { headers: parentHeaders })).status()).toBe(403);
    await page.goBack();
    await expect(page.getByRole('heading', { name: '验证家长身份' })).toBeVisible();
    await expect(page.getByRole('table')).toHaveCount(0);
    const nextGrant = await unlock(page);
    await expect(page.getByRole('table', { name: '有效设备' }).getByRole('row')).toHaveCount(3);
    expect((await request.delete(`${f.url}/api/v1/admin/grants`, { headers: { Authorization: `Bearer ${current.token}`, 'X-Parent-Authorization': nextGrant.token } })).status()).toBe(204);
    await page.getByRole('button', { name: '撤销 设置电脑', exact: true }).click();
    await expect(page.getByRole('heading', { name: '验证家长身份' })).toBeVisible();
    expect((await request.get(`${f.url}/api/v1/home`, { headers: f.headers })).status()).toBe(200);
    await unlock(page);
    await expect(page.getByRole('table', { name: '有效设备' }).getByRole('row')).toHaveCount(3);
    await page.clock.fastForward(5 * 60 * 1000 + 10);
    await expect(page.getByRole('heading', { name: '验证家长身份' })).toBeVisible();
    await expect(page.getByRole('button', { name: '重新生成恢复码' })).toHaveCount(0);
    await page.clock.setFixedTime(new Date());
    await unlock(page);
    await expect(page.getByRole('table', { name: '有效设备' }).getByRole('row')).toHaveCount(3);
  } finally { await f.close(); }
});

test('管理到期后仍接收同一设备会话已完成的恢复码轮换与当前设备撤销结果', async ({ page, request }) => {
  const f = await fixture(request);
  let release = () => {};
  try {
    await page.clock.install();
    const current = await login(page, `${f.url}/admin/devices`);
    await unlock(page);
    await expect(page.getByRole('table', { name: '有效设备' }).getByRole('row')).toHaveCount(3);
    await page.clock.fastForward(295000);
    const rotation = await holdResponse(page, '**/api/v1/admin/recovery-code'); release = rotation.release;
    await page.getByRole('button', { name: '重新生成恢复码' }).click(); await rotation.seen;
    await page.clock.fastForward(5100);
    await expect(page.getByRole('heading', { name: '验证家长身份' })).toBeVisible();
    rotation.release();
    await expect(page.getByRole('heading', { name: '请保存恢复码' })).toBeVisible();
    expect(await page.getByLabel('恢复码', { exact: true }).inputValue()).not.toBe(f.initial.recoveryCode);
    expect((await request.post(`${f.url}/api/v1/recovery`, { data: { recoveryCode: f.initial.recoveryCode, newPassword: 'new family password 456', deviceName: '旧码验证' } })).status()).toBe(401);
    await page.getByLabel('我已将恢复码保存在安全的地方').check();
    await page.getByRole('button', { name: '进入错题集' }).click();
    await page.clock.setFixedTime(new Date());
    await unlock(page);
    await expect(page.getByRole('table', { name: '有效设备' }).getByRole('row')).toHaveCount(3);
    await page.clock.fastForward(295000);
    const revocation = await holdResponse(page, '**/api/v1/admin/devices/*'); release = revocation.release;
    await page.getByRole('button', { name: '撤销 管理电脑', exact: true }).click(); await revocation.seen;
    await page.clock.fastForward(5100);
    await expect(page.getByRole('heading', { name: '验证家长身份' })).toBeVisible();
    revocation.release();
    await expect(page.getByRole('heading', { name: '登录家庭资料库' })).toBeVisible();
    expect((await request.get(`${f.url}/api/v1/home`, { headers: { Authorization: `Bearer ${current.token}` } })).status()).toBe(401);
  } finally { release(); await f.close(); }
});

test('旧设备会话的恢复码响应不能覆盖重新登录后的管理页面', async ({ page, request }) => {
  const f = await fixture(request);
  let release = () => {};
  try {
    await page.clock.install();
    const current = await login(page, `${f.url}/admin/devices`);
    await unlock(page);
    await expect(page.getByRole('table', { name: '有效设备' }).getByRole('row')).toHaveCount(3);
    await page.clock.fastForward(295000);
    const rotation = await holdResponse(page, '**/api/v1/admin/recovery-code'); release = rotation.release;
    await page.getByRole('button', { name: '重新生成恢复码' }).click(); await rotation.seen;
    expect((await request.delete(`${f.url}/api/v1/sessions/current`, { headers: { Authorization: `Bearer ${current.token}` } })).status()).toBe(204);
    await page.clock.fastForward(5100);
    await page.getByLabel('家长密码', { exact: true }).fill('family password 123');
    await page.getByRole('button', { name: '验证并进入管理' }).click();
    await expect(page.getByRole('heading', { name: '登录家庭资料库' })).toBeVisible();
    await page.clock.setFixedTime(new Date());
    await page.getByLabel('家长账号').fill('parent');
    await page.getByLabel('家长密码', { exact: true }).fill('family password 123');
    await page.getByLabel('设备名称', { exact: true }).fill('重新登录的电脑');
    await page.getByRole('button', { name: '登录此设备', exact: true }).click();
    await unlock(page);
    const table = page.getByRole('table', { name: '有效设备' });
    await expect(table.getByRole('row')).toHaveCount(3);
    const response = page.waitForResponse(response => response.url().endsWith('/api/v1/admin/recovery-code'));
    rotation.release(); await (await response).finished();
    await page.getByRole('button', { name: '刷新设备列表' }).click();
    await expect(table.getByRole('row').filter({ hasText: '重新登录的电脑' })).toContainText('当前设备');
    await expect(page.getByRole('heading', { name: '请保存恢复码' })).toHaveCount(0);
  } finally { release(); await f.close(); }
});
