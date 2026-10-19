import { test, expect } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { startServer } from './server.ts';
import { reveal } from './interactions.ts';

const password = 'family password 123';
async function fixture(request: APIRequestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'klbook-trash-'));
  const server = await startServer(dir);
  const setupCode = (await readFile(join(dir, 'setup-code.txt'), 'utf8')).trim();
  const session = (await (await request.post(`${server.url}/api/v1/setup`, { data: { setupCode, username: 'parent', password, learnerName: '小明', deviceName: '电脑' } })).json());
  const headers = { authorization: `Bearer ${session.token}` };
  const grant = (await (await request.post(`${server.url}/api/v1/admin/grants`, { headers, data: { password } })).json()).token;
  const parent = { ...headers, 'x-parent-authorization': grant };
  const image = await sharp(await readFile(new URL('../fixtures/paper.svg', import.meta.url))).png().toBuffer();
  const draft = await (await request.post(`${server.url}/api/v1/collection/drafts`, { headers: { ...headers, 'Content-Type': 'image/png', 'Idempotency-Key': crypto.randomUUID() }, data: image })).json();
  const question = await (await request.put(`${server.url}/api/v1/collection/questions/${draft.id}`, { headers, data: { operationId: crypto.randomUUID(), expectedRevision: 1, state: 'collected', subjectId: 'math', region: { x: 0, y: 0, width: 1, height: 1 }, sourceId: null, pageNumber: '3', questionNumber: '8', note: '删除前的备注' } })).json();
  return { ...server, headers, parent, question, async close() { await server.stop(); await rm(dir, { recursive: true, force: true }); } };
}
async function login(page: Page, url: string) {
  await page.goto(url);
  await page.getByLabel('家长账号').fill('parent');
  await page.getByLabel('家长密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录此设备' }).click();
}
async function unlock(page: Page) {
  await page.getByLabel('家长密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '验证并进入管理' }).click();
}

test('管理端确认删除、恢复、永久删除；学习端不展示删除入口', async ({ page, request }) => {
  const f = await fixture(request);
  try {
    await login(page, `${f.url}/admin/materials`); await unlock(page);
    await page.getByRole('button', { name: '打开', exact: true }).click();
    await reveal(page.getByRole('button', { name: '移入回收站', exact: true, includeHidden: true }));
    await page.getByRole('button', { name: '移入回收站', exact: true }).click();
    const confirm = page.getByRole('dialog', { name: '移入回收站' });
    await confirm.getByRole('button', { name: '确认移入回收站' }).click();
    await page.getByRole('button', { name: '回收站', exact: true }).click();
    await expect(page.getByRole('table', { name: '回收站资料' }).getByRole('row')).toHaveCount(2);
    await page.getByRole('button', { name: '查看与恢复' }).click();
    await expect(page.getByText('删除前的备注', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '恢复题目', exact: true }).click();
    await expect(page.getByText('回收站为空', { exact: true })).toBeVisible();
    const restored = await (await request.get(`${f.url}/api/v1/collection/questions/${f.question.id}`, { headers: f.headers })).json();
    expect(restored.note).toBe('删除前的备注');
    await request.put(`${f.url}/api/v1/admin/trash/${restored.id}`, { headers: f.parent, data: { operationId: crypto.randomUUID(), expectedRevision: restored.revision, action: 'trash' } });
    await page.getByRole('button', { name: '刷新回收站' }).click();
    await page.getByRole('button', { name: '查看与恢复' }).click();
    await page.getByRole('button', { name: '永久删除', exact: true }).click();
    const purge = page.getByRole('dialog', { name: '永久删除这道题' });
    await purge.getByRole('button', { name: '保留在回收站' }).click();
    await expect(page.getByRole('button', { name: '恢复题目', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '永久删除', exact: true }).click();
    await purge.getByRole('button', { name: '确认永久删除' }).click();
    await expect(page.getByText('回收站为空', { exact: true })).toBeVisible();
    await page.goto(`${f.url}/learn`);
    await expect(page.getByRole('heading', { name: '小明的错题集' })).toBeVisible();
    await expect(page.getByRole('button', { name: '移入回收站' })).toHaveCount(0);
    expect((await request.get(`${f.url}/api/v1/collection/questions/${restored.id}`, { headers: f.headers })).status()).toBe(410);
  } finally { await f.close(); }
});

test('另一设备删除后旧离线修改不补回，收集页可查看本机文字，恢复后仍需核对', async ({ page, request }) => {
  const f = await fixture(request);
  try {
    await login(page, `${f.url}/learn`);
    await page.getByRole('button', { name: '打开错题' }).click();
    await page.getByRole('button', { name: '编辑资料' }).click();
    await page.route('**/api/v1/collection/questions/*', route => route.request().method() === 'PUT' ? route.abort() : route.continue());
    await reveal(page.getByLabel('备注（选填）'));
    await page.getByLabel('备注（选填）').fill('离线时写下的思路仍要保留');
    await page.getByRole('button', { name: '保存修改', exact: true }).click();
    await expect(page.getByText('本机已收集，待同步', { exact: true })).toBeVisible();
    const deletion = await (await request.put(`${f.url}/api/v1/admin/trash/${f.question.id}`, { headers: f.parent, data: { operationId: crypto.randomUUID(), expectedRevision: f.question.revision, action: 'trash' } })).json();
    await page.unroute('**/api/v1/collection/questions/*');
    await page.goto(`${f.url}/learn/collect`);
    await expect(page.getByLabel('本机保留的备注')).toHaveValue('离线时写下的思路仍要保留');
    await expect(page.getByRole('button', { name: '继续整理' })).toHaveCount(0);
    expect((await (await request.get(`${f.url}/api/v1/collection/questions?state=collected`, { headers: f.headers })).json()).total).toBe(0);
    await request.put(`${f.url}/api/v1/admin/trash/${f.question.id}`, { headers: f.parent, data: { operationId: crypto.randomUUID(), expectedRevision: deletion.revision, action: 'restore' } });
    await page.goto(`${f.url}/learn`);
    await expect(page.getByRole('button', { name: '打开错题' })).toBeVisible();
    const current = await (await request.get(`${f.url}/api/v1/collection/questions/${f.question.id}`, { headers: f.headers })).json();
    expect(current.note).toBe('删除前的备注');
    await page.getByRole('button', { name: '打开错题' }).click();
    await page.getByRole('button', { name: '编辑资料' }).click();
    await reveal(page.getByLabel('备注（选填）'));
    await expect(page.getByLabel('备注（选填）')).toHaveValue('离线时写下的思路仍要保留');
  } finally { await f.close(); }
});

test('永久删除授权过期后重新验证，回执丢失重试使用同一操作', async ({ page, request }) => {
  const f = await fixture(request);
  try {
    await request.put(`${f.url}/api/v1/admin/trash/${f.question.id}`, { headers: f.parent, data: { operationId: crypto.randomUUID(), expectedRevision: f.question.revision, action: 'trash' } });
    await login(page, `${f.url}/admin/trash`); await unlock(page);
    await page.getByRole('button', { name: '查看与恢复' }).click();
    await page.getByRole('button', { name: '永久删除', exact: true }).click();
    const operations: string[] = [];
    await page.route(`**/api/v1/admin/trash/${f.question.id}`, async route => {
      operations.push(route.request().postDataJSON().operationId);
      if (operations.length === 1) {
        const headers = route.request().headers();
        expect((await request.delete(`${f.url}/api/v1/admin/grants`, { headers: { authorization: headers.authorization!, 'x-parent-authorization': headers['x-parent-authorization']! } })).status()).toBe(204);
        await route.continue();
      } else if (operations.length === 2) { await route.fetch(); await route.abort(); }
      else await route.continue();
    });
    await page.getByRole('button', { name: '确认永久删除' }).click();
    await expect(page.getByRole('heading', { name: '验证家长身份' })).toBeVisible();
    await unlock(page);
    const dialog = page.getByRole('dialog', { name: '永久删除这道题' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: '确认永久删除' }).click();
    await expect(dialog.getByRole('alert')).toContainText('无法连接家庭电脑');
    await dialog.getByRole('button', { name: '确认永久删除' }).click();
    await expect(page.getByText('回收站为空', { exact: true })).toBeVisible();
    expect(operations).toHaveLength(3);
    expect(new Set(operations).size).toBe(1);
  } finally { await f.close(); }
});

test('上传回执丢失后服务器已删草稿，不重复建回且不阻塞其他新材料', async ({ page, request }) => {
  const f = await fixture(request);
  try {
    await login(page, `${f.url}/learn/collect`);
    const image = await sharp({ create: { width: 160, height: 200, channels: 3, background: 'white' } }).png().toBuffer();
    let deletedId = '';
    await page.route('**/api/v1/collection/drafts', async route => {
      const response = await route.fetch(), draft = await response.json();
      deletedId = draft.id;
      expect((await request.put(`${f.url}/api/v1/admin/trash/${draft.id}`, { headers: f.parent, data: { operationId: crypto.randomUUID(), expectedRevision: draft.revision, action: 'trash' } })).status()).toBe(200);
      await route.abort();
    }, { times: 1 });
    await expect(page.getByLabel('选择题目图片')).toBeEnabled();
    await page.getByLabel('选择题目图片').setInputFiles({ name: '已删除.png', mimeType: 'image/png', buffer: image });
    await expect(page.getByRole('heading', { name: '框住这道题' })).toBeVisible();
    await page.reload();
    await expect(page.getByText('已删除题目的本机内容', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '继续整理' })).toHaveCount(0);
    await expect(page.getByLabel('选择题目图片')).toBeEnabled();
    await page.getByLabel('选择题目图片').setInputFiles({ name: '新材料.png', mimeType: 'image/png', buffer: image });
    await reveal(page.getByRole('button', { name: '选择整页', exact: true, includeHidden: true }));
    await page.getByRole('button', { name: '选择整页', exact: true }).click();
    await page.getByRole('button', { name: '下一步，选学科' }).click();
    await page.getByRole('combobox', { name: '学科', exact: true }).selectOption('science');
    await page.getByRole('button', { name: '保存到错题集', exact: true }).click();
    await expect(page.getByRole('heading', { name: '错题详情' })).toBeVisible();
    expect((await (await request.get(`${f.url}/api/v1/collection/questions?state=collected`, { headers: f.headers })).json()).total).toBe(2);
    expect((await request.get(`${f.url}/api/v1/collection/questions/${deletedId}`, { headers: f.headers })).status()).toBe(410);
  } finally { await f.close(); }
});
