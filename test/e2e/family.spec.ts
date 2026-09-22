import { expect, test } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from './server.ts';

test('浏览器初始化、保存恢复码、重启服务和退出后再次登录', async ({ page }) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'klbook-browser-'));
  let server = await startServer(dataDir);
  try {
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    await page.goto(server.url);
    await expect(page.getByRole('heading', { name: '建立家庭资料库' })).toBeVisible();
    await page.getByLabel('本机设置码').fill((await readFile(join(dataDir, 'setup-code.txt'), 'utf8')).trim());
    await page.getByLabel('家长账号').fill('parent');
    await page.getByLabel('家长密码', { exact: true }).fill('family password 123');
    await page.getByLabel('学习者称呼').fill('小明');
    await page.getByLabel('设备名称').fill('家庭电脑');
    await page.getByRole('button', { name: '建立资料库', exact: true }).click();
    await expect(page.getByRole('heading', { name: '请保存恢复码' })).toBeVisible();
    await expect(page.getByLabel('恢复码', { exact: true })).not.toHaveValue('');
    await page.getByLabel('我已将恢复码保存在安全的地方').check();
    await page.getByRole('button', { name: '进入错题集' }).click();
    await expect(page.getByRole('heading', { name: '小明的错题集' })).toBeVisible();
    await page.getByRole('button', { name: '我的', exact: true }).click();
    const libraryId = await page.getByTestId('library-id').innerText();
    expect(libraryId).toMatch(/^[a-f0-9-]{36}$/);
    const port = Number(new URL(server.url).port);
    await server.stop();
    server = await startServer(dataDir, port);
    await page.reload();
    await expect(page.getByRole('heading', { name: '我的', exact: true })).toBeVisible();
    await expect(page.getByTestId('library-id')).toHaveText(libraryId);
    await page.getByRole('button', { name: '退出此设备' }).click();
    await page.getByLabel('家长账号').fill('parent');
    await page.getByLabel('家长密码', { exact: true }).fill('family password 123');
    await page.getByRole('button', { name: '登录此设备' }).click();
    await expect(page.getByRole('heading', { name: '我的', exact: true })).toBeVisible();
  } finally { await server.stop(); await rm(dataDir, { recursive: true, force: true }); }
});

test('手机尺寸页面登录、家长验证与设备撤销，恢复账号后旧设备退出', async ({ browser, request }) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'klbook-browser-'));
  const server = await startServer(dataDir);
  const parent = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const child = await browser.newContext();
  try {
    const setupCode = (await readFile(join(dataDir, 'setup-code.txt'), 'utf8')).trim();
    const setup = await request.post(`${server.url}/api/v1/setup`, { data: { setupCode, username: 'parent', password: 'family password 123', learnerName: '小明', deviceName: '初始电脑' } });
    const initial = await setup.json();
    const parentPage = await parent.newPage();
    const childPage = await child.newPage();
    for (const [page, deviceName] of [[parentPage, '手机'], [childPage, '平板']] as const) {
      await page.goto(server.url);
      await page.getByLabel('家长账号').fill('parent');
      await page.getByLabel('家长密码', { exact: true }).fill('family password 123');
      await page.getByLabel('设备名称').fill(deviceName);
      await page.getByRole('button', { name: '登录此设备' }).click();
      await expect(page.getByRole('heading', { name: '小明的错题集' })).toBeVisible();
    }
    await parentPage.getByRole('button', { name: '我的', exact: true }).click();
    await expect(parentPage.getByRole('button', { name: '家长管理', exact: true })).toBeVisible();
    await parentPage.getByRole('button', { name: '家长管理', exact: true }).click();
    await expect(parentPage.getByRole('heading', { name: '验证家长身份' })).toBeVisible();
    await parentPage.getByLabel('家长密码', { exact: true }).fill('incorrect password');
    await parentPage.getByRole('button', { name: '验证并进入管理' }).click();
    await expect(parentPage.getByRole('alert')).toContainText('家长密码不正确');
    await parentPage.getByLabel('家长密码', { exact: true }).fill('family password 123');
    await parentPage.getByRole('button', { name: '验证并进入管理' }).click();
    await parentPage.getByRole('button', { name: '管理菜单', exact: true }).click();
    await parentPage.getByRole('button', { name: '设备与账号', exact: true }).click();
    await parentPage.getByRole('button', { name: '撤销 平板', exact: true }).click();
    await childPage.reload();
    await expect(childPage.getByRole('heading', { name: '登录家庭资料库' })).toBeVisible();
    await parentPage.getByRole('button', { name: '结束管理' }).click();
    await parentPage.getByRole('button', { name: '我的', exact: true }).click();
    await parentPage.getByRole('button', { name: '家长管理', exact: true }).click();
    await parentPage.getByLabel('家长密码', { exact: true }).fill('family password 123');
    await parentPage.getByRole('button', { name: '验证并进入管理' }).click();
    await parentPage.getByRole('button', { name: '管理菜单', exact: true }).click();
    await parentPage.getByRole('button', { name: '设备与账号', exact: true }).click();
    await parentPage.getByRole('button', { name: '重新生成恢复码' }).click();
    const replacementCode = await parentPage.getByLabel('恢复码', { exact: true }).inputValue();
    expect(replacementCode).not.toBe(initial.recoveryCode);
    await parentPage.getByLabel('我已将恢复码保存在安全的地方').check();
    await parentPage.getByRole('button', { name: '进入错题集' }).click();
    await parentPage.getByRole('button', { name: '返回错题集' }).click();
    await parentPage.getByRole('button', { name: '我的', exact: true }).click();
    await parentPage.getByRole('button', { name: '退出此设备' }).click();
    await parentPage.getByRole('button', { name: '忘记密码，使用恢复码' }).click();
    await parentPage.getByLabel('恢复码', { exact: true }).fill(replacementCode);
    await parentPage.getByLabel('新的家长密码').fill('replacement password 456');
    await parentPage.getByRole('button', { name: '重设密码并登录' }).click();
    await expect(parentPage.getByRole('heading', { name: '请保存恢复码' })).toBeVisible();
    await expect(parentPage.getByLabel('恢复码', { exact: true })).not.toHaveValue(initial.recoveryCode);
    await parentPage.getByLabel('我已将恢复码保存在安全的地方').check();
    await parentPage.getByRole('button', { name: '进入错题集' }).click();
    await expect(parentPage.getByTestId('library-id')).toHaveText(initial.library.id);
    expect((await request.get(`${server.url}/api/v1/home`, { headers: { Authorization: `Bearer ${initial.token}` } })).status()).toBe(401);
    expect(await parentPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await parentPage.screenshot({ path: `test-results/home-mobile-${test.info().project.name}.png`, fullPage: true });
  } finally { await Promise.allSettled([parent.close(), child.close()]); await server.stop(); await rm(dataDir, { recursive: true, force: true }); }
});
