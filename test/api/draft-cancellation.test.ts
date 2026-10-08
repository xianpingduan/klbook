import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import sharp from 'sharp';
import { auth, familyFixture } from './fixture.ts';

test('取消草稿可跨设备撤销，重试幂等，旧保存不能复活，原图及已收集题受保护', async () => {
  const f = await familyFixture();
  try {
    const headers = auth(f.first.token), other = auth((await f.login('手机')).json().token);
    const bytes = await sharp({ create: { width: 200, height: 300, channels: 3, background: 'white' } }).png().toBuffer();
    const draft = (await f.app.inject({ method: 'POST', url: '/api/v1/collection/drafts', headers: { ...headers, 'content-type': 'image/png', 'idempotency-key': randomUUID() }, payload: bytes })).json();
    const url = `/api/v1/collection/questions/${draft.id}/cancellation`;
    const payload = { operationId: randomUUID(), expectedRevision: 1, cancelled: true };
    const cancel = await f.app.inject({ method: 'PUT', url, headers, payload });
    assert.equal(cancel.statusCode, 200, cancel.body);
    assert.equal(cancel.json().revision, 2);
    assert.equal((await f.app.inject({ method: 'PUT', url, headers, payload })).json().revision, 2);
    assert.equal((await f.app.inject({ url: '/api/v1/collection/questions?state=draft', headers: other })).json().total, 0);
    assert.equal((await f.app.inject({ url: `/api/v1/collection/questions/${draft.id}`, headers })).statusCode, 409);
    const edit = { operationId: randomUUID(), expectedRevision: 1, state: 'collected', subjectId: 'math', sourceId: null, region: { x: 0, y: 0, width: 1, height: 1 }, pageNumber: '', questionNumber: '', note: '' };
    assert.equal((await f.app.inject({ method: 'PUT', url: `/api/v1/collection/questions/${draft.id}`, headers, payload: edit })).statusCode, 409);
    const cancelled = (await f.app.inject({ url: '/api/v1/collection/cancelled-drafts', headers: other })).json();
    assert.equal(cancelled[0].id, draft.id);
    assert.deepEqual((await f.app.inject({ url: `/api/v1/collection/pages/${draft.originalPage.id}/original`, headers })).rawPayload, bytes);
    assert.equal((await f.app.inject({ method: 'PUT', url, payload })).statusCode, 401);
    const restore = { operationId: randomUUID(), expectedRevision: 2, cancelled: false };
    assert.equal((await f.app.inject({ method: 'PUT', url, headers: other, payload: restore })).json().revision, 3);
    assert.equal((await f.app.inject({ method: 'PUT', url, headers: other, payload: restore })).json().revision, 3);
    // An old cancel retry reports its receipt, never cancels the restored draft again.
    await f.app.inject({ method: 'PUT', url, headers, payload });
    assert.equal((await f.app.inject({ url: '/api/v1/collection/questions?state=draft', headers })).json().total, 1);
    assert.equal((await f.app.inject({ method: 'PUT', url, headers, payload: { ...payload, operationId: randomUUID() } })).statusCode, 409);
    assert.equal((await f.app.inject({ method: 'PUT', url: `/api/v1/collection/questions/${draft.id}`, headers, payload: { ...edit, expectedRevision: 3 } })).statusCode, 200);
    assert.equal((await f.app.inject({ method: 'PUT', url, headers, payload: { ...payload, operationId: randomUUID(), expectedRevision: 4 } })).statusCode, 409);
  } finally { await f.close(); }
});
