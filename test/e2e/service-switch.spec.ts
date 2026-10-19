import { test, expect } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { startServer } from './server.ts';
import { reveal } from './interactions.ts';

test.use({ hasTouch: true });

async function setup(request: APIRequestContext, url: string, dir: string) {
  const setupCode = (await readFile(join(dir, 'setup-code.txt'), 'utf8')).trim();
  return (await request.post(`${url}/api/v1/setup`, { data: { setupCode, username: 'parent', password: 'family password 123', learnerName: '小明', deviceName: '电脑' } })).json();
}
async function login(page: Page) {
  await page.getByLabel('家长账号').fill('parent');
  await page.getByLabel('家长密码', { exact: true }).fill('family password 123');
  await page.getByRole('button', { name: '登录此设备', exact: true }).click();
  await expect(page.getByRole('button', { name: '我的', exact: true })).toBeVisible();
}
async function settings(page: Page) {
  await page.getByRole('button', { name: '我的', exact: true }).click();
  await page.getByRole('button', { name: '连接设置', exact: true }).click();
}
async function select(page: Page, address: string) {
  await page.getByLabel('后端服务地址', { exact: true }).fill(address);
  await page.getByRole('button', { name: '测试连接', exact: true }).click();
  await expect(page.getByRole('button', { name: '使用此地址并登录', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '使用此地址并登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '登录家庭资料库', exact: true })).toBeVisible();
}

test('切换前显示本机待处理数量，不同库隔离材料，同库别名登录后续传', async ({ page, request }) => {
  const root = await mkdtemp(join(tmpdir(), 'klbook-switch-'));
  const first = await startServer(join(root, 'a'));
  const second = await startServer(join(root, 'b'), 0, [first.url]);
  try {
    const a = await setup(request, first.url, join(root, 'a'));
    const b = await setup(request, second.url, join(root, 'b'));
    const bytes = await sharp(await readFile('test/fixtures/paper.svg')).png().toBuffer();
    await page.goto(`${first.url}/learn/collect`); await login(page);
    await page.getByLabel('从相册选择（可多选）').setInputFiles(['一.png', '二.png', '三.png'].map(name => ({ name, mimeType: 'image/png', buffer: bytes })));
    await reveal(page.getByRole('button', { name: '选择整页', includeHidden: true }));
    await page.getByRole('button', { name: '选择整页' }).click();
    await page.getByRole('button', { name: '下一步，选学科' }).click();
    await page.getByRole('combobox', { name: '学科', exact: true }).selectOption('math');
    await expect(page.getByText('草稿已同步到家庭电脑', { exact: true })).toBeVisible();
    await page.route(`${first.url}/api/v1/collection/questions/*`, route => route.request().method() === 'PUT' ? route.abort() : route.continue());
    await reveal(page.getByLabel('备注（选填）'));
    await page.getByLabel('备注（选填）').fill('只属于原资料库的备注');
    await page.getByRole('button', { name: '返回列表', exact: true }).click();
    await settings(page);
    await expect(page.getByText('待上传图片：2 张', { exact: true })).toBeVisible();
    await expect(page.getByText('未同步或未提交的题目整理：1 道', { exact: true })).toBeVisible();
    const beforeLogin: { path: string; authenticated: boolean }[] = [];
    const listener = (req: import('@playwright/test').Request) => {
      if (new URL(req.url()).origin === second.url) beforeLogin.push({ path: new URL(req.url()).pathname, authenticated: !!req.headers().authorization });
    };
    page.on('request', listener);
    await select(page, second.url);
    expect(beforeLogin.length).toBeGreaterThan(0);
    expect(beforeLogin.every(item => item.path === '/api/v1/info' && !item.authenticated)).toBe(true);
    page.off('request', listener);
    await login(page);
    await page.getByRole('button', { name: '我的', exact: true }).click();
    await expect(page.getByTestId('library-id')).toHaveText(b.library.id);
    await page.reload();
    await page.getByRole('button', { name: '收集', exact: true }).click();
    await expect(page.getByRole('button', { name: '继续整理', exact: true })).toHaveCount(0);
    await expect(page.getByRole('region', { name: '本机待上传图片' })).toHaveCount(0);
    const bQuestions = await (await request.get(`${second.url}/api/v1/collection/questions?state=draft`, { headers: { Authorization: `Bearer ${b.token}` } })).json();
    expect(bQuestions.total).toBe(0);
    await page.unroute(`${first.url}/api/v1/collection/questions/*`);
    await settings(page);
    await select(page, first.url.replace('127.0.0.1', 'localhost'));
    await login(page);
    await page.getByRole('button', { name: '我的', exact: true }).click();
    await expect(page.getByTestId('library-id')).toHaveText(a.library.id);
    await page.getByRole('button', { name: '收集', exact: true }).click();
    await expect(page.getByText('还有 2 张图片等待上传', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '继续整理', exact: true }).click();
    await reveal(page.getByLabel('备注（选填）'));
    await expect(page.getByLabel('备注（选填）')).toHaveValue('只属于原资料库的备注');
    const aQuestions = await (await request.get(`${first.url}/api/v1/collection/questions?state=draft`, { headers: { Authorization: `Bearer ${a.token}` } })).json();
    expect(aQuestions.total).toBe(1);
    expect(aQuestions.items[0].note).toBe('只属于原资料库的备注');
  } finally { await second.stop(); await first.stop(); await rm(root, { recursive: true, force: true }); }
});

test('连接设置打开后停止旧连接补传，迟到的登录态读取不启动上传', async ({ page, request }) => {
  const root = await mkdtemp(join(tmpdir(), 'klbook-switch-late-'));
  const first = await startServer(join(root, 'a'));
  const second = await startServer(join(root, 'b'), 0, [first.url]);
  let release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  try {
    const a = await setup(request, first.url, join(root, 'a'));
    await setup(request, second.url, join(root, 'b'));
    await page.goto(`${first.url}/learn/collect`); await login(page);
    const bytes = await sharp(await readFile('test/fixtures/paper.svg')).png().toBuffer();
    await page.route(`${first.url}/api/v1/collection/drafts`, route => route.abort());
    await page.getByLabel('从相册选择（可多选）').setInputFiles({ name: '旧库离线材料.png', mimeType: 'image/png', buffer: bytes });
    await expect(page.getByRole('heading', { name: '框住这道题' })).toBeVisible();
    await page.getByRole('button', { name: '返回列表', exact: true }).click();
    await page.unroute(`${first.url}/api/v1/collection/drafts`);
    let waiting = false;
    await page.route(`${first.url}/api/v1/home`, async route => {
      const response = await route.fetch();
      if (!waiting) { waiting = true; await held; }
      await route.fulfill({ response }).catch(() => {});
    });
    await page.reload();
    await expect.poll(() => waiting).toBe(true);
    await page.getByRole('button', { name: '连接设置', exact: true }).click();
    await expect(page.getByText('待上传图片：1 张', { exact: true })).toBeVisible();
    const uploads: string[] = [];
    page.on('request', req => { if (req.url() === `${first.url}/api/v1/collection/drafts` && req.method() === 'POST') uploads.push(req.url()); });
    release();
    await select(page, second.url); await login(page);
    await page.getByRole('button', { name: '我的', exact: true }).click();
    expect(uploads).toHaveLength(0);
    const original = await (await request.get(`${first.url}/api/v1/collection/questions?state=draft`, { headers: { Authorization: `Bearer ${a.token}` } })).json();
    expect(original.total).toBe(0);
    await settings(page); await select(page, first.url); await login(page);
    await page.getByRole('button', { name: '收集', exact: true }).click();
    await expect(page.getByRole('button', { name: '继续整理', exact: true })).toHaveCount(1);
  } finally { release(); await second.stop(); await first.stop(); await rm(root, { recursive: true, force: true }); }
});

test.describe('准备好的网页入口保持不变', () => {
  test.use({ serviceWorkers: 'allow' });

  test('旧服务停机后重开并收集，换到其他库隔离，再登录原库新地址只补传一次', async ({ page, request }) => {
    const root = await mkdtemp(join(tmpdir(), 'klbook-switch-offline-'));
    const first = await startServer(join(root, 'a'));
    const second = await startServer(join(root, 'b'), 0, [first.url]);
    let restarted: Awaited<ReturnType<typeof startServer>> | undefined;
    try {
      const a = await setup(request, first.url, join(root, 'a'));
      const b = await setup(request, second.url, join(root, 'b'));
      await page.goto(`${first.url}/learn/collect`); await login(page);
      await expect(page.getByRole('heading', { name: '还没有草稿' })).toBeVisible();
      await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker?.controller)).toBe(true);
      await first.stop();
      await page.reload();
      const bytes = await sharp(await readFile('test/fixtures/paper.svg')).png().toBuffer();
      await page.getByLabel('从相册选择（可多选）').setInputFiles({ name: '离线收集.png', mimeType: 'image/png', buffer: bytes });
      await reveal(page.getByRole('button', { name: '选择整页', includeHidden: true }));
      await page.getByRole('button', { name: '选择整页' }).click();
      await page.getByRole('button', { name: '下一步，选学科' }).click();
      await page.getByRole('combobox', { name: '学科', exact: true }).selectOption('science');
      await page.getByRole('button', { name: '保存到错题集', exact: true }).click();
      await expect(page.getByText('本机已收集，待同步', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: '返回列表', exact: true }).click();
      await settings(page);
      await expect(page.getByText('待上传图片：1 张', { exact: true })).toBeVisible();
      await expect(page.getByText('未同步或未提交的题目整理：1 道', { exact: true })).toBeVisible();
      await select(page, second.url); await login(page);
      await page.reload();
      await page.getByRole('button', { name: '首页', exact: true }).click();
      await expect(page.getByRole('button', { name: '打开错题' })).toHaveCount(0);
      expect(new URL(page.url()).origin).toBe(first.url);
      const bList = await (await request.get(`${second.url}/api/v1/collection/questions?state=collected`, { headers: { Authorization: `Bearer ${b.token}` } })).json();
      expect(bList.total).toBe(0);
      restarted = await startServer(join(root, 'a'), 0, [first.url]);
      await settings(page); await select(page, restarted.url); await login(page);
      await page.getByRole('button', { name: '首页', exact: true }).click();
      await expect(page.getByRole('button', { name: '打开错题' })).toHaveCount(1);
      await page.reload();
      await expect(page.getByRole('button', { name: '打开错题' })).toHaveCount(1);
      const list = await (await request.get(`${restarted.url}/api/v1/collection/questions?state=collected`, { headers: { Authorization: `Bearer ${a.token}` } })).json();
      expect(list.total).toBe(1); expect(list.items[0].subjectId).toBe('science');
      expect((await request.get(`${restarted.url}/api/v1/collection/pages/${list.items[0].originalPage.id}/original`, { headers: { Authorization: `Bearer ${a.token}` } })).status()).toBe(200);
    } finally { await restarted?.stop(); await second.stop(); await first.stop(); await rm(root, { recursive: true, force: true }); }
  });
});

for (const delayed of ['身份检查', '上传回执']) {
  test(`${delayed}迟到时仍显示旧库暂存，切换后不串库，切回不重复上传`, async ({ page, request }) => {
    const root = await mkdtemp(join(tmpdir(), 'klbook-switch-response-'));
    const first = await startServer(join(root, 'a'));
    const second = await startServer(join(root, 'b'), 0, [first.url]);
    let release = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    try {
      const a = await setup(request, first.url, join(root, 'a'));
      const b = await setup(request, second.url, join(root, 'b'));
      await page.goto(`${first.url}/learn/collect`); await login(page);
      const bytes = await sharp(await readFile('test/fixtures/paper.svg')).png().toBuffer();
      await page.route(`${first.url}/api/v1/collection/drafts`, route => route.abort());
      await page.getByLabel('从相册选择（可多选）').setInputFiles({ name: '保留的材料.png', mimeType: 'image/png', buffer: bytes });
      await expect(page.getByRole('heading', { name: '框住这道题' })).toBeVisible();
      await page.getByRole('button', { name: '返回列表', exact: true }).click();
      await page.unroute(`${first.url}/api/v1/collection/drafts`);
      let waiting = false;
      const endpoint = delayed === '身份检查' ? '/api/v1/info' : '/api/v1/collection/drafts';
      await page.route(`${first.url}${endpoint}`, async route => {
        const response = await route.fetch();
        if (!waiting) { waiting = true; await held; }
        await route.fulfill({ response }).catch(() => {});
      });
      await page.reload();
      await expect.poll(() => waiting).toBe(true);
      await page.getByRole('button', { name: '连接设置', exact: true }).click();
      await expect(page.getByText('待上传图片：1 张', { exact: true })).toBeVisible();
      const secondTokens: (string | undefined)[] = [];
      page.on('request', req => { if (new URL(req.url()).origin === second.url) secondTokens.push(req.headers().authorization); });
      await select(page, second.url); await login(page);
      release();
      await page.getByRole('button', { name: '收集', exact: true }).click();
      await expect(page.getByRole('button', { name: '继续整理', exact: true })).toHaveCount(0);
      const bList = await (await request.get(`${second.url}/api/v1/collection/questions?state=draft`, { headers: { Authorization: `Bearer ${b.token}` } })).json();
      expect(bList.total).toBe(0);
      expect(secondTokens).not.toContain(`Bearer ${a.token}`);
      await settings(page); await select(page, first.url); await login(page);
      await page.getByRole('button', { name: '收集', exact: true }).click();
      await expect(page.getByRole('button', { name: '继续整理', exact: true })).toHaveCount(1);
      await page.reload();
      await expect(page.getByRole('button', { name: '继续整理', exact: true })).toHaveCount(1);
      const aList = await (await request.get(`${first.url}/api/v1/collection/questions?state=draft`, { headers: { Authorization: `Bearer ${a.token}` } })).json();
      expect(aList.total).toBe(1);
    } finally { release(); await second.stop(); await first.stop(); await rm(root, { recursive: true, force: true }); }
  });
}

test('会话撤销后重开仍显示原库待处理数量，重新登录才继续补传', async ({ page, request }) => {
  const root = await mkdtemp(join(tmpdir(), 'klbook-switch-revoked-'));
  const first = await startServer(join(root, 'a'));
  try {
    const a = await setup(request, first.url, join(root, 'a'));
    const headers = { Authorization: `Bearer ${a.token}` };
    const grant = await (await request.post(`${first.url}/api/v1/admin/grants`, { headers, data: { password: 'family password 123' } })).json();
    await page.goto(`${first.url}/learn/collect`); await login(page);
    const bytes = await sharp(await readFile('test/fixtures/paper.svg')).png().toBuffer();
    await page.route(`${first.url}/api/v1/collection/drafts`, route => route.abort());
    await page.getByLabel('从相册选择（可多选）').setInputFiles({ name: '撤销后仍保留.png', mimeType: 'image/png', buffer: bytes });
    await expect(page.getByRole('heading', { name: '框住这道题' })).toBeVisible();
    await page.getByRole('button', { name: '返回列表', exact: true }).click();
    await settings(page);
    await expect(page.getByText('待上传图片：1 张', { exact: true })).toBeVisible();
    const devices = await (await request.get(`${first.url}/api/v1/admin/devices`, { headers: { ...headers, 'X-Parent-Authorization': grant.token } })).json();
    const device = devices.find((value: { id: string }) => value.id !== a.session.id);
    expect(device).toBeTruthy();
    expect((await request.delete(`${first.url}/api/v1/admin/devices/${device.id}`, { headers: { ...headers, 'X-Parent-Authorization': grant.token } })).ok()).toBe(true);
    await page.unroute(`${first.url}/api/v1/collection/drafts`);
    await page.getByRole('button', { name: '返回', exact: true }).click();
    await expect(page.getByRole('heading', { name: '登录家庭资料库', exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: '登录家庭资料库', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '连接设置', exact: true }).click();
    await expect(page.getByText('待上传图片：1 张', { exact: true })).toBeVisible();
    expect((await (await request.get(`${first.url}/api/v1/collection/questions?state=draft`, { headers })).json()).total).toBe(0);
    await select(page, first.url); await login(page);
    await page.getByRole('button', { name: '收集', exact: true }).click();
    await expect(page.getByRole('button', { name: '继续整理', exact: true })).toHaveCount(1);
    expect((await (await request.get(`${first.url}/api/v1/collection/questions?state=draft`, { headers })).json()).total).toBe(1);
  } finally { await first.stop(); await rm(root, { recursive: true, force: true }); }
});
