import { expect, test } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { startServer } from './server.ts';

async function fixture(request: APIRequestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'klbook-admin-materials-'));
  const server = await startServer(dir);
  const setupCode = (await readFile(join(dir, 'setup-code.txt'), 'utf8')).trim();
  const initial = await (await request.post(`${server.url}/api/v1/setup`, { data: { setupCode, username: 'parent', password: 'family password 123', learnerName: '小明', deviceName: '电脑' } })).json();
  const image = await sharp(await readFile(new URL('../fixtures/paper.svg', import.meta.url))).png().toBuffer();
  const headers = { Authorization: `Bearer ${initial.token}` };
  return { ...server, headers, image, initial, async close() { await server.stop(); await rm(dir, { recursive: true, force: true }); } };
}
async function login(page: Page, url: string) {
  await page.goto(url);
  await page.getByLabel('家长账号').fill('parent');
  await page.getByLabel('家长密码', { exact: true }).fill('family password 123');
  await page.getByRole('button', { name: '登录此设备' }).click();
}
async function unlock(page: Page) {
  await page.getByLabel('家长密码', { exact: true }).fill('family password 123');
  await page.getByRole('button', { name: '验证并进入管理' }).click();
}

test('后台批量处理保护当前修改，取消一张并刷新后继续，材料不重复', async ({ page, request }) => {
  const f = await fixture(request);
  try {
    await login(page, `${f.url}/admin/materials`); await unlock(page);
    await expect(page.getByLabel('上传材料', { exact: true })).toBeEnabled();
    await page.getByLabel('上传材料', { exact: true }).setInputFiles(['第一张', '第二张', '第三张'].map(name => ({ name: `${name}.png`, mimeType: 'image/png', buffer: f.image })));
    await page.getByRole('button', { name: '选择整页' }).click();
    await page.getByRole('combobox', { name: '学科', exact: true }).selectOption('math');
    await page.getByRole('button', { name: '保存到错题集' }).click();
    await expect(page.getByRole('status')).toHaveText('已同步到家庭资料库');
    await page.getByLabel('备注（选填）').fill('批次切换前保留');
    await page.getByRole('button', { name: '继续下一张', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '还有未保存的修改' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: '继续编辑' }).click();
    await page.getByRole('button', { name: '取消 第二张.png', exact: true }).click();
    await page.getByRole('button', { name: '稍后继续', exact: true }).click();
    await dialog.getByRole('button', { name: '保存后离开' }).click();
    await expect(page.getByRole('button', { name: '继续上传 第三张.png', exact: true })).toBeVisible();
    await page.reload(); await unlock(page);
    await page.getByRole('button', { name: '继续上传 第三张.png', exact: true }).click();
    await page.getByRole('button', { name: '选择整页' }).click();
    await page.getByRole('combobox', { name: '学科', exact: true }).selectOption('science');
    await page.getByRole('button', { name: '保存到错题集' }).click();
    await expect(page.getByRole('status')).toHaveText('已同步到家庭资料库');
    const all = await (await request.get(`${f.url}/api/v1/collection/questions?state=collected`, { headers: f.headers })).json();
    expect(all.total).toBe(2);
    expect(all.items.find((item: { note: string }) => item.note === '批次切换前保留')).toBeTruthy();
    expect((await (await request.get(`${f.url}/api/v1/collection/questions?state=draft`, { headers: f.headers })).json()).total).toBe(0);
  } finally { await f.close(); }
});

test('服务端撤销管理授权后上传与保存被拒绝，重新验证保留材料和表单', async ({ page, request }) => {
  const f = await fixture(request);
  try {
    await login(page, `${f.url}/admin/materials`); await unlock(page);
    async function revoke(headers: Record<string, string>) {
      expect(headers['x-parent-authorization']).toBeTruthy();
      expect((await request.delete(`${f.url}/api/v1/admin/grants`, { headers: { authorization: headers.authorization!, 'x-parent-authorization': headers['x-parent-authorization']! } })).status()).toBe(204);
    }
    await page.route('**/api/v1/collection/drafts', async route => { await revoke(route.request().headers()); await route.continue(); }, { times: 1 });
    await expect(page.getByLabel('上传材料', { exact: true })).toBeEnabled();
    await page.getByLabel('上传材料', { exact: true }).setInputFiles({ name: '授权撤销.png', mimeType: 'image/png', buffer: f.image });
    await expect(page.getByRole('heading', { name: '验证家长身份' })).toBeVisible();
    expect((await (await request.get(`${f.url}/api/v1/collection/questions?state=draft`, { headers: f.headers })).json()).total).toBe(0);
    await unlock(page);
    await page.getByRole('button', { name: '继续上传 授权撤销.png', exact: true }).click();
    await page.getByRole('button', { name: '选择整页' }).click();
    await page.getByRole('combobox', { name: '学科', exact: true }).selectOption('math');
    await page.getByLabel('备注（选填）').fill('重新验证也要保留');
    await page.route('**/api/v1/collection/questions/*', async route => { await revoke(route.request().headers()); await route.continue(); }, { times: 1 });
    await page.getByRole('button', { name: '保存到错题集' }).click();
    await expect(page.getByRole('heading', { name: '验证家长身份' })).toBeVisible();
    expect((await (await request.get(`${f.url}/api/v1/collection/questions?state=collected`, { headers: f.headers })).json()).total).toBe(0);
    await unlock(page);
    await expect(page.getByLabel('备注（选填）')).toHaveValue('重新验证也要保留');
    await page.getByRole('button', { name: '保存到错题集' }).click();
    await expect(page.getByRole('status')).toHaveText('已同步到家庭资料库');
    const saved = await (await request.get(`${f.url}/api/v1/collection/questions?state=collected`, { headers: f.headers })).json();
    expect(saved.total).toBe(1); expect(saved.items[0].note).toBe('重新验证也要保留');
  } finally { await f.close(); }
});

test('后台资料按状态显示真实总数和分页，每行单一打开入口，窄屏表格内部滚动', async ({ page, request }) => {
  const f = await fixture(request);
  try {
    const small = await sharp({ create: { width: 32, height: 32, channels: 3, background: 'white' } }).png().toBuffer();
    for (let i = 0; i < 53; i++) {
      const draft = await (await request.post(`${f.url}/api/v1/collection/drafts`, { data: small, headers: { ...f.headers, 'Content-Type': 'image/png', 'Idempotency-Key': crypto.randomUUID() } })).json();
      if (i >= 51) continue;
      expect((await request.put(`${f.url}/api/v1/collection/questions/${draft.id}`, { headers: f.headers, data: { operationId: crypto.randomUUID(), expectedRevision: draft.revision, state: 'collected', subjectId: 'math', region: { x: 0, y: 0, width: 1, height: 1 }, sourceId: null, pageNumber: '6', questionNumber: String(i + 1), note: '' } })).status()).toBe(200);
    }
    await login(page, `${f.url}/admin/materials`);
    await expect(page.getByRole('table')).toHaveCount(0);
    await unlock(page);
    const table = page.getByRole('table', { name: '已收集资料' });
    await expect(table.getByRole('row')).toHaveCount(51);
    await expect(page.getByText('已显示 50 / 51 道', { exact: true })).toBeVisible();
    for (const row of await table.getByRole('row').all()) {
      if (await row.getByRole('cell').count()) await expect(row.getByRole('button')).toHaveText(['打开']);
    }
    await expect(page.getByLabel('上传材料', { exact: true })).toHaveCount(1);
    await page.getByRole('button', { name: '加载更多' }).click();
    await expect(table.getByRole('row')).toHaveCount(52);
    await expect(page.getByText('已显示 51 / 51 道', { exact: true })).toBeVisible();
    for (const width of [1440, 820, 390]) {
      await page.setViewportSize({ width, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const scroll = page.getByRole('region', { name: '资料表格，可横向滚动' });
      await scroll.focus(); await page.keyboard.press('End');
      if (width === 390) expect(await scroll.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({ path: `test-results/admin-materials-${width}-${test.info().project.name}.png` });
    }
    await page.getByRole('button', { name: '草稿', exact: true }).click();
    await expect(page.getByRole('table', { name: '草稿资料' }).getByRole('button', { name: '打开', exact: true })).toHaveCount(2);
    await expect(page.getByText('已显示 2 / 2 道', { exact: true })).toBeVisible();
    await page.route('**/api/v1/collection/questions?*', route => route.abort());
    await page.getByRole('button', { name: '刷新列表' }).click();
    await expect(page.getByRole('alert')).toContainText('暂时无法读取');
    await expect(page.getByText('已显示 0 / 0 道', { exact: true })).toHaveCount(0);
    await page.unroute('**/api/v1/collection/questions?*');
    await page.getByRole('button', { name: '重试读取' }).click();
    await expect(page.getByText('已显示 2 / 2 道', { exact: true })).toBeVisible();
  } finally { await f.close(); }
});

test('来源独立表格保护未提交表单，保存失败留在原页，刷新和重新验证保留输入', async ({ page, request }) => {
  const f = await fixture(request);
  try {
    await page.clock.install();
    await login(page, `${f.url}/admin/sources`); await unlock(page);
    const table = page.getByRole('table', { name: '来源列表' });
    await expect(table.getByRole('row')).toHaveCount(5);
    await page.getByLabel('来源名称', { exact: true }).fill('每周小测');
    await page.getByRole('button', { name: '刷新来源列表' }).click();
    await expect(page.getByLabel('来源名称', { exact: true })).toHaveValue('每周小测');
    await page.getByRole('button', { name: '管理概览', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '来源还有未保存的修改' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: '继续编辑' }).click();
    await page.getByRole('button', { name: '管理概览', exact: true }).click();
    await page.route('**/api/v1/admin/sources/*', route => route.abort());
    await dialog.getByRole('button', { name: '保存后离开' }).click();
    await expect(dialog.getByRole('alert')).toContainText('无法连接');
    await expect(page).toHaveURL(`${f.url}/admin/sources`);
    await page.unroute('**/api/v1/admin/sources/*');
    await dialog.getByRole('button', { name: '保存后离开' }).click();
    await expect(page.getByRole('region', { name: '启用来源数' }).locator('strong')).toHaveText('5');
    await page.goBack();
    await page.getByRole('button', { name: '改名 每周小测', exact: true }).click();
    await page.getByLabel('来源名称', { exact: true }).fill('新名字先不提交');
    await page.clock.fastForward(5 * 60 * 1000 + 10);
    await expect(page.getByRole('heading', { name: '验证家长身份' })).toBeVisible();
    await page.getByRole('button', { name: '返回错题集', exact: true }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: '保存后离开' })).toBeDisabled();
    await dialog.getByRole('button', { name: '继续编辑' }).click();
    await page.clock.setFixedTime(new Date());
    await page.getByLabel('家长密码', { exact: true }).fill('wrong password 123');
    await page.getByRole('button', { name: '验证并进入管理' }).click();
    await expect(page.getByRole('heading', { name: '验证家长身份' })).toBeVisible();
    await unlock(page);
    await expect(page.getByLabel('来源名称', { exact: true })).toHaveValue('新名字先不提交');
    await page.getByRole('button', { name: '结束管理', exact: true }).click();
    await dialog.getByRole('button', { name: '放弃本次修改并离开' }).click();
    await expect(page).toHaveURL(`${f.url}/learn`);
    await page.getByRole('button', { name: '我的', exact: true }).click();
    await page.getByRole('button', { name: '家长管理', exact: true }).click();
    await unlock(page);
    await page.getByRole('button', { name: '来源管理', exact: true }).click();
    await expect(table.getByRole('cell', { name: '每周小测', exact: true })).toHaveCount(1);
    await expect(table.getByRole('cell', { name: '新名字先不提交', exact: true })).toHaveCount(0);
  } finally { await f.close(); }
});

test('来源重名与并发冲突不覆盖输入，保存离开时被撤权可重新验证后继续', async ({ page, request }) => {
  const f = await fixture(request);
  try {
    const grant = await (await request.post(`${f.url}/api/v1/admin/grants`, { headers: f.headers, data: { password: 'family password 123' } })).json();
    const parentHeaders = { ...f.headers, 'X-Parent-Authorization': grant.token };
    await login(page, `${f.url}/admin/sources`); await unlock(page);
    await page.getByLabel('来源名称', { exact: true }).fill('练习册');
    await page.getByRole('button', { name: '添加来源', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('已有同名来源');
    await expect(page.getByLabel('来源名称', { exact: true })).toHaveValue('练习册');
    await page.getByRole('button', { name: '取消修改', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '来源还有未保存的修改' });
    await dialog.getByRole('button', { name: '放弃本次修改并离开' }).click();
    await page.getByRole('button', { name: '改名 练习册', exact: true }).click();
    await page.getByLabel('来源名称', { exact: true }).fill('本页输入暂保留');
    const all = await (await request.get(`${f.url}/api/v1/admin/sources`, { headers: parentHeaders })).json();
    const source = all.find((item: { name: string }) => item.name === '练习册');
    expect((await request.put(`${f.url}/api/v1/admin/sources/${source.id}`, { headers: parentHeaders, data: { operationId: crypto.randomUUID(), expectedRevision: source.revision, name: '另一会话已更名', active: true } })).status()).toBe(200);
    await page.getByRole('button', { name: '保存来源', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('修改');
    await expect(page.getByLabel('来源名称', { exact: true })).toHaveValue('本页输入暂保留');
    await page.getByRole('button', { name: '刷新来源列表', exact: true }).click();
    await expect(page.getByRole('cell', { name: '另一会话已更名', exact: true })).toBeVisible();
    await expect(page.getByLabel('来源名称', { exact: true })).toHaveValue('本页输入暂保留');
    await page.getByRole('button', { name: '取消修改', exact: true }).click();
    await dialog.getByRole('button', { name: '放弃本次修改并离开' }).click();
    await page.getByRole('button', { name: '改名 另一会话已更名', exact: true }).click();
    await page.getByLabel('来源名称', { exact: true }).fill('共同确认的名字');
    await page.route('**/api/v1/admin/sources/*', async route => {
      const headers = route.request().headers();
      expect((await request.delete(`${f.url}/api/v1/admin/grants`, { headers: { authorization: headers.authorization!, 'x-parent-authorization': headers['x-parent-authorization']! } })).status()).toBe(204);
      await route.continue();
    }, { times: 1 });
    await page.getByRole('button', { name: '管理概览', exact: true }).click();
    await dialog.getByRole('button', { name: '保存后离开' }).click();
    await expect(page.getByRole('heading', { name: '验证家长身份' })).toBeVisible();
    await expect(dialog).not.toBeVisible();
    await unlock(page);
    await expect(page.getByLabel('来源名称', { exact: true })).toHaveValue('共同确认的名字');
    await page.getByRole('button', { name: '保存来源', exact: true }).click();
    await expect(page.getByRole('cell', { name: '共同确认的名字', exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 650 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole('region', { name: '来源表格，可横向滚动' }).focus();
    await page.keyboard.press('End');
    await page.screenshot({ path: `test-results/admin-sources-phone-${test.info().project.name}.png`, fullPage: true });
  } finally { await f.close(); }
});

test('后台上传后同页看图与编辑，草稿续接和更正保留身份，另一学习会话找回原图', async ({ page, browser, request }) => {
  const f = await fixture(request);
  const learner = await browser.newContext();
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, `${f.url}/admin/materials`); await unlock(page);
    await expect(page.getByLabel('上传材料', { exact: true })).toBeEnabled();
    await page.getByLabel('上传材料', { exact: true }).setInputFiles({ name: '家长协助.png', mimeType: 'image/png', buffer: f.image });
    await expect(page.getByRole('heading', { name: '错题资料详情', exact: true })).toBeVisible();
    await expect(page.getByRole('combobox', { name: '学科', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '选择整页' }).click();
    await page.getByRole('combobox', { name: '学科', exact: true }).selectOption('math');
    await page.getByRole('combobox', { name: '来源（选填）', exact: true }).selectOption({ label: '练习册' });
    await page.getByLabel('页码（选填）').fill('15');
    await page.getByLabel('题号（选填）').fill('3');
    await page.getByLabel('备注（选填）').fill('家长协助留下的草稿');
    const material = (await page.getByRole('region', { name: '题目与原始页' }).boundingBox())!;
    const subject = (await page.getByRole('combobox', { name: '学科', exact: true }).boundingBox())!;
    expect(material.x + material.width).toBeLessThan(subject.x);
    await page.getByRole('button', { name: '保存草稿' }).click();
    await expect(page.getByRole('status')).toContainText('草稿已保存');
    await page.getByRole('button', { name: '返回列表' }).click();
    await page.getByRole('button', { name: '草稿', exact: true }).click();
    await page.getByRole('table', { name: '草稿资料' }).getByRole('button', { name: '打开', exact: true }).click();
    await expect(page.getByLabel('备注（选填）')).toHaveValue('家长协助留下的草稿');
    await page.getByRole('button', { name: '保存到错题集' }).click();
    await expect(page.getByRole('status')).toHaveText('已同步到家庭资料库');
    await expect(page.getByRole('button', { name: '补充或更正信息' })).toHaveCount(0);
    const before = await (await request.get(`${f.url}/api/v1/collection/questions?state=collected`, { headers: f.headers })).json();
    await page.getByLabel('备注（选填）').fill('更正后仍是同一道题');
    await expect(page.getByRole('status')).toHaveCount(0);
    await page.route('**/api/v1/collection/questions/*', async route => {
      if (route.request().method() === 'PUT') { await route.fetch(); await route.abort(); } else await route.continue();
    });
    await page.getByRole('button', { name: '保存修改' }).click();
    await expect(page.getByRole('alert')).toContainText('当前填写内容仍保留');
    await page.unroute('**/api/v1/collection/questions/*');
    await page.getByRole('button', { name: '保存修改' }).click();
    await expect(page.getByRole('status')).toHaveText('已同步到家庭资料库');
    await page.getByRole('button', { name: '查看原始页' }).click();
    await expect(page.getByRole('img', { name: '原始页（保留作答和批改）' })).toBeVisible();
    await page.screenshot({ path: `test-results/admin-detail-${test.info().project.name}.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 650 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByLabel('备注（选填）').focus();
    await page.getByRole('button', { name: '保存修改' }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `test-results/admin-detail-phone-${test.info().project.name}.png`, fullPage: true });
    const second = await learner.newPage();
    await login(second, f.url);
    await second.getByRole('button', { name: '打开错题' }).click();
    await expect(second.getByText('更正后仍是同一道题', { exact: true })).toBeVisible();
    await second.getByRole('button', { name: '查看原始页' }).click();
    await expect(second.getByRole('img', { name: '原始页（保留作答和批改）' })).toBeVisible();
    const after = await (await request.get(`${f.url}/api/v1/collection/questions?state=collected`, { headers: f.headers })).json();
    expect(after.total).toBe(1);
    expect(after.items[0]).toMatchObject({ id: before.items[0].id, collectedAt: before.items[0].collectedAt, revision: before.items[0].revision + 1, pageNumber: '15', questionNumber: '3', source: '练习册', note: '更正后仍是同一道题' });
    expect(await (await request.get(`${f.url}/api/v1/collection/pages/${after.items[0].originalPage.id}/original`, { headers: f.headers })).body()).toEqual(f.image);
  } finally { await learner.close(); await f.close(); }
});
