import { expect, test } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { startServer } from './server.ts';
import type { Question } from '../../src/shared/collection.ts';

test('从小题建立跨页共享原文，另一小题选择同一材料，解除首题后仍可完整查看', async ({ page, request }) => {
  const dir = await mkdtemp(join(tmpdir(), 'klbook-reading-'));
  const server = await startServer(dir);
  try {
    const setupCode = (await readFile(join(dir, 'setup-code.txt'), 'utf8')).trim();
    const first = await (await request.post(`${server.url}/api/v1/setup`, { data: { setupCode, username: 'parent', password: 'family password 123', learnerName: '小明', deviceName: '设置电脑' } })).json();
    const headers = { Authorization: `Bearer ${first.token}` };
    const bytes = await sharp(await readFile('test/fixtures/paper.svg')).png().toBuffer();
    const paper = await (await request.post(`${server.url}/api/v1/collection/pages`, { headers: { ...headers, 'Content-Type': 'image/png', 'Idempotency-Key': crypto.randomUUID() }, data: bytes })).json();
    const fields = { state: 'collected', subjectId: 'chinese', region: { x: 0, y: .5, width: 1, height: .2 }, sourceId: null, pageNumber: '', questionNumber: '1', note: '' };
    const question = await (await request.post(`${server.url}/api/v1/collection/pages/${paper.id}/questions`, { headers, data: { ...fields, operationId: crypto.randomUUID() } })).json();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${server.url}/learn`);
    await page.getByLabel('家长账号').fill('parent'); await page.getByLabel('家长密码', { exact: true }).fill('family password 123');
    await page.getByRole('button', { name: '登录此设备', exact: true }).click();
    await page.getByRole('button', { name: '打开错题', exact: true }).click();
    await page.getByRole('button', { name: '补充或更正信息', exact: true }).click();
    await page.getByRole('button', { name: '从原始页新建阅读材料', exact: true }).click();
    await page.getByLabel('阅读材料名称', { exact: true }).fill('春天的故事');
    await page.getByRole('button', { name: '选择整页', exact: true }).click();
    await page.getByRole('button', { name: '保存并返回题目', exact: true }).click();
    await expect(page.getByRole('combobox', { name: '阅读材料（选填）', exact: true })).toHaveValue(/.+/);
    await page.getByRole('button', { name: '编辑已关联原文', exact: true }).click();
    await expect(page.getByLabel('追加原文图片', { exact: true })).toBeEnabled();
    await page.getByLabel('追加原文图片', { exact: true }).setInputFiles({ name: '阅读续页.png', mimeType: 'image/png', buffer: await sharp(bytes).flop().png().toBuffer() });
    await expect(page.getByRole('button', { name: '原文区 2', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: '选择整页', exact: true }).click();
    await page.getByRole('button', { name: '向前移动', exact: true }).click();
    await page.getByRole('button', { name: '保存并返回题目', exact: true }).click();
    await page.getByRole('button', { name: '返回列表', exact: true }).click();
    await page.getByRole('button', { name: '打开错题', exact: true }).click();
    await expect(page.getByRole('region', { name: '共享阅读材料', exact: true }).getByRole('img', { name: '阅读材料区', exact: true })).toHaveCount(2);
    await page.getByRole('button', { name: '从此原始页再收集一道', exact: true }).click();
    await page.getByRole('button', { name: '选择整页', exact: true }).click();
    await page.getByRole('button', { name: '下一步，选学科', exact: true }).click();
    await page.getByRole('combobox', { name: '学科', exact: true }).selectOption('chinese');
    await page.getByLabel('题号（选填）').fill('2');
    const materialId = await page.getByRole('combobox', { name: '阅读材料（选填）', exact: true }).inputValue();
    await page.getByRole('combobox', { name: '阅读材料（选填）', exact: true }).selectOption('');
    await page.getByRole('combobox', { name: '阅读材料（选填）', exact: true }).selectOption(materialId);
    await page.getByRole('button', { name: '保存到错题集', exact: true }).click();
    await expect(page.getByRole('region', { name: '共享阅读材料', exact: true })).toContainText('春天的故事');
    await page.getByRole('button', { name: '返回列表', exact: true }).click();
    await expect(page.getByRole('button', { name: '打开错题', exact: true })).toHaveCount(2);
    await page.getByRole('article').filter({ has: page.getByRole('heading', { name: '未填写来源 · 第 1 题', exact: true }) }).getByRole('button', { name: '打开错题', exact: true }).click();
    await page.getByRole('button', { name: '补充或更正信息', exact: true }).click();
    await page.getByRole('combobox', { name: '阅读材料（选填）', exact: true }).selectOption('');
    await page.getByRole('button', { name: '保存修改', exact: true }).click();
    await expect(page.getByRole('region', { name: '共享阅读材料', exact: true })).toHaveCount(0);
    const updated = await (await request.get(`${server.url}/api/v1/collection/questions/${question.id}`, { headers })).json();
    expect(updated.readingMaterial).toBeNull(); expect(updated.collectedAt).toBe(question.collectedAt);
    await page.reload();
    await page.getByRole('article').filter({ has: page.getByRole('heading', { name: '未填写来源 · 第 2 题', exact: true }) }).getByRole('button', { name: '打开错题', exact: true }).click();
    await expect(page.getByRole('region', { name: '共享阅读材料', exact: true }).getByRole('img', { name: '阅读材料区', exact: true })).toHaveCount(2);
    await page.getByRole('button', { name: '查看原始页', exact: true }).click();
    await expect(page.getByRole('img', { name: '原始页（保留作答和批改）', exact: true })).toHaveCount(2);
    for (const width of [390, 820, 1440]) {
      await page.setViewportSize({ width, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `test-results/reading-material-${width}-${test.info().project.name}.png`, fullPage: true });
    }
    const list = await (await request.get(`${server.url}/api/v1/collection/reading-materials`, { headers })).json();
    expect(list.total).toBe(1); expect(list.items[0].referenceCount).toBe(1);
    // A lost association response must not hide another device's later unlink.
    await page.getByRole('button', { name: '返回列表', exact: true }).click();
    await page.getByRole('article').filter({ has: page.getByRole('heading', { name: '未填写来源 · 第 1 题', exact: true }) }).getByRole('button', { name: '打开错题', exact: true }).click();
    await page.getByRole('button', { name: '补充或更正信息', exact: true }).click();
    await page.getByRole('button', { name: '从原始页新建阅读材料', exact: true }).click();
    await page.getByLabel('阅读材料名称').fill('重试时保留的原文');
    await page.getByRole('button', { name: '选择整页', exact: true }).click();
    await page.route('**/api/v1/collection/questions/*', async route => { await route.fetch(); await route.abort(); }, { times: 1 });
    await page.getByRole('button', { name: '保存并返回题目', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('仍保留');
    const linked: Question = await (await request.get(`${server.url}/api/v1/collection/questions/${question.id}`, { headers })).json();
    expect(linked.readingMaterial?.title).toBe('重试时保留的原文');
    const unlinked = await request.put(`${server.url}/api/v1/collection/questions/${question.id}`, { headers, data: {
      ...fields, expectedRevision: linked.revision, operationId: crypto.randomUUID(), readingMaterialId: null,
      parts: linked.parts.map(part => ({ id: part.id, pageId: part.originalPage.id, region: part.region })), note: '另一设备已解除引用'
    } });
    expect(unlinked.status()).toBe(200);
    await page.getByRole('button', { name: '保存并返回题目', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('题目已在其他页面更新');
    await expect(page.getByLabel('阅读材料名称')).toHaveValue('重试时保留的原文');
    expect(await (await request.get(`${server.url}/api/v1/collection/questions/${question.id}`, { headers })).json()).toEqual(await unlinked.json());
  } finally { await server.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('后台原文保存及关联响应丢失可重试，修改不重复创建，到期保护输入且旧修订不覆盖', async ({ page, request }) => {
  const dir = await mkdtemp(join(tmpdir(), 'klbook-reading-retry-'));
  const server = await startServer(dir);
  try {
    const setupCode = (await readFile(join(dir, 'setup-code.txt'), 'utf8')).trim();
    const first = await (await request.post(`${server.url}/api/v1/setup`, { data: { setupCode, username: 'parent', password: 'family password 123', learnerName: '小明', deviceName: '设置电脑' } })).json();
    const headers = { Authorization: `Bearer ${first.token}` };
    const bytes = await sharp(await readFile('test/fixtures/paper.svg')).png().toBuffer();
    const paper = await (await request.post(`${server.url}/api/v1/collection/pages`, { headers: { ...headers, 'Content-Type': 'image/png', 'Idempotency-Key': crypto.randomUUID() }, data: bytes })).json();
    const fields = { state: 'collected', subjectId: 'english', region: { x: 0, y: 0, width: 1, height: 1 }, sourceId: null, pageNumber: '', questionNumber: '', note: '' };
    const question = await (await request.post(`${server.url}/api/v1/collection/pages/${paper.id}/questions`, { headers, data: { ...fields, operationId: crypto.randomUUID() } })).json();
    await page.goto(`${server.url}/admin/materials`);
    await page.getByLabel('家长账号').fill('parent'); await page.getByLabel('家长密码', { exact: true }).fill('family password 123');
    await page.getByRole('button', { name: '登录此设备', exact: true }).click();
    await page.getByLabel('家长密码', { exact: true }).fill('family password 123'); await page.getByRole('button', { name: '验证并进入管理', exact: true }).click();
    await page.getByRole('table', { name: '已收集资料' }).getByRole('button', { name: '打开', exact: true }).click();
    await expect(page.getByLabel('追加跨页图片', { exact: true })).toBeEnabled();
    await page.getByLabel('追加跨页图片', { exact: true }).setInputFiles({ name: '新追加原始页.png', mimeType: 'image/png', buffer: await sharp(bytes).flop().png().toBuffer() });
    await expect(page.getByRole('button', { name: '题目区 2', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: '选择整页', exact: true }).click();
    await page.getByRole('button', { name: '确认题目范围', exact: true }).click();
    await page.getByLabel('备注（选填）').fill('先保存小题的修改');
    await page.getByRole('button', { name: '从原始页新建阅读材料', exact: true }).click();
    await page.getByRole('button', { name: '保存后离开', exact: true }).click();
    await page.getByLabel('阅读材料名称', { exact: true }).fill('My story'); await page.getByRole('button', { name: '选择整页', exact: true }).click();
    await page.getByRole('button', { name: '原文区 2', exact: true }).click();
    await page.getByRole('button', { name: '选择整页', exact: true }).click();
    await page.route('**/api/v1/collection/reading-materials/*', async route => { await route.fetch(); await route.abort(); }, { times: 1 });
    await page.getByRole('button', { name: '保存并返回题目', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('仍保留');
    await page.getByLabel('阅读材料名称', { exact: true }).fill('My revised story');
    await page.route('**/api/v1/collection/questions/*', async route => { await route.fetch(); await route.abort(); }, { times: 1 });
    await page.getByRole('button', { name: '保存并返回题目', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('仍保留');
    await page.getByRole('button', { name: '保存并返回题目', exact: true }).click();
    await expect(page.getByLabel('备注（选填）')).toHaveValue('先保存小题的修改');
    const saved = await (await request.get(`${server.url}/api/v1/collection/questions/${question.id}`, { headers })).json();
    expect(saved.readingMaterial.title).toBe('My revised story');
    expect(saved.readingMaterial.parts.map((part: { originalPage: { id: string } }) => part.originalPage.id)).toEqual(saved.parts.map((part: { originalPage: { id: string } }) => part.originalPage.id));
    expect((await (await request.get(`${server.url}/api/v1/collection/reading-materials`, { headers })).json()).total).toBe(1);
    await page.getByRole('button', { name: '编辑已关联原文', exact: true }).click();
    await page.getByLabel('阅读材料名称', { exact: true }).fill('本页尚未保存的名称');
    await request.put(`${server.url}/api/v1/collection/reading-materials/${saved.readingMaterial.id}`, { headers, data: { operationId: crypto.randomUUID(), expectedRevision: saved.readingMaterial.revision, title: '另一设备已更正', parts: saved.readingMaterial.parts.map((part: { id: string; originalPage: { id: string }; region: object }) => ({ id: part.id, pageId: part.originalPage.id, region: part.region })) } });
    await page.getByRole('button', { name: '保存并返回题目', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('阅读材料已更新');
    await expect(page.getByLabel('阅读材料名称')).toHaveValue('本页尚未保存的名称');
    await page.getByRole('button', { name: '返回题目', exact: true }).click(); await page.getByRole('button', { name: '放弃本次修改并离开', exact: true }).click();
    await page.getByRole('button', { name: '编辑已关联原文', exact: true }).click();
    await expect(page.getByLabel('阅读材料名称')).toHaveValue('另一设备已更正');
    await page.getByLabel('阅读材料名称').fill('验证后继续');
    await page.route('**/api/v1/collection/reading-materials/*', async route => {
      const sent = route.request().headers();
      await request.delete(`${server.url}/api/v1/admin/grants`, { headers: { Authorization: sent.authorization!, 'X-Parent-Authorization': sent['x-parent-authorization']! } });
      await route.continue();
    }, { times: 1 });
    await page.getByRole('button', { name: '保存并返回题目', exact: true }).click();
    await expect(page.getByRole('heading', { name: '验证家长身份', exact: true })).toBeVisible();
    await page.getByLabel('家长密码', { exact: true }).fill('family password 123'); await page.getByRole('button', { name: '验证并进入管理', exact: true }).click();
    await expect(page.getByLabel('阅读材料名称')).toHaveValue('验证后继续');
    await page.getByRole('button', { name: '保存并返回题目', exact: true }).click();
    await expect(page.getByRole('region', { name: '共享阅读材料', exact: true })).toContainText('验证后继续');
  } finally { await server.stop(); await rm(dir, { recursive: true, force: true }); }
});
