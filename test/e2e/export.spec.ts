import { test, expect } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { startServer } from './server.ts';
import { reveal } from './interactions.ts';
import { packageFiles } from '../package-files.ts';

const password = 'family password 123';
async function fixture(request: APIRequestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'klbook-export-'));
  const server = await startServer(dir);
  const setupCode = (await readFile(join(dir, 'setup-code.txt'), 'utf8')).trim();
  const session = await (await request.post(`${server.url}/api/v1/setup`, { data: { setupCode, username: 'parent', password, learnerName: '小明', deviceName: '电脑' } })).json();
  const headers = { authorization: `Bearer ${session.token}` };
  const bytes = await sharp({ create: { width: 160, height: 200, channels: 3, background: 'white' } }).png().toBuffer();
  const draft = await (await request.post(`${server.url}/api/v1/collection/drafts`, { headers: { ...headers, 'Content-Type': 'image/png', 'Idempotency-Key': crypto.randomUUID() }, data: bytes })).json();
  const fields = { state: 'collected', subjectId: 'math', region: { x: 0, y: 0, width: 1, height: 1 }, sourceId: null, pageNumber: '3', questionNumber: '8', note: '电脑已同步的备注' };
  const question = await (await request.put(`${server.url}/api/v1/collection/questions/${draft.id}`, { headers, data: { ...fields, operationId: crypto.randomUUID(), expectedRevision: 1 } })).json();
  return { ...server, dir, headers, bytes, question, fields, async close() { await server.stop(); await rm(dir, { recursive: true, force: true }); } };
}
async function login(page: Page, url: string) {
  await page.goto(url); await page.getByLabel('家长账号').fill('parent');
  await page.getByLabel('家长密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录此设备' }).click();
}
async function unlock(page: Page) {
  await page.getByLabel('家长密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '验证并进入管理' }).click();
}
test('管理端核对范围后下载真实 ZIP，学习端不增加导出入口', async ({ page, request }) => {
  const f = await fixture(request);
  try {
    await login(page, `${f.url}/admin/exports`);
    await expect(page.getByRole('heading', { name: '验证家长身份' })).toBeVisible();
    await unlock(page);
    await expect(page.getByRole('heading', { name: '本次导出范围' })).toBeVisible();
    await expect(page.getByText('1 道', { exact: true })).toBeVisible();
    await expect(page.getByText(/0 张待上传图片，0 道题/)).toBeVisible();
    for (const width of [390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
    await page.getByRole('button', { name: '确认范围并生成资料包' }).click();
    const downloading = page.waitForEvent('download');
    await page.getByRole('button', { name: '下载 ZIP 资料包' }).click();
    const download = await downloading;
    expect(await download.failure()).toBeNull();
    expect(download.suggestedFilename()).toMatch(/^klbook-learning-.*\.zip$/);
    const files = await packageFiles(await readFile((await download.path())!));
    const data = JSON.parse(files.get('data.json')!.toString());
    expect(data.questions).toHaveLength(1); expect(data.questions[0].id).toBe(f.question.id);
    expect(files.get(data.pages[0].path)).toEqual(f.bytes);
    await page.goto(`${f.url}/learn`);
    await expect(page.getByRole('heading', { name: '小明的错题集' })).toBeVisible();
    await expect(page.getByRole('button', { name: '资料导出', exact: true })).toHaveCount(0);
  } finally { await f.close(); }
});

test('本机未同步修改明确提示，范围变化需刷新后才能生成', async ({ page, request }) => {
  const f = await fixture(request);
  try {
    await login(page, `${f.url}/learn`);
    await page.getByRole('button', { name: '打开错题' }).click();
    await page.getByRole('button', { name: '编辑资料' }).click();
    await page.route('**/api/v1/collection/questions/*', route => route.request().method() === 'PUT' ? route.abort() : route.continue());
    await reveal(page.getByLabel('备注（选填）'));
    await page.getByLabel('备注（选填）').fill('只在手机上的未同步备注');
    await page.getByRole('button', { name: '保存修改', exact: true }).click();
    await expect(page.getByText('本机已收集，待同步', { exact: true })).toBeVisible();
    await page.goto(`${f.url}/admin/exports`); await unlock(page);
    await expect(page.getByText(/0 张待上传图片，1 道题/)).toBeVisible();
    const changed = await (await request.put(`${f.url}/api/v1/collection/questions/${f.question.id}`, { headers: f.headers, data: { ...f.fields, operationId: crypto.randomUUID(), expectedRevision: f.question.revision, note: '电脑在核对后修改' } })).json();
    expect(changed.note).toBe('电脑在核对后修改');
    await page.getByRole('button', { name: '确认范围并生成资料包' }).click();
    await expect(page.getByRole('alert')).toContainText('刷新导出范围');
    await expect(page.getByRole('button', { name: '下载 ZIP 资料包' })).toHaveCount(0);
    await page.getByRole('button', { name: '刷新导出范围' }).click();
    await page.getByRole('button', { name: '确认范围并生成资料包' }).click();
    const downloaded = page.waitForEvent('download');
    await page.getByRole('button', { name: '下载 ZIP 资料包' }).click();
    const files = await packageFiles(await readFile((await (await downloaded).path())!));
    expect(JSON.parse(files.get('data.json')!.toString()).questions[0].note).toBe('电脑在核对后修改');
    expect(files.get('data.json')!.toString()).not.toContain('只在手机上的未同步备注');
  } finally { await f.close(); }
});

test('生成回执丢失可重试同一操作，下载授权到期后重新验证保留已生成包', async ({ page, request }) => {
  const f = await fixture(request);
  try {
    await login(page, `${f.url}/admin/exports`); await unlock(page);
    const ids: string[] = [];
    await page.route('**/api/v1/admin/exports/*', async route => {
      if (route.request().method() !== 'PUT') return route.continue();
      ids.push(route.request().url());
      if (ids.length === 1) { const result = await route.fetch(); expect(result.status()).toBe(202); await route.abort(); }
      else await route.continue();
    });
    await page.getByRole('button', { name: '确认范围并生成资料包' }).click();
    await expect(page.getByRole('alert')).toContainText('无法连接家庭电脑');
    await page.getByRole('button', { name: '重试本次生成' }).click();
    await expect(page.getByRole('button', { name: '下载 ZIP 资料包' })).toBeVisible();
    expect(ids).toHaveLength(2); expect(new Set(ids).size).toBe(1);
    await page.route('**/api/v1/admin/exports/*/file', async route => {
      const headers = route.request().headers();
      expect((await request.delete(`${f.url}/api/v1/admin/grants`, { headers: { authorization: headers.authorization!, 'x-parent-authorization': headers['x-parent-authorization']! } })).status()).toBe(204);
      await route.continue();
    }, { times: 1 });
    await page.getByRole('button', { name: '下载 ZIP 资料包' }).click();
    await expect(page.getByRole('heading', { name: '验证家长身份' })).toBeVisible();
    await unlock(page);
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: '下载 ZIP 资料包' }).click();
    expect(await (await download).failure()).toBeNull();
    expect(ids).toHaveLength(2);
  } finally { await f.close(); }
});

test('生成回执返回时服务已重启，页面清除失效任务并能重新生成', async ({ page, request }) => {
  const f = await fixture(request);
  let restarted: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    await login(page, `${f.url}/admin/exports`); await unlock(page);
    await page.route('**/api/v1/admin/exports/*', async route => {
      if (route.request().method() !== 'PUT' || restarted) return route.continue();
      const response = await route.fetch();
      expect(response.status()).toBe(202);
      expect((await response.json()).status).toBe('preparing');
      await f.stop(); restarted = await startServer(f.dir, Number(new URL(f.url).port));
      await route.fulfill({ response });
    });
    await page.getByRole('button', { name: '确认范围并生成资料包' }).click();
    await expect(page.getByRole('alert')).toContainText('服务已重启');
    await expect(page.getByRole('button', { name: '确认范围并生成资料包' })).toBeEnabled();
    await page.getByRole('button', { name: '刷新导出范围' }).click();
    await page.getByRole('button', { name: '确认范围并生成资料包' }).click();
    const downloaded = page.waitForEvent('download');
    await page.getByRole('button', { name: '下载 ZIP 资料包' }).click();
    expect(await (await downloaded).failure()).toBeNull();
  } finally { await restarted?.stop(); await f.close(); }
});
