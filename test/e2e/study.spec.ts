import { expect, test } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { startServer } from './server.ts';

test('后台新增学科和阶段，批次暂存保留旧归属，学习端更正与组合筛选后能打开原题', async ({ page, request }) => {
  const dir = await mkdtemp(join(tmpdir(), 'klbook-study-browser-'));
  const server = await startServer(dir);
  try {
    const setupCode = (await readFile(join(dir, 'setup-code.txt'), 'utf8')).trim();
    const first = await (await request.post(`${server.url}/api/v1/setup`, { data: { setupCode, username: 'parent', password: 'family password 123', learnerName: '小明', deviceName: '设置电脑' } })).json();
    const headers = { Authorization: `Bearer ${first.token}` };
    const image = await sharp(await readFile('test/fixtures/paper.svg')).png().toBuffer();
    const oldDraft = await (await request.post(`${server.url}/api/v1/collection/drafts`, { headers: { ...headers, 'Content-Type': 'image/png', 'Idempotency-Key': crypto.randomUUID() }, data: image })).json();
    await page.goto(`${server.url}/admin`);
    await page.getByLabel('家长账号').fill('parent'); await page.getByLabel('家长密码', { exact: true }).fill('family password 123');
    await page.getByRole('button', { name: '登录此设备', exact: true }).click();
    await page.getByLabel('家长密码', { exact: true }).fill('family password 123'); await page.getByRole('button', { name: '验证并进入管理', exact: true }).click();
    await page.getByRole('button', { name: '学科与学习阶段', exact: true }).click();
    await page.getByRole('textbox', { name: '新学科名称', exact: true }).fill('历史'); await page.getByRole('button', { name: '添加学科', exact: true }).click();
    await expect(page.getByRole('table', { name: '学科列表', exact: true }).getByText('历史', { exact: true })).toBeVisible();
    await page.getByRole('textbox', { name: '学年（选填）', exact: true }).fill('2025-2026'); await page.getByRole('textbox', { name: '年级（选填）', exact: true }).fill('小学四年级');
    await page.getByRole('combobox', { name: '学期（选填）', exact: true }).selectOption('second'); await page.getByRole('button', { name: '保存学习阶段', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: '学习阶段已保存' })).toBeVisible();
    await page.getByRole('button', { name: '结束管理', exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: '收集', exact: true }).click();
    await expect(page.getByLabel('选择题目图片')).toBeEnabled();
    await page.getByLabel('选择题目图片').setInputFiles([{ name: 'first.png', mimeType: 'image/png', buffer: image }, { name: 'second.png', mimeType: 'image/png', buffer: image }]);
    const finish = async () => {
      await page.getByRole('button', { name: '选择整页', exact: true }).click(); await page.getByRole('button', { name: '下一步，选学科', exact: true }).click();
      await expect(page.getByRole('textbox', { name: '学年（选填）', exact: true })).toHaveValue('2025-2026');
      await expect(page.getByRole('textbox', { name: '年级（选填）', exact: true })).toHaveValue('小学四年级');
      await page.getByRole('combobox', { name: '学科', exact: true }).selectOption({ label: '历史' }); await page.getByRole('button', { name: '保存到错题集', exact: true }).click();
      await expect(page.getByRole('heading', { name: '错题详情', exact: true })).toBeVisible();
    };
    await finish();
    const grant = await (await request.post(`${server.url}/api/v1/admin/grants`, { headers, data: { password: 'family password 123' } })).json();
    const changed = await request.put(`${server.url}/api/v1/admin/study-settings`, { headers: { ...headers, 'X-Parent-Authorization': grant.token }, data: { operationId: crypto.randomUUID(), expectedRevision: 1, stage: { schoolYear: '2026-2027', grade: '小学五年级', term: 'first' } } });
    expect(changed.ok()).toBeTruthy();
    await page.reload(); await page.getByRole('button', { name: '继续上传 second.png', exact: true }).click(); await finish();
    await page.getByRole('button', { name: '补充或更正信息', exact: true }).click();
    await page.getByRole('textbox', { name: '学年（选填）', exact: true }).fill('2024-2025'); await page.getByRole('textbox', { name: '年级（选填）', exact: true }).fill('小学三年级');
    await page.getByLabel('备注（选填）', { exact: true }).fill('补收旧题'); await page.getByRole('button', { name: '保存修改', exact: true }).click();
    await expect(page.getByText('2024-2025 学年 · 小学三年级 · 下学期', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '返回列表', exact: true }).click(); await page.getByRole('button', { name: '首页', exact: true }).click();
    await page.getByText('筛选错题', { exact: true }).click();
    await page.getByLabel('筛选学科', { exact: true }).selectOption({ label: '历史' }); await page.getByLabel('筛选学年', { exact: true }).selectOption('2024-2025');
    await page.getByLabel('筛选年级', { exact: true }).selectOption('小学三年级'); await page.getByLabel('筛选学期', { exact: true }).selectOption('second');
    await page.getByLabel('筛选来源', { exact: true }).selectOption('__unset__');
    const today = await page.evaluate(() => { const now = new Date(); return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`; });
    await page.getByLabel('收集开始日期', { exact: true }).fill(today); await page.getByLabel('收集结束日期', { exact: true }).fill(today);
    await page.getByRole('button', { name: '应用筛选', exact: true }).click();
    await expect(page.getByRole('button', { name: '打开错题', exact: true })).toHaveCount(1);
    await page.getByRole('button', { name: '打开错题', exact: true }).click(); await expect(page.getByText('补收旧题', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '返回列表', exact: true }).click();
    await page.getByText('筛选错题', { exact: true }).click(); await page.getByRole('button', { name: '清空筛选', exact: true }).click();
    await expect(page.getByRole('button', { name: '打开错题', exact: true })).toHaveCount(2);
    const old = await (await request.get(`${server.url}/api/v1/collection/questions/${oldDraft.id}`, { headers })).json();
    expect(old.studyStage).toEqual({ schoolYear: null, grade: null, term: null });
    const list = await (await request.get(`${server.url}/api/v1/collection/questions?state=collected`, { headers })).json();
    expect(list.items.map((q: { studyStage: { schoolYear: string } }) => q.studyStage.schoolYear).sort()).toEqual(['2024-2025', '2025-2026']);
    for (const width of [390, 820, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
      await page.screenshot({ path: `test-results/study-filters-${width}.png`, fullPage: true });
    }
  } finally { await server.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('管理设置保护未保存输入，新增和保存响应丢失可重试，重新验证和并发冲突不覆盖', async ({ page, request }) => {
  const dir = await mkdtemp(join(tmpdir(), 'klbook-study-protection-'));
  const server = await startServer(dir);
  try {
    const setupCode = (await readFile(join(dir, 'setup-code.txt'), 'utf8')).trim();
    const first = await (await request.post(`${server.url}/api/v1/setup`, { data: { setupCode, username: 'parent', password: 'family password 123', learnerName: '小明', deviceName: '设置电脑' } })).json();
    const headers = { Authorization: `Bearer ${first.token}` };
    await page.goto(`${server.url}/admin/study`);
    await page.getByLabel('家长账号').fill('parent'); await page.getByLabel('家长密码', { exact: true }).fill('family password 123'); await page.getByRole('button', { name: '登录此设备', exact: true }).click();
    const unlock = async () => { await page.getByLabel('家长密码', { exact: true }).fill('family password 123'); await page.getByRole('button', { name: '验证并进入管理', exact: true }).click(); };
    await unlock();
    await page.getByRole('textbox', { name: '新学科名称', exact: true }).fill('地理');
    await page.route('**/api/v1/admin/subjects/*', async route => { await route.fetch(); await route.abort(); }, { times: 1 });
    await page.getByRole('button', { name: '添加学科', exact: true }).click(); await expect(page.getByRole('alert')).toContainText('无法连接家庭电脑');
    await page.getByRole('button', { name: '添加学科', exact: true }).click();
    await expect(page.getByRole('table', { name: '学科列表' }).getByText('地理', { exact: true })).toHaveCount(1);
    await page.getByRole('textbox', { name: '学年（选填）', exact: true }).fill('2025-2026'); await page.getByRole('textbox', { name: '年级（选填）', exact: true }).fill('小学四年级');
    await page.getByRole('button', { name: '来源管理', exact: true }).click(); await expect(page.getByRole('dialog')).toBeVisible(); await page.getByRole('button', { name: '继续编辑', exact: true }).click();
    await page.route('**/api/v1/admin/study-settings', async route => { await route.fetch(); await route.abort(); }, { times: 1 });
    await page.getByRole('button', { name: '保存学习阶段', exact: true }).click(); await expect(page.getByRole('alert')).toContainText('无法连接家庭电脑');
    await page.getByRole('textbox', { name: '学年（选填）', exact: true }).fill('2026-2027'); await page.getByRole('textbox', { name: '年级（选填）', exact: true }).fill('小学五年级');
    await page.getByRole('button', { name: '保存学习阶段', exact: true }).click(); await expect(page.getByRole('status').filter({ hasText: '学习阶段已保存' })).toBeVisible();
    const read = () => request.get(`${server.url}/api/v1/collection/study-settings`, { headers }).then(response => response.json());
    expect(await read()).toEqual({ revision: 2, stage: { schoolYear: '2026-2027', grade: '小学五年级', term: null } });
    await page.getByRole('textbox', { name: '年级（选填）', exact: true }).fill('小学六年级');
    await page.route('**/api/v1/admin/study-settings', async route => {
      const sent = route.request().headers();
      expect((await request.delete(`${server.url}/api/v1/admin/grants`, { headers: { Authorization: sent.authorization!, 'X-Parent-Authorization': sent['x-parent-authorization']! } })).status()).toBe(204);
      await route.continue();
    }, { times: 1 });
    await page.getByRole('button', { name: '保存学习阶段', exact: true }).click(); await expect(page.getByRole('heading', { name: '验证家长身份', exact: true })).toBeVisible();
    await unlock(); await expect(page.getByRole('textbox', { name: '年级（选填）', exact: true })).toHaveValue('小学六年级');
    await page.getByRole('button', { name: '保存学习阶段', exact: true }).click(); await expect.poll(async () => (await read()).revision).toBe(3);
    const grant = await (await request.post(`${server.url}/api/v1/admin/grants`, { headers, data: { password: 'family password 123' } })).json();
    expect((await request.put(`${server.url}/api/v1/admin/study-settings`, { headers: { ...headers, 'X-Parent-Authorization': grant.token }, data: { operationId: crypto.randomUUID(), expectedRevision: 3, stage: { schoolYear: null, grade: null, term: null } } })).ok()).toBeTruthy();
    await page.getByRole('combobox', { name: '学期（选填）', exact: true }).selectOption('second'); await page.getByRole('button', { name: '保存学习阶段', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('其他页面更新'); await expect(page.getByRole('combobox', { name: '学期（选填）', exact: true })).toHaveValue('second');
    await page.getByRole('button', { name: '重新读取设置', exact: true }).click(); await page.getByRole('button', { name: '放弃本次修改并离开', exact: true }).click();
    await expect(page.getByRole('textbox', { name: '学年（选填）', exact: true })).toHaveValue('');
    await page.getByRole('button', { name: '来源管理', exact: true }).click();
    expect((await request.put(`${server.url}/api/v1/admin/study-settings`, { headers: { ...headers, 'X-Parent-Authorization': grant.token }, data: { operationId: crypto.randomUUID(), expectedRevision: 4, stage: { schoolYear: '2027-2028', grade: '初中一年级', term: 'first' } } })).ok()).toBeTruthy();
    await page.getByRole('button', { name: '学科与学习阶段', exact: true }).click();
    await expect(page.getByRole('textbox', { name: '学年（选填）', exact: true })).toHaveValue('2027-2028');
    expect((await request.put(`${server.url}/api/v1/admin/study-settings`, { headers: { ...headers, 'X-Parent-Authorization': grant.token }, data: { operationId: crypto.randomUUID(), expectedRevision: 5, stage: { schoolYear: null, grade: null, term: null } } })).ok()).toBeTruthy();
    await page.getByRole('button', { name: '保存学习阶段', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('其他页面更新');
    await page.screenshot({ path: 'test-results/study-admin.png', fullPage: true });
  } finally { await server.stop(); await rm(dir, { recursive: true, force: true }); }
});
