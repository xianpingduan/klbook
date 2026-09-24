import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import sharp from 'sharp';
import { auth, familyFixture } from './fixture.ts';
import type { Question } from '../../src/shared/collection.ts';

const whole = { x: 0, y: 0, width: 1, height: 1 };
const fields = { state: 'collected', subjectId: 'math', region: whole, sourceId: null, pageNumber: '', questionNumber: '1', note: '' };

test('两个真实会话同时改题只接受一个版本，冲突可定位并核对，处理后迟到请求与重复提交不覆盖或重复', async () => {
  const f = await familyFixture();
  try {
    const a = auth(f.first.token), b = auth((await f.login('另一设备')).json().token);
    const bytes = await sharp(await readFile('test/fixtures/paper.svg')).png().toBuffer();
    const uploaded = await f.app.inject({ method: 'POST', url: '/api/v1/collection/drafts', headers: { ...a, 'content-type': 'image/png', 'idempotency-key': randomUUID() }, payload: bytes });
    const draft = uploaded.json<Question>();
    const url = `/api/v1/collection/questions/${draft.id}`;
    const save = (headers: Record<string, string>, payload: object) => f.app.inject({ method: 'PUT', url, headers, payload });
    const first = { ...fields, operationId: randomUUID(), expectedRevision: 1, note: '电脑的整理' };
    const second = { ...fields, operationId: randomUUID(), expectedRevision: 1, note: '手机的整理' };
    const replies = await Promise.all([save(a, first), save(b, second)]);
    assert.deepEqual(replies.map(r => r.statusCode).sort(), [200, 409]);
    const conflict = replies.find(r => r.statusCode === 409)!;
    assert.deepEqual(conflict.json().conflict, { entity: 'question', id: draft.id });
    const accepted = replies.find(r => r.statusCode === 200)!.json<Question>();
    const current = await f.app.inject({ url, headers: b });
    assert.deepEqual(current.json(), accepted);
    assert.equal(accepted.revision, 2);
    const merged = { ...fields, expectedRevision: 2, operationId: randomUUID(), note: '核对后保留电脑和手机两份说明' };
    const saved = await save(b, merged);
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(saved.json().revision, 3);
    assert.equal(saved.json().collectedAt, accepted.collectedAt);
    for (const reply of await Promise.all([save(a, merged), save(b, merged)])) assert.deepEqual(reply.json(), saved.json());
    const late = await save(a, { ...first, operationId: randomUUID() });
    assert.equal(late.statusCode, 409);
    assert.deepEqual(late.json().conflict, { entity: 'question', id: draft.id });
    const oldRetry = await save(a, replies[0]!.statusCode === 200 ? first : second);
    assert.deepEqual(oldRetry.json(), saved.json());
    assert.deepEqual((await f.app.inject({ url, headers: a })).json(), saved.json());
    assert.equal((await f.app.inject({ url: '/api/v1/collection/questions?state=collected', headers: b })).json().total, 1);
    assert.deepEqual((await f.app.inject({ url: `/api/v1/collection/pages/${draft.originalPage.id}/original`, headers: b })).rawPayload, bytes);
    assert.equal((await f.app.inject({ method: 'PUT', url, payload: merged })).statusCode, 401);
  } finally { await f.close(); }
});

test('题目材料关系与答案共用题目修订，阅读原文独立修订；核对后保存保留原件、顺序与关联', async () => {
  const f = await familyFixture();
  try {
    const a = auth(f.first.token), b = auth((await f.login('平板')).json().token);
    const bytes = await sharp(await readFile('test/fixtures/paper.svg')).png().toBuffer();
    const draft = (await f.app.inject({ method: 'POST', url: '/api/v1/collection/drafts', headers: { ...a, 'content-type': 'image/png', 'idempotency-key': randomUUID() }, payload: bytes })).json<Question>();
    const url = `/api/v1/collection/questions/${draft.id}`;
    const put = (path: string, payload: object, headers = a) => f.app.inject({ method: 'PUT', url: path, headers, payload });
    const materialId = randomUUID(), readingUrl = `/api/v1/collection/reading-materials/${materialId}`;
    const reading = { operationId: randomUUID(), expectedRevision: 0, title: '共同阅读的原文', parts: [{ id: randomUUID(), pageId: draft.originalPage.id, region: whole }] };
    assert.equal((await put(readingUrl, reading)).statusCode, 200);
    const material = await put(readingUrl, { ...reading, operationId: randomUUID(), expectedRevision: 1, title: '电脑改后的原文' });
    const staleReading = await put(readingUrl, { ...reading, operationId: randomUUID(), expectedRevision: 1, title: '平板的原文修改' }, b);
    assert.equal(staleReading.statusCode, 409);
    assert.deepEqual(staleReading.json().conflict, { entity: 'readingMaterial', id: materialId });
    const parts = [{ id: draft.parts[0]!.id, pageId: draft.originalPage.id, region: whole }, { id: randomUUID(), pageId: draft.originalPage.id, region: { x: .1, y: .1, width: .4, height: .4 } }];
    const linked = await put(url, { ...fields, operationId: randomUUID(), expectedRevision: 1, parts, readingMaterialId: materialId });
    assert.equal(linked.statusCode, 200);
    const answer = { operationId: randomUUID(), expectedRevision: 1, parts: [{ id: randomUUID(), pageId: draft.originalPage.id, region: whole }] };
    const staleAnswer = await put(`${url}/answers`, answer, b);
    assert.equal(staleAnswer.statusCode, 409);
    assert.deepEqual(staleAnswer.json().conflict, { entity: 'question', id: draft.id });
    const resolvedAnswer = { ...answer, operationId: randomUUID(), expectedRevision: 2 };
    const answered = await put(`${url}/answers`, resolvedAnswer, b);
    assert.equal(answered.statusCode, 200);
    assert.deepEqual(answered.json().parts, linked.json().parts);
    assert.deepEqual(answered.json().readingMaterial, { ...material.json(), referenceCount: 1 });
    assert.deepEqual((await put(`${url}/answers`, resolvedAnswer)).json(), answered.json());
    const staleParts = await put(url, { ...fields, operationId: randomUUID(), expectedRevision: 2, parts: [...parts].reverse(), region: parts[1]!.region, readingMaterialId: null });
    assert.equal(staleParts.statusCode, 409);
    const resolvedParts = { ...fields, operationId: randomUUID(), expectedRevision: 3, parts: [...parts].reverse(), region: parts[1]!.region, readingMaterialId: null };
    const final = await put(url, resolvedParts);
    assert.equal(final.statusCode, 200);
    assert.deepEqual(final.json().answerParts, answered.json().answerParts);
    assert.equal(final.json().readingMaterial, null);
    assert.deepEqual(final.json().parts.map((part: { id: string }) => part.id), [parts[1]!.id, parts[0]!.id]);
    assert.deepEqual((await put(url, resolvedParts, b)).json(), final.json());
    assert.equal((await f.app.inject({ url: readingUrl, headers: b })).json().title, '电脑改后的原文');
    assert.deepEqual((await f.app.inject({ url: `/api/v1/collection/pages/${draft.originalPage.id}/original`, headers: b })).rawPayload, bytes);
  } finally { await f.close(); }
});
