import { expect, test } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from '../../src/server/app.ts';
import { aiVendor } from '../api/ai-fixture.ts';

test('家长查看统一用量与分类限额，预算丢失回执可重试，离开和权限到期保留修改', async ({ page, request }) => {
  const dir = await mkdtemp(join(tmpdir(), 'klbook-usage-browser-')), vendor = aiVendor();
  let offset = 0;
  const port = 49152 + Math.floor(Math.random() * 15000), url = `http://127.0.0.1:${port}`;
  const app = createApp({ dataDir: dir, staticDir: resolve('dist/client'), allowedOrigins: [url], now: () => Date.now() + offset, aiHttp: vendor.http });
  await app.listen({ host: '127.0.0.1', port });
  try {
    await page.clock.install();
    const setupCode = (await readFile(join(dir, 'setup-code.txt'), 'utf8')).trim();
    const setup = await request.post(`${url}/api/v1/setup`, { data: { setupCode, username: 'parent', password: 'family password 123', learnerName: '小明', deviceName: '电脑' } });
    const token = (await setup.json()).token;
    const parent = await request.post(`${url}/api/v1/admin/grants`, { headers: { authorization: `Bearer ${token}` }, data: { password: 'family password 123' } });
    const headers = { authorization: `Bearer ${token}`, 'x-parent-authorization': (await parent.json()).token };
    const ai = await (await request.get(`${url}/api/v1/admin/ai`, { headers })).json();
    ai.config.enabled = true; ai.config.modelPrices.lite = { inputCentsPerMillion: 200, outputCentsPerMillion: 600, confirmed: true };
    await request.put(`${url}/api/v1/admin/ai`, { headers, data: { operationId: crypto.randomUUID(), expectedRevision: 0, config: ai.config, credentials: { apiPassword: 'browser-ai-private' } } });
    await request.put(`${url}/api/v1/admin/ai/tests/${crypto.randomUUID()}`, { headers, data: { expectedRevision: 1, prompt: '示例提示' } });
    await page.goto(`${url}/admin`);
    await page.getByLabel('家长账号').fill('parent'); await page.getByLabel('家长密码', { exact: true }).fill('family password 123');
    await page.getByRole('button', { name: '登录此设备', exact: true }).click();
    const unlock = async () => { await page.getByLabel('家长密码', { exact: true }).fill('family password 123'); await page.getByRole('button', { name: '验证并进入管理', exact: true }).click(); };
    await unlock(); await page.getByRole('button', { name: '服务用量与预算', exact: true }).click();
    await expect(page.getByRole('heading', { name: '服务用量与预算', exact: true })).toBeVisible();
    const budget = page.getByLabel('每月服务总预算（元）', { exact: true });
    await expect(budget).toHaveValue('50');
    await expect(page.getByTestId('usage-total-cost')).toContainText('0.000170');
    await expect(page.getByRole('table', { name: '调用明细' })).toContainText('47');
    await page.getByRole('combobox', { name: '调用类别', exact: true }).selectOption('ocr');
    await expect(page.getByText('这个月没有符合条件的调用记录。')).toBeVisible();
    await expect(page.getByTestId('usage-total-cost')).toContainText('0.000170');
    await page.getByRole('combobox', { name: '调用类别', exact: true }).selectOption('');
    await budget.fill('20');
    await page.route('**/api/v1/admin/service-usage', async route => { if (route.request().method() !== 'PUT') return route.continue(); const response = await route.fetch(); expect(response.status()).toBe(200); await route.abort(); }, { times: 1 });
    await page.getByRole('button', { name: '保存预算', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('无法连接');
    await budget.fill('25'); await page.getByRole('button', { name: '保存预算', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: '预算已保存' })).toBeVisible();
    expect(vendor.calls).toHaveLength(1);
    await page.reload(); await unlock(); await expect(budget).toHaveValue('25');
    await budget.fill('28');
    const current = await (await request.get(`${url}/api/v1/admin/service-usage`, { headers })).json();
    expect((await request.put(`${url}/api/v1/admin/service-usage`, { headers, data: { operationId: crypto.randomUUID(), expectedRevision: current.revision, config: { ...current.config, monthlyBudgetCents: 2700 } } })).status()).toBe(200);
    await page.getByRole('button', { name: '保存预算', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('其他页面'); await expect(budget).toHaveValue('28');
    await page.getByRole('button', { name: '重新读取预算与用量', exact: true }).click();
    await page.getByRole('button', { name: '放弃本次修改并离开', exact: true }).click();
    await expect(budget).toHaveValue('27');
    await budget.fill('30'); await page.getByRole('button', { name: '图片识别服务', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible(); await page.getByRole('button', { name: '继续编辑', exact: true }).click();
    offset = 5 * 60000 + 1000; await page.clock.fastForward(offset);
    await expect(page.getByRole('heading', { name: '验证家长身份', exact: true })).toBeVisible();
    await unlock(); await expect(budget).toHaveValue('30');
    await page.getByRole('button', { name: '保存预算', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: '预算已保存' })).toBeVisible();
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
      await page.screenshot({ path: test.info().outputPath(`usage-${width}.png`), fullPage: true });
    }
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});
