import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { auth, familyFixture } from './fixture.ts';
import { createApp } from '../../src/server/app.ts';
import type { OriginalPage } from '../../src/shared/collection.ts';

const whole = { x: 0, y: 0, width: 1, height: 1 };
const answer = { x: .1, y: .55, width: .8, height: .3 };
const fields = { state: 'collected', subjectId: 'math', region: whole, sourceId: null, pageNumber: '', questionNumber: '', note: '' };

test('缺答案可先收集，同页和另页答案可后补排序，共用答案页不覆盖且解除单题后原件保留', async () => {
  const f = await familyFixture();
  try {
    const headers = auth(f.first.token);
    const originals = [await sharp(await readFile('test/fixtures/paper.svg')).png().toBuffer(), await sharp(await readFile('test/fixtures/paper.svg')).flop().png().toBuffer()];
    const pages: OriginalPage[] = [];
    for (const bytes of originals) {
      const uploaded = await f.app.inject({ method: 'POST', url: '/api/v1/collection/pages', headers: { ...headers, 'content-type': 'image/png', 'idempotency-key': randomUUID() }, payload: bytes });
      assert.equal(uploaded.statusCode, 201); pages.push(uploaded.json());
    }
    const questions = [];
    for (const questionNumber of ['1', '2']) {
      const response = await f.app.inject({ method: 'POST', url: `/api/v1/collection/pages/${pages[0]!.id}/questions`, headers, payload: { ...fields, questionNumber, operationId: randomUUID() } });
      assert.equal(response.statusCode, 201); questions.push(response.json());
    }
    const url = `/api/v1/collection/questions/${questions[0].id}/answers`;
    const parts = [{ id: randomUUID(), pageId: pages[0]!.id, region: answer }, { id: randomUUID(), pageId: pages[1]!.id, region: whole }];
    const input = { operationId: randomUUID(), expectedRevision: 1, parts };
    const saved = await f.app.inject({ method: 'PUT', url, headers, payload: input });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.deepEqual(questions[0].answerParts, []);
    assert.equal(saved.json().collectedAt, questions[0].collectedAt);
    assert.deepEqual(saved.json().parts, questions[0].parts);
    assert.deepEqual(saved.json().answerParts.map((part: { originalPage: { id: string }; region: object }) => [part.originalPage.id, part.region]), [[pages[0]!.id, answer], [pages[1]!.id, whole]]);
    assert.deepEqual((await f.app.inject({ method: 'PUT', url, headers, payload: input })).json(), saved.json());
    const other = (await f.login('另一设备')).json();
    const otherHeaders = auth(other.token);
    const shared = await f.app.inject({ method: 'PUT', url: `/api/v1/collection/questions/${questions[1].id}/answers`, headers: otherHeaders, payload: { operationId: randomUUID(), expectedRevision: 1, parts: [{ id: randomUUID(), pageId: pages[1]!.id, region: answer }] } });
    assert.equal(shared.statusCode, 200, shared.body);
    const pageList = await f.app.inject({ url: '/api/v1/collection/answer-pages?offset=0', headers });
    assert.equal(pageList.statusCode, 200); assert.equal(pageList.json().total, 2);
    const reordered = await f.app.inject({ method: 'PUT', url, headers, payload: { ...input, operationId: randomUUID(), expectedRevision: 2, parts: [...parts].reverse() } });
    assert.equal(reordered.statusCode, 200);
    assert.deepEqual(reordered.json().answerParts.map((part: { originalPage: { id: string } }) => part.originalPage.id), [pages[1]!.id, pages[0]!.id]);
    // An older question edit must leave answer associations intact.
    const edited = await f.app.inject({ method: 'PUT', url: `/api/v1/collection/questions/${questions[0].id}`, headers, payload: { ...fields, operationId: randomUUID(), expectedRevision: 3, note: '后补备注' } });
    assert.deepEqual(edited.json().answerParts, reordered.json().answerParts);
    const unlinked = await f.app.inject({ method: 'PUT', url, headers, payload: { operationId: randomUUID(), expectedRevision: 4, parts: [] } });
    assert.equal(unlinked.statusCode, 200); assert.deepEqual(unlinked.json().answerParts, []);
    assert.deepEqual((await f.app.inject({ url: `/api/v1/collection/questions/${questions[1].id}`, headers })).json(), shared.json());
    assert.equal((await f.app.inject({ url: '/api/v1/collection/questions?state=collected', headers })).json().total, 2);
    await f.app.close();
    const restarted = createApp({ dataDir: f.dataDir });
    try {
      assert.deepEqual((await restarted.inject({ url: `/api/v1/collection/questions/${questions[1].id}`, headers: otherHeaders })).json(), shared.json());
      for (let index = 0; index < pages.length; index++) assert.deepEqual((await restarted.inject({ url: `/api/v1/collection/pages/${pages[index]!.id}/original`, headers: otherHeaders })).rawPayload, originals[index]);
    } finally { await restarted.close(); }
  } finally { await f.close(); }
});

test('答案保存拒绝无效范围和越权，修订冲突不覆盖，答案附件缺失不能通过题目保存或旧操作重试', async () => {
  const f = await familyFixture();
  try {
    const headers = auth(f.first.token);
    const bytes = await sharp(await readFile('test/fixtures/paper.svg')).png().toBuffer();
    const pages: OriginalPage[] = [];
    for (let index = 0; index < 2; index++) pages.push((await f.app.inject({ method: 'POST', url: '/api/v1/collection/pages', headers: { ...headers, 'content-type': 'image/png', 'idempotency-key': randomUUID() }, payload: bytes })).json());
    const question = (await f.app.inject({ method: 'POST', url: `/api/v1/collection/pages/${pages[0]!.id}/questions`, headers, payload: { ...fields, operationId: randomUUID() } })).json();
    const url = `/api/v1/collection/questions/${question.id}/answers`;
    const input = { operationId: randomUUID(), expectedRevision: 1, parts: [{ id: randomUUID(), pageId: pages[0]!.id, region: answer }] };
    const save = (payload: object, credentials: Record<string, string> = headers) => f.app.inject({ method: 'PUT', url, headers: credentials, payload });
    assert.equal((await save(input, {})).statusCode, 401);
    assert.equal((await f.app.inject({ url: '/api/v1/collection/answer-pages' })).statusCode, 401);
    assert.equal((await save({ ...input, parts: [{ ...input.parts[0], region: null }] })).statusCode, 422);
    assert.equal((await save({ ...input, parts: [{ ...input.parts[0], region: { x: .9, y: 0, width: .5, height: 1 } }] })).statusCode, 422);
    assert.equal((await save({ ...input, parts: [input.parts[0], input.parts[0]] })).statusCode, 422);
    assert.equal((await save({ ...input, parts: [{ ...input.parts[0], pageId: randomUUID() }] })).statusCode, 404);
    assert.deepEqual((await f.app.inject({ url: `/api/v1/collection/questions/${question.id}`, headers })).json(), question);
    const first = await save(input); assert.equal(first.statusCode, 200);
    assert.equal((await save({ ...input, parts: [] })).statusCode, 409);
    assert.equal((await save({ ...input, operationId: randomUUID(), parts: [] })).statusCode, 409);
    const updated = await save({ operationId: randomUUID(), expectedRevision: 2, parts: [{ id: randomUUID(), pageId: pages[1]!.id, region: whole }] });
    assert.equal(updated.statusCode, 200);
    assert.deepEqual((await save(input)).json(), updated.json());
    const original = join(f.dataDir, 'attachments', 'pages', pages[1]!.id, 'original');
    await rename(original, `${original}.unavailable`);
    try {
      assert.equal((await save(input)).statusCode, 503, '旧操作重试须核验最新答案页');
      assert.equal((await f.app.inject({ method: 'PUT', url: `/api/v1/collection/questions/${question.id}`, headers, payload: { ...fields, expectedRevision: 3, operationId: randomUUID(), note: '不能把缺答案附件报为完整同步' } })).statusCode, 503);
      assert.deepEqual((await f.app.inject({ url: `/api/v1/collection/questions/${question.id}`, headers })).json(), updated.json());
    } finally { await rename(`${original}.unavailable`, original); }
    const grant = (await f.app.inject({ method: 'POST', url: '/api/v1/admin/grants', headers, payload: { password: 'family password 123' } })).json();
    f.advance(300001);
    assert.equal((await save({ operationId: randomUUID(), expectedRevision: 3, parts: [] }, auth(f.first.token, grant.token))).statusCode, 403);
    assert.equal((await f.app.inject({ url: '/api/v1/collection/answer-pages', headers: auth(f.first.token, grant.token) })).statusCode, 403);
    assert.deepEqual((await f.app.inject({ url: `/api/v1/collection/questions/${question.id}`, headers })).json(), updated.json());
  } finally { await f.close(); }
});
