import { expect, test } from '@playwright/test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { startServer } from './server.ts';

test('上传、框题、保存草稿、继续收集和补充信息，第二设备可追溯原图', async ({ page, browser, request }) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'klbook-collection-browser-'));
  let server = await startServer(dataDir);
  const second = await browser.newContext();
  try {
    const setupCode = (await readFile(join(dataDir, 'setup-code.txt'), 'utf8')).trim();
    await request.post(`${server.url}/api/v1/setup`, { data: { setupCode, username: 'parent', password: 'family password 123', learnerName: '小明', deviceName: '设置电脑' } });
    const image = await sharp(await readFile(new URL('../fixtures/paper.svg', import.meta.url))).png().toBuffer();
    const login = async (target: typeof page) => {
      await target.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
      await target.goto(server.url);
      await target.getByLabel('家长账号').fill('parent');
      await target.getByLabel('家长密码', { exact: true }).fill('family password 123');
      await target.getByRole('button', { name: '登录此设备' }).click();
      await expect(target.getByRole('heading', { name: '小明的错题集' })).toBeVisible();
    };
    await login(page);
    await expect(page.getByRole('button', { name: '收集一道错题' })).toBeVisible();
    await page.getByRole('button', { name: '收集一道错题' }).click();
    await page.getByLabel('选择题目图片').setInputFiles({ name: '数学作业.png', mimeType: 'image/png', buffer: image });
    await expect(page.getByRole('heading', { name: '整理这道题' })).toBeVisible();
    const frame = page.getByRole('img', { name: '框选题目范围' });
    await expect(frame).toBeVisible();
    await frame.scrollIntoViewIfNeeded();
    const bounds = (await frame.boundingBox())!;
    await page.mouse.move(bounds.x + bounds.width * .05, bounds.y + bounds.height * .11);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width * .87, bounds.y + bounds.height * .22);
    await page.mouse.up();
    await page.getByRole('combobox', { name: '学科', exact: true }).selectOption({ label: '数学' });
    await page.getByLabel('来源（选填）').fill('练习册');
    await page.getByRole('button', { name: '保存草稿' }).click();
    await expect(page.getByRole('status')).toContainText('草稿已保存到家庭资料库');
    await page.getByRole('button', { name: '返回列表' }).click();
    await page.getByRole('button', { name: '草稿', exact: true }).click();
    await page.getByRole('button', { name: '继续整理' }).click();
    await expect(page.getByLabel('来源（选填）')).toHaveValue('练习册');
    await page.getByRole('button', { name: '保存到错题集' }).click();
    await expect(page.getByRole('heading', { name: '错题详情' })).toBeVisible();
    await expect(page.getByText('已同步到家庭资料库', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '补充或更正信息' }).click();
    await page.getByLabel('页码（选填）').fill('3');
    await page.getByLabel('题号（选填）').fill('1');
    await page.getByLabel('备注（选填）').fill('还没弄懂，先记下来');
    await page.getByRole('button', { name: '保存修改' }).click();
    await expect(page.getByText('还没弄懂，先记下来', { exact: true })).toBeVisible();
    const port = Number(new URL(server.url).port);
    await server.stop();
    server = await startServer(dataDir, port);
    await page.reload();
    await page.getByRole('button', { name: '打开错题' }).click();
    await expect(page.getByText('还没弄懂，先记下来', { exact: true })).toBeVisible();
    const secondPage = await second.newPage();
    await login(secondPage);
    await secondPage.getByRole('button', { name: '打开错题' }).click();
    await secondPage.getByRole('button', { name: '查看原始页' }).click();
    await expect(secondPage.getByRole('img', { name: '原始页（保留作答和批改）' })).toBeVisible();
    await secondPage.screenshot({ path: `test-results/collection-original-${test.info().project.name}.png`, fullPage: true });
  } finally { await second.close().catch(() => {}); await server.stop(); await rm(dataDir, { recursive: true, force: true }); }
});

test('写入失败和响应丢失后保留材料，重开及重复保存不会多建一道题', async ({ page, request }) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'klbook-collection-browser-'));
  const server = await startServer(dataDir);
  try {
    const setupCode = (await readFile(join(dataDir, 'setup-code.txt'), 'utf8')).trim();
    const initial = await request.post(`${server.url}/api/v1/setup`, { data: { setupCode, username: 'parent', password: 'family password 123', learnerName: '小明', deviceName: '设置电脑' } });
    const token = (await initial.json()).token;
    const image = await sharp(await readFile(new URL('../fixtures/paper.svg', import.meta.url))).png().toBuffer();
    await writeFile(join(dataDir, 'attachments', 'pages'), 'simulate unavailable storage');
    await page.goto(server.url);
    await page.getByLabel('家长账号').fill('parent');
    await page.getByLabel('家长密码', { exact: true }).fill('family password 123');
    await page.getByRole('button', { name: '登录此设备' }).click();
    await page.getByRole('button', { name: '收集一道错题' }).click();
    await page.getByLabel('选择题目图片').setInputFiles({ name: '待恢复的作业.png', mimeType: 'image/png', buffer: image });
    await expect(page.getByRole('alert')).toContainText('图片未能完整保存');
    await expect(page.getByText('已同步到家庭资料库', { exact: true })).toHaveCount(0);
    await page.reload();
    await expect(page.getByText('还有一张图片等待上传', { exact: true })).toBeVisible();
    await rm(join(dataDir, 'attachments', 'pages'));
    await page.route('**/api/v1/collection/drafts', async route => { await route.fetch(); await route.abort(); });
    await page.getByRole('button', { name: '继续上传' }).click();
    await expect(page.getByRole('alert')).toContainText('无法连接家庭电脑');
    await page.reload();
    await page.unroute('**/api/v1/collection/drafts');
    await page.getByRole('button', { name: '继续上传' }).click();
    await expect(page.getByRole('heading', { name: '整理这道题' })).toBeVisible();
    await page.getByRole('button', { name: '选择整页' }).click();
    await page.getByRole('combobox', { name: '学科', exact: true }).selectOption({ label: '科学' });
    await page.getByLabel('备注（选填）').fill('保存失败也不要丢掉这句话');
    await page.route('**/api/v1/collection/questions/*', async route => {
      if (route.request().method() === 'PUT') { await route.fetch(); await route.abort(); }
      else await route.continue();
    });
    await page.getByRole('button', { name: '保存到错题集' }).click();
    await expect(page.getByRole('alert')).toContainText('当前填写内容仍保留');
    await expect(page.getByLabel('备注（选填）')).toHaveValue('保存失败也不要丢掉这句话');
    await expect(page.getByText('已同步到家庭资料库', { exact: true })).toHaveCount(0);
    await page.unroute('**/api/v1/collection/questions/*');
    await page.getByRole('button', { name: '保存到错题集' }).click();
    await expect(page.getByRole('heading', { name: '错题详情' })).toBeVisible();
    const records = await request.get(`${server.url}/api/v1/collection/questions?state=collected`, { headers: { Authorization: `Bearer ${token}` } });
    const list = await records.json();
    expect(list.total).toBe(1);
    expect(list.items[0].revision).toBe(2);
    expect(list.items[0].note).toBe('保存失败也不要丢掉这句话');
  } finally { await server.stop(); await rm(dataDir, { recursive: true, force: true }); }
});
