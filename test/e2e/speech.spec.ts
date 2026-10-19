import { expect, test } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from '../../src/server/app.ts';
import { speechVendor, testWav } from '../api/speech-fixture.ts';

test('后台语音配置、试听与移除音频、丢失响应重试、刷新结果和到期清空凭据', async ({ page, request }) => {
  const dir = await mkdtemp(join(tmpdir(), 'klbook-speech-browser-'));
  const vendor = speechVendor();
  let offset = 0;
  const port = 49152 + Math.floor(Math.random() * 15000), url = `http://127.0.0.1:${port}`;
  const app = createApp({ dataDir: dir, staticDir: resolve('dist/client'), allowedOrigins: [url], now: () => Date.now() + offset, speechSocket: vendor.connect });
  await app.listen({ host: '127.0.0.1', port });
  try {
    await page.clock.install();
    const setupCode = (await readFile(join(dir, 'setup-code.txt'), 'utf8')).trim();
    await request.post(`${url}/api/v1/setup`, { data: { setupCode, username: 'parent', password: 'family password 123', learnerName: '小明', deviceName: '电脑' } });
    await page.goto(`${url}/admin/services/speech`);
    await page.getByLabel('家长账号').fill('parent'); await page.getByLabel('家长密码', { exact: true }).fill('family password 123');
    await page.getByRole('button', { name: '登录此设备', exact: true }).click();
    const unlock = async () => { await page.getByLabel('家长密码', { exact: true }).fill('family password 123'); await page.getByRole('button', { name: '验证并进入管理', exact: true }).click(); };
    await unlock();
    await expect(page.getByRole('heading', { name: '语音转写服务', exact: true })).toBeVisible();
    await page.getByLabel('APPID', { exact: true }).fill('browser-app');
    await page.getByLabel('APIKey', { exact: true }).fill('K'.repeat(32));
    await page.getByLabel('APISecret', { exact: true }).fill('S'.repeat(32));
    await page.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: '配置已保存' })).toBeVisible();
    expect(vendor.sockets).toHaveLength(0);
    await expect(page.getByLabel('APISecret', { exact: true })).toHaveValue('');
    const input = page.getByLabel('测试音频', { exact: true }), submit = page.getByRole('button', { name: '发送所选音频并测试', exact: true });
    await expect(input).toBeEnabled();
    const bytes = testWav();
    await input.setInputFiles({ name: '测试.wav', mimeType: 'audio/wav', buffer: bytes });
    await expect(page.getByLabel('试听所选测试音频')).toBeVisible();
    await expect(submit).toBeDisabled();
    await page.getByRole('button', { name: '移除测试音频', exact: true }).click();
    await expect(page.getByLabel('试听所选测试音频')).toHaveCount(0);
    await page.getByLabel('启用语音转写服务', { exact: true }).check();
    await page.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: '配置已保存' })).toBeVisible();
    await expect(input).toBeEnabled();
    await input.setInputFiles({ name: '测试.wav', mimeType: 'audio/wav', buffer: bytes });
    // Explicit payload forwarding avoids WebKit route.fetch dropping a Blob request body.
    await page.route('**/api/v1/admin/speech/tests/*', async route => {
      const response = await route.fetch({ postData: bytes }); expect(response.status()).toBe(202); await route.abort();
    }, { times: 1 });
    await submit.click();
    await expect(page.getByRole('alert')).toContainText('无法连接');
    await page.getByRole('button', { name: '重试提交同一次测试', exact: true }).click();
    await expect(page.getByText('我先读题，再列式。', { exact: true })).toBeVisible();
    expect(vendor.sockets).toHaveLength(1);
    await page.reload(); await unlock();
    await expect(page.getByText('我先读题，再列式。', { exact: true })).toBeVisible();
    await expect(page.getByLabel('APISecret', { exact: true })).toHaveValue('');
    // A second explicit test exercises native binary upload with no interception.
    await expect(input).toBeEnabled(); await input.setInputFiles({ name: '再次.wav', mimeType: 'audio/wav', buffer: bytes });
    await submit.click();
    await expect(page.getByRole('table', { name: '语音转写调用记录' }).getByRole('row')).toHaveCount(3);
    await expect(page.getByText('我先读题，再列式。', { exact: true })).toHaveCount(2);
    expect(vendor.sockets).toHaveLength(2);
    expect(Buffer.concat(vendor.sockets[1]!.frames.map(frame => Buffer.from(frame.data.audio ?? '', 'base64')))).toEqual(bytes.subarray(44));
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
      await page.screenshot({ path: test.info().outputPath(`speech-${width}.png`), fullPage: true });
    }
    await page.getByLabel('服务名称', { exact: true }).fill('未保存的语音名称');
    await page.getByRole('button', { name: '图片识别服务', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: '继续编辑', exact: true }).click();
    await page.getByLabel('APPID', { exact: true }).fill('unsaved-app');
    await page.getByLabel('APIKey', { exact: true }).fill('unsaved-key');
    await page.getByLabel('APISecret', { exact: true }).fill('unsaved-secret');
    offset = 5 * 60000 + 1000; await page.clock.fastForward(offset);
    await expect(page.getByRole('heading', { name: '验证家长身份', exact: true })).toBeVisible();
    await unlock();
    for (const label of ['APPID', 'APIKey', 'APISecret']) await expect(page.getByLabel(label, { exact: true })).toHaveValue('');
    await expect(page.getByLabel('服务名称', { exact: true })).toHaveValue('未保存的语音名称');
    expect(vendor.sockets).toHaveLength(2);
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});
