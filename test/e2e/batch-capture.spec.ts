import { expect, test } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { startServer } from './server.ts';

test.use({ hasTouch: true });

test('相册多选逐张整理，取消单张后重开保留进度，另一设备能找回', async ({ page, browser, request }) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'klbook-batch-'));
  const server = await startServer(dataDir);
  const other = await browser.newContext();
  try {
    const setupCode = (await readFile(join(dataDir, 'setup-code.txt'), 'utf8')).trim();
    await request.post(`${server.url}/api/v1/setup`, { data: { setupCode, username: 'parent', password: 'family password 123', learnerName: '小明', deviceName: '电脑' } });
    const image = await sharp(await readFile(new URL('../fixtures/paper.svg', import.meta.url))).png().toBuffer();
    await page.route('**/*', route => new URL(route.request().url()).origin === server.url ? route.continue() : route.abort());
    const login = async (target: typeof page) => {
      await target.goto(server.url);
      await target.getByLabel('家长账号').fill('parent');
      await target.getByLabel('家长密码', { exact: true }).fill('family password 123');
      await target.getByRole('button', { name: '登录此设备' }).click();
    };
    await login(page);
    await page.getByRole('button', { name: '收集', exact: true }).click();
    await expect(page.getByLabel('从相册选择（可多选）')).toBeEnabled();
    await page.getByLabel('从相册选择（可多选）').setInputFiles(['第一张.png', '取消这张.png', '第三张.png'].map(name => ({ name, mimeType: 'image/png', buffer: image })));
    await expect(page.getByRole('heading', { name: '框住这道题' })).toBeVisible();
    await page.getByRole('button', { name: '选择整页' }).click();
    await page.getByRole('button', { name: '下一步，选学科' }).click();
    await page.getByRole('combobox', { name: '学科', exact: true }).selectOption('math');
    await page.getByRole('button', { name: '保存到错题集' }).click();
    await page.getByRole('button', { name: '取消 取消这张.png', exact: true }).click();
    await expect(page.getByText('已上传 1 / 3 张，已取消 1 张', { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByText('还有 1 张图片等待上传', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '继续上传 第三张.png', exact: true }).click();
    await expect(page.getByRole('heading', { name: '框住这道题' })).toBeVisible();
    await page.getByRole('button', { name: '选择整页' }).click();
    await page.getByRole('button', { name: '下一步，选学科' }).click();
    await page.getByRole('combobox', { name: '学科', exact: true }).selectOption('english');
    await page.getByRole('button', { name: '保存到错题集' }).click();
    const second = await other.newPage();
    await login(second);
    await expect(second.getByRole('button', { name: '打开错题' })).toHaveCount(2);
    await page.screenshot({ path: `test-results/batch-${test.info().project.name}.png`, fullPage: true });
  } finally { await other.close(); await server.stop(); await rm(dataDir, { recursive: true, force: true }); }
});

test('拍照取消有退路，批量坏图可跳过，触控框题与电脑停止后的重试保留材料', async ({ page, request }) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'klbook-capture-failure-'));
  let server = await startServer(dataDir);
  try {
    const setupCode = (await readFile(join(dataDir, 'setup-code.txt'), 'utf8')).trim();
    const initial = await request.post(`${server.url}/api/v1/setup`, { data: { setupCode, username: 'parent', password: 'family password 123', learnerName: '小明', deviceName: '电脑' } });
    const token = (await initial.json()).token;
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(server.url);
    await page.getByLabel('家长账号').fill('parent');
    await page.getByLabel('家长密码', { exact: true }).fill('family password 123');
    await page.getByRole('button', { name: '登录此设备' }).click();
    await page.getByRole('button', { name: '收集', exact: true }).click();
    await page.getByLabel('拍照', { exact: true }).dispatchEvent('cancel');
    await expect(page.getByRole('status')).toContainText('没有取得照片');
    const image = await sharp({ create: { width: 160, height: 100, channels: 3, background: '#edf2e4' } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    await expect(page.getByLabel('从相册选择（可多选）')).toBeEnabled();
    await page.getByLabel('从相册选择（可多选）').setInputFiles([
      { name: '损坏的材料.heic', mimeType: 'image/heic', buffer: Buffer.from('not an image') },
      { name: '手机拍照.jpg', mimeType: 'image/jpeg', buffer: image }
    ]);
    await expect(page.getByRole('alert')).toContainText('图片无法读取');
    await page.getByRole('button', { name: '取消 损坏的材料.heic', exact: true }).click();
    const port = Number(new URL(server.url).port);
    await server.stop();
    await page.getByRole('button', { name: '继续上传 手机拍照.jpg', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: /^无法连接家庭电脑，请确认电脑已开机且服务运行，再重试$/ })).toBeVisible();
    await expect(page.getByText('手机拍照.jpg', { exact: true }).first()).toBeVisible();
    server = await startServer(dataDir, port);
    await page.getByRole('button', { name: '继续上传 手机拍照.jpg', exact: true }).click();
    const frame = page.getByRole('img', { name: '框选题目范围' });
    await expect(frame).toBeVisible();
    await frame.scrollIntoViewIfNeeded();
    const bounds = (await frame.boundingBox())!;
    await frame.dispatchEvent('pointerdown', { pointerId: 1, pointerType: 'touch', clientX: bounds.x + bounds.width * .1, clientY: bounds.y + bounds.height * .1 });
    await frame.dispatchEvent('pointermove', { pointerId: 1, pointerType: 'touch', clientX: bounds.x + bounds.width * .8, clientY: bounds.y + bounds.height * .6 });
    await frame.dispatchEvent('pointerup', { pointerId: 1, pointerType: 'touch', clientX: bounds.x + bounds.width * .8, clientY: bounds.y + bounds.height * .6 });
    await page.getByRole('button', { name: '下一步，选学科' }).click();
    await page.getByRole('combobox', { name: '学科', exact: true }).selectOption('science');
    await page.getByRole('button', { name: '保存到错题集' }).click();
    await expect(page.getByRole('heading', { name: '错题详情' })).toBeVisible();
    const records = await (await request.get(`${server.url}/api/v1/collection/questions?state=collected`, { headers: { Authorization: `Bearer ${token}` } })).json();
    expect(records.total).toBe(1);
    expect(records.items[0].originalPage.width).toBe(100);
    expect(records.items[0].originalPage.height).toBe(160);
    expect(records.items[0].region.width).toBeCloseTo(.7, 2);
    expect(records.items[0].region.height).toBeCloseTo(.5, 2);
  } finally { await server.stop(); await rm(dataDir, { recursive: true, force: true }); }
});
