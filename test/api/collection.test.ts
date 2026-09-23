import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';
import { auth, familyFixture } from './fixture.ts';
import { createApp } from '../../src/server/app.ts';

async function paperImage() {
  return sharp(await readFile(new URL('../fixtures/paper.svg', import.meta.url))).png().toBuffer();
}

test('后台提交携带的管理授权失效时被拒绝，日常学习仍可收集和修改', async () => {
  const f = await familyFixture();
  try {
    const grant = (await f.app.inject({ method: 'POST', url: '/api/v1/admin/grants', headers: auth(f.first.token), payload: { password: 'family password 123' } })).json();
    const upload = { method: 'POST' as const, url: '/api/v1/collection/drafts', headers: { ...auth(f.first.token, grant.token), 'content-type': 'image/png', 'idempotency-key': randomUUID() }, payload: await paperImage() };
    const draft = (await f.app.inject(upload)).json();
    assert.ok(draft.id);
    f.advance(5 * 60 * 1000 + 1);
    assert.equal((await f.app.inject(upload)).statusCode, 403);
    const edit = { method: 'PUT' as const, url: `/api/v1/collection/questions/${draft.id}`, headers: auth(f.first.token, grant.token), payload: { operationId: randomUUID(), expectedRevision: 1, state: 'collected', subjectId: 'math', region: { x: 0, y: 0, width: 1, height: 1 }, sourceId: null, pageNumber: '', questionNumber: '', note: '同一道题' } };
    assert.equal((await f.app.inject(edit)).statusCode, 403);
    assert.equal((await f.app.inject({ url: '/api/v1/collection/questions?state=draft', headers: auth(f.first.token, grant.token) })).statusCode, 403);
    assert.equal((await f.app.inject({ ...edit, headers: auth(f.first.token) })).statusCode, 200);
    assert.equal((await f.app.inject({ ...upload, headers: { ...upload.headers, 'x-parent-authorization': '' } })).statusCode, 403);
    const learnerUpload = { ...upload.headers }; delete learnerUpload['x-parent-authorization'];
    assert.equal((await f.app.inject({ ...upload, headers: learnerUpload })).statusCode, 201);
    assert.equal((await f.app.inject({ url: '/api/v1/admin/sources', headers: auth(f.first.token) })).statusCode, 403);
  } finally { await f.close(); }
});

test('真实图片经鉴权上传为可重开的草稿，原始页字节不变且未登录不能读取', async () => {
  const f = await familyFixture();
  try {
    const bytes = await paperImage();
    const operationId = randomUUID();
    const input = { method: 'POST' as const, url: '/api/v1/collection/drafts', headers: { 'content-type': 'image/png', 'idempotency-key': operationId }, payload: bytes };
    assert.equal((await f.app.inject(input)).statusCode, 401);
    const uploaded = await f.app.inject({ ...input, headers: { ...input.headers, ...auth(f.first.token) } });
    assert.equal(uploaded.statusCode, 201, uploaded.body);
    const draft = uploaded.json();
    assert.equal(draft.state, 'draft');
    assert.equal(draft.syncState, 'synced');
    assert.equal(draft.revision, 1);
    assert.equal(draft.region, null);
    assert.equal(draft.subjectId, null);
    assert.equal(draft.collectedAt, null);
    assert.equal(draft.originalPage.width, 640);
    assert.equal(draft.originalPage.height, 800);
    const path = `/api/v1/collection/pages/${draft.originalPage.id}/original`;
    assert.equal((await f.app.inject(path)).statusCode, 401);
    const original = await f.app.inject({ url: path, headers: auth(f.first.token) });
    assert.equal(original.statusCode, 200);
    assert.equal(original.headers['content-type'], 'image/png');
    assert.deepEqual(original.rawPayload, bytes);
    const list = await f.app.inject({ url: '/api/v1/collection/questions?state=draft', headers: auth(f.first.token) });
    assert.equal(list.statusCode, 200, list.body);
    assert.equal(list.json().items[0].id, draft.id);
    const detail = await f.app.inject({ url: `/api/v1/collection/questions/${draft.id}`, headers: auth(f.first.token) });
    assert.equal(detail.json().id, draft.id);
    assert.equal((await f.app.inject({ url: '/api/v1/collection/questions?state=collected', headers: auth(f.first.token) })).json().total, 0);
    const retry = await f.app.inject({ ...input, headers: { ...input.headers, ...auth(f.first.token) } });
    assert.equal(retry.json().id, draft.id);
    assert.equal((await f.app.inject({ url: '/api/v1/collection/questions?state=draft', headers: auth(f.first.token) })).json().total, 1);
  } finally { await f.close(); }
});

test('图片按真实格式校验，JPEG 方向正确，原件保真，损坏及超限材料被拒绝', async () => {
  const f = await familyFixture();
  try {
    const image = await paperImage();
    const upload = (payload: Buffer, type = 'image/png') => f.app.inject({ method: 'POST', url: '/api/v1/collection/drafts', headers: { ...auth(f.first.token), 'content-type': type, 'idempotency-key': randomUUID() }, payload });
    for (const format of ['jpeg', 'webp'] as const) {
      const bytes = format === 'jpeg' ? await sharp(image).withMetadata({ orientation: 6 }).jpeg().toBuffer() : await sharp(image).webp().toBuffer();
      const result = await upload(bytes); // Do not trust a caller's MIME claim.
      assert.equal(result.statusCode, 201, result.body);
      const page = result.json().originalPage;
      assert.equal(page.mimeType, `image/${format}`);
      assert.equal(page.width, format === 'jpeg' ? 800 : 640);
      assert.equal(page.height, format === 'jpeg' ? 640 : 800);
      const original = await f.app.inject({ url: `/api/v1/collection/pages/${page.id}/original`, headers: auth(f.first.token) });
      assert.deepEqual(original.rawPayload, bytes);
      const preview = await f.app.inject({ url: `/api/v1/collection/pages/${page.id}/preview`, headers: auth(f.first.token) });
      const dimensions = await sharp(preview.rawPayload).metadata();
      assert.equal(dimensions.width, page.width);
      assert.equal(dimensions.height, page.height);
    }
    assert.equal((await upload(Buffer.from('not an image'))).statusCode, 422);
    assert.equal((await upload(await readFile(new URL('../fixtures/paper.svg', import.meta.url)))).statusCode, 422);
    assert.equal((await upload(Buffer.alloc(15 * 1024 * 1024 + 1))).statusCode, 413);
    assert.equal((await upload(image, 'application/json')).statusCode, 400);
    assert.equal((await f.app.inject({ url: '/api/v1/collection/questions?state=draft', headers: auth(f.first.token) })).json().total, 2);
  } finally { await f.close(); }
});

test('同时重试只创建一个草稿，操作标识不能挪用到不同内容', async () => {
  const f = await familyFixture();
  try {
    const image = await paperImage();
    const input = { method: 'POST' as const, url: '/api/v1/collection/drafts', headers: { ...auth(f.first.token), 'content-type': 'image/png', 'idempotency-key': randomUUID() }, payload: image };
    const [first, second] = await Promise.all([f.app.inject(input), f.app.inject(input)]);
    assert.equal(first.statusCode, 201, first.body);
    assert.equal(second.statusCode, 201, second.body);
    assert.equal(first.json().id, second.json().id);
    assert.equal((await f.app.inject({ ...input, payload: await sharp(image).webp().toBuffer() })).statusCode, 409);
    assert.equal((await f.app.inject({ url: '/api/v1/collection/questions?state=draft', headers: auth(f.first.token) })).json().total, 1);
  } finally { await f.close(); }
});

test('草稿写入的响应丢失后，即使另一会话完成收集，原操作仍可重放到最新版本', async () => {
  const f = await familyFixture();
  try {
    const uploaded = await f.app.inject({ method: 'POST', url: '/api/v1/collection/drafts', headers: { ...auth(f.first.token), 'content-type': 'image/png', 'idempotency-key': randomUUID() }, payload: await paperImage() });
    const path = `/api/v1/collection/questions/${uploaded.json().id}`;
    const draftEdit = { operationId: randomUUID(), expectedRevision: 1, state: 'draft', subjectId: 'math', region: { x: 0, y: 0, width: 1, height: 1 }, source: '', pageNumber: '', questionNumber: '', note: '稍后整理' };
    assert.equal((await f.app.inject({ method: 'PUT', url: path, headers: auth(f.first.token), payload: draftEdit })).statusCode, 200);
    const second = (await f.login('另一设备')).json();
    const collected = await f.app.inject({ method: 'PUT', url: path, headers: auth(second.token), payload: { ...draftEdit, operationId: randomUUID(), expectedRevision: 2, state: 'collected' } });
    assert.equal(collected.statusCode, 200, collected.body);
    const replay = await f.app.inject({ method: 'PUT', url: path, headers: auth(f.first.token), payload: draftEdit });
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(replay.json().state, 'collected');
    assert.equal(replay.json().revision, 3);
  } finally { await f.close(); }
});

test('真实附件写入故障与材料缺失不发布半道题，恢复目录后可用同一操作重试', async () => {
  const f = await familyFixture();
  try {
    const bytes = await paperImage();
    const storagePath = join(f.dataDir, 'attachments', 'pages');
    await writeFile(storagePath, 'simulate an unavailable directory');
    const input = { method: 'POST' as const, url: '/api/v1/collection/drafts', headers: { ...auth(f.first.token), 'content-type': 'image/png', 'idempotency-key': randomUUID() }, payload: bytes };
    assert.equal((await f.app.inject(input)).statusCode, 503);
    assert.equal((await f.app.inject({ url: '/api/v1/collection/questions?state=draft', headers: auth(f.first.token) })).json().total, 0);
    await rm(storagePath);
    const retried = await f.app.inject(input);
    assert.equal(retried.statusCode, 201, retried.body);
    const draft = retried.json();
    const originalPath = join(storagePath, draft.originalPage.id, 'original');
    const originalBytes = await readFile(originalPath);
    await rm(originalPath);
    try {
      assert.equal((await f.app.inject(input)).statusCode, 503);
      const save = await f.app.inject({ method: 'PUT', url: `/api/v1/collection/questions/${draft.id}`, headers: auth(f.first.token), payload: {
        operationId: randomUUID(), expectedRevision: 1, state: 'collected', subjectId: 'math', region: { x: 0, y: 0, width: 1, height: 1 }, source: '', pageNumber: '', questionNumber: '', note: ''
      } });
      assert.equal(save.statusCode, 503);
      assert.equal((await f.app.inject({ url: '/api/v1/collection/questions?state=collected', headers: auth(f.first.token) })).json().total, 0);
      assert.equal((await f.app.inject({ url: `/api/v1/collection/questions/${draft.id}`, headers: auth(f.first.token) })).json().revision, 1);
    } finally { await writeFile(originalPath, originalBytes, { flag: 'wx' }); }
    const restored = await f.app.inject(input);
    assert.equal(restored.statusCode, 201);
    assert.equal(restored.json().id, draft.id);
    assert.equal((await f.app.inject({ url: '/api/v1/collection/questions?state=draft', headers: auth(f.first.token) })).json().total, 1);
  } finally { await f.close(); }
});

test('框题并选学科即可收集，选填信息可补充更正，修订拒绝覆盖且另一设备和重启后能找回', async () => {
  const f = await familyFixture();
  try {
    const uploaded = await f.app.inject({ method: 'POST', url: '/api/v1/collection/drafts', headers: { ...auth(f.first.token), 'content-type': 'image/png', 'idempotency-key': randomUUID() }, payload: await paperImage() });
    const draft = uploaded.json();
    const subjects = await f.app.inject({ url: '/api/v1/collection/subjects', headers: auth(f.first.token) });
    assert.deepEqual(subjects.json().map((s: { name: string }) => s.name), ['语文', '数学', '英语', '科学']);
    const math = subjects.json().find((s: { name: string }) => s.name === '数学').id;
    const path = `/api/v1/collection/questions/${draft.id}`;
    const edit = { operationId: randomUUID(), expectedRevision: 1, state: 'collected', subjectId: math, region: { x: 0.04, y: 0.11, width: 0.85, height: 0.17 }, source: '', pageNumber: '', questionNumber: '', note: '' };
    assert.equal((await f.app.inject({ method: 'PUT', url: path, headers: auth(f.first.token), payload: { ...edit, region: null } })).statusCode, 422);
    f.advance(1000);
    const collected = await f.app.inject({ method: 'PUT', url: path, headers: auth(f.first.token), payload: edit });
    assert.equal(collected.statusCode, 200, collected.body);
    assert.equal(collected.json().state, 'collected');
    assert.equal(collected.json().revision, 2);
    assert.equal(collected.json().syncState, 'synced');
    assert.ok(collected.json().collectedAt > draft.createdAt);
    assert.equal(collected.json().note, '');
    const filled = { ...edit, operationId: randomUUID(), expectedRevision: 2, source: '练习册', pageNumber: '3', questionNumber: '1', note: '还没弄懂，先记下来' };
    const saved = await f.app.inject({ method: 'PUT', url: path, headers: auth(f.first.token), payload: filled });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(saved.json().revision, 3);
    assert.equal(saved.json().collectedAt, collected.json().collectedAt);
    assert.equal((await f.app.inject({ method: 'PUT', url: path, headers: auth(f.first.token), payload: filled })).json().revision, 3);
    assert.equal((await f.app.inject({ method: 'PUT', url: path, headers: auth(f.first.token), payload: { ...filled, operationId: randomUUID(), expectedRevision: 1, note: '旧页面内容' } })).statusCode, 409);
    const second = (await f.login('平板')).json();
    const secondRead = await f.app.inject({ url: path, headers: auth(second.token) });
    assert.equal(secondRead.json().note, '还没弄懂，先记下来');
    await f.app.close();
    const restarted = createApp({ dataDir: f.dataDir });
    try {
      const list = await restarted.inject({ url: '/api/v1/collection/questions?state=collected', headers: auth(second.token) });
      assert.equal(list.json().items[0].id, draft.id);
      assert.equal(list.json().items[0].source, '练习册');
      assert.equal((await restarted.inject({ url: `/api/v1/collection/pages/${draft.originalPage.id}/original`, headers: auth(second.token) })).statusCode, 200);
    } finally { await restarted.close(); }
  } finally { await f.close(); }
});
