import { expect, test } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { startServer } from './server.ts';

for (const lostReceipt of [false, true]) test(`原地换图${lostReceipt ? '丢失回执并重开' : '失败'}保留材料，取消可撤销，继续收集仅保存新图片`, async ({ page, request }) => {
  const dir = await mkdtemp(join(tmpdir(), 'klbook-simple-'));
  const server = await startServer(dir);
  try {
    const setupCode = (await readFile(join(dir, 'setup-code.txt'), 'utf8')).trim();
    const session = await (await request.post(`${server.url}/api/v1/setup`, { data: { setupCode, username: 'parent', password: 'family password 123', learnerName: '小明', deviceName: '电脑' } })).json();
    const headers = { Authorization: `Bearer ${session.token}` };
    await page.goto(`${server.url}/learn/collect`);
    await page.getByLabel('家长账号').fill('parent'); await page.getByLabel('家长密码', { exact: true }).fill('family password 123');
    await page.getByRole('button', { name: '登录此设备', exact: true }).click();
    const first = await sharp({ create: { width: 400, height: 500, channels: 3, background: 'red' } }).png().toBuffer();
    const second = await sharp({ create: { width: 500, height: 600, channels: 3, background: 'green' } }).png().toBuffer();
    await expect(page.getByLabel('选择题目图片')).toBeEnabled();
    await page.getByLabel('选择题目图片').setInputFiles({ name: '选错.png', mimeType: 'image/png', buffer: first });
    await page.getByRole('button', { name: '选择整页', exact: true }).click();
    const before = (await (await request.get(`${server.url}/api/v1/collection/questions?state=draft`, { headers })).json()).items[0];
    await page.route('**/api/v1/collection/pages', async route => { if (lostReceipt) await route.fetch(); await route.abort(); }, { times: 1 });
    await page.getByLabel('换图', { exact: true }).setInputFiles({ name: '正确.png', mimeType: 'image/png', buffer: second });
    await expect(page.getByRole('alert')).toContainText('仍保留');
    await expect(page.getByRole('button', { name: '下一步，选学科' })).toBeEnabled();
    if (lostReceipt) {
      await page.reload(); await page.getByRole('button', { name: '继续整理', exact: true }).click();
    }
    await page.getByRole('button', { name: '重试换图', exact: true }).click();
    await expect(page.getByRole('button', { name: '下一步，选学科' })).toBeDisabled();
    await page.getByRole('button', { name: '选择整页', exact: true }).click();
    await page.getByRole('button', { name: '下一步，选学科' }).click();
    await page.getByLabel('备注（选填）').fill('保留我的填写');
    if (lostReceipt) await page.route('**/api/v1/collection/questions/*/cancellation', async route => { await route.fetch(); await route.abort(); }, { times: 1 });
    await page.getByRole('button', { name: '取消本次', exact: true }).click();
    if (lostReceipt) { await expect(page.getByRole('alert')).toContainText('仍保留'); await page.getByRole('button', { name: '取消本次', exact: true }).click(); }
    await expect(page.getByText('已取消本次收集，材料仍保留。', { exact: true })).toBeVisible();
    expect((await (await request.get(`${server.url}/api/v1/collection/questions?state=draft`, { headers })).json()).total).toBe(0);
    await page.reload();
    await page.getByText('已取消的收集', { exact: true }).click();
    await page.getByRole('button', { name: '撤销取消', exact: true }).click();
    await expect(page.getByLabel('备注（选填）')).toHaveValue('保留我的填写');
    await page.getByRole('combobox', { name: '学科', exact: true }).selectOption('math');
    await page.getByRole('button', { name: '保存到错题集', exact: true }).click();
    await expect(page.getByRole('heading', { name: '错题详情', exact: true })).toBeVisible();
    const after = await (await request.get(`${server.url}/api/v1/collection/questions?state=collected`, { headers })).json();
    expect(after.total).toBe(1); expect(after.items[0].id).toBe(before.id); expect(after.items[0].parts).toHaveLength(1);
    expect(after.items[0].originalPage.id).not.toBe(before.originalPage.id);
    expect(await (await request.get(`${server.url}/api/v1/collection/pages/${after.items[0].originalPage.id}/original`, { headers })).body()).toEqual(second);
    expect(await (await request.get(`${server.url}/api/v1/collection/pages/${before.originalPage.id}/original`, { headers })).body()).toEqual(first);
  } finally { await server.stop(); await rm(dir, { recursive: true, force: true }); }
});
