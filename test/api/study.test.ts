import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import sharp from 'sharp';
import { auth, familyFixture, password } from './fixture.ts';

const empty = { schoolYear: null, grade: null, term: null };
const fourth = { schoolYear: '2025-2026', grade: '小学四年级', term: 'second' };
const fifth = { schoolYear: '2026-2027', grade: '小学五年级', term: 'first' };
const fields = { state: 'collected', subjectId: 'math', region: { x: 0, y: 0, width: 1, height: 1 }, sourceId: null, pageNumber: '', questionNumber: '', note: '' };

test('家长扩展学科并设置新题默认阶段，旧题与草稿保留归属，补收更正不改变收集日期', async () => {
  const f = await familyFixture();
  try {
    const headers = auth(f.first.token);
    const grant = (await f.app.inject({ method: 'POST', url: '/api/v1/admin/grants', headers, payload: { password } })).json().token;
    const parent = auth(f.first.token, grant);
    const subjectId = randomUUID();
    const added = await f.app.inject({ method: 'PUT', url: `/api/v1/admin/subjects/${subjectId}`, headers: parent, payload: { name: ' 历史 ' } });
    assert.equal(added.statusCode, 200, added.body);
    assert.deepEqual(added.json(), { id: subjectId, name: '历史' });
    const image = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#fff' } }).png().toBuffer();
    const upload = (stage?: object, operationId = randomUUID()) => f.app.inject({ method: 'POST', url: '/api/v1/collection/drafts', headers: { ...headers, 'content-type': 'image/png', 'idempotency-key': operationId, ...(stage ? { 'x-learning-stage': JSON.stringify(stage) } : {}) }, payload: image });
    const unconfigured = (await upload()).json();
    assert.deepEqual(unconfigured.studyStage, empty);
    const settings = { operationId: randomUUID(), expectedRevision: 0, stage: fourth };
    assert.equal((await f.app.inject({ method: 'PUT', url: '/api/v1/admin/study-settings', headers: parent, payload: settings })).statusCode, 200);
    const draft = (await upload()).json();
    assert.deepEqual(draft.studyStage, fourth);
    const op = randomUUID(); const earlier = (await upload(fourth, op)).json();
    const changed = await f.app.inject({ method: 'PUT', url: '/api/v1/admin/study-settings', headers: parent, payload: { operationId: randomUUID(), expectedRevision: 1, stage: fifth } });
    assert.equal(changed.statusCode, 200, changed.body);
    assert.deepEqual((await upload()).json().studyStage, fifth);
    assert.deepEqual((await upload(fourth)).json().studyStage, fourth, '设备暂存的旧阶段不被新默认值覆盖');
    assert.deepEqual((await upload(empty)).json().studyStage, empty);
    assert.deepEqual((await upload(fifth, op)).json(), earlier, '首次已接收操作保留原归属');
    const save = (id: string, input: object) => f.app.inject({ method: 'PUT', url: `/api/v1/collection/questions/${id}`, headers, payload: input });
    const collected = await save(draft.id, { ...fields, subjectId, operationId: randomUUID(), expectedRevision: 1 });
    assert.equal(collected.statusCode, 200, collected.body); assert.deepEqual(collected.json().studyStage, fourth);
    assert.deepEqual((await save(unconfigured.id, { ...fields, operationId: randomUUID(), expectedRevision: 1 })).json().studyStage, empty);
    f.advance(60000);
    const corrected = await save(draft.id, { ...fields, subjectId, expectedRevision: 2, operationId: randomUUID(), studyStage: { ...fourth, grade: '小学三年级', term: null }, note: '补收以前的题' });
    assert.equal(corrected.statusCode, 200, corrected.body); assert.equal(corrected.json().collectedAt, collected.json().collectedAt);
    const other = (await f.login('平板')).json();
    const read = await f.app.inject({ url: `/api/v1/collection/questions/${draft.id}`, headers: auth(other.token) });
    assert.deepEqual(read.json(), corrected.json());
    assert.deepEqual((await f.app.inject({ url: `/api/v1/collection/pages/${draft.originalPage.id}/original`, headers: auth(other.token) })).rawPayload, image);
    const created = await f.app.inject({ method: 'POST', url: `/api/v1/collection/pages/${draft.originalPage.id}/questions`, headers, payload: { ...fields, operationId: randomUUID() } });
    assert.equal(created.statusCode, 201, created.body); assert.deepEqual(created.json().studyStage, fifth);
  } finally { await f.close(); }
});

test('按学科、阶段、日期和停用来源组合查找，未设置可查，分页与清空条件不漏题', async () => {
  const f = await familyFixture();
  try {
    const headers = auth(f.first.token);
    const image = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#fff' } }).png().toBuffer();
    const page = (await f.app.inject({ method: 'POST', url: '/api/v1/collection/pages', headers: { ...headers, 'content-type': 'image/png', 'idempotency-key': randomUUID() }, payload: image })).json();
    const source = (await f.app.inject({ url: '/api/v1/collection/sources', headers })).json()[0];
    const create = (stage: object, sourceId: string | null, subjectId = 'math') => f.app.inject({ method: 'POST', url: `/api/v1/collection/pages/${page.id}/questions`, headers, payload: { ...fields, operationId: randomUUID(), studyStage: stage, sourceId, subjectId } });
    const first = (await create(fourth, source.id)).json();
    f.advance(1000);
    for (let index = 0; index < 51; index++) assert.equal((await create(fifth, source.id)).statusCode, 201);
    const boundary = (await create(empty, null, 'english')).json();
    const query = (values: Record<string, string>) => f.app.inject({ url: `/api/v1/collection/questions?${new URLSearchParams({ state: 'collected', ...values })}`, headers });
    const filters = { subjectId: 'math', schoolYear: '2026-2027', grade: '小学五年级', term: 'first', sourceId: source.id };
    const filtered = await query(filters);
    assert.equal(filtered.statusCode, 200, filtered.body); assert.equal(filtered.json().total, 51); assert.equal(filtered.json().items.length, 50);
    const next = (await query({ ...filters, offset: '50' })).json(); assert.equal(next.items.length, 1);
    assert.equal(new Set([...filtered.json().items, ...next.items].map(item => item.id)).size, 51);
    assert.deepEqual((await query({ collectedFrom: String(first.collectedAt), collectedBefore: String(boundary.collectedAt) })).json().items.map((q: { id: string }) => q.id), [first.id]);
    assert.equal((await query({ schoolYear: '__unset__', grade: '__unset__', term: '__unset__', sourceId: '__unset__' })).json().items[0].id, boundary.id);
    assert.equal((await query({ ...filters, subjectId: 'english' })).json().total, 0);
    assert.equal((await query({})).json().total, 53);
    assert.equal((await query({ collectedFrom: '2000', collectedBefore: '1000' })).statusCode, 422);
    assert.equal((await query({ term: 'unknown' })).statusCode, 400);
    const grant = (await f.app.inject({ method: 'POST', url: '/api/v1/admin/grants', headers, payload: { password } })).json().token;
    assert.equal((await f.app.inject({ method: 'PUT', url: `/api/v1/admin/sources/${source.id}`, headers: auth(f.first.token, grant), payload: { operationId: randomUUID(), expectedRevision: source.revision, name: source.name, active: false } })).statusCode, 200);
    const options = await f.app.inject({ url: '/api/v1/collection/filter-options', headers });
    assert.equal(options.statusCode, 200, options.body); assert.deepEqual(options.json().schoolYears, ['2026-2027', '2025-2026']);
    assert.equal(options.json().sources.find((item: { id: string }) => item.id === source.id).active, false);
    assert.equal((await query(filters)).json().total, 51);
  } finally { await f.close(); }
});

test('家庭默认设置只能由有效家长授权修改，稳定重试不重复，旧修订及无效归档被拒绝', async () => {
  const f = await familyFixture();
  try {
    const headers = auth(f.first.token);
    const settings = { operationId: randomUUID(), expectedRevision: 0, stage: fourth };
    const path = '/api/v1/admin/study-settings';
    assert.equal((await f.app.inject({ method: 'PUT', url: path, payload: settings })).statusCode, 401);
    assert.equal((await f.app.inject({ method: 'PUT', url: path, headers, payload: settings })).statusCode, 403);
    const subjectId = randomUUID(); const subjectPath = `/api/v1/admin/subjects/${subjectId}`;
    assert.equal((await f.app.inject({ method: 'PUT', url: subjectPath, headers, payload: { name: '历史' } })).statusCode, 403);
    const grant = (await f.app.inject({ method: 'POST', url: '/api/v1/admin/grants', headers, payload: { password } })).json().token;
    const parent = auth(f.first.token, grant);
    const save = (payload: object) => f.app.inject({ method: 'PUT', url: path, headers: parent, payload });
    assert.equal((await save(settings)).json().revision, 1); assert.equal((await save(settings)).json().revision, 1);
    assert.equal((await save({ ...settings, stage: fifth })).statusCode, 409);
    assert.equal((await save({ ...settings, operationId: randomUUID(), stage: fifth })).statusCode, 409);
    assert.equal((await save({ operationId: randomUUID(), expectedRevision: 1, stage: { ...fourth, schoolYear: '2025-2027' } })).statusCode, 422);
    assert.equal((await save({ operationId: randomUUID(), expectedRevision: 1, stage: { ...fourth, grade: '   ' } })).statusCode, 422);
    assert.equal((await save({ operationId: randomUUID(), expectedRevision: 1, stage: { ...fourth, term: 'third' } })).statusCode, 400);
    assert.equal((await save({ operationId: randomUUID(), expectedRevision: 1, stage: empty })).json().revision, 2);
    assert.deepEqual((await save(settings)).json(), { revision: 2, stage: empty });
    const add = (name: string, id = subjectId) => f.app.inject({ method: 'PUT', url: `/api/v1/admin/subjects/${id}`, headers: parent, payload: { name } });
    assert.equal((await add('History')).statusCode, 200); assert.equal((await add('History')).statusCode, 200);
    assert.equal((await add('history', randomUUID())).statusCode, 409); assert.equal((await add('改变旧名称')).statusCode, 409);
    const subjects = (await f.app.inject({ url: '/api/v1/collection/subjects', headers })).json();
    assert.deepEqual(subjects.map((item: { name: string }) => item.name), ['语文', '数学', '英语', '科学', 'History']);
    const other = (await f.login('孩子设备')).json();
    assert.equal((await f.app.inject({ method: 'PUT', url: path, headers: auth(other.token, grant), payload: settings })).statusCode, 403);
    f.advance(5 * 60000);
    assert.equal((await save(settings)).statusCode, 403); assert.equal((await add('History')).statusCode, 403);
    assert.deepEqual((await f.app.inject({ url: '/api/v1/collection/study-settings', headers })).json(), { revision: 2, stage: empty });
  } finally { await f.close(); }
});
