import { expect, test } from '@playwright/test';
import type { Page, APIRequestContext } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from './server.ts';
import sharp from 'sharp';

const password = 'family password 123';
async function fixture(request: APIRequestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'klbook-ui-entry-'));
  const server = await startServer(dir);
  const setupCode = (await readFile(join(dir, 'setup-code.txt'), 'utf8')).trim();
  const result = await request.post(`${server.url}/api/v1/setup`, { data: { setupCode, username: 'parent', password, learnerName: '小明', deviceName: '原有电脑' } });
  return { ...server, initial: await result.json(), async close() { await server.stop(); await rm(dir, { recursive: true, force: true }); } };
}
async function login(page: Page) {
  await page.getByLabel('家长账号').fill('parent');
  await page.getByLabel('家长密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录此设备' }).click();
}
async function unlock(page: Page) {
  await page.getByLabel('家长密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '验证并进入管理' }).click();
}

test('管理地址登录后二次验证，真实概览与三 Tab 独立，前进后退及刷新保持目标', async ({ page, request }) => {
  const f = await fixture(request);
  try {
    await page.goto(`${f.url}/admin?returnTo=https://example.com`);
    await login(page);
    await expect(page.getByRole('heading', { name: '验证家长身份' })).toBeVisible();
    await expect(page.getByRole('region', { name: '已收集数' })).toHaveCount(0);
    await unlock(page);
    await expect(page.getByRole('heading', { name: '管理概览', exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: '有效设备数' })).toContainText('2');
    await page.getByRole('button', { name: '来源管理', exact: true }).click();
    await expect(page).toHaveURL(`${f.url}/admin/sources`);
    await page.goBack();
    await expect(page.getByRole('heading', { name: '管理概览', exact: true })).toBeVisible();
    await page.goForward();
    await expect(page.getByLabel('来源名称', { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: '验证家长身份' })).toBeVisible();
    await unlock(page);
    await expect(page.getByLabel('来源名称', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '结束管理', exact: true }).click();
    await expect(page).toHaveURL(`${f.url}/learn`);
    await expect(page.getByRole('navigation', { name: '学习导航' }).getByRole('button')).toHaveText(['首页', '收集', '我的']);
    for (const width of [390, 820, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      for (const button of await page.getByRole('navigation', { name: '学习导航' }).getByRole('button').all()) expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(48);
      await page.screenshot({ path: `test-results/ui-learning-${width}-${test.info().project.name}.png`, fullPage: true });
    }
    await page.getByRole('button', { name: '我的', exact: true }).click();
    await expect(page.getByTestId('library-id')).toHaveText(f.initial.library.id);
    await page.reload();
    await expect(page.getByRole('heading', { name: '我的', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '家长管理', exact: true }).click();
    await expect(page.getByRole('heading', { name: '验证家长身份' })).toBeVisible();
  } finally { await f.close(); }
});

test('管理入口首次设置及恢复账号均在保存一次性恢复码后返回管理验证', async ({ page, request }) => {
  const dir = await mkdtemp(join(tmpdir(), 'klbook-ui-setup-'));
  const server = await startServer(dir);
  try {
    await page.goto(`${server.url}/admin`);
    await page.getByLabel('本机设置码').fill((await readFile(join(dir, 'setup-code.txt'), 'utf8')).trim());
    await page.getByLabel('家长账号').fill('parent');
    await page.getByLabel('家长密码', { exact: true }).fill(password);
    await page.getByLabel('学习者称呼').fill('小明');
    await page.getByRole('button', { name: '建立资料库', exact: true }).click();
    const code = await page.getByLabel('恢复码', { exact: true }).inputValue();
    await expect(page.getByRole('button', { name: '进入错题集' })).toBeDisabled();
    await page.getByLabel('我已将恢复码保存在安全的地方').check();
    await page.getByRole('button', { name: '进入错题集' }).click();
    await expect(page).toHaveURL(`${server.url}/admin`);
    await unlock(page);
    await expect(page.getByRole('heading', { name: '管理概览', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '结束管理', exact: true }).click();
    await page.getByRole('button', { name: '我的', exact: true }).click();
    const identity = await page.getByTestId('library-id').textContent();
    await page.getByRole('button', { name: '退出此设备' }).click();
    await page.goto(`${server.url}/admin`);
    await page.getByRole('button', { name: '忘记密码，使用恢复码' }).click();
    await page.getByLabel('恢复码', { exact: true }).fill(code);
    await page.getByLabel('新的家长密码').fill(password);
    await page.getByRole('button', { name: '重设密码并登录' }).click();
    await expect(page.getByLabel('恢复码', { exact: true })).not.toHaveValue(code);
    await page.getByLabel('我已将恢复码保存在安全的地方').check();
    await page.getByRole('button', { name: '进入错题集' }).click();
    await expect(page.getByRole('heading', { name: '验证家长身份' })).toBeVisible();
    await unlock(page);
    await expect(page.getByRole('heading', { name: '管理概览', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '结束管理', exact: true }).click();
    await page.getByRole('button', { name: '我的', exact: true }).click();
    await expect(page.getByTestId('library-id')).toHaveText(identity!);
    expect((await request.post(`${server.url}/api/v1/recovery`, { data: { recoveryCode: code, newPassword: password, deviceName: '测试旧码' } })).status()).toBe(401);
  } finally { await server.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('管理概览读取超过一页的总数、排除停用来源及撤销设备，部分失败可重试', async ({ page, request }) => {
  const f = await fixture(request);
  try {
    const headers = { Authorization: `Bearer ${f.initial.token}` };
    const grant = await (await request.post(`${f.url}/api/v1/admin/grants`, { headers, data: { password } })).json();
    const adminHeaders = { ...headers, 'X-Parent-Authorization': grant.token };
    const sources = await (await request.get(`${f.url}/api/v1/admin/sources`, { headers: adminHeaders })).json();
    for (const source of sources.slice(1)) await request.put(`${f.url}/api/v1/admin/sources/${source.id}`, { headers: adminHeaders, data: { expectedRevision: source.revision, name: source.name, active: false, operationId: crypto.randomUUID() } });
    const other = await (await request.post(`${f.url}/api/v1/sessions`, { data: { username: 'parent', password, deviceName: '已撤销平板' } })).json();
    expect((await request.delete(`${f.url}/api/v1/admin/devices/${other.session.id}`, { headers: adminHeaders })).status()).toBe(204);
    const image = await sharp({ create: { width: 32, height: 32, channels: 3, background: 'white' } }).png().toBuffer();
    for (let i = 0; i < 53; i++) {
      const question = await (await request.post(`${f.url}/api/v1/collection/drafts`, { headers: { ...headers, 'Content-Type': 'image/png', 'Idempotency-Key': crypto.randomUUID() }, data: image })).json();
      if (i === 52) continue;
      expect((await request.put(`${f.url}/api/v1/collection/questions/${question.id}`, { headers, data: { expectedRevision: question.revision, operationId: crypto.randomUUID(), state: 'collected', subjectId: 'math', region: { x: 0, y: 0, width: 1, height: 1 }, sourceId: null, pageNumber: '', questionNumber: '', note: '' } })).status()).toBe(200);
    }
    await page.goto(`${f.url}/admin`);
    await login(page); await unlock(page);
    for (const [label, count] of [['已收集数', '52'], ['草稿数', '1'], ['启用来源数', '1'], ['有效设备数', '2']]) await expect(page.getByRole('region', { name: label, exact: true }).locator('strong')).toHaveText(count!);
    await page.route('**/api/v1/collection/questions?state=draft*', route => route.abort());
    await page.getByRole('button', { name: '刷新概览' }).click();
    await expect(page.getByRole('region', { name: '草稿数', exact: true })).toContainText('暂不可用');
    await expect(page.getByRole('region', { name: '已收集数', exact: true }).locator('strong')).toHaveText('52');
    await page.unroute('**/api/v1/collection/questions?state=draft*');
    await page.getByRole('button', { name: '刷新概览' }).click();
    await expect(page.getByRole('region', { name: '草稿数', exact: true }).locator('strong')).toHaveText('1');
    await page.screenshot({ path: `test-results/ui-overview-${test.info().project.name}.png`, fullPage: true });
    for (const width of [390, 820, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      if (width === 390) await page.getByRole('button', { name: '管理菜单' }).click();
      await expect(page.getByRole('button', { name: '错题资料', exact: true })).toBeVisible();
    }
  } finally { await f.close(); }
});

test('管理到期隐藏表单且不能写入，重新验证保留输入，服务端撤销也立即锁定', async ({ page, request }) => {
  const f = await fixture(request);
  try {
    await page.clock.install();
    await page.goto(`${f.url}/admin/sources`);
    await login(page); await unlock(page);
    await page.getByLabel('来源名称', { exact: true }).fill('保留这份未提交内容');
    await page.clock.fastForward(5 * 60 * 1000 + 10);
    await expect(page.getByRole('heading', { name: '验证家长身份' })).toBeVisible();
    await expect(page.getByRole('button', { name: '添加来源', exact: true })).toHaveCount(0);
    // Resume the browser clock before a real server issues the next five-minute grant.
    await page.clock.setFixedTime(new Date());
    await unlock(page);
    await expect(page.getByLabel('来源名称', { exact: true })).toHaveValue('保留这份未提交内容');
    const response = page.waitForRequest(request => request.url().includes('/admin/sources/') && request.method() === 'PUT');
    await page.getByRole('button', { name: '添加来源', exact: true }).click();
    const savedRequest = await response;
    await expect(page.getByRole('button', { name: '改名 保留这份未提交内容', exact: true })).toBeVisible();
    const headers = await savedRequest.allHeaders();
    expect((await request.delete(`${f.url}/api/v1/admin/grants`, { headers: { Authorization: headers.authorization!, 'X-Parent-Authorization': headers['x-parent-authorization']! } })).status()).toBe(204);
    await page.getByLabel('来源名称', { exact: true }).fill('服务器撤销时仍保留');
    await page.getByRole('button', { name: '添加来源', exact: true }).click();
    await expect(page.getByRole('heading', { name: '验证家长身份' })).toBeVisible();
    await unlock(page);
    await expect(page.getByLabel('来源名称', { exact: true })).toHaveValue('服务器撤销时仍保留');
  } finally { await f.close(); }
});
