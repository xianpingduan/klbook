import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/server/app.ts';

test('学习与管理地址可直达，缺失 API、附件和静态资源不回退成页面', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'klbook-routes-'));
  const staticDir = join(dir, 'web');
  await mkdir(staticDir);
  await writeFile(join(staticDir, 'index.html'), '<!doctype html><title>错题集</title>');
  const app = createApp({ dataDir: join(dir, 'data'), staticDir });
  try {
    for (const url of ['/', '/learn', '/learn/collect', '/learn/mine', '/admin', '/admin/materials', '/admin/sources', '/admin/devices', '/admin?returnTo=https://example.com']) {
      const response = await app.inject({ url });
      assert.equal(response.statusCode, 200, url);
      assert.match(String(response.headers['content-type']), /text\/html/);
    }
    for (const url of ['/api/v1/missing', '/assets/missing.js', '/admin/missing.js', '/learn/unknown', '/api/v1/collection/pages/missing/original']) {
      const response = await app.inject({ url });
      assert.ok(response.statusCode >= 400, url);
      assert.doesNotMatch(String(response.headers['content-type']), /text\/html/, url);
    }
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});
