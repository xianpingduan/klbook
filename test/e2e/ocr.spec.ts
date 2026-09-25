import { expect, test } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from '../../src/server/app.ts';

test('家长配置图片识别、预览合成材料并测试，刷新保留结果且密钥不回填', async ({ page, request }) => {
  const dir = await mkdtemp(join(tmpdir(), 'klbook-ocr-browser-'));
  let calls = 0, clockOffset = 0;
  const port = 49152 + Math.floor(Math.random() * 15000), url = `http://127.0.0.1:${port}`;
  const app = createApp({ dataDir: dir, now: () => Date.now() + clockOffset, allowedOrigins: [url], staticDir: resolve('dist/client'), ocrHttp: async (target, init) => {
    calls++;
    if (target.host === 'api.xf-yun.com') {
      expect(JSON.parse(String(init.body)).header.app_id).toBe('browser-app');
      return Response.json({ header: { code: 0 }, payload: { result: { encoding: 'utf8', compress: 'raw', format: 'json', text: Buffer.from(JSON.stringify({ pages: [{ exception: 0, lines: [{ exception: 0, words: [{ content: 'I' }, { content: 'read' }, { content: 'a' }, { content: 'book.' }] }] }] })).toString('base64') } } });
    }
    return Response.json(target.pathname.includes('/token') ? { access_token: 'browser-vendor-token', expires_in: 6000 } : { words_result: [{ words: '12 × 3 = 36' }] });
  } });
  await app.listen({ host: '127.0.0.1', port });
  try {
    await page.clock.install();
    const setupCode = (await readFile(join(dir, 'setup-code.txt'), 'utf8')).trim();
    await request.post(`${url}/api/v1/setup`, { data: { setupCode, username: 'parent', password: 'family password 123', learnerName: '小明', deviceName: '电脑' } });
    await page.goto(`${url}/admin/services/ocr`);
    await page.getByLabel('家长账号').fill('parent'); await page.getByLabel('家长密码', { exact: true }).fill('family password 123');
    await page.getByRole('button', { name: '登录此设备', exact: true }).click();
    const unlock = async () => { await page.getByLabel('家长密码', { exact: true }).fill('family password 123'); await page.getByRole('button', { name: '验证并进入管理', exact: true }).click(); };
    await unlock();
    await expect(page.getByRole('heading', { name: '图片识别服务', exact: true })).toBeVisible();
    await page.getByLabel('API Key', { exact: true }).fill('browser-api-key'); await page.getByLabel('Secret Key', { exact: true }).fill('browser-secret-key');
    await page.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: '配置已保存' })).toBeVisible();
    expect(calls).toBe(0);
    await expect(page.getByLabel('Secret Key', { exact: true })).toHaveValue('');
    await expect(page.getByRole('img', { name: '将发送的合成测试材料' })).toBeVisible();
    let dropResponse = true;
    await page.route('**/api/v1/admin/ocr/tests/*', async route => {
      if (dropResponse) { dropResponse = false; await route.fetch(); await route.abort(); } else await route.continue();
    });
    await page.getByRole('button', { name: '发送样例并测试', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('无法连接');
    await page.getByRole('button', { name: '重试提交测试请求', exact: true }).click();
    await expect(page.getByText('测试成功，请核对识别文字', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('12 × 3 = 36', { exact: true })).toBeVisible(); expect(calls).toBe(2);
    await page.reload(); await unlock();
    await expect(page.getByText('12 × 3 = 36', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Secret Key', { exact: true })).toHaveValue('');
    await page.getByRole('combobox', { name: '识别供应商', exact: true }).selectOption('xfyun');
    await expect(page.getByLabel('每次估算单价（元）', { exact: true })).toHaveValue('0.035');
    await expect(page.getByLabel('识别公式（LaTeX）', { exact: true })).toHaveCount(0);
    await page.getByLabel('APPID', { exact: true }).fill('browser-app');
    await page.getByLabel('APIKey', { exact: true }).fill('apikeyXXXXXXXXXXXXXXXXXXXXXXXXXX');
    await page.getByLabel('APISecret', { exact: true }).fill('apisecretXXXXXXXXXXXXXXXXXXXXXXX');
    await page.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: '配置已保存' })).toBeVisible();
    await expect(page.getByLabel('APPID', { exact: true })).toHaveValue('');
    expect(calls).toBe(2);
    await page.getByRole('button', { name: '发送样例并测试', exact: true }).click();
    await expect(page.getByText('I read a book.', { exact: true })).toBeVisible(); expect(calls).toBe(3);
    await expect(page.getByRole('table', { name: '图片识别调用记录' }).getByText('讯飞 · 通用文字识别', { exact: true })).toBeVisible();
    await page.getByRole('combobox', { name: '识别供应商', exact: true }).selectOption('baidu');
    await expect(page.getByText('所选供应商的凭据已保存。留空保留，填写全部凭据以替换。', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: '配置已保存' })).toBeVisible();
    await page.getByRole('combobox', { name: '识别供应商', exact: true }).selectOption('xfyun');
    await page.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: '配置已保存' })).toBeVisible();
    await page.getByLabel('服务名称', { exact: true }).fill('未保存名称');
    await page.getByRole('button', { name: '来源管理', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: '继续编辑', exact: true }).click();
    await expect(page.getByLabel('服务名称', { exact: true })).toHaveValue('未保存名称');
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
      await page.screenshot({ path: `test-results/ocr-${width}.png`, fullPage: true });
    }
    await page.getByLabel('APPID', { exact: true }).fill('new-unsaved-app');
    await page.getByLabel('APIKey', { exact: true }).fill('new-unsaved-key');
    await page.getByLabel('APISecret', { exact: true }).fill('new-unsaved-secret');
    clockOffset = 5 * 60000 + 1000;
    await page.clock.fastForward(clockOffset);
    await expect(page.getByRole('heading', { name: '验证家长身份', exact: true })).toBeVisible();
    await unlock();
    await expect(page.getByLabel('APPID', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('APIKey', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('APISecret', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('服务名称', { exact: true })).toHaveValue('未保存名称');
    await page.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: '配置已保存' })).toBeVisible();
    expect(calls).toBe(3);
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});
