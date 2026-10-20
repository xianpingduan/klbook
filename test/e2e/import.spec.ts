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

test('家长核对修改后另存副本，重复导入跳过，回收站记录需明确选择恢复', async ({ page, request }) => {
  const source = await fixture(request), target = await fixture(request);
  try {
    const exported = await realPackage(request, source), id = crypto.randomUUID();
    const upload = async (batchId: string) => (await request.put(`${target.url}/api/v1/admin/imports/${batchId}`, { headers: { ...target.parent, 'content-type': 'application/zip' }, data: exported.pack })).json();
    const initial = await upload(id);
    const imported = await (await request.post(`${target.url}/api/v1/admin/imports/${id}/confirm`, { headers: target.parent, data: { previewToken: initial.token } })).json();
    const qid = imported.questionIds[0], q = await (await request.get(`${target.url}/api/v1/collection/questions/${qid}`, { headers: target.headers })).json();
    expect((await request.put(`${target.url}/api/v1/collection/questions/${qid}`, { headers: target.headers, data: { operationId: crypto.randomUUID(), expectedRevision: q.revision, state: q.state, subjectId: q.subjectId, sourceId: q.sourceId, region: q.region, pageNumber: q.pageNumber, questionNumber: q.questionNumber, note: '本机已经更正' } })).status()).toBe(200);
    await login(page, `${target.url}/admin/imports`); await unlock(page);
    await page.getByLabel('选择 ZIP 资料包').setInputFiles({ name: 'conflict.zip', mimeType: 'application/zip', buffer: exported.pack });
    await expect(page.getByText('修改冲突 1 道', { exact: true })).toBeVisible();
    await expect(page.getByText('本机已经更正', { exact: true })).toBeVisible();
    await page.getByText('查看资料包题目图片', { exact: true }).click();
    await page.getByText('查看当前题目图片', { exact: true }).click();
    await expect(page.getByRole('img', { name: '资料包题目图片', exact: true })).toBeVisible();
    await expect(page.getByRole('img', { name: '当前题目图片', exact: true })).toBeVisible();
    await page.getByLabel('第 1 项的处理').selectOption('copy');
    await expect(page.getByText('本次将另存 1 道副本', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '确认导入', exact: true }).click();
    await expect(page.getByRole('heading', { name: '导入完成' })).toBeVisible();
    await expect(page.getByText('另存副本 1 道', { exact: true })).toBeVisible();
    let all = await (await request.get(`${target.url}/api/v1/collection/questions?state=collected`, { headers: target.headers })).json();
    expect(all.total).toBe(2); expect(all.items.find((q: any) => q.id === qid).note).toBe('本机已经更正');
    const copy = all.items.find((q: any) => q.id !== qid);
    await page.getByLabel('选择 ZIP 资料包').setInputFiles({ name: 'conflict.zip', mimeType: 'application/zip', buffer: exported.pack });
    await expect(page.getByText('新增 0 道，跳过 1 道完全相同的题目。')).toBeVisible();
    expect((await request.put(`${target.url}/api/v1/admin/trash/${copy.id}`, { headers: target.parent, data: { operationId: crypto.randomUUID(), expectedRevision: copy.revision, action: 'trash' } })).status()).toBe(200);
    await page.getByRole('button', { name: '刷新预览' }).click();
    await expect(page.getByText('回收站或已删除 1 道', { exact: true })).toBeVisible();
    await expect(page.getByLabel('第 1 项的处理')).toHaveValue('keep');
    await page.getByLabel('第 1 项的处理').selectOption('restore');
    await expect(page.getByText('本次将恢复 1 道题', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '确认导入', exact: true }).click();
    await expect(page.getByText('恢复 1 道', { exact: true })).toBeVisible();
    all = await (await request.get(`${target.url}/api/v1/collection/questions?state=collected`, { headers: target.headers })).json(); expect(all.total).toBe(2);
  } finally { await source.close(); await target.close(); }
});

test('学科对应与新增名称可核对，刷新继续原选择，手机平板桌面不溢出', async ({ page, request }) => {
  const source = await fixture(request), target = await fixture(request);
  try {
    const first = await realPackage(request, source), sourceId = crypto.randomUUID(), targetId = crypto.randomUUID();
    for (const [f, id] of [[source, sourceId], [target, targetId]] as const) expect((await request.put(`${f.url}/api/v1/admin/subjects/${id}`, { headers: f.parent, data: { name: '综合实践' } })).status()).toBe(200);
    const q = first.question;
    expect((await request.put(`${source.url}/api/v1/collection/questions/${q.id}`, { headers: source.headers, data: { operationId: crypto.randomUUID(), expectedRevision: q.revision, state: q.state, subjectId: sourceId, sourceId: null, region: q.region, pageNumber: q.pageNumber, questionNumber: q.questionNumber, note: q.note } })).status()).toBe(200);
    const preview = await (await request.get(`${source.url}/api/v1/admin/exports`, { headers: source.parent })).json(), exportId = crypto.randomUUID();
    await request.put(`${source.url}/api/v1/admin/exports/${exportId}`, { headers: source.parent, data: { previewToken: preview.token } });
    await expect.poll(async () => (await (await request.get(`${source.url}/api/v1/admin/exports/${exportId}`, { headers: source.parent })).json()).status).toBe('ready');
    const pack = await (await request.get(`${source.url}/api/v1/admin/exports/${exportId}/file`, { headers: source.parent })).body();
    await login(page, `${target.url}/admin/imports`); await unlock(page);
    await page.getByLabel('选择 ZIP 资料包').setInputFiles({ name: 'subjects.zip', mimeType: 'application/zip', buffer: pack });
    await expect(page.getByRole('button', { name: '确认导入', exact: true })).toBeDisabled();
    await page.getByLabel('综合实践的学科对应').selectOption(targetId);
    await expect(page.getByRole('button', { name: '确认导入', exact: true })).toBeEnabled();
    await page.getByLabel('综合实践的学科对应').selectOption('new');
    await expect(page.getByRole('button', { name: '确认导入', exact: true })).toBeDisabled();
    await page.getByLabel('综合实践的新学科名称').fill('实践拓展'); await page.getByRole('button', { name: '确认学科名称' }).click();
    await expect(page.getByText('综合实践 → 新增“实践拓展”', { exact: true })).toBeVisible();
    await page.reload(); await unlock(page);
    await expect(page.getByText('综合实践 → 新增“实践拓展”', { exact: true })).toBeVisible();
    for (const width of [390, 768, 1440]) { await page.setViewportSize({ width, height: 900 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); }
    await page.getByRole('button', { name: '确认导入', exact: true }).click(); await expect(page.getByRole('heading', { name: '导入完成' })).toBeVisible();
    const items = await (await request.get(`${target.url}/api/v1/collection/questions?state=collected`, { headers: target.headers })).json(); expect(items.total).toBe(1); expect(items.items[0].subjectId).not.toBe(targetId);
    const subjects = await (await request.get(`${target.url}/api/v1/collection/subjects`, { headers: target.headers })).json(); expect(subjects.find((s: any) => s.id === items.items[0].subjectId).name).toBe('实践拓展');
  } finally { await source.close(); await target.close(); }
});

test('导入选择的授权失效和成功回执丢失可续接，并发变更要求重新选择', async ({ page, request }) => {
  const source = await fixture(request), target = await fixture(request);
  try {
    const exported = await realPackage(request, source), id = crypto.randomUUID();
    const preview = await (await request.put(`${target.url}/api/v1/admin/imports/${id}`, { headers: { ...target.parent, 'content-type': 'application/zip' }, data: exported.pack })).json();
    const imported = await (await request.post(`${target.url}/api/v1/admin/imports/${id}/confirm`, { headers: target.parent, data: { previewToken: preview.token } })).json(), qid = imported.questionIds[0];
    const peer = await (await request.post(`${target.url}/api/v1/sessions`, { data: { username: 'parent', password, deviceName: '另一设备' } })).json();
    const headers = { authorization: `Bearer ${peer.token}` };
    const edit = async (note: string) => {
      const q = await (await request.get(`${target.url}/api/v1/collection/questions/${qid}`, { headers })).json();
      expect((await request.put(`${target.url}/api/v1/collection/questions/${qid}`, { headers, data: { operationId: crypto.randomUUID(), expectedRevision: q.revision, state: q.state, subjectId: q.subjectId, sourceId: q.sourceId, region: q.region, pageNumber: q.pageNumber, questionNumber: q.questionNumber, note } })).status()).toBe(200);
    };
    await edit('第一次修改');
    await login(page, `${target.url}/admin/imports`); await unlock(page);
    await page.getByLabel('选择 ZIP 资料包').setInputFiles({ name: 'conflict.zip', mimeType: 'application/zip', buffer: exported.pack });
    await expect(page.getByText('修改冲突 1 道', { exact: true })).toBeVisible();
    await page.route('**/api/v1/admin/imports/*/decisions', async route => {
      const headers = route.request().headers();
      expect((await request.delete(`${target.url}/api/v1/admin/grants`, { headers: { authorization: headers.authorization!, 'x-parent-authorization': headers['x-parent-authorization']! } })).status()).toBe(204);
      await route.continue();
    }, { times: 1 });
    await page.getByLabel('第 1 项的处理').selectOption('copy');
    await expect(page.getByRole('heading', { name: '验证家长身份' })).toBeVisible(); await unlock(page);
    await expect(page.getByRole('button', { name: '重试所选处理' })).toBeEnabled();
    await page.route('**/api/v1/admin/imports/*/decisions', async route => { expect((await route.fetch()).status()).toBe(200); await route.abort(); }, { times: 1 });
    await page.getByRole('button', { name: '重试所选处理' }).click();
    await expect(page.getByRole('alert')).toContainText('无法连接家庭电脑');
    await page.getByRole('button', { name: '重试所选处理' }).click();
    await expect(page.getByText('本次将另存 1 道副本', { exact: true })).toBeVisible();
    await edit('并发更正，仍须保留');
    await page.getByRole('button', { name: '确认导入', exact: true }).click(); await expect(page.getByRole('alert')).toContainText('家庭资料已变化');
    await page.getByRole('button', { name: '刷新预览' }).click();
    await expect(page.getByText('资料已在其他页面变化，原选择已重置。请按最新内容重新核对。')).toBeVisible();
    await expect(page.getByLabel('第 1 项的处理')).toHaveValue('keep'); await expect(page.getByText('并发更正，仍须保留', { exact: true })).toBeVisible();
    await page.getByLabel('第 1 项的处理').selectOption('copy');
    await expect(page.getByText('本次将另存 1 道副本', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '确认导入', exact: true }).click(); await expect(page.getByRole('heading', { name: '导入完成' })).toBeVisible();
    const all = await (await request.get(`${target.url}/api/v1/collection/questions?state=collected`, { headers })).json(); expect(all.total).toBe(2); expect(all.items.find((q: any) => q.id === qid).note).toBe('并发更正，仍须保留');
  } finally { await source.close(); await target.close(); }
});
