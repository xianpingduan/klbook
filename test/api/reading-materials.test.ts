import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { rename } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { auth, familyFixture } from './fixture.ts';
import { createApp } from '../../src/server/app.ts';
import type { OriginalPage, Question } from '../../src/shared/collection.ts';

const whole = { x: 0, y: 0, width: 1, height: 1 };
const fields = { state: 'collected', subjectId: 'chinese', region: whole, sourceId: null, pageNumber: '', questionNumber: '', note: '' };
const paper = (background: string) => sharp({ create: { width: 180, height: 240, channels: 3, background } }).png().toBuffer();

test('多道独立小题共用跨页原文，排序更正同步可见，解除单题引用不删材料且重启保留', async () => {
  const f = await familyFixture();
  try {
    const headers = auth(f.first.token);
    const originals = [await paper('#faf6ea'), await paper('#eff8fa')];
    const pages: OriginalPage[] = [];
    for (const bytes of originals) {
      const response = await f.app.inject({ method: 'POST', url: '/api/v1/collection/pages', headers: { ...headers, 'content-type': 'image/png', 'idempotency-key': randomUUID() }, payload: bytes });
      assert.equal(response.statusCode, 201); pages.push(response.json());
    }
    const materialId = randomUUID();
    const url = `/api/v1/collection/reading-materials/${materialId}`;
    const parts = pages.map(page => ({ id: randomUUID(), pageId: page.id, region: whole }));
    const input = { operationId: randomUUID(), expectedRevision: 0, title: '一篇跨页原文', parts };
    const create = await f.app.inject({ method: 'PUT', url, headers, payload: input });
    assert.equal(create.statusCode, 200, create.body);
    assert.equal(create.json().referenceCount, 0);
    assert.deepEqual((await f.app.inject({ method: 'PUT', url, headers, payload: input })).json(), create.json());
    const questions: Question[] = [];
    for (const questionNumber of ['1', '2']) {
      const response = await f.app.inject({ method: 'POST', url: `/api/v1/collection/pages/${pages[0]!.id}/questions`, headers, payload: { ...fields, questionNumber, readingMaterialId: materialId, operationId: randomUUID() } });
      assert.equal(response.statusCode, 201, response.body); questions.push(response.json());
    }
    assert.equal((await f.app.inject({ url: '/api/v1/collection/questions?state=collected', headers })).json().total, 2);
    assert.equal((await f.app.inject({ url: '/api/v1/collection/questions?state=draft', headers })).json().total, 0);
    const reordered = await f.app.inject({ method: 'PUT', url, headers, payload: { ...input, operationId: randomUUID(), expectedRevision: 1, title: '更正后的原文', parts: [...parts].reverse() } });
    assert.equal(reordered.statusCode, 200, reordered.body);
    const other = (await f.login('另一台设备')).json();
    const read = (id: string) => f.app.inject({ url: `/api/v1/collection/questions/${id}`, headers: auth(other.token) });
    for (const question of questions) {
      const latest = (await read(question.id)).json();
      assert.equal(latest.revision, question.revision);
      assert.equal(latest.collectedAt, question.collectedAt);
      assert.equal(latest.readingMaterial.id, materialId);
      assert.equal(latest.readingMaterial.referenceCount, 2);
      assert.deepEqual(latest.readingMaterial.parts.map((part: { originalPage: { id: string } }) => part.originalPage.id), [pages[1]!.id, pages[0]!.id]);
    }
    // Older clients omit the new field; their edits must preserve the shared reference.
    const legacy = await f.app.inject({ method: 'PUT', url: `/api/v1/collection/questions/${questions[0]!.id}`, headers, payload: { ...fields, expectedRevision: 1, operationId: randomUUID(), note: '旧客户端修改' } });
    assert.equal(legacy.json().readingMaterial.id, materialId);
    const unlink = await f.app.inject({ method: 'PUT', url: `/api/v1/collection/questions/${questions[0]!.id}`, headers, payload: { ...fields, expectedRevision: 2, operationId: randomUUID(), readingMaterialId: null } });
    assert.equal(unlink.statusCode, 200, unlink.body); assert.equal(unlink.json().readingMaterial, null);
    const remaining = (await read(questions[1]!.id)).json();
    assert.equal(remaining.readingMaterial.referenceCount, 1);
    assert.equal((await f.app.inject({ url: '/api/v1/collection/reading-materials?offset=0', headers })).json().total, 1);
    await f.app.close();
    const restarted = createApp({ dataDir: f.dataDir });
    try {
      assert.deepEqual((await restarted.inject({ url: `/api/v1/collection/questions/${questions[1]!.id}`, headers: auth(other.token) })).json(), remaining);
      for (let index = 0; index < pages.length; index++) assert.deepEqual((await restarted.inject({ url: `/api/v1/collection/pages/${pages[index]!.id}/original`, headers })).rawPayload, originals[index]);
    } finally { await restarted.close(); }
  } finally { await f.close(); }
});

test('共享材料遵守权限、重试与修订规则，附件缺失不能保存或新建关联', async () => {
  const f = await familyFixture();
  try {
    const headers = auth(f.first.token);
    const page = (await f.app.inject({ method: 'POST', url: '/api/v1/collection/pages', headers: { ...headers, 'content-type': 'image/png', 'idempotency-key': randomUUID() }, payload: await paper('#eeeeee') })).json();
    const input = { operationId: randomUUID(), expectedRevision: 0, title: '原文', parts: [{ id: randomUUID(), pageId: page.id, region: whole }] };
    const url = `/api/v1/collection/reading-materials/${randomUUID()}`;
    const save = (payload: object, tokenHeaders: Record<string, string> = headers) => f.app.inject({ method: 'PUT', url, headers: tokenHeaders, payload });
    assert.equal((await save(input, {})).statusCode, 401);
    assert.equal((await save({ ...input, title: ' ' })).statusCode, 422);
    assert.equal((await save({ ...input, parts: [{ ...input.parts[0], region: null }] })).statusCode, 422);
    assert.equal((await save({ ...input, parts: [...input.parts, ...input.parts] })).statusCode, 422);
    assert.equal((await save({ ...input, parts: [{ ...input.parts[0], pageId: randomUUID() }] })).statusCode, 404);
    const result = await save(input); assert.equal(result.statusCode, 200, result.body);
    const material = result.json();
    assert.equal((await save({ ...input, title: '同一操作变更' })).statusCode, 409);
    assert.equal((await save({ ...input, operationId: randomUUID() })).statusCode, 409);
    const continuation = (await f.app.inject({ method: 'POST', url: '/api/v1/collection/pages', headers: { ...headers, 'content-type': 'image/png', 'idempotency-key': randomUUID() }, payload: await paper('#dddddd') })).json();
    const edit = { ...input, operationId: randomUUID(), expectedRevision: 1, title: '已更正', parts: [...input.parts, { id: randomUUID(), pageId: continuation.id, region: whole }] };
    const updated = await save(edit); assert.equal(updated.statusCode, 200);
    assert.equal((await save({ ...edit, operationId: randomUUID(), title: '旧修订覆盖' })).statusCode, 409);
    assert.equal((await save(input)).json().revision, 2);
    const continuationOriginal = join(f.dataDir, 'attachments', 'pages', continuation.id, 'original');
    await rename(continuationOriginal, `${continuationOriginal}.unavailable`);
    try { assert.equal((await save(input)).statusCode, 503, '重放旧操作不能将包含缺失续页的最新原文报为完整保存'); }
    finally { await rename(`${continuationOriginal}.unavailable`, continuationOriginal); }
    assert.deepEqual((await save(input)).json(), updated.json());
    // Move the actual original file temporarily; verification remains through public interfaces.
    const original = join(f.dataDir, 'attachments', 'pages', page.id, 'original');
    await rename(original, `${original}.unavailable`);
    try {
      assert.equal((await save({ ...edit, operationId: randomUUID(), expectedRevision: 2 })).statusCode, 503);
      assert.equal((await f.app.inject({ method: 'POST', url: `/api/v1/collection/pages/${page.id}/questions`, headers, payload: { ...fields, readingMaterialId: material.id, operationId: randomUUID() } })).statusCode, 503);
    } finally { await rename(`${original}.unavailable`, original); }
    assert.deepEqual((await f.app.inject({ url, headers })).json(), updated.json());
    const grant = (await f.app.inject({ method: 'POST', url: '/api/v1/admin/grants', headers, payload: { password: 'family password 123' } })).json();
    f.advance(300001);
    assert.equal((await save(edit, auth(f.first.token, grant.token))).statusCode, 403);
    assert.equal((await f.app.inject({ url, headers: auth(f.first.token, grant.token) })).statusCode, 403);
    assert.equal((await f.app.inject({ url: '/api/v1/collection/reading-materials', headers: auth(f.first.token, grant.token) })).statusCode, 403);
    assert.equal((await f.app.inject({ method: 'POST', url: `/api/v1/collection/pages/${page.id}/questions`, headers, payload: { ...fields, readingMaterialId: randomUUID(), operationId: randomUUID() } })).statusCode, 404);
    assert.equal((await f.app.inject({ url: '/api/v1/collection/questions?state=collected', headers })).json().total, 0);
    assert.equal((await f.app.inject({ url: '/api/v1/collection/reading-materials', headers })).json().total, 1);
  } finally { await f.close(); }
});
