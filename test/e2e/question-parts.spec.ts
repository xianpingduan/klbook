import { expect, test } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { APIRequestContext, Page } from '@playwright/test';
import sharp from 'sharp';
import { startServer } from './server.ts';

async function fixture(request: APIRequestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'klbook-parts-'));
  const server = await startServer(dir);
  const setupCode = (await readFile(join(dir, 'setup-code.txt'), 'utf8')).trim();
  const first = await (await request.post(`${server.url}/api/v1/setup`, { data: { setupCode, username: 'parent', password: 'family password 123', learnerName: '小明', deviceName: '设置电脑' } })).json();
  const bytes = await sharp(await readFile('test/fixtures/paper.svg')).png().toBuffer();
  return { ...server, bytes, headers: { Authorization: `Bearer ${first.token}` }, async close() { await server.stop(); await rm(dir, { recursive: true, force: true }); } };
}
async function login(page: Page, url: string) {
  await page.goto(url);
  await page.getByLabel('家长账号').fill('parent');
  await page.getByLabel('家长密码', { exact: true }).fill('family password 123');
  await page.getByRole('button', { name: '登录此设备', exact: true }).click();
}

test('同一原始页继续选题，清除误选后重画，保存响应丢失重试只新增一道', async ({ page, request }) => {
  const f = await fixture(request);
  try {
    await login(page, `${f.url}/learn/collect`);
    await expect(page.getByLabel('选择题目图片')).toBeEnabled();
    await page.getByLabel('选择题目图片').setInputFiles({ name: '同页.png', mimeType: 'image/png', buffer: f.bytes });
    await page.getByRole('button', { name: '选择整页', exact: true }).click();
    await page.getByRole('button', { name: '下一步，选学科' }).click();
    await page.getByRole('combobox', { name: '学科', exact: true }).selectOption('math');
    await page.getByLabel('备注（选填）').fill('第一道题');
    await page.getByRole('button', { name: '保存到错题集', exact: true }).click();
    await expect(page.getByRole('heading', { name: '错题详情' })).toBeVisible();
    const before = await (await request.get(`${f.url}/api/v1/collection/questions?state=collected`, { headers: f.headers })).json();
    await page.getByRole('button', { name: '从此原始页再收集一道', exact: true }).click();
    expect((await (await request.get(`${f.url}/api/v1/collection/questions?state=collected`, { headers: f.headers })).json()).total).toBe(1);
    await page.getByRole('button', { name: '选择整页', exact: true }).click();
    await page.getByRole('button', { name: '清除当前框选', exact: true }).click();
    await expect(page.getByRole('button', { name: '下一步，选学科' })).toBeDisabled();
    await page.getByRole('button', { name: '选择整页', exact: true }).click();
    await page.getByText('精确调整范围（百分比）', { exact: true }).click();
    await page.getByLabel('范围高度', { exact: true }).fill('40');
    await page.getByRole('button', { name: '下一步，选学科' }).click();
    await page.getByRole('combobox', { name: '学科', exact: true }).selectOption('science');
    await page.getByLabel('备注（选填）').fill('第二道题');
    await page.route('**/api/v1/collection/pages/*/questions', async route => { await route.fetch(); await route.abort(); }, { times: 1 });
    await page.getByRole('button', { name: '保存到错题集', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('仍保留');
    await page.getByRole('button', { name: '保存到错题集', exact: true }).click();
    await expect(page.getByRole('heading', { name: '错题详情' })).toBeVisible();
    const after = await (await request.get(`${f.url}/api/v1/collection/questions?state=collected`, { headers: f.headers })).json();
    expect(after.total).toBe(2);
    expect(after.items.find((item: { id: string }) => item.id === before.items[0].id)).toEqual(before.items[0]);
    const added = after.items.find((item: { id: string }) => item.id !== before.items[0].id);
    expect(added.originalPage.id).toBe(before.items[0].originalPage.id);
    expect(added.subjectId).toBe('science'); expect(added.region.height).toBe(.4);
    expect(await (await request.get(`${f.url}/api/v1/collection/pages/${added.originalPage.id}/original`, { headers: f.headers })).body()).toEqual(f.bytes);
  } finally { await f.close(); }
});

test('手机尺寸学习端追加图片，未确认的新范围阻止保存离开，完成后刷新仍可查看整道题', async ({ page, request }) => {
  const f = await fixture(request);
  try {
    const draft = await (await request.post(`${f.url}/api/v1/collection/drafts`, { headers: { ...f.headers, 'Content-Type': 'image/png', 'Idempotency-Key': crypto.randomUUID() }, data: f.bytes })).json();
    await request.put(`${f.url}/api/v1/collection/questions/${draft.id}`, { headers: f.headers, data: { operationId: crypto.randomUUID(), expectedRevision: 1, state: 'collected', region: { x: 0, y: 0, width: 1, height: 1 }, subjectId: 'math', sourceId: null, pageNumber: '', questionNumber: '', note: '' } });
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, `${f.url}/learn`);
    await page.getByRole('button', { name: '打开错题', exact: true }).click();
    await page.getByRole('button', { name: '补充或更正信息' }).click();
    await expect(page.getByLabel('追加跨页图片')).toBeEnabled();
    await page.getByLabel('追加跨页图片').setInputFiles({ name: '续页.png', mimeType: 'image/png', buffer: f.bytes });
    await expect(page.getByRole('button', { name: '题目区 2', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: '下一步，选学科' })).toBeDisabled();
    await page.getByRole('button', { name: '返回列表', exact: true }).click();
    await page.getByRole('button', { name: '保存后离开' }).click();
    await expect(page.getByRole('dialog').getByRole('alert')).toContainText('确认所有题目范围');
    await page.getByRole('button', { name: '继续编辑' }).click();
    await page.getByRole('button', { name: '选择整页', exact: true }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/question-parts-editor-${test.info().project.name}.png`, fullPage: true });
    await page.getByRole('button', { name: '下一步，选学科' }).click();
    await page.getByLabel('备注（选填）').fill('补全跨页题');
    await page.getByRole('button', { name: '保存修改', exact: true }).click();
    await expect(page.getByRole('heading', { name: '错题详情' })).toBeVisible();
    await expect(page.getByRole('img', { name: '已收集的题目区', exact: true })).toHaveCount(2);
    await page.reload();
    await page.getByRole('button', { name: '打开错题', exact: true }).click();
    await expect(page.getByRole('img', { name: '已收集的题目区', exact: true })).toHaveCount(2);
    await expect(page.getByText('补全跨页题', { exact: true })).toBeVisible();
  } finally { await f.close(); }
});

test('追加跨页图片响应丢失后刷新续接，重排和移除题目区后另一设备按顺序查看原图', async ({ page, request }) => {
  const f = await fixture(request);
  try {
    const draft = await (await request.post(`${f.url}/api/v1/collection/drafts`, { headers: { ...f.headers, 'Content-Type': 'image/png', 'Idempotency-Key': crypto.randomUUID() }, data: f.bytes })).json();
    const whole = { x: 0, y: 0, width: 1, height: 1 };
    await request.put(`${f.url}/api/v1/collection/questions/${draft.id}`, { headers: f.headers, data: { operationId: crypto.randomUUID(), expectedRevision: 1, state: 'collected', region: whole, subjectId: 'math', sourceId: null, pageNumber: '4—5', questionNumber: '3', note: '跨页题' } });
    await login(page, `${f.url}/admin/materials`);
    await page.getByLabel('家长密码', { exact: true }).fill('family password 123');
    await page.getByRole('button', { name: '验证并进入管理', exact: true }).click();
    await page.getByRole('table', { name: '已收集资料' }).getByRole('button', { name: '打开', exact: true }).click();
    const secondBytes = await sharp(f.bytes).flop().png().toBuffer();
    await page.route('**/api/v1/collection/pages', async route => { await route.fetch({ postData: secondBytes }); await route.abort(); }, { times: 1 });
    await expect(page.getByLabel('追加跨页图片')).toBeEnabled();
    await page.getByLabel('追加跨页图片').setInputFiles({ name: '第二页.png', mimeType: 'image/png', buffer: secondBytes });
    await expect(page.getByRole('alert')).toContainText('仍保留');
    await page.reload();
    await page.getByLabel('家长密码', { exact: true }).fill('family password 123');
    await page.getByRole('button', { name: '验证并进入管理', exact: true }).click();
    await page.getByRole('table', { name: '已收集资料' }).getByRole('button', { name: '打开', exact: true }).click();
    await page.getByRole('button', { name: '继续追加 第二页.png', exact: true }).click();
    await expect(page.getByRole('button', { name: '题目区 2', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: '选择整页', exact: true }).click();
    await page.getByRole('button', { name: '在本页补充题目区', exact: true }).click();
    await page.getByRole('button', { name: '选择整页', exact: true }).click();
    await page.getByRole('button', { name: '移除此题目区', exact: true }).click();
    await expect(page.getByRole('button', { name: '题目区 3', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '题目区 2', exact: true }).click();
    await page.getByRole('button', { name: '向前移动', exact: true }).click();
    await page.getByRole('button', { name: '确认题目范围', exact: true }).click();
    await page.getByRole('button', { name: '保存修改', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('已同步');
    const saved = await (await request.get(`${f.url}/api/v1/collection/questions/${draft.id}`, { headers: f.headers })).json();
    expect(saved.parts).toHaveLength(2); expect(saved.parts[1].originalPage.id).toBe(draft.originalPage.id);
    expect(saved.region).toEqual(whole);
    expect((await (await request.get(`${f.url}/api/v1/collection/questions?state=collected`, { headers: f.headers })).json()).total).toBe(1);
    expect(await (await request.get(`${f.url}/api/v1/collection/pages/${saved.parts[0].originalPage.id}/original`, { headers: f.headers })).body()).toEqual(secondBytes);
    await page.getByRole('button', { name: '结束管理', exact: true }).click();
    await page.getByRole('button', { name: '打开错题', exact: true }).first().click();
    await expect(page.getByRole('img', { name: '已收集的题目区', exact: true })).toHaveCount(2);
    await page.getByRole('button', { name: '查看原始页', exact: true }).click();
    await expect(page.getByRole('img', { name: '原始页（保留作答和批改）', exact: true })).toHaveCount(2);
    for (const width of [390, 820, 1440]) {
      await page.setViewportSize({ width, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `test-results/question-parts-${width}-${test.info().project.name}.png`, fullPage: true });
    }
  } finally { await f.close(); }
});

