import { reveal } from './interactions.ts';
import { test, expect } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { startServer } from './server.ts';

async function fixture(request: APIRequestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'klbook-autosave-'));
  const server = await startServer(dir);
  const setupCode = (await readFile(join(dir, 'setup-code.txt'), 'utf8')).trim();
  const result = await (await request.post(`${server.url}/api/v1/setup`, { data: { setupCode, username: 'parent', password: 'family password 123', learnerName: '小明', deviceName: '电脑' } })).json();
  const image = await sharp(await readFile(new URL('../fixtures/paper.svg', import.meta.url))).png().toBuffer();
  return { ...server, dir, image, headers: { Authorization: `Bearer ${result.token}` }, async close() { await server.stop();
    await rm(dir, { recursive: true, force: true }); } };
}
async function login(page: Page, url: string) {
  await page.goto(`${url}/learn/collect`);
  await page.getByLabel('家长账号').fill('parent');
  await page.getByLabel('家长密码', { exact: true }).fill('family password 123');
  await page.getByRole('button', { name: '登录此设备', exact: true }).click();
  await expect(page.getByLabel('选择题目图片')).toBeEnabled();
}
async function optional(page: Page) {
  const disclosure = page.locator('details').filter({ has: page.locator('summary', { hasText: '补充信息' }) }).first();
  if (await disclosure.count() && !(await disclosure.getAttribute('open') !== null)) await disclosure.locator('summary').first().click();
}
async function startQuestion(page: Page, f: Awaited<ReturnType<typeof fixture>>) {
  await login(page, f.url);
  await page.getByLabel('选择题目图片').setInputFiles({ name: '测试.png', mimeType: 'image/png', buffer: f.image });
  await reveal(page.getByRole('button', { name: '选择整页', exact: true, includeHidden: true }));
  await page.getByRole('button', { name: '选择整页', exact: true }).click();
  await page.getByRole('button', { name: '下一步，选学科' }).click();
  await page.getByRole('combobox', { name: '学科', exact: true }).selectOption('math');
  await optional(page);
}

test('保存回执丢失后重开，重放旧请求再同步新填写，不复用旧请求的内容', async ({ page, request }) => {
  const f = await fixture(request);
  try {
    await startQuestion(page, f);
    await expect(page.getByText('草稿已同步到家庭电脑', { exact: true })).toBeVisible();
    let lost = false;
    await page.route('**/api/v1/collection/questions/*', async route => {
      if (route.request().method() !== 'PUT') { await route.continue(); return; }
      if (lost) { await route.abort(); return; }
      lost = true;
    await route.fetch();
    await route.abort();
    });
    await reveal(page.getByLabel('备注（选填）'));
    await page.getByLabel('备注（选填）').fill('回执丢失前');
    await expect(page.getByText('已在本机保留，等待同步', { exact: true })).toBeVisible();
    await reveal(page.getByLabel('备注（选填）'));
    await page.getByLabel('备注（选填）').fill('回执丢失后继续填写');
    await page.unroute('**/api/v1/collection/questions/*');
    await page.reload();
    await page.getByRole('button', { name: '继续整理', exact: true }).click();
    await optional(page);
    await reveal(page.getByLabel('备注（选填）'));
    await expect(page.getByLabel('备注（选填）')).toHaveValue('回执丢失后继续填写');
    await page.getByRole('button', { name: '保存到错题集', exact: true }).click();
    await expect(page.getByRole('heading', { name: '错题详情' })).toBeVisible();
    const list = await (await request.get(`${f.url}/api/v1/collection/questions?state=collected`, { headers: f.headers })).json();
    expect(list.total).toBe(1); expect(list.items[0].note).toBe('回执丢失后继续填写');
  } finally { await f.close(); }
});

test('本机存储失败不声称已保存，并阻止无提示离开；恢复存储后可继续', async ({ page, request }) => {
  const f = await fixture(request);
  try {
    await startQuestion(page, f);
    await expect(page.getByText('草稿已同步到家庭电脑', { exact: true })).toBeVisible();
    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        if (key.startsWith('klbook.edits:') && key.includes(':question:')) throw new DOMException('Storage full', 'QuotaExceededError');
        original.call(this, key, value);
      };
      Object.assign(window, { restoreStorage: () => { Storage.prototype.setItem = original; } });
    });
    await reveal(page.getByLabel('备注（选填）'));
    await page.getByLabel('备注（选填）').fill('需要保留的材料');
    await expect(page.getByRole('alert')).toContainText('本机整理进度未能保存');
    await expect(page.getByText('草稿已同步到家庭电脑', { exact: true })).not.toBeVisible();
    await page.getByRole('button', { name: '返回列表', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: '继续编辑', exact: true }).click();
    await page.evaluate(() => (window as unknown as { restoreStorage(): void }).restoreStorage());
    await page.getByRole('button', { name: '重试本机保存', exact: true }).click();
    await page.getByRole('button', { name: '返回列表', exact: true }).click();
    await page.getByRole('button', { name: '继续整理', exact: true }).click();
    await optional(page);
    await reveal(page.getByLabel('备注（选填）'));
    await expect(page.getByLabel('备注（选填）')).toHaveValue('需要保留的材料');
  } finally { await f.close(); }
});

test('早先保存的回执不能把后来填写的内容标为已同步', async ({ page, request }) => {
  const f = await fixture(request);
  let releaseFirst = () => {}, releaseSecond = () => {};
  const first = new Promise<void>(resolve => { releaseFirst = resolve; });
  const second = new Promise<void>(resolve => { releaseSecond = resolve; });
  let waitingFirst = false, waitingSecond = false;
  try {
    await startQuestion(page, f);
    await expect(page.getByText('草稿已同步到家庭电脑', { exact: true })).toBeVisible();
    await page.route('**/api/v1/collection/questions/*', async route => {
      if (route.request().method() !== 'PUT') { await route.continue(); return; }
      const response = await route.fetch();
      if (route.request().postDataJSON().note === '较早内容') { waitingFirst = true; await first; }
      if (route.request().postDataJSON().note === '后写内容') { waitingSecond = true; await second; }
      await route.fulfill({ response });
    });
    await page.getByLabel('备注（选填）').fill('较早内容');
    await expect.poll(() => waitingFirst).toBe(true);
    await page.getByLabel('备注（选填）').fill('后写内容');
    releaseFirst();
    await expect.poll(() => waitingSecond).toBe(true);
    await expect(page.getByText('草稿已同步到家庭电脑', { exact: true })).not.toBeVisible();
    await expect(page.getByLabel('备注（选填）')).toHaveValue('后写内容');
    releaseSecond();
    await expect(page.getByText('草稿已同步到家庭电脑', { exact: true })).toBeVisible();
  } finally { releaseFirst(); releaseSecond(); await f.close(); }
});

test('A 布局默认折叠选填项，每步一个主操作，手机平板电脑滚动后均可保存', async ({ page, request }, info) => {
  const f = await fixture(request);
  try {
    await startQuestion(page, f);
    await page.locator('details.optional-info').first().locator('summary').click();
    await expect(page.getByLabel('备注（选填）')).not.toBeVisible();
    await expect(page.getByRole('button', { name: '补充纸质答案', includeHidden: true })).not.toBeVisible();
    await expect(page.getByRole('button', { name: '保存草稿', includeHidden: true })).toHaveCount(0);
    for (const width of [390, 820, 1440]) {
      await page.setViewportSize({ width, height: 844 });
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({ path: info.outputPath(`confirm-${width}.png`) });
      await optional(page);
      await page.getByLabel('备注（选填）').fill('选填内容展开后主操作仍可达');
      await page.getByLabel('备注（选填）').scrollIntoViewIfNeeded();
      const button = page.getByRole('button', { name: '保存到错题集', exact: true });
      const bounds = (await button.boundingBox())!;
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(844);
      expect(bounds.height).toBeGreaterThanOrEqual(48);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.locator('details.optional-info').first().locator('summary').click();
    }
    await page.getByRole('button', { name: '保存到错题集', exact: true }).click();
    await expect(page.getByRole('button', { name: '编辑资料', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '补充纸质答案', includeHidden: true })).toHaveCount(0);
    await page.getByRole('button', { name: '完成，回到首页', exact: true }).click();
    await expect(page.getByRole('button', { name: '打开错题', exact: true })).toHaveCount(1);
  } finally { await f.close(); }
});

test('已收集题目未提交的更正只在本机保留，保存修改后才更新家庭资料库', async ({ page, request }) => {
  const f = await fixture(request);
  try {
    await startQuestion(page, f);
    await reveal(page.getByLabel('备注（选填）'));
    await page.getByLabel('备注（选填）').fill('原来内容');
    await page.getByRole('button', { name: '保存到错题集', exact: true }).click();
    await page.getByRole('button', { name: /补充或更正信息|编辑资料/ }).click();
    await optional(page);
    await reveal(page.getByLabel('备注（选填）'));
    await page.getByLabel('备注（选填）').fill('更正内容');
    await page.reload();
    let list = await (await request.get(`${f.url}/api/v1/collection/questions?state=collected`, { headers: f.headers })).json();
    expect(list.items[0].note).toBe('原来内容');
    await page.getByRole('button', { name: '首页', exact: true }).click();
    await page.getByRole('button', { name: '打开错题', exact: true }).click();
    await page.getByRole('button', { name: /补充或更正信息|编辑资料/ }).click();
    await optional(page);
    await reveal(page.getByLabel('备注（选填）'));
    await expect(page.getByLabel('备注（选填）')).toHaveValue('更正内容');
    await page.getByRole('button', { name: '保存修改', exact: true }).click();
    await expect(page.getByRole('heading', { name: '错题详情' })).toBeVisible();
    list = await (await request.get(`${f.url}/api/v1/collection/questions?state=collected`, { headers: f.headers })).json();
    expect(list.total).toBe(1); expect(list.items[0].note).toBe('更正内容');
  } finally { await f.close(); }
});
test('填写后立即刷新或返回自动保留进度，只有显式保存才完成收集', async ({ page, request }) => {
  const f = await fixture(request);
  try {
    await login(page, f.url);
    await page.getByLabel('选择题目图片').setInputFiles({ name: '自动草稿.png', mimeType: 'image/png', buffer: f.image });
    await reveal(page.getByRole('button', { name: '选择整页', exact: true, includeHidden: true }));
    await page.getByRole('button', { name: '选择整页', exact: true }).click();
    await page.getByRole('button', { name: '下一步，选学科' }).click();
    await page.getByRole('combobox', { name: '学科', exact: true }).selectOption('math');
    await optional(page);
    await reveal(page.getByLabel('备注（选填）'));
    await page.getByLabel('备注（选填）').fill('刚写完就刷新，也要留住');
    await page.reload();
    await page.getByRole('button', { name: '继续整理', exact: true }).first().click();
    await expect(page.getByRole('heading', { name: '确认并保存' })).toBeVisible();
    await optional(page);
    await reveal(page.getByLabel('备注（选填）'));
    await expect(page.getByLabel('备注（选填）')).toHaveValue('刚写完就刷新，也要留住');
    await expect(page.getByRole('combobox', { name: '学科', exact: true })).toHaveValue('math');
    await reveal(page.getByLabel('备注（选填）'));
    await page.getByLabel('备注（选填）').fill('返回也保留');
    await page.getByRole('button', { name: '返回列表', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect((await (await request.get(`${f.url}/api/v1/collection/questions?state=collected`, { headers: f.headers })).json()).total).toBe(0);
    await page.getByRole('button', { name: '继续整理', exact: true }).first().click();
    await optional(page);
    await reveal(page.getByLabel('备注（选填）'));
    await expect(page.getByLabel('备注（选填）')).toHaveValue('返回也保留');
    await page.getByRole('button', { name: '保存到错题集', exact: true }).click();
    await expect(page.getByRole('heading', { name: '错题详情' })).toBeVisible();
    const list = await (await request.get(`${f.url}/api/v1/collection/questions?state=collected`, { headers: f.headers })).json();
    expect(list.total).toBe(1); expect(list.items[0].note).toBe('返回也保留');
  } finally { await f.close(); }
});

test('准备后的页面停服仍能重开并编辑，恢复后只收集一次', async ({ page, request }) => {
  const f = await fixture(request);
  let restarted: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    await login(page, f.url);
    await page.getByLabel('选择题目图片').setInputFiles({ name: '离线编辑.png', mimeType: 'image/png', buffer: f.image });
    await reveal(page.getByRole('button', { name: '选择整页', exact: true, includeHidden: true }));
    await page.getByRole('button', { name: '选择整页', exact: true }).click();
    await page.getByRole('button', { name: '下一步，选学科' }).click();
    await page.getByRole('combobox', { name: '学科', exact: true }).selectOption('math');
    await optional(page);
    await reveal(page.getByLabel('备注（选填）'));
    await page.getByLabel('备注（选填）').fill('离线前的记录');
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker?.controller)).toBe(true);
    await expect(page.getByText('草稿已同步到家庭电脑', { exact: true })).toBeVisible();
    await f.stop();
    await page.reload();
    await page.getByRole('button', { name: '继续整理', exact: true }).first().click();
    await optional(page);
    await reveal(page.getByLabel('备注（选填）'));
    await expect(page.getByLabel('备注（选填）')).toHaveValue('离线前的记录');
    await reveal(page.getByLabel('备注（选填）'));
    await page.getByLabel('备注（选填）').fill('停服时继续整理的记录');
    await page.reload();
    await page.getByRole('button', { name: '继续整理', exact: true }).first().click();
    await optional(page);
    await reveal(page.getByLabel('备注（选填）'));
    await expect(page.getByLabel('备注（选填）')).toHaveValue('停服时继续整理的记录');
    restarted = await startServer(f.dir, Number(new URL(f.url).port));
    await page.getByRole('button', { name: '保存到错题集', exact: true }).click();
    await expect(page.getByRole('heading', { name: '错题详情' })).toBeVisible();
    await page.reload();
    await page.getByRole('button', { name: '首页', exact: true }).click();
    await expect(page.getByRole('button', { name: '打开错题' })).toHaveCount(1);
    const list = await (await request.get(`${f.url}/api/v1/collection/questions?state=collected`, { headers: f.headers })).json();
    expect(list.total).toBe(1); expect(list.items[0].note).toBe('停服时继续整理的记录');
  } finally { await restarted?.stop();
    await f.close(); }
});

test('停服时新选图片仍可框题并确认收集，重开恢复后自动补传且不重复', async ({ page, request }) => {
  const f = await fixture(request);
  let restarted: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    await login(page, f.url);
    await expect(page.getByRole('heading', { name: '还没有草稿' })).toBeVisible();
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker?.controller)).toBe(true);
    await f.stop();
    await page.reload();
    await page.getByLabel('选择题目图片').setInputFiles({ name: '全程离线.png', mimeType: 'image/png', buffer: f.image });
    await reveal(page.getByRole('button', { name: '选择整页', exact: true, includeHidden: true }));
    await page.getByRole('button', { name: '选择整页', exact: true }).click();
    await page.getByRole('button', { name: '下一步，选学科' }).click();
    await page.getByRole('combobox', { name: '学科', exact: true }).selectOption('science');
    await optional(page);
    await reveal(page.getByLabel('备注（选填）'));
    await page.getByLabel('备注（选填）').fill('离线完成后自动补传');
    await page.getByRole('button', { name: '保存到错题集', exact: true }).click();
    await expect(page.getByRole('heading', { name: '错题详情' })).toBeVisible();
    await expect(page.getByText('本机已收集，待同步', { exact: true })).toBeVisible();
    await page.reload();
    restarted = await startServer(f.dir, Number(new URL(f.url).port));
    await page.reload();
    await page.getByRole('button', { name: '首页', exact: true }).click();
    await expect(page.getByRole('button', { name: '打开错题' })).toHaveCount(1);
    const list = await (await request.get(`${f.url}/api/v1/collection/questions?state=collected`, { headers: f.headers })).json();
    expect(list.total).toBe(1);
    expect(list.items[0]).toMatchObject({ subjectId: 'science', note: '离线完成后自动补传' });
    expect((await request.get(`${f.url}/api/v1/collection/pages/${list.items[0].originalPage.id}/original`, { headers: f.headers })).status()).toBe(200);
    await page.reload();
    expect((await (await request.get(`${f.url}/api/v1/collection/questions?state=collected`, { headers: f.headers })).json()).total).toBe(1);
  } finally { await restarted?.stop();
    await f.close(); }
});
