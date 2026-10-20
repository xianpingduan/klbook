import { test, expect } from '@playwright/test';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from './server.ts';

test('家长设置电脑备份目录、生成和刷新状态，明确区分完整备份与学习资料包', async ({ page, request }) => {
  const root = await mkdtemp(join(tmpdir(), 'klbook-backup-ui-')), data = join(root, 'data'), backups = join(root, 'backups');
  await mkdir(backups);
  const server = await startServer(data), password = 'family password 123';
  try {
    const setupCode = (await readFile(join(data, 'setup-code.txt'), 'utf8')).trim();
    await request.post(`${server.url}/api/v1/setup`, { data: { setupCode, username: 'parent', password, learnerName: '小明', deviceName: '电脑' } });
    await page.goto(`${server.url}/admin/backups`);
    await page.getByLabel('家长账号').fill('parent'); await page.getByLabel('家长密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录此设备' }).click();
    await page.getByLabel('家长密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '验证并进入管理' }).click();
    await expect(page.getByRole('heading', { name: '资料库备份', exact: true })).toBeVisible();
    await expect(page.getByText(/其他设备尚未上传/)).toBeVisible();
    await page.getByLabel('家庭电脑上的备份目录').fill(backups);
    await page.getByRole('button', { name: '保存备份目录' }).click();
    await expect(page.getByText('备份目录已保存', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '立即备份' }).click();
    await expect(page.getByText('备份已生成并通过完整性校验', { exact: true })).toBeVisible();
    await page.reload();
    await page.getByLabel('家长密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '验证并进入管理' }).click();
    await expect(page.getByText('备份已生成并通过完整性校验', { exact: true })).toBeVisible();
    for (const width of [390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
    await page.goto(`${server.url}/learn`);
    await expect(page.getByRole('button', { name: '资料库备份', exact: true })).toHaveCount(0);
  } finally { await server.stop(); await rm(root, { recursive: true, force: true }); }
});
