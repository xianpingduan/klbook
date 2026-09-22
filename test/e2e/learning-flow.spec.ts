import { expect, test } from '@playwright/test';
import type { Page, APIRequestContext } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { startServer } from './server.ts';

async function fixture(request: APIRequestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'klbook-learning-'));
  const server = await startServer(dir);
  const setupCode = (await readFile(join(dir, 'setup-code.txt'), 'utf8')).trim();
  const initial = await (await request.post(`${server.url}/api/v1/setup`, { data: { setupCode, username: 'parent', password: 'family password 123', learnerName: '小明', deviceName: '电脑' } })).json();
  const image = await sharp(await readFile(new URL('../fixtures/paper.svg', import.meta.url))).png().toBuffer();
  const headers = { Authorization: `Bearer ${initial.token}` };
  return { ...server, dir, image, initial, headers, async close() { await server.stop(); await rm(dir, { recursive: true, force: true }); } };
}
async function login(page: Page, url: string) {
  await page.goto(url);
  await page.getByLabel('家长账号').fill('parent');
  await page.getByLabel('家长密码', { exact: true }).fill('family password 123');
  await page.getByRole('button', { name: '登录此设备' }).click();
}

test('首页、收集、我的各只有固定职责，电脑直接选图且草稿只在收集页', async ({ page, request }) => {
  const f = await fixture(request);
  try {
    await request.post(`${f.url}/api/v1/collection/drafts`, { data: f.image, headers: { ...f.headers, 'Content-Type': 'image/png', 'Idempotency-Key': crypto.randomUUID() } });
    await login(page, f.url);
    await expect(page.getByText('不会的题，可以慢慢弄懂。', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '继续整理' })).toHaveCount(0);
    await expect(page.locator('input[type=file]')).toHaveCount(0);
    await page.getByRole('button', { name: '收集', exact: true }).click();
    await expect(page.getByLabel('选择题目图片')).toBeVisible();
    await expect(page.locator('input[type=file]')).toHaveCount(1);
    await expect(page.getByRole('button', { name: '收集一道错题' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '已收集', exact: true })).toHaveCount(0);
    await expect(page.getByRole('region', { name: '已保存的草稿' }).getByRole('button', { name: '继续整理' })).toHaveCount(1);
    await page.getByRole('button', { name: '我的', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('家庭资料库已连接');
    await expect(page.getByRole('button', { name: '继续整理' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '家长管理', exact: true })).toHaveCount(1);
  } finally { await f.close(); }
});

test('浏览器后退和返回前处理未保存输入，保存失败留在原题，放弃不删除草稿', async ({ page, request }) => {
  const f = await fixture(request);
  try {
    await login(page, f.url);
    await page.getByRole('button', { name: '收集', exact: true }).click();
    await expect(page.getByLabel('选择题目图片')).toBeEnabled();
    await page.getByLabel('选择题目图片').setInputFiles({ name: '离开保护.png', mimeType: 'image/png', buffer: f.image });
    await page.getByRole('button', { name: '选择整页' }).click();
    await page.getByRole('button', { name: '下一步，选学科' }).click();
    await page.getByLabel('备注（选填）').fill('后退也要保留');
    await page.goBack();
    const dialog = page.getByRole('dialog', { name: '还有未保存的修改' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: '继续编辑' }).click();
    await expect(page).toHaveURL(`${f.url}/learn/collect`);
    await expect(page.getByLabel('备注（选填）')).toHaveValue('后退也要保留');
    await page.getByRole('button', { name: '返回列表' }).click();
    await page.route('**/api/v1/collection/questions/*', route => route.request().method() === 'PUT' ? route.abort() : route.continue());
    await dialog.getByRole('button', { name: '保存后离开' }).click();
    await expect(dialog.getByRole('alert')).toContainText('当前填写内容仍保留');
    await expect(page).toHaveURL(`${f.url}/learn/collect`);
    await page.unroute('**/api/v1/collection/questions/*');
    await dialog.getByRole('button', { name: '保存后离开' }).click();
    await expect(page.getByRole('region', { name: '已保存的草稿' })).toBeVisible();
    const list = await (await request.get(`${f.url}/api/v1/collection/questions?state=draft`, { headers: f.headers })).json();
    expect(list.total).toBe(1);
    expect(list.items[0].note).toBe('后退也要保留');
    await page.getByRole('button', { name: '继续整理' }).click();
    await page.getByLabel('备注（选填）').fill('这一句放弃');
    await page.goBack();
    await dialog.getByRole('button', { name: '放弃本次修改并离开' }).click();
    await expect(page).toHaveURL(`${f.url}/learn`);
    await page.goForward();
    await expect(page.getByRole('region', { name: '已保存的草稿' })).toBeVisible();
    await page.getByRole('button', { name: '继续整理' }).click();
    await expect(page.getByLabel('备注（选填）')).toHaveValue('后退也要保留');
  } finally { await f.close(); }
});

test('框题与确认分步保存，选填信息和原图可在另一会话找回，更正不改变收集身份', async ({ page, request }) => {
  const f = await fixture(request);
  try {
    await login(page, f.url);
    await page.getByRole('button', { name: '收集', exact: true }).click();
    await expect(page.getByLabel('选择题目图片')).toBeEnabled();
    await page.getByLabel('选择题目图片').setInputFiles({ name: '作业.png', mimeType: 'image/png', buffer: f.image });
    await expect(page.getByRole('heading', { name: '框住这道题' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: '学习导航' })).toHaveCount(0);
    await expect(page.getByRole('combobox', { name: '学科', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '选择整页' }).click();
    await page.getByRole('button', { name: '下一步，选学科' }).click();
    await expect(page.getByRole('heading', { name: '确认并保存' })).toBeVisible();
    await page.getByRole('combobox', { name: '学科', exact: true }).selectOption('math');
    await page.getByRole('combobox', { name: '来源（选填）', exact: true }).selectOption({ label: '练习册' });
    await page.getByLabel('页码（选填）').fill('7');
    await page.getByLabel('题号（选填）').fill('2');
    await page.getByLabel('备注（选填）').fill('还有一点没懂');
    await page.getByRole('button', { name: '保存到错题集' }).click();
    await expect(page.getByRole('heading', { name: '错题详情' })).toBeVisible();
    const before = await (await request.get(`${f.url}/api/v1/collection/questions?state=collected`, { headers: f.headers })).json();
    expect(before.total).toBe(1);
    expect(before.items[0]).toMatchObject({ pageNumber: '7', questionNumber: '2', source: '练习册', note: '还有一点没懂' });
    await page.getByRole('button', { name: '补充或更正信息' }).click();
    await page.getByLabel('备注（选填）').fill('现在补充了思考');
    await page.getByRole('button', { name: '保存修改' }).click();
    await page.getByRole('button', { name: '查看原始页' }).click();
    await expect(page.getByRole('img', { name: '原始页（保留作答和批改）' })).toBeVisible();
    const after = await (await request.get(`${f.url}/api/v1/collection/questions?state=collected`, { headers: f.headers })).json();
    expect(after.total).toBe(1);
    expect(after.items[0]).toMatchObject({ id: before.items[0].id, collectedAt: before.items[0].collectedAt, state: 'collected', note: '现在补充了思考' });
    const original = await request.get(`${f.url}/api/v1/collection/pages/${after.items[0].originalPage.id}/original`, { headers: f.headers });
    expect(await original.body()).toEqual(f.image);
  } finally { await f.close(); }
});

test('首页和草稿各能加载第二页，手机平板电脑的列表与键盘操作均可达', async ({ page, request }) => {
  const f = await fixture(request);
  try {
    const small = await sharp({ create: { width: 32, height: 32, channels: 3, background: 'white' } }).png().toBuffer();
    for (let i = 0; i < 102; i++) {
      const question = await (await request.post(`${f.url}/api/v1/collection/drafts`, { data: small, headers: { ...f.headers, 'Content-Type': 'image/png', 'Idempotency-Key': crypto.randomUUID() } })).json();
      if (i >= 51) continue;
      expect((await request.put(`${f.url}/api/v1/collection/questions/${question.id}`, { headers: f.headers, data: { expectedRevision: question.revision, operationId: crypto.randomUUID(), state: 'collected', subjectId: 'math', region: { x: 0, y: 0, width: 1, height: 1 }, sourceId: null, pageNumber: '', questionNumber: String(i), note: '' } })).status()).toBe(200);
    }
    await login(page, f.url);
    await expect(page.getByRole('button', { name: '打开错题' })).toHaveCount(50);
    await page.getByRole('button', { name: '加载更多' }).click();
    await expect(page.getByRole('button', { name: '打开错题' })).toHaveCount(51);
    await expect(page.getByRole('button', { name: '加载更多' })).toHaveCount(0);
    for (const width of [390, 820, 1440]) {
      await page.setViewportSize({ width, height: 844 });
      await page.evaluate(() => window.scrollTo(0, 0));
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `test-results/learning-home-${width}-${test.info().project.name}.png` });
    }
    await page.getByRole('button', { name: '收集', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: '继续整理' })).toHaveCount(50);
    await page.getByRole('button', { name: '加载更多' }).click();
    await expect(page.getByRole('button', { name: '继续整理' })).toHaveCount(51);
    await page.getByRole('button', { name: '继续整理' }).first().click();
    await page.getByRole('button', { name: '选择整页' }).click();
    await page.getByRole('button', { name: '下一步，选学科' }).click();
    for (const width of [390, 820, 1440]) {
      await page.setViewportSize({ width, height: 650 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.getByLabel('备注（选填）').fill('键盘打开时也能滚动到保存');
      await page.getByRole('button', { name: '保存草稿' }).scrollIntoViewIfNeeded();
      expect((await page.getByRole('button', { name: '保存草稿' }).boundingBox())!.height).toBeGreaterThanOrEqual(48);
      await page.screenshot({ path: `test-results/learning-confirm-${width}-${test.info().project.name}.png`, fullPage: true });
    }
  } finally { await f.close(); }
});

test('服务列表读取失败仍能看见本机材料，取消不删除已接收的草稿', async ({ page, request }) => {
  const f = await fixture(request);
  try {
    await login(page, f.url);
    await page.getByRole('button', { name: '收集', exact: true }).click();
    let uploadId = '';
    await page.route('**/api/v1/collection/drafts', async route => {
      // WebKit's interception does not expose a File-backed request body; replay the chosen fixture bytes.
      const accepted = await route.fetch({ postData: f.image });
      expect(accepted.status()).toBe(201);
      uploadId = (await accepted.json()).id;
      await route.abort();
    });
    await expect(page.getByLabel('选择题目图片')).toBeEnabled();
    await page.getByLabel('选择题目图片').setInputFiles({ name: '收到但响应丢失.png', mimeType: 'image/png', buffer: f.image });
    await expect(page.getByRole('alert')).toContainText('无法连接家庭电脑');
    await page.route('**/api/v1/collection/questions?*', route => route.abort());
    await page.reload();
    await expect(page.getByRole('region', { name: '本机待上传图片' })).toContainText('收到但响应丢失.png');
    await expect(page.getByRole('region', { name: '已保存的草稿' })).toContainText('暂时无法读取');
    await expect(page.getByRole('heading', { name: '还没有草稿' })).toHaveCount(0);
    await page.unroute('**/api/v1/collection/questions?*');
    await page.getByRole('button', { name: '取消 收到但响应丢失.png', exact: true }).click();
    await expect(page.getByRole('region', { name: '本机待上传图片' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '继续整理' })).toHaveCount(1);
    const drafts = await (await request.get(`${f.url}/api/v1/collection/questions?state=draft`, { headers: f.headers })).json();
    expect(drafts.total).toBe(1);
    expect(drafts.items[0].id).toBe(uploadId);
    await page.getByRole('button', { name: '继续整理' }).click();
    await expect(page.getByRole('img', { name: '用于框题的原始页预览' })).toBeVisible();
  } finally { await f.close(); }
});

test('更正校验失败不离开，保存后离开不降级，切管理页面先保护编辑内容', async ({ page, request }) => {
  const f = await fixture(request);
  try {
    await page.clock.install();
    await login(page, `${f.url}/admin/materials`);
    await page.getByLabel('家长密码', { exact: true }).fill('family password 123');
    await page.getByRole('button', { name: '验证并进入管理' }).click();
    await page.getByRole('button', { name: '收集一道错题' }).click();
    await expect(page.getByLabel('选择题目图片')).toBeEnabled();
    await page.getByLabel('选择题目图片').setInputFiles({ name: '管理切换.png', mimeType: 'image/png', buffer: f.image });
    await page.getByRole('button', { name: '选择整页' }).click();
    await page.getByRole('button', { name: '下一步，选学科' }).click();
    await page.getByRole('combobox', { name: '学科', exact: true }).selectOption('math');
    await page.getByRole('button', { name: '保存到错题集' }).click();
    const before = await (await request.get(`${f.url}/api/v1/collection/questions?state=collected`, { headers: f.headers })).json();
    await page.getByRole('button', { name: '补充或更正信息' }).click();
    await page.getByRole('combobox', { name: '学科', exact: true }).selectOption('');
    await page.getByRole('button', { name: '管理概览', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '还有未保存的修改' });
    await dialog.getByRole('button', { name: '保存后离开' }).click();
    await expect(dialog.getByRole('alert')).toContainText('当前填写内容仍保留');
    await expect(page).toHaveURL(`${f.url}/admin/materials`);
    await dialog.getByRole('button', { name: '继续编辑' }).click();
    await page.getByRole('combobox', { name: '学科', exact: true }).selectOption('science');
    await page.getByLabel('备注（选填）').fill('离开之前保留');
    await page.clock.fastForward(5 * 60 * 1000 + 10);
    await expect(page.getByRole('heading', { name: '验证家长身份' })).toBeVisible();
    await page.getByRole('button', { name: '返回错题集', exact: true }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: '保存后离开' })).toBeDisabled();
    await dialog.getByRole('button', { name: '继续编辑' }).click();
    await page.clock.setFixedTime(new Date());
    await page.getByLabel('家长密码', { exact: true }).fill('family password 123');
    await page.getByRole('button', { name: '验证并进入管理' }).click();
    await expect(page.getByLabel('备注（选填）')).toHaveValue('离开之前保留');
    await page.getByRole('button', { name: '结束管理', exact: true }).click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: '保存后离开' }).click();
    await expect(page).toHaveURL(`${f.url}/learn`);
    await expect(page.getByRole('button', { name: '打开错题' })).toHaveCount(1);
    const after = await (await request.get(`${f.url}/api/v1/collection/questions?state=collected`, { headers: f.headers })).json();
    expect(after.total).toBe(1);
    expect(after.items[0]).toMatchObject({ id: before.items[0].id, collectedAt: before.items[0].collectedAt, state: 'collected', subjectId: 'science', note: '离开之前保留' });
    expect((await (await request.get(`${f.url}/api/v1/collection/questions?state=draft`, { headers: f.headers })).json()).total).toBe(0);
  } finally { await f.close(); }
});

test('资料库变化后旧会话不能提交材料，重新登录另一家庭不混入旧批次', async ({ page, request }) => {
  const f = await fixture(request);
  const replacementDir = await mkdtemp(join(tmpdir(), 'klbook-other-family-'));
  let replacement: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    await login(page, f.url);
    await page.getByRole('button', { name: '收集', exact: true }).click();
    await page.route('**/api/v1/collection/drafts', route => route.abort());
    await expect(page.getByLabel('选择题目图片')).toBeEnabled();
    await page.getByLabel('选择题目图片').setInputFiles({ name: '旧家庭的材料.png', mimeType: 'image/png', buffer: f.image });
    await expect(page.getByRole('region', { name: '本机待上传图片' }).getByRole('button', { name: '继续上传 旧家庭的材料.png' })).toBeEnabled();
    await page.unroute('**/api/v1/collection/drafts');
    await f.stop();
    const port = Number(new URL(f.url).port);
    replacement = await startServer(replacementDir, port);
    const setupCode = (await readFile(join(replacementDir, 'setup-code.txt'), 'utf8')).trim();
    const other = await (await request.post(`${f.url}/api/v1/setup`, { data: { setupCode, username: 'parent', password: 'family password 123', learnerName: '另一个家庭', deviceName: '另一台电脑' } })).json();
    await page.getByRole('button', { name: '继续上传 旧家庭的材料.png' }).click();
    await expect(page.getByRole('heading', { name: '登录家庭资料库' })).toBeVisible();
    await page.getByLabel('家长账号').fill('parent');
    await page.getByLabel('家长密码', { exact: true }).fill('family password 123');
    await page.getByRole('button', { name: '登录此设备' }).click();
    await expect(page.getByRole('heading', { name: '还没有草稿' })).toBeVisible();
    await expect(page.getByRole('region', { name: '本机待上传图片' })).toHaveCount(0);
    expect((await (await request.get(`${f.url}/api/v1/collection/questions?state=draft`, { headers: { Authorization: `Bearer ${other.token}` } })).json()).total).toBe(0);
    await replacement.stop();
    replacement = await startServer(f.dir, port);
    await login(page, f.url);
    await page.getByRole('button', { name: '收集', exact: true }).click();
    await expect(page.getByRole('button', { name: '继续上传 旧家庭的材料.png' })).toBeVisible();
  } finally { await replacement?.stop(); await f.close(); await rm(replacementDir, { recursive: true, force: true }); }
});
