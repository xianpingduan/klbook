import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { mkdtemp, readFile, rm, readdir, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { startServer } from './server.ts';

const password = 'family password 123';
async function fixture(request: APIRequestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'klbook-import-')), server = await startServer(dir);
  const setupCode = (await readFile(join(dir, 'setup-code.txt'), 'utf8')).trim();
  const session = await (await request.post(`${server.url}/api/v1/setup`, { data: { setupCode, username: 'parent', password, learnerName: '小明', deviceName: '电脑' } })).json();
  const headers = { authorization: `Bearer ${session.token}` };
  const grant = await (await request.post(`${server.url}/api/v1/admin/grants`, { headers, data: { password } })).json();
  const parent = { ...headers, 'x-parent-authorization': grant.token };
  return { ...server, dir, headers, parent, async close() { await server.stop(); await rm(dir, { recursive: true, force: true }); } };
}
async function realPackage(request: APIRequestContext, f: Awaited<ReturnType<typeof fixture>>, many = false) {
  const bytes = many ? await sharp(randomBytes(1024 * 1024 * 3), { raw: { width: 1024, height: 1024, channels: 3 } }).png().toBuffer()
    : await sharp({ create: { width: 120, height: 180, channels: 3, background: 'white' } }).png().toBuffer();
  let question;
  for (let i = 0; i < (many ? 8 : 1); i++) {
  const draft = await (await request.post(`${f.url}/api/v1/collection/drafts`, { headers: { ...f.headers, 'Content-Type': 'image/png', 'Idempotency-Key': crypto.randomUUID() }, data: bytes })).json();
  question = await (await request.put(`${f.url}/api/v1/collection/questions/${draft.id}`, { headers: f.headers, data: { operationId: crypto.randomUUID(), expectedRevision: 1, state: 'collected', subjectId: 'math', region: { x: 0, y: 0, width: 1, height: 1 }, sourceId: null, pageNumber: '3', questionNumber: '8', note: '迁移后仍能追溯', studyStage: { schoolYear: '2025-2026', grade: '三年级', term: 'second' } } })).json();
  }
  const preview = await (await request.get(`${f.url}/api/v1/admin/exports`, { headers: f.parent })).json(), id = crypto.randomUUID();
  expect((await request.put(`${f.url}/api/v1/admin/exports/${id}`, { headers: f.parent, data: { previewToken: preview.token } })).status()).toBe(202);
  await expect.poll(async () => (await (await request.get(`${f.url}/api/v1/admin/exports/${id}`, { headers: f.parent })).json()).status).toBe('ready');
  return { pack: await (await request.get(`${f.url}/api/v1/admin/exports/${id}/file`, { headers: f.parent })).body(), bytes, question };
}
async function login(page: Page, url: string) {
  await page.goto(url); await page.getByLabel('家长账号').fill('parent'); await page.getByLabel('家长密码', { exact: true }).fill(password); await page.getByRole('button', { name: '登录此设备' }).click();
}
async function unlock(page: Page) { await page.getByLabel('家长密码', { exact: true }).fill(password); await page.getByRole('button', { name: '验证并进入管理' }).click(); }

test('家长选择真实资料包、核对预览后导入，刷新与重复选择均不增加题目', async ({ page, request }) => {
  const source = await fixture(request), target = await fixture(request);
  try {
    const exported = await realPackage(request, source);
    await login(page, `${target.url}/admin/imports`); await unlock(page);
    await expect(page.getByRole('heading', { name: '导入学习资料' })).toBeVisible();
    await page.getByLabel('选择 ZIP 资料包').setInputFiles({ name: 'learning.zip', mimeType: 'application/zip', buffer: exported.pack });
    await expect(page.getByText('新增 1 道，跳过 0 道完全相同的题目。')).toBeVisible();
    expect((await (await request.get(`${target.url}/api/v1/collection/questions?state=collected`, { headers: target.headers })).json()).total).toBe(0);
    for (const width of [390, 768, 1440]) { await page.setViewportSize({ width, height: 900 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); }
    await page.reload(); await unlock(page);
    await expect(page.getByText('新增 1 道，跳过 0 道完全相同的题目。')).toBeVisible();
    await page.getByRole('button', { name: '确认导入', exact: true }).click();
    await expect(page.getByRole('heading', { name: '导入完成' })).toBeVisible();
    const list = await (await request.get(`${target.url}/api/v1/collection/questions?state=collected`, { headers: target.headers })).json();
    expect(list.total).toBe(1); expect(list.items[0].note).toBe('迁移后仍能追溯');
    expect(await (await request.get(`${target.url}/api/v1/collection/pages/${list.items[0].originalPage.id}/original`, { headers: target.headers })).body()).toEqual(exported.bytes);
    await page.getByLabel('选择 ZIP 资料包').setInputFiles({ name: 'learning.zip', mimeType: 'application/zip', buffer: exported.pack });
    await expect(page.getByText('新增 0 道，跳过 1 道完全相同的题目。')).toBeVisible();
    await page.getByRole('button', { name: '确认导入', exact: true }).click();
    await expect(page.getByRole('heading', { name: '导入完成' })).toBeVisible();
    await page.goto(`${target.url}/learn`); await page.getByRole('button', { name: '打开错题' }).click();
    await expect(page.getByText('迁移后仍能追溯', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '资料导入', exact: true })).toHaveCount(0);
  } finally { await source.close(); await target.close(); }
});

test('选错或损坏文件可重新选择，授权到期与导入回执丢失后重试仍只新增一次', async ({ page, request }) => {
  const source = await fixture(request), target = await fixture(request);
  try {
    const exported = await realPackage(request, source);
    await login(page, `${target.url}/admin/imports`); await unlock(page);
    await page.getByLabel('选择 ZIP 资料包').setInputFiles({ name: 'bad.zip', mimeType: 'application/zip', buffer: Buffer.from('broken') });
    await expect(page.getByRole('alert')).toContainText('资料包无法读取');
    await page.getByLabel('选择 ZIP 资料包').setInputFiles({ name: 'good.zip', mimeType: 'application/zip', buffer: exported.pack });
    await expect(page.getByRole('button', { name: '确认导入', exact: true })).toBeEnabled();
    await page.route('**/api/v1/admin/imports/*/confirm', async route => {
      const headers = route.request().headers();
      expect((await request.delete(`${target.url}/api/v1/admin/grants`, { headers: { authorization: headers.authorization!, 'x-parent-authorization': headers['x-parent-authorization']! } })).status()).toBe(204);
      await route.continue();
    }, { times: 1 });
    await page.getByRole('button', { name: '确认导入', exact: true }).click();
    await expect(page.getByRole('heading', { name: '验证家长身份' })).toBeVisible();
    await unlock(page);
    await expect(page.getByRole('button', { name: '确认导入', exact: true })).toBeEnabled();
    const ids: string[] = [];
    await page.route('**/api/v1/admin/imports/*/confirm', async route => {
      ids.push(route.request().url());
      if (ids.length === 1) { expect((await route.fetch()).status()).toBe(200); await route.abort(); }
      else await route.continue();
    });
    await page.getByRole('button', { name: '确认导入', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('无法连接家庭电脑');
    await page.getByRole('button', { name: '确认导入', exact: true }).click();
    await expect(page.getByRole('heading', { name: '导入完成' })).toBeVisible();
    expect(ids).toHaveLength(2); expect(new Set(ids).size).toBe(1);
    await page.reload(); await unlock(page); await expect(page.getByRole('heading', { name: '导入完成' })).toBeVisible();
    expect((await (await request.get(`${target.url}/api/v1/collection/questions?state=collected`, { headers: target.headers })).json()).total).toBe(1);
  } finally { await source.close(); await target.close(); }
});

test('实际写入原图期间电脑中断，重启后没有半批题目，重新校验可完整导入', async ({ page, request }) => {
  test.setTimeout(120000);
  const source = await fixture(request), target = await fixture(request);
  let restarted: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    const exported = await realPackage(request, source, true);
    await login(page, `${target.url}/admin/imports`); await unlock(page);
    const file = { name: 'several-pages.zip', mimeType: 'application/zip', buffer: exported.pack };
    await page.getByLabel('选择 ZIP 资料包').setInputFiles(file);
    await expect(page.getByText('新增 8 道，跳过 0 道完全相同的题目。')).toBeVisible();
    const publishing = (async () => {
      const folder = join(target.dir, 'attachments', 'pages');
      // Observe real disk publication only to choose the interruption point; all business assertions use HTTP.
      for (let i = 0; i < 1500; i++) {
        const ids = await readdir(folder).catch(() => []);
        if (ids.length && (await stat(join(folder, ids[0]!, 'original')).catch(() => null))?.isFile()) { await target.stop(); return; }
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      throw new Error('No in-progress original write observed');
    })();
    await page.getByRole('button', { name: '确认导入', exact: true }).click(); await publishing;
    await expect(page.getByRole('alert')).toContainText('无法连接家庭电脑');
    restarted = await startServer(target.dir, Number(new URL(target.url).port));
    expect((await (await request.get(`${target.url}/api/v1/collection/questions?state=collected`, { headers: target.headers })).json()).total).toBe(0);
    await page.getByRole('button', { name: '刷新预览' }).click(); await expect(page.getByRole('alert')).toContainText('重新选择资料包');
    await page.getByLabel('选择 ZIP 资料包').setInputFiles(file);
    await expect(page.getByRole('button', { name: '确认导入', exact: true })).toBeEnabled(); await page.getByRole('button', { name: '确认导入', exact: true }).click();
    await expect(page.getByRole('heading', { name: '导入完成' })).toBeVisible();
    const result = await (await request.get(`${target.url}/api/v1/collection/questions?state=collected`, { headers: target.headers })).json();
    expect(result.total).toBe(8);
    for (const q of result.items) expect(await (await request.get(`${target.url}/api/v1/collection/pages/${q.originalPage.id}/original`, { headers: target.headers })).body()).toEqual(exported.bytes);
  } finally { await restarted?.stop(); await source.close(); await target.close(); }
});

test('上传尚未完成时切换管理页面再返回，迟到查询不清除批次，刷新仍能继续', async ({ page, request }) => {
  const source = await fixture(request), target = await fixture(request);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let reached!: () => void;
  const sent = new Promise<void>(resolve => { reached = resolve; });
  try {
    const exported = await realPackage(request, source);
    await login(page, `${target.url}/admin/imports`); await unlock(page);
    await page.route('**/api/v1/admin/imports/*', async route => { if (route.request().method() !== 'PUT') return route.continue(); reached(); await held; await route.continue(); });
    await page.getByLabel('选择 ZIP 资料包').setInputFiles({ name: 'learning.zip', mimeType: 'application/zip', buffer: exported.pack });
    await sent;
    await page.getByRole('button', { name: '来源管理', exact: true }).click();
    await page.getByRole('button', { name: '资料导入', exact: true }).click();
    await expect(page.getByRole('heading', { name: '导入学习资料' })).toBeVisible();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    release();
    await expect(page.getByText('新增 1 道，跳过 0 道完全相同的题目。')).toBeVisible();
    await page.reload(); await unlock(page);
    await expect(page.getByText('新增 1 道，跳过 0 道完全相同的题目。')).toBeVisible();
    await page.getByRole('button', { name: '确认导入', exact: true }).click();
    await expect(page.getByRole('heading', { name: '导入完成' })).toBeVisible();
  } finally { release(); await source.close(); await target.close(); }
});
