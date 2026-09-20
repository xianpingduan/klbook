import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import sharp from 'sharp';
import { auth, familyFixture, password } from './fixture.ts';

test('家长独立维护来源，日常会话只读，重复名称和旧修订不能覆盖，重试不重复创建', async () => {
  const f = await familyFixture();
  try {
    const list = () => f.app.inject({ url: '/api/v1/collection/sources', headers: auth(f.first.token) });
    const initial = await list();
    assert.equal(initial.statusCode, 200, initial.body);
    assert.deepEqual(initial.json().map((source: { name: string }) => source.name).sort(), ['课堂作业', '练习册', '试卷', '其他'].sort());
    const id = randomUUID();
    const path = `/api/v1/admin/sources/${id}`;
    const input = { operationId: randomUUID(), expectedRevision: 0, name: ' 每周小测 ', active: true };
    assert.equal((await f.app.inject({ method: 'PUT', url: path, headers: auth(f.first.token), payload: input })).statusCode, 403);
    const grant = (await f.app.inject({ method: 'POST', url: '/api/v1/admin/grants', headers: auth(f.first.token), payload: { password } })).json().token;
    const save = (body: typeof input) => f.app.inject({ method: 'PUT', url: path, headers: auth(f.first.token, grant), payload: body });
    const created = await save(input);
    assert.equal(created.statusCode, 200, created.body);
    assert.equal(created.json().name, '每周小测');
    assert.equal(created.json().revision, 1);
    assert.equal((await save(input)).json().revision, 1);
    const duplicate = await f.app.inject({ method: 'PUT', url: `/api/v1/admin/sources/${randomUUID()}`, headers: auth(f.first.token, grant), payload: { ...input, operationId: randomUUID() } });
    assert.equal(duplicate.statusCode, 409);
    assert.equal((await save({ ...input, operationId: randomUUID(), expectedRevision: 1, name: '   ' })).statusCode, 422);
    const rename = { operationId: randomUUID(), expectedRevision: 1, name: '每周数学小测', active: true };
    assert.equal((await save(rename)).json().revision, 2);
    assert.equal((await save({ ...rename, operationId: randomUUID(), name: '旧页面改名' })).statusCode, 409);
    const disabled = { operationId: randomUUID(), expectedRevision: 2, name: rename.name, active: false };
    assert.equal((await save(disabled)).json().active, false);
    assert.equal((await list()).json().some((source: { id: string }) => source.id === id), false);
    const managed = await f.app.inject({ url: '/api/v1/admin/sources', headers: auth(f.first.token, grant) });
    assert.equal(managed.json().find((source: { id: string }) => source.id === id).active, false);
    assert.equal((await save(input)).json().revision, 3);
    assert.equal((await save({ operationId: randomUUID(), expectedRevision: 3, name: rename.name, active: true })).json().revision, 4);
    const second = (await f.login('平板')).json();
    assert.equal((await f.app.inject({ method: 'PUT', url: path, headers: auth(second.token, grant), payload: input })).statusCode, 403);
    f.advance(5 * 60000);
    assert.equal((await save(input)).statusCode, 403);
  } finally { await f.close(); }
});

test('来源改名更新显示，停用保留旧题且拒绝新关联，清空与重试不改变原始材料', async () => {
  const f = await familyFixture();
  try {
    const sources = (await f.app.inject({ url: '/api/v1/collection/sources', headers: auth(f.first.token) })).json();
    const workbook = sources.find((source: { name: string }) => source.name === '练习册');
    const image = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#ffffff' } }).png().toBuffer();
    const upload = () => f.app.inject({ method: 'POST', url: '/api/v1/collection/drafts', headers: { ...auth(f.first.token), 'content-type': 'image/png', 'idempotency-key': randomUUID() }, payload: image });
    const draft = (await upload()).json();
    const path = `/api/v1/collection/questions/${draft.id}`;
    const input = { operationId: randomUUID(), expectedRevision: 1, state: 'collected', subjectId: 'math', region: { x: 0, y: 0, width: 1, height: 1 }, sourceId: workbook.id, pageNumber: '', questionNumber: '', note: '' };
    const save = (payload: object, url = path) => f.app.inject({ method: 'PUT', url, headers: auth(f.first.token), payload });
    const collected = await save(input);
    assert.equal(collected.statusCode, 200, collected.body);
    assert.equal(collected.json().source, '练习册');
    const grant = (await f.app.inject({ method: 'POST', url: '/api/v1/admin/grants', headers: auth(f.first.token), payload: { password } })).json().token;
    const manage = (expectedRevision: number, active: boolean) => f.app.inject({ method: 'PUT', url: `/api/v1/admin/sources/${workbook.id}`, headers: auth(f.first.token, grant), payload: { operationId: randomUUID(), expectedRevision, name: '四年级练习册', active } });
    assert.equal((await manage(1, true)).statusCode, 200);
    const renamed = (await f.app.inject({ url: path, headers: auth(f.first.token) })).json();
    assert.equal(renamed.source, '四年级练习册');
    assert.equal(renamed.sourceId, workbook.id);
    assert.equal(renamed.revision, 2);
    assert.equal(renamed.collectedAt, collected.json().collectedAt);
    assert.equal((await manage(2, false)).statusCode, 200);
    const second = (await upload()).json();
    assert.equal((await save({ ...input, operationId: randomUUID() }, `/api/v1/collection/questions/${second.id}`)).statusCode, 422);
    const kept = await save({ ...input, operationId: randomUUID(), expectedRevision: 2, note: '仅补充备注' });
    assert.equal(kept.statusCode, 200, kept.body);
    assert.equal(kept.json().sourceId, workbook.id);
    const retry = await save(input);
    assert.equal(retry.statusCode, 200, retry.body);
    assert.equal(retry.json().revision, 3);
    const cleared = await save({ ...input, operationId: randomUUID(), expectedRevision: 3, sourceId: null });
    assert.equal(cleared.statusCode, 200, cleared.body);
    assert.equal(cleared.json().sourceId, null);
    assert.equal(cleared.json().source, '');
    const original = await f.app.inject({ url: `/api/v1/collection/pages/${draft.originalPage.id}/original`, headers: auth(f.first.token) });
    assert.deepEqual(original.rawPayload, image);
    const { sourceId: _old, ...legacy } = input;
    assert.equal((await save({ ...legacy, operationId: randomUUID(), expectedRevision: 4, source: '孩子私自新增' })).statusCode, 409);
  } finally { await f.close(); }
});
