import { expect, test } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import sharp from 'sharp';
import { startServer } from './server.ts';

async function setupFamily(request: APIRequestContext, url: string, dataDir: string, learnerName: string) {
  return (await request.post(`${url}/api/v1/setup`, { data: {
    setupCode: (await readFile(join(dataDir, 'setup-code.txt'), 'utf8')).trim(), username: 'parent', password: 'family password 123', learnerName, deviceName: '设置电脑'
  } })).json();
}

async function login(page: Page) {
  await page.getByLabel('家长账号').fill('parent'); await page.getByLabel('家长密码', { exact: true }).fill('family password 123');
  await page.getByRole('button', { name: '登录此设备', exact: true }).click();
}

test('拒绝未允许网页来源和不兼容服务，测试不发送原凭据；旧服务停机时仍可进入设置', async ({ page, request, context }) => {
  const root = await mkdtemp(join(tmpdir(), 'klbook-connection-denied-'));
  const first = await startServer(join(root, 'first'));
  const blocked = await startServer(join(root, 'blocked'));
  const observed: { path: string; method: string; auth?: string; cookie?: string }[] = [];
  let mode: 'foreign' | 'version' | 'html' = 'foreign';
  const incompatible = createServer((req, res) => {
    observed.push({ path: req.url ?? '', method: req.method ?? '', auth: req.headers.authorization, cookie: req.headers.cookie });
    res.setHeader('Access-Control-Allow-Origin', first.url);
    res.setHeader('Content-Type', mode === 'html' ? 'text/html' : 'application/json');
    res.end(mode === 'html' ? '<h1>A different service</h1>' : JSON.stringify({ app: mode === 'foreign' ? 'another-app' : 'klbook', apiVersion: mode === 'version' ? 2 : 1, initialized: true }));
  });
  incompatible.listen(0, '127.0.0.1'); await once(incompatible, 'listening');
  const address = incompatible.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  const incompatibleUrl = `http://127.0.0.1:${address.port}`;
  try {
    const setup = await setupFamily(request, first.url, join(root, 'first'), '原库');
    await page.goto(`${first.url}/learn/mine`);
    await login(page);
    await expect(page.getByTestId('library-id')).toHaveText(setup.library.id);
    if (process.platform === 'win32' && test.info().project.name === 'webkit') {
      test.info().annotations.push({ type: 'browser limitation', description: 'Windows WebKit原生fetch在credentials:omit时仍发送人工Cookie，独立探针另记失败；本用例仍核对应用真实令牌、无业务请求及兼容性处理。' });
    } else await context.addCookies([{ name: 'credential-probe', value: 'must-not-be-sent', url: incompatibleUrl }]);
    await page.getByRole('button', { name: '连接设置', exact: true }).click();
    await page.getByLabel('后端服务地址', { exact: true }).fill(blocked.url);
    await page.getByRole('button', { name: '测试连接', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('无法连接');
    await expect(page.getByRole('button', { name: '使用此地址并登录', exact: true })).toBeDisabled();
    await page.getByLabel('后端服务地址', { exact: true }).fill(incompatibleUrl);
    for (const variant of ['foreign', 'version', 'html'] as const) {
      mode = variant;
      await page.getByRole('button', { name: '测试连接', exact: true }).click();
      await expect(page.getByRole('alert')).toContainText('不兼容');
      await expect(page.getByRole('button', { name: '使用此地址并登录', exact: true })).toBeDisabled();
      await expect(page.getByRole('definition')).toHaveText(first.url);
    }
    expect(observed).toEqual(Array.from({ length: 3 }, () => ({ path: '/api/v1/info', method: 'GET', auth: undefined, cookie: undefined })));
    await page.getByRole('button', { name: '返回', exact: true }).click();
    await expect(page.getByTestId('library-id')).toHaveText(setup.library.id);
    await first.stop();
    await page.getByRole('button', { name: '连接设置', exact: true }).click();
    await page.getByRole('button', { name: '测试连接', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('无法连接');
    await expect(page.getByLabel('后端服务地址', { exact: true })).toBeEnabled();
  } finally { incompatible.close(); await blocked.stop(); await first.stop(); await rm(root, { recursive: true, force: true }); }
});

test('首次连接和登录前可设置地址，格式错误不保存，不可达地址单独暂存且原连接仍可使用', async ({ page, request }) => {
  const root = await mkdtemp(join(tmpdir(), 'klbook-pending-address-'));
  const active = await startServer(join(root, 'active'));
  const unavailable = await startServer(join(root, 'unavailable'));
  await unavailable.stop();
  try {
    await page.goto(active.url);
    await expect(page.getByRole('heading', { name: '建立家庭资料库', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '连接设置', exact: true }).click();
    for (const address of ['http://192.168.1.50:8787', 'https://user:password@example.com', 'https://example.com/api', 'https://example.com?secret=test', 'https:example.com', 'https://example.com:0']) {
      await page.getByLabel('后端服务地址', { exact: true }).fill(address);
      await page.getByRole('button', { name: '保存待连接地址', exact: true }).click();
      await expect(page.getByRole('alert')).toContainText('服务地址');
      await expect(page.getByRole('definition')).toHaveText(active.url);
    }
    await page.getByLabel('后端服务地址', { exact: true }).fill(unavailable.url);
    await page.getByRole('button', { name: '测试连接', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('无法连接');
    await expect(page.getByRole('button', { name: '使用此地址并登录', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '保存待连接地址', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('当前连接保持不变');
    await page.reload();
    await expect(page.getByRole('heading', { name: '建立家庭资料库', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '连接设置', exact: true }).click();
    await expect(page.getByLabel('后端服务地址', { exact: true })).toHaveValue(unavailable.url);
    await expect(page.getByRole('definition')).toHaveText(active.url);
    await page.getByRole('button', { name: '返回', exact: true }).click();
    const setup = await setupFamily(request, active.url, join(root, 'active'), '原资料库');
    await page.reload(); await expect(page.getByRole('heading', { name: '登录家庭资料库', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '连接设置', exact: true }).click();
    await page.getByRole('button', { name: '返回', exact: true }).click();
    await login(page);
    await page.getByRole('button', { name: '我的', exact: true }).click();
    await expect(page.getByTestId('library-id')).toHaveText(setup.library.id);
    await page.getByRole('button', { name: '连接设置', exact: true }).click();
    await expect(page.getByLabel('后端服务地址', { exact: true })).toHaveValue(unavailable.url);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/connection-390-${test.info().project.name}.png`, fullPage: true });
  } finally { await active.stop(); await rm(root, { recursive: true, force: true }); }
});

test('配置另一服务先无凭据测试，再登录读取该库题目和附件，重开保留且其他设备不变', async ({ page, browser, request }) => {
  const root = await mkdtemp(join(tmpdir(), 'klbook-connection-'));
  const first = await startServer(join(root, 'first'));
  const second = await startServer(join(root, 'second'), 0, [first.url]);
  const other = await browser.newContext();
  try {
    const a = await setupFamily(request, first.url, join(root, 'first'), '第一资料库');
    const b = await setupFamily(request, second.url, join(root, 'second'), '第二资料库');
    const bytes = await sharp(await readFile('test/fixtures/paper.svg')).png().toBuffer();
    const draft = await (await request.post(`${second.url}/api/v1/collection/drafts`, { headers: { Authorization: `Bearer ${b.token}`, 'Content-Type': 'image/png', 'Idempotency-Key': crypto.randomUUID() }, data: bytes })).json();
    const otherPage = await other.newPage();
    for (const device of [page, otherPage]) { await device.goto(`${first.url}/learn/mine`); await login(device); await expect(device.getByTestId('library-id')).toHaveText(a.library.id); }
    const sent: { path: string; authorization?: string; cookie?: string; method: string }[] = [];
    const target = second.url.replace('127.0.0.1', 'localhost');
    page.on('request', req => { if (new URL(req.url()).origin === target) sent.push({ path: new URL(req.url()).pathname, method: req.method(), authorization: req.headers().authorization, cookie: req.headers().cookie }); });
    await page.getByRole('button', { name: '连接设置', exact: true }).click();
    await page.getByLabel('后端服务地址', { exact: true }).fill(`${target}/`);
    await page.getByRole('button', { name: '测试连接', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('连接成功，服务兼容');
    expect(sent.filter(item => item.method !== 'OPTIONS')).toEqual([{ path: '/api/v1/info', method: 'GET', authorization: undefined, cookie: undefined }]);
    await page.getByRole('button', { name: '使用此地址并登录', exact: true }).click();
    await expect(page.getByRole('heading', { name: '登录家庭资料库', exact: true })).toBeVisible();
    expect(sent.every(item => item.path === '/api/v1/info' && !item.authorization && !item.cookie)).toBe(true);
    await login(page);
    await expect(page.getByTestId('library-id')).toHaveText(b.library.id);
    await expect(page.getByText('服务地址已更新，请由家长登录目标资料库。', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '收集', exact: true }).click();
    await page.getByRole('button', { name: '继续整理', exact: true }).click();
    await expect(page.getByRole('img', { name: '用于框题的原始页预览', exact: true })).toBeVisible();
    expect(sent.some(item => item.path.includes(draft.originalPage.id) && !!item.authorization)).toBe(true);
    await page.getByRole('button', { name: '返回列表', exact: true }).click();
    await page.reload(); await page.getByRole('button', { name: '我的', exact: true }).click();
    await expect(page.getByTestId('library-id')).toHaveText(b.library.id);
    await page.getByRole('button', { name: '连接设置', exact: true }).click();
    await expect(page.getByText(target, { exact: true })).toBeVisible();
    await otherPage.reload(); await expect(otherPage.getByTestId('library-id')).toHaveText(a.library.id);
    expect(new URL(page.url()).origin).toBe(first.url);
  } finally { await other.close(); await second.stop(); await first.stop(); await rm(root, { recursive: true, force: true }); }
});
