import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';
import { auth, familyFixture } from './fixture.ts';
import { createApp } from '../../src/server/app.ts';

const top = { x: .05, y: .05, width: .9, height: .35 };
const bottom = { x: .05, y: .5, width: .9, height: .4 };
const fields = { state: 'collected', subjectId: 'math', region: top, sourceId: null, pageNumber: '12', questionNumber: '1', note: '第一道' };
const paper = async () => sharp(await readFile(new URL('../fixtures/paper.svg', import.meta.url))).png().toBuffer();

test('同页独立收集第二道题，重复确认不复制题目或原图，修改不影响第一道', async () => {
  const f = await familyFixture();
  try {
    const bytes = await paper();
    const draft = (await f.app.inject({ method: 'POST', url: '/api/v1/collection/drafts', headers: { ...auth(f.first.token), 'content-type': 'image/png', 'idempotency-key': randomUUID() }, payload: bytes })).json();
    const saved = await f.app.inject({ method: 'PUT', url: `/api/v1/collection/questions/${draft.id}`, headers: auth(f.first.token), payload: { ...fields, operationId: randomUUID(), expectedRevision: 1 } });
    assert.equal(saved.statusCode, 200, saved.body);
    const input = { method: 'POST' as const, url: `/api/v1/collection/pages/${draft.originalPage.id}/questions`, headers: auth(f.first.token), payload: { ...fields, operationId: randomUUID(), region: bottom, subjectId: 'science', questionNumber: '2', note: '第二道' } };
    const second = await f.app.inject(input);
    assert.equal(second.statusCode, 201, second.body);
    assert.notEqual(second.json().id, draft.id);
    assert.equal(second.json().originalPage.id, draft.originalPage.id);
    assert.deepEqual(second.json().region, bottom);
    assert.equal((await f.app.inject(input)).json().id, second.json().id);
    assert.equal((await f.app.inject({ ...input, payload: { ...input.payload, note: '重试不可换内容' } })).statusCode, 409);
    const other = (await f.login('平板')).json();
    const edit = await f.app.inject({ method: 'PUT', url: `/api/v1/collection/questions/${second.json().id}`, headers: auth(other.token), payload: { ...fields, region: { ...bottom, width: .8 }, operationId: randomUUID(), expectedRevision: 1, note: '只改第二道' } });
    assert.equal(edit.statusCode, 200, edit.body);
    assert.deepEqual((await f.app.inject({ url: `/api/v1/collection/questions/${draft.id}`, headers: auth(other.token) })).json(), saved.json());
    assert.equal((await f.app.inject({ url: '/api/v1/collection/questions?state=collected', headers: auth(other.token) })).json().total, 2);
    assert.deepEqual((await f.app.inject({ url: `/api/v1/collection/pages/${draft.originalPage.id}/original`, headers: auth(other.token) })).rawPayload, bytes);
    assert.equal((await f.app.inject({ ...input, headers: {} })).statusCode, 401);
    assert.equal((await f.app.inject({ ...input, url: `/api/v1/collection/pages/${randomUUID()}/questions` })).statusCode, 404);
  } finally { await f.close(); }
});

test('追加图片遵守授权与稳定重试，缺失附件时不发布半道跨页题', async () => {
  const f = await familyFixture();
  try {
    const bytes = await paper();
    const grant = (await f.app.inject({ method: 'POST', url: '/api/v1/admin/grants', headers: auth(f.first.token), payload: { password: 'family password 123' } })).json();
    const headers = { ...auth(f.first.token, grant.token), 'content-type': 'image/png', 'idempotency-key': randomUUID() };
    const upload = { method: 'POST' as const, url: '/api/v1/collection/pages', headers, payload: bytes };
    assert.equal((await f.app.inject({ ...upload, headers: { 'content-type': 'image/png', 'idempotency-key': randomUUID() } })).statusCode, 401);
    const [one, repeated] = await Promise.all([f.app.inject(upload), f.app.inject(upload)]);
    assert.equal(one.statusCode, 201, one.body); assert.equal(one.json().id, repeated.json().id);
    assert.equal((await f.app.inject({ ...upload, payload: await sharp(bytes).webp().toBuffer() })).statusCode, 409);
    const draft = (await f.app.inject({ ...upload, url: '/api/v1/collection/drafts', headers: { ...headers, 'idempotency-key': randomUUID() } })).json();
    const path = join(f.dataDir, 'attachments', 'pages', one.json().id, 'original');
    await rm(path);
    const input = { method: 'PUT' as const, url: `/api/v1/collection/questions/${draft.id}`, headers: auth(f.first.token), payload: { ...fields, operationId: randomUUID(), expectedRevision: 1, parts: [{ id: draft.parts[0].id, pageId: draft.originalPage.id, region: top }, { id: randomUUID(), pageId: one.json().id, region: bottom }] } };
    assert.equal((await f.app.inject(input)).statusCode, 503);
    assert.equal((await f.app.inject({ url: input.url, headers: auth(f.first.token) })).json().revision, 1);
    await writeFile(path, bytes, { flag: 'wx' });
    const saved = await f.app.inject(input); assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(saved.json().parts.length, 2);
    f.advance(300001);
    assert.equal((await f.app.inject(upload)).statusCode, 403);
    assert.equal((await f.app.inject({ method: 'POST', url: `/api/v1/collection/pages/${draft.originalPage.id}/questions`, headers: auth(f.first.token, grant.token), payload: { ...fields, operationId: randomUUID() } })).statusCode, 403);
    assert.equal((await f.app.inject({ ...upload, headers: { ...headers, ...auth(f.first.token), 'x-parent-authorization': '' } })).statusCode, 403);
    assert.deepEqual((await f.app.inject({ url: input.url, headers: auth(f.first.token) })).json(), saved.json());
  } finally { await f.close(); }
});

test('跨页题目区按明确顺序保存，移除误选不删原图，第二会话和重启后完整读取', async () => {
  const f = await familyFixture();
  try {
    const bytes = await paper();
    const headers = { ...auth(f.first.token), 'content-type': 'image/png' };
    const draft = (await f.app.inject({ method: 'POST', url: '/api/v1/collection/drafts', headers: { ...headers, 'idempotency-key': randomUUID() }, payload: bytes })).json();
    assert.equal(draft.parts.length, 1);
    const pageUpload = { method: 'POST' as const, url: '/api/v1/collection/pages', headers: { ...headers, 'idempotency-key': randomUUID() }, payload: await sharp(bytes).flop().png().toBuffer() };
    const result = await f.app.inject(pageUpload);
    assert.equal(result.statusCode, 201, result.body);
    const secondPage = result.json();
    assert.equal((await f.app.inject(pageUpload)).json().id, secondPage.id);
    assert.equal((await f.app.inject({ url: '/api/v1/collection/questions?state=draft', headers: auth(f.first.token) })).json().total, 1);
    const parts = [
      { id: draft.parts[0].id, pageId: draft.originalPage.id, region: top },
      { id: randomUUID(), pageId: secondPage.id, region: bottom },
      { id: randomUUID(), pageId: draft.originalPage.id, region: bottom }
    ];
    const url = `/api/v1/collection/questions/${draft.id}`;
    const save = (payload: object) => f.app.inject({ method: 'PUT', url, headers: auth(f.first.token), payload });
    const edit = { ...fields, operationId: randomUUID(), expectedRevision: 1, parts };
    const collected = await save(edit);
    assert.equal(collected.statusCode, 200, collected.body);
    assert.deepEqual(collected.json().parts.map((part: { id: string }) => part.id), parts.map(part => part.id));
    const reordered = [parts[1]!, parts[0]!];
    const changed = await save({ ...edit, operationId: randomUUID(), expectedRevision: 2, region: bottom, parts: reordered });
    assert.equal(changed.statusCode, 200, changed.body);
    assert.equal(changed.json().originalPage.id, secondPage.id);
    assert.equal(changed.json().collectedAt, collected.json().collectedAt);
    assert.deepEqual(changed.json().parts.map((part: { originalPage: { id: string } }) => part.originalPage.id), [secondPage.id, draft.originalPage.id]);
    assert.equal((await save({ ...edit, operationId: randomUUID() })).statusCode, 409);
    assert.equal((await save({ ...edit, operationId: randomUUID(), expectedRevision: 3, parts: [] })).statusCode, 400);
    assert.equal((await save({ ...edit, operationId: randomUUID(), expectedRevision: 3, parts: [parts[0], parts[0]] })).statusCode, 422);
    assert.equal((await save({ ...edit, operationId: randomUUID(), expectedRevision: 3, parts: [{ ...parts[0], pageId: randomUUID() }] })).statusCode, 404);
    assert.equal((await save({ ...edit, operationId: randomUUID(), expectedRevision: 3, parts: [{ ...parts[0], region: { ...top, width: 1 } }] })).statusCode, 422);
    // Older clients can still edit the first region without dropping later pages.
    const legacyEdit = { ...fields, operationId: randomUUID(), expectedRevision: 3, region: bottom, note: '旧客户端补充' };
    const legacy = await save(legacyEdit);
    assert.equal(legacy.statusCode, 200, legacy.body);
    assert.equal(legacy.json().parts.length, 2);
    const other = (await f.login('第二设备')).json();
    await f.app.close();
    const restarted = createApp({ dataDir: f.dataDir });
    try {
      assert.deepEqual((await restarted.inject({ url, headers: auth(other.token) })).json(), legacy.json());
      for (const [pageId, expected] of [[draft.originalPage.id, bytes], [secondPage.id, pageUpload.payload]] as const) {
        assert.deepEqual((await restarted.inject({ url: `/api/v1/collection/pages/${pageId}/original`, headers: auth(other.token) })).rawPayload, expected);
      }
    } finally { await restarted.close(); }
  } finally { await f.close(); }
});
