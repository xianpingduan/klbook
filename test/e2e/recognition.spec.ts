import { expect, test } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../src/server/app.ts';
import type { APIRequestContext } from '@playwright/test';

async function recognitionFixture(request: APIRequestContext, wait = async () => {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'klbook-recognition-browser-'));
  const port = 49152 + Math.floor(Math.random() * 14000), url = `http://127.0.0.1:${port}`;
  let calls = 0;
  const app = createApp({ dataDir, allowedOrigins: [url], staticDir: resolve('dist/client'), ocrHttp: async () => {
    calls++;
    await wait();
    return Response.json({ header: { code: 0 }, payload: { result: { encoding: 'utf8', compress: 'raw', format: 'json', text: Buffer.from(JSON.stringify({ pages: [{ exception: 0, lines: [
      { exception: 0, coord: [{ x: 30, y: 100 }, { x: 400, y: 100 }, { x: 400, y: 140 }, { x: 30, y: 140 }], words: [{ content: '1. 计算 12 × 3 =' }] },
      { exception: 0, coord: [{ x: 30, y: 300 }, { x: 400, y: 300 }, { x: 400, y: 340 }, { x: 30, y: 340 }], words: [{ content: '2. 计算 25 + 16 =' }] }
    ] }] })).toString('base64') } } });
  } });
  await app.listen({ host: '127.0.0.1', port });
    const setupCode = (await readFile(join(dataDir, 'setup-code.txt'), 'utf8')).trim(), password = 'family password 123';
    const session = await (await request.post(`${url}/api/v1/setup`, { data: { setupCode, username: 'parent', password, learnerName: '小明', deviceName: '设置电脑' } })).json();
    const headers = { Authorization: `Bearer ${session.token}` };
    const grant = await (await request.post(`${url}/api/v1/admin/grants`, { headers, data: { password } })).json();
    await request.put(`${url}/api/v1/admin/ocr`, { headers: { ...headers, 'X-Parent-Authorization': grant.token }, data: { operationId: randomUUID(), expectedRevision: 0, config: { provider: 'xfyun', name: '收集识别', enabled: true, language: 'CHN_ENG', handwriting: true, formulas: false, timeoutSeconds: 5, retries: 0, monthlyLimit: 20, monthlyBudgetCents: 100, priceCents: 3.5 }, credentials: { appId: 'collect-app', apiKey: 'apikeyXXXXXXXXXXXXXXXXXXXXXXXXXX', secretKey: 'apisecretXXXXXXXXXXXXXXXXXXXXXXX' } } });
    return { url, headers, password, calls: () => calls, close: async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); } };
}

test('框题后后台识别，折叠建议按需采用；更正可追溯且重新识别不覆盖', async ({ page, request }) => {
  const f = await recognitionFixture(request), { url, headers, password } = f;
  try {
    await page.goto(`${url}/learn/collect`);
    await page.getByLabel('家长账号').fill('parent'); await page.getByLabel('家长密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录此设备', exact: true }).click();
    const bytes = await sharp(await readFile(new URL('../fixtures/paper.svg', import.meta.url))).png().toBuffer();
    await expect(page.getByLabel('选择题目图片')).toBeEnabled();
    await page.getByLabel('选择题目图片').setInputFiles({ name: '数学.png', mimeType: 'image/png', buffer: bytes });
    await expect(page.getByRole('button', { name: '下一步，选学科' })).toBeDisabled();
    expect(f.calls()).toBe(0);
    await expect(page.getByLabel('题干文字（选填，可更正）')).not.toBeVisible();
    await page.getByRole('button', { name: '选择整页', exact: true }).click();
    await page.getByRole('button', { name: '下一步，选学科' }).click();
    await page.getByText('识别文字（选看）', { exact: false }).click();
    await expect(page.getByRole('button', { name: '选用候选题 1', exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: '.scratch/issue-14/recognition-candidates-phone.png', fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole('button', { name: '选用候选题 1', exact: true }).click();
    await page.getByRole('button', { name: '确认采用建议', exact: true }).click();
    await page.getByText('识别文字（选看）', { exact: false }).click();
    await page.getByLabel('题干文字（选填，可更正）').fill('1. 计算 12 × 3 = 36（已核对）');
    await expect(page.getByRole('combobox', { name: '学科', exact: true })).toHaveValue('math');
    await page.getByRole('button', { name: '保存到错题集', exact: true }).click();
    await expect(page.getByRole('heading', { name: '错题详情', exact: true })).toBeVisible();
    await expect(page.getByText('1. 计算 12 × 3 = 36（已核对）', { exact: true })).toBeVisible();
    await page.getByText('查看采用时的识别结果', { exact: true }).click();
    await expect(page.getByText('1. 计算 12 × 3 =', { exact: true })).toBeVisible();
    expect(f.calls()).toBe(1);
    const collected = await (await request.get(`${url}/api/v1/collection/questions?state=collected`, { headers })).json();
    expect(collected.total).toBe(1);
    await page.getByRole('button', { name: '从此原始页再收集一道', exact: true }).click();
    await page.getByRole('button', { name: '选择整页', exact: true }).click();
    await page.getByRole('button', { name: '下一步，选学科' }).click();
    await page.getByText('识别文字（选看）', { exact: false }).click();
    await page.getByRole('button', { name: '选用候选题 2', exact: true }).click();
    await page.getByRole('button', { name: '确认采用建议', exact: true }).click();
    await page.getByRole('button', { name: '保存到错题集', exact: true }).click();
    expect((await (await request.get(`${url}/api/v1/collection/questions?state=collected`, { headers })).json()).total).toBe(2);
    expect(f.calls()).toBe(1);
    await page.getByRole('button', { name: '补充或更正信息', exact: true }).click();
    await page.getByText('识别文字（选看）', { exact: false }).click();
    await page.getByLabel('题干文字（选填，可更正）').fill('第二题手工更正，重试不能覆盖');
    let drop = true;
    await page.route('**/api/v1/collection/pages/*/recognitions/*', async route => {
      if (route.request().method() === 'PUT' && drop) { drop = false; await route.fetch(); await route.abort(); } else await route.continue();
    });
    await page.getByRole('button', { name: '识别当前范围', exact: true }).click();
    await expect(page.getByText('无法连接家庭电脑', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: '重试提交识别', exact: true }).click();
    await expect(page.getByLabel('题干文字（选填，可更正）')).toHaveValue('第二题手工更正，重试不能覆盖');
    expect(f.calls()).toBe(2);
    await page.getByRole('button', { name: '保存修改', exact: true }).click();
    await expect(page.getByRole('heading', { name: '错题详情', exact: true })).toBeVisible();
    await expect(page.getByText('第二题手工更正，重试不能覆盖', { exact: true })).toBeVisible();
    await page.screenshot({ path: '.scratch/issue-14/recognition-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: '.scratch/issue-14/recognition-phone.png', fullPage: true });
  } finally { await f.close(); }
});

test('识别迟到仍能立即保存，后台回执丢失后重试不重复调用或覆盖手工内容', async ({ page, request }) => {
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const f = await recognitionFixture(request, () => waiting);
  try {
    await page.goto(`${f.url}/learn/collect`);
    await page.getByLabel('家长账号').fill('parent'); await page.getByLabel('家长密码', { exact: true }).fill(f.password);
    await page.getByRole('button', { name: '登录此设备', exact: true }).click();
    const bytes = await sharp(await readFile(new URL('../fixtures/paper.svg', import.meta.url))).png().toBuffer();
    await expect(page.getByLabel('选择题目图片')).toBeEnabled();
    await page.getByLabel('选择题目图片').setInputFiles({ name: '等待.png', mimeType: 'image/png', buffer: bytes });
    await page.getByRole('button', { name: '选择整页', exact: true }).click();
    await page.route('**/api/v1/collection/pages/*/recognitions/*', async route => { await route.fetch(); await route.abort(); }, { times: 1 });
    await page.getByRole('button', { name: '下一步，选学科' }).click();
    await page.getByRole('combobox', { name: '学科', exact: true }).selectOption('science');
    await page.getByLabel('备注（选填）').fill('我先保存，不等识别');
    await expect.poll(f.calls).toBe(1);
    await page.getByText('识别文字（选看）', { exact: false }).click();
    await page.getByRole('button', { name: '重试后台识别', exact: true }).click();
    await expect(page.getByRole('button', { name: '重试后台识别', exact: true })).not.toBeVisible();
    expect(f.calls()).toBe(1);
    await page.getByRole('button', { name: '保存到错题集', exact: true }).click();
    await expect(page.getByRole('heading', { name: '错题详情', exact: true })).toBeVisible();
    const saved = (await (await request.get(`${f.url}/api/v1/collection/questions?state=collected`, { headers: f.headers })).json()).items[0];
    const results = `${f.url}/api/v1/collection/pages/${saved.originalPage.id}/recognitions`;
    expect((await (await request.get(results, { headers: f.headers })).json()).runs[0].status).toBe('running');
    release();
    await expect.poll(async () => (await (await request.get(results, { headers: f.headers })).json()).runs[0].status).toBe('succeeded');
    await page.reload(); await page.getByRole('button', { name: '首页', exact: true }).click();
    await page.getByRole('button', { name: '打开错题', exact: true }).click();
    await expect(page.getByText('我先保存，不等识别', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '补充或更正信息', exact: true }).click();
    await page.getByText('识别文字（选看）', { exact: false }).click();
    await expect(page.getByRole('button', { name: '选用候选题 1', exact: true })).toBeVisible();
    await expect(page.getByRole('combobox', { name: '学科', exact: true })).toHaveValue('science');
    await expect(page.getByLabel('题干文字（选填，可更正）')).toHaveValue('');
    expect(f.calls()).toBe(1);
  } finally { release(); await f.close(); }
});
