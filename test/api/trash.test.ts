import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { access as fileAccess } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { auth, familyFixture, password } from './fixture.ts';
import type { Question } from '../../src/shared/collection.ts';
import { createApp } from '../../src/server/app.ts';
import { rename, writeFile, unlink } from 'node:fs/promises';
import { finishedOcr } from './ocr-fixture.ts';

const whole = { x: 0, y: 0, width: 1, height: 1 };
const fields = { state: 'collected', subjectId: 'math', region: whole, sourceId: null, pageNumber: '3', questionNumber: '2', note: '保留我的整理' };
async function prepare(f: Awaited<ReturnType<typeof familyFixture>>) {
  const headers = auth(f.first.token);
  const grant = (await f.app.inject({ method: 'POST', url: '/api/v1/admin/grants', headers, payload: { password } })).json().token;
  const bytes = await sharp({ create: { width: 160, height: 200, channels: 3, background: 'white' } }).png().toBuffer();
  const uploadId = randomUUID();
  const draft = (await f.app.inject({ method: 'POST', url: '/api/v1/collection/drafts', headers: { ...headers, 'content-type': 'image/png', 'idempotency-key': uploadId }, payload: bytes })).json<Question>();
  const saved = (await f.app.inject({ method: 'PUT', url: `/api/v1/collection/questions/${draft.id}`, headers, payload: { ...fields, operationId: randomUUID(), expectedRevision: 1 } })).json<Question>();
  return { headers, parent: auth(f.first.token, grant), bytes, uploadId, question: saved };
}

test('家长删除题目进入三十天回收站，重复删除保留原时间，恢复保留资料并拒绝旧修订', async () => {
  const f = await familyFixture();
  try {
    const time = Date.UTC(2026, 9, 19, 2);
    f.setTime(time);
    const p = await prepare(f);
    const id = p.question.id, path = `/api/v1/admin/trash/${id}`;
    const change = { operationId: randomUUID(), expectedRevision: p.question.revision, action: 'trash' };
    assert.equal((await f.app.inject({ method: 'PUT', url: path, payload: change })).statusCode, 401);
    assert.equal((await f.app.inject({ method: 'PUT', url: path, headers: p.headers, payload: change })).statusCode, 403);
    const removed = await f.app.inject({ method: 'PUT', url: path, headers: p.parent, payload: change });
    assert.equal(removed.statusCode, 200, removed.body);
    assert.equal(removed.json().deletedAt, time);
    assert.equal(removed.json().expiresAt, Date.UTC(2026, 10, 18, 2));
    assert.equal((await f.app.inject({ url: '/api/v1/collection/questions?state=collected', headers: p.headers })).json().total, 0);
    assert.equal((await f.app.inject({ url: `/api/v1/collection/questions/${id}`, headers: p.headers })).statusCode, 410);
    assert.equal((await f.app.inject({ url: '/api/v1/admin/trash', headers: p.headers })).statusCode, 403);
    const trash = (await f.app.inject({ url: '/api/v1/admin/trash', headers: p.parent })).json();
    assert.equal(trash.total, 1);
    assert.equal(trash.items[0].question.note, p.question.note);
    assert.deepEqual(trash.items[0].question.parts, p.question.parts);
    assert.deepEqual((await f.app.inject({ method: 'PUT', url: path, headers: p.parent, payload: change })).json(), removed.json());
    assert.equal((await f.app.inject({ method: 'PUT', url: `/api/v1/collection/questions/${id}`, headers: p.headers, payload: { ...fields, operationId: randomUUID(), expectedRevision: 2 } })).statusCode, 410);
    const restored = await f.app.inject({ method: 'PUT', url: path, headers: p.parent, payload: { operationId: randomUUID(), expectedRevision: removed.json().revision, action: 'restore' } });
    assert.equal(restored.statusCode, 200, restored.body);
    const current = (await f.app.inject({ url: `/api/v1/collection/questions/${id}`, headers: p.headers })).json<Question>();
    assert.equal(current.revision, p.question.revision + 2);
    assert.equal(current.collectedAt, p.question.collectedAt);
    assert.deepEqual(current.parts, p.question.parts);
    assert.equal(current.note, p.question.note);
    assert.equal((await f.app.inject({ method: 'PUT', url: `/api/v1/collection/questions/${id}`, headers: p.headers, payload: { ...fields, operationId: randomUUID(), expectedRevision: 2 } })).statusCode, 409);
    assert.equal((await f.app.inject({ url: '/api/v1/admin/trash', headers: p.parent })).json().total, 0);
  } finally { await f.close(); }
});

test('永久删除保护另一题共享的原图与阅读材料，清理独占答案；旧上传和旧原文不能重新建回', async () => {
  const f = await familyFixture();
  try {
    const p = await prepare(f);
    const uploadPage = async () => (await f.app.inject({ method: 'POST', url: '/api/v1/collection/pages', headers: { ...p.headers, 'content-type': 'image/png', 'idempotency-key': randomUUID() }, payload: p.bytes })).json();
    const answer = await uploadPage(), readingPage = await uploadPage();
    const readingId = randomUUID();
    const readingEdit = { operationId: randomUUID(), expectedRevision: 0, title: '两个小题的原文', parts: [{ id: randomUUID(), pageId: readingPage.id, region: whole }] };
    assert.equal((await f.app.inject({ method: 'PUT', url: `/api/v1/collection/reading-materials/${readingId}`, headers: p.headers, payload: readingEdit })).statusCode, 200);
    let first = (await f.app.inject({ method: 'PUT', url: `/api/v1/collection/questions/${p.question.id}`, headers: p.headers, payload: { ...fields, operationId: randomUUID(), expectedRevision: 2, readingMaterialId: readingId } })).json<Question>();
    first = (await f.app.inject({ method: 'PUT', url: `/api/v1/collection/questions/${first.id}/answers`, headers: p.headers, payload: { operationId: randomUUID(), expectedRevision: first.revision, parts: [{ id: randomUUID(), pageId: answer.id, region: whole }] } })).json<Question>();
    first = (await f.app.inject({ method: 'PUT', url: `/api/v1/collection/questions/${first.id}`, headers: p.headers, payload: { ...fields, operationId: randomUUID(), expectedRevision: first.revision,
      studyStage: { schoolYear: '2026-2027', grade: '4', term: 'first' },
      parts: [{ id: first.parts[0]!.id, pageId: first.originalPage.id, region: whole, transcription: '自己的题干更正' }, { id: randomUUID(), pageId: readingPage.id, region: whole }]
    } })).json<Question>();
    assert.ok(first.parts, JSON.stringify(first));
    const deleted = (await f.app.inject({ method: 'PUT', url: `/api/v1/admin/trash/${first.id}`, headers: p.parent, payload: { operationId: randomUUID(), expectedRevision: first.revision, action: 'trash' } })).json();
    assert.equal((await f.app.inject({ method: 'PUT', url: `/api/v1/admin/trash/${first.id}`, headers: p.parent, payload: { operationId: randomUUID(), expectedRevision: deleted.revision, action: 'restore' } })).statusCode, 200);
    const restored = (await f.app.inject({ url: `/api/v1/collection/questions/${first.id}`, headers: p.headers })).json<Question>();
    assert.deepEqual(restored, { ...first, revision: first.revision + 2, updatedAt: restored.updatedAt });
    first = restored;
    const second = (await f.app.inject({ method: 'POST', url: `/api/v1/collection/pages/${first.originalPage.id}/questions`, headers: p.headers, payload: { ...fields, operationId: randomUUID(), readingMaterialId: readingId } })).json<Question>();
    const remove = async (q: Question) => {
      const path = `/api/v1/admin/trash/${q.id}`;
      const deleted = await f.app.inject({ method: 'PUT', url: path, headers: p.parent, payload: { operationId: randomUUID(), expectedRevision: q.revision, action: 'trash' } });
      assert.equal(deleted.statusCode, 200, deleted.body);
      const operation = { operationId: randomUUID(), expectedRevision: deleted.json().revision, action: 'purge', confirm: true };
      assert.equal((await f.app.inject({ method: 'PUT', url: path, headers: p.parent, payload: { ...operation, confirm: false } })).statusCode, 422);
      const result = await f.app.inject({ method: 'PUT', url: path, headers: p.parent, payload: operation });
      assert.equal(result.statusCode, 200, result.body);
      assert.equal((await f.app.inject({ method: 'PUT', url: path, headers: p.parent, payload: operation })).statusCode, 200);
      return result;
    };
    await remove(first);
    const surviving = await f.app.inject({ url: `/api/v1/collection/questions/${second.id}`, headers: p.headers });
    assert.equal(surviving.statusCode, 200, surviving.body);
    assert.equal(surviving.json().readingMaterial.title, readingEdit.title);
    for (const id of [first.originalPage.id, readingPage.id]) assert.deepEqual((await f.app.inject({ url: `/api/v1/collection/pages/${id}/original`, headers: p.headers })).rawPayload, p.bytes);
    assert.equal((await f.app.inject({ url: `/api/v1/collection/pages/${answer.id}/original`, headers: p.headers })).statusCode, 410);
    await assert.rejects(fileAccess(join(f.dataDir, 'attachments', 'pages', answer.id, 'original')));
    const replay = await f.app.inject({ method: 'POST', url: '/api/v1/collection/drafts', headers: { ...p.headers, 'content-type': 'image/png', 'idempotency-key': p.uploadId }, payload: p.bytes });
    assert.equal(replay.statusCode, 410);
    await remove(second);
    for (const id of [first.originalPage.id, readingPage.id]) {
      assert.equal((await f.app.inject({ url: `/api/v1/collection/pages/${id}/original`, headers: p.headers })).statusCode, 410);
      await assert.rejects(fileAccess(join(f.dataDir, 'attachments', 'pages', id, 'original')));
    }
    assert.equal((await f.app.inject({ method: 'PUT', url: `/api/v1/collection/reading-materials/${readingId}`, headers: p.headers, payload: readingEdit })).statusCode, 410);
    assert.equal((await f.app.inject({ url: '/api/v1/admin/trash', headers: p.parent })).json().total, 0);
  } finally { await f.close(); }
});

test('两个会话冲突不丢修改；停机跨过期限后启动清理，原删除时间和重试回执保留', async () => {
  const f = await familyFixture();
  let restarted: ReturnType<typeof createApp> | undefined;
  try {
    const p = await prepare(f);
    const second = (await f.login('手机')).json();
    const newer = (await f.app.inject({ method: 'PUT', url: `/api/v1/collection/questions/${p.question.id}`, headers: auth(second.token), payload: { ...fields, note: '手机的并发修改', operationId: randomUUID(), expectedRevision: p.question.revision } })).json<Question>();
    const path = `/api/v1/admin/trash/${newer.id}`;
    assert.equal((await f.app.inject({ method: 'PUT', url: path, headers: p.parent, payload: { operationId: randomUUID(), expectedRevision: p.question.revision, action: 'trash' } })).statusCode, 409);
    const input = { operationId: randomUUID(), expectedRevision: newer.revision, action: 'trash' };
    const receipt = (await f.app.inject({ method: 'PUT', url: path, headers: p.parent, payload: input })).json();
    assert.equal((await f.app.inject({ url: '/api/v1/collection/deleted-questions', headers: auth(second.token) })).json()[0].id, newer.id);
    await f.app.close();
    restarted = createApp({ dataDir: f.dataDir, now: () => receipt.expiresAt + 1 });
    const session = (await restarted.inject({ method: 'POST', url: '/api/v1/sessions', payload: { username: 'parent', password, deviceName: '重启后电脑' } })).json();
    const grant = (await restarted.inject({ method: 'POST', url: '/api/v1/admin/grants', headers: auth(session.token), payload: { password } })).json().token;
    const parent = auth(session.token, grant);
    assert.equal((await restarted.inject({ url: '/api/v1/admin/trash', headers: parent })).json().total, 0);
    const tombstone = (await restarted.inject({ url: '/api/v1/collection/deleted-questions', headers: auth(session.token) })).json()[0];
    assert.equal(tombstone.deletedAt, receipt.deletedAt);
    assert.equal(tombstone.expiresAt, receipt.expiresAt);
    assert.equal(tombstone.purgedAt, receipt.expiresAt + 1);
    await assert.rejects(fileAccess(join(f.dataDir, 'attachments', 'pages', newer.originalPage.id, 'original')));
    assert.equal((await restarted.inject({ method: 'PUT', url: path, headers: parent, payload: { operationId: randomUUID(), expectedRevision: receipt.revision, action: 'restore' } })).statusCode, 410);
    assert.deepEqual((await restarted.inject({ method: 'PUT', url: path, headers: parent, payload: input })).json(), receipt);
    assert.equal((await restarted.inject({ method: 'POST', url: '/api/v1/admin/trash/cleanup', headers: parent })).json().cleanup.pending, 0);
  } finally { await restarted?.close(); await f.close(); }
});

test('真实文件目录故障保留清理任务，重启后安全重试且不删除无关上传', async () => {
  const f = await familyFixture();
  let restarted: ReturnType<typeof createApp> | undefined;
  const pages = join(f.dataDir, 'attachments', 'pages'), held = join(f.dataDir, 'attachments', 'pages-held');
  let moved = false, blocked = false;
  try {
    const p = await prepare(f);
    const unrelated = (await f.app.inject({ method: 'POST', url: '/api/v1/collection/pages', headers: { ...p.headers, 'content-type': 'image/png', 'idempotency-key': randomUUID() }, payload: p.bytes })).json();
    const path = `/api/v1/admin/trash/${p.question.id}`;
    const deletion = (await f.app.inject({ method: 'PUT', url: path, headers: p.parent, payload: { operationId: randomUUID(), expectedRevision: p.question.revision, action: 'trash' } })).json();
    // A real ENOTDIR failure at the filesystem boundary, without mocking file operations.
    await rename(pages, held); moved = true;
    await writeFile(pages, '暂时无法访问图片目录'); blocked = true;
    assert.equal((await f.app.inject({ method: 'PUT', url: path, headers: p.parent, payload: { operationId: randomUUID(), expectedRevision: deletion.revision, action: 'purge', confirm: true } })).statusCode, 200);
    const failed = (await f.app.inject({ url: '/api/v1/admin/trash', headers: p.parent })).json();
    assert.equal(failed.total, 0);
    assert.deepEqual(failed.cleanup, { pending: 1, failed: 1 });
    await f.app.close();
    await unlink(pages); blocked = false; await rename(held, pages); moved = false;
    restarted = createApp({ dataDir: f.dataDir });
    const cleaned = await restarted.inject({ url: '/api/v1/admin/trash', headers: p.parent });
    assert.equal(cleaned.statusCode, 200, cleaned.body);
    assert.deepEqual(cleaned.json().cleanup, { pending: 0, failed: 0 });
    await assert.rejects(fileAccess(join(pages, p.question.originalPage.id, 'original')));
    assert.deepEqual((await restarted.inject({ url: `/api/v1/collection/pages/${unrelated.id}/original`, headers: p.headers })).rawPayload, p.bytes);
    assert.equal((await restarted.inject({ method: 'POST', url: '/api/v1/admin/trash/cleanup', headers: p.parent })).json().cleanup.pending, 0);
  } finally {
    if (blocked) await unlink(pages);
    if (moved) await rename(held, pages);
    await restarted?.close(); await f.close();
  }
});

test('正在识别的文件延迟清理，完成后保留费用记录并移除识别内容', async () => {
  let release = () => {};
  let started = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  const f = await familyFixture({ ocrHttp: async () => {
    started(); await gate;
    return Response.json({ header: { code: 0 }, payload: { result: { encoding: 'utf8', compress: 'raw', format: 'json', text: Buffer.from(JSON.stringify({ pages: [{ exception: 0, lines: [{ exception: 0, coord: [{ x: 10, y: 10 }, { x: 110, y: 10 }, { x: 110, y: 40 }, { x: 10, y: 40 }], words: [{ content: '1. 计算 12 + 3' }] }] }] })).toString('base64') } } });
  } });
  try {
    const p = await prepare(f), pageId = p.question.originalPage.id;
    assert.equal((await f.app.inject({ method: 'PUT', url: '/api/v1/admin/ocr', headers: p.parent, payload: { operationId: randomUUID(), expectedRevision: 0,
      config: { provider: 'xfyun', name: '回收站测试', enabled: true, language: 'CHN_ENG', handwriting: true, formulas: false, timeoutSeconds: 5, retries: 0, monthlyLimit: 20, monthlyBudgetCents: 100, priceCents: 3.5 },
      credentials: { appId: 'collect-app', apiKey: 'apikeyXXXXXXXXXXXXXXXXXXXXXXXXXX', secretKey: 'apisecretXXXXXXXXXXXXXXXXXXXXXXX' }
    } })).statusCode, 200);
    assert.equal((await f.app.inject({ method: 'PUT', url: `/api/v1/collection/pages/${pageId}/recognitions/${randomUUID()}`, headers: p.headers, payload: { region: whole, automatic: true } })).statusCode, 202);
    await entered;
    const path = `/api/v1/admin/trash/${p.question.id}`;
    const deletion = (await f.app.inject({ method: 'PUT', url: path, headers: p.parent, payload: { operationId: randomUUID(), expectedRevision: p.question.revision, action: 'trash' } })).json();
    assert.equal((await f.app.inject({ method: 'PUT', url: path, headers: p.parent, payload: { operationId: randomUUID(), expectedRevision: deletion.revision, action: 'purge', confirm: true } })).statusCode, 200);
    assert.equal((await f.app.inject({ url: '/api/v1/admin/trash', headers: p.parent })).json().cleanup.pending, 1);
    release(); await finishedOcr(f, p.parent);
    const before = (await f.app.inject({ url: '/api/v1/admin/service-usage', headers: p.parent })).json();
    assert.equal((await f.app.inject({ method: 'POST', url: '/api/v1/admin/trash/cleanup', headers: p.parent })).json().cleanup.pending, 0);
    assert.deepEqual((await f.app.inject({ url: '/api/v1/admin/service-usage', headers: p.parent })).json(), before);
    assert.equal((await f.app.inject({ url: `/api/v1/collection/pages/${pageId}/recognitions`, headers: p.headers })).statusCode, 410);
    const settings = (await f.app.inject({ url: '/api/v1/admin/ocr', headers: p.parent })).json();
    assert.equal(settings.tests[0].status, 'succeeded');
    assert.deepEqual(settings.tests[0].lines, []);
    await assert.rejects(fileAccess(join(f.dataDir, 'attachments', 'pages', pageId, 'original')));
  } finally { release(); await f.close(); }
});
