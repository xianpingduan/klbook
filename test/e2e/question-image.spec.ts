import { expect, test } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { startServer } from './server.ts';

for (const fails of [false, true]) test(`详情图片在按下编辑按钮期间加载${fails ? '失败' : '完成'}，按钮不移位且一次点击进入编辑`, async ({ page, request }) => {
  const dir = await mkdtemp(join(tmpdir(), 'klbook-image-layout-'));
  const server = await startServer(dir);
  let release = () => {};
  try {
    await page.setViewportSize({ width: 1280, height: 1200 });
    const setupCode = (await readFile(join(dir, 'setup-code.txt'), 'utf8')).trim();
    const password = 'family password 123';
    const session = await (await request.post(`${server.url}/api/v1/setup`, { data: { setupCode, username: 'parent', password, learnerName: '小明', deviceName: '电脑' } })).json();
    const headers = { Authorization: `Bearer ${session.token}` };
    const image = await sharp(await readFile(new URL('../fixtures/paper.svg', import.meta.url))).png().toBuffer();
    const draft = await (await request.post(`${server.url}/api/v1/collection/drafts`, { data: image, headers: { ...headers, 'Content-Type': 'image/png', 'Idempotency-Key': randomUUID() } })).json();
    expect((await request.put(`${server.url}/api/v1/collection/questions/${draft.id}`, { headers, data: { operationId: randomUUID(), expectedRevision: draft.revision, state: 'collected', subjectId: 'math', region: { x: .05, y: .3, width: .75, height: .12 }, sourceId: null, pageNumber: '', questionNumber: '', note: '' } })).status()).toBe(200);
    await page.goto(`${server.url}/learn`);
    await page.getByLabel('家长账号').fill('parent');
    await page.getByLabel('家长密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录此设备', exact: true }).click();
    await expect(page.getByRole('img', { name: '已收集的题目区', exact: true }).locator('image')).toHaveAttribute('href', /^blob:/);
    const waiting = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/api/v1/collection/pages/*/preview', async route => { await waiting; if (fails) await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: '测试图片读取失败' }) }); else await route.continue(); }, { times: 1 });
    await page.getByRole('button', { name: '打开错题', exact: true }).click();
    await expect(page.getByRole('heading', { name: '小明的错题集', exact: true })).not.toBeVisible();
    const edit = page.getByRole('button', { name: '编辑资料', exact: true });
    await expect(edit).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 0));
    const before = (await edit.boundingBox())!;
    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
    await page.mouse.down();
    release();
    if (fails) await expect(page.getByRole('button', { name: '重试加载图片', exact: true })).toBeVisible();
    else await expect(page.getByRole('img', { name: '已收集的题目区', exact: true }).locator('image')).toHaveAttribute('href', /^blob:/);
    const after = (await edit.boundingBox())!;
    expect.soft(Math.abs(after.y - before.y)).toBeLessThan(1);
    await page.mouse.up();
    await expect(page.getByRole('button', { name: '保存修改', exact: true })).toBeVisible();
  } finally {
    release();
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
