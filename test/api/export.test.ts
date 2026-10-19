import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { packageFiles as unpack } from '../package-files.ts';
import { rename, readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { LearningPackageData } from '../../src/shared/learning-package.ts';
import type { Question } from '../../src/shared/collection.ts';
import { createApp } from '../../src/server/app.ts';
import { auth, familyFixture, password } from './fixture.ts';

const root = '/api/v1/admin/exports';
const whole = { x: 0, y: 0, width: 1, height: 1 };
const fields = { state: 'collected', subjectId: 'math', region: whole, sourceId: null, pageNumber: '6', questionNumber: '3', note: '按原图核对' };
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function prepare(f: Awaited<ReturnType<typeof familyFixture>>) {
  const headers = auth(f.first.token);
  const grant = (await f.app.inject({ method: 'POST', url: '/api/v1/admin/grants', headers, payload: { password } })).json().token;
  const bytes = await sharp({ create: { width: 160, height: 200, channels: 3, background: 'white' } }).png().toBuffer();
  const draft = (await f.app.inject({ method: 'POST', url: '/api/v1/collection/drafts', headers: { ...headers, 'content-type': 'image/png', 'idempotency-key': randomUUID() }, payload: bytes })).json();
  const question = (await f.app.inject({ method: 'PUT', url: `/api/v1/collection/questions/${draft.id}`, headers, payload: { ...fields, operationId: randomUUID(), expectedRevision: 1 } })).json();
  return { headers, parent: auth(f.first.token, grant), bytes, question };
}
async function finished(f: Awaited<ReturnType<typeof familyFixture>>, parent: ReturnType<typeof auth>, id: string) {
  for (let i = 0; i < 250; i++) {
    const response = await f.app.inject({ url: `${root}/${id}`, headers: parent });
    assert.equal(response.statusCode, 200, response.body);
    if (response.json().status !== 'preparing') return response.json();
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Export did not finish');
}

test('导出须由家长核对范围，ZIP 包独立保存真实原图与完整性信息', async () => {
  const f = await familyFixture();
  try {
    const p = await prepare(f), id = randomUUID();
    assert.equal((await f.app.inject({ url: root })).statusCode, 401);
    assert.equal((await f.app.inject({ url: root, headers: p.headers })).statusCode, 403);
    const preview = await f.app.inject({ url: root, headers: p.parent });
    assert.equal(preview.statusCode, 200, preview.body);
    assert.equal(preview.json().questionCount, 1); assert.equal(preview.json().pageCount, 1);
    const payload = { previewToken: preview.json().token };
    assert.equal((await f.app.inject({ method: 'PUT', url: `${root}/${id}`, headers: p.headers, payload })).statusCode, 403);
    const created = await f.app.inject({ method: 'PUT', url: `${root}/${id}`, headers: p.parent, payload });
    assert.equal(created.statusCode, 202, created.body);
    assert.equal((await finished(f, p.parent, id)).status, 'ready');
    assert.equal((await f.app.inject({ url: `${root}/${id}/file`, headers: p.headers })).statusCode, 403);
    const result = await f.app.inject({ url: `${root}/${id}/file`, headers: p.parent });
    assert.equal(result.statusCode, 200, result.body.slice(0, 100));
    assert.match(String(result.headers['content-type']), /application\/zip/);
    const files = await unpack(result.rawPayload);
    const manifest = JSON.parse(files.get('manifest.json')!.toString());
    assert.equal(manifest.format, 'klbook-learning-package'); assert.equal(manifest.version, 1);
    assert.equal(files.get('manifest.sha256')!.toString().trim(), sha(files.get('manifest.json')!));
    for (const entry of manifest.files) {
      assert.equal(files.get(entry.path)?.length, entry.byteLength);
      assert.equal(sha(files.get(entry.path)!), entry.sha256);
      assert.doesNotMatch(entry.path, /(^\/|[\\:]|\.\.)/);
    }
    const data = JSON.parse(files.get('data.json')!.toString());
    assert.equal(data.library.id, p.question.libraryId);
    assert.equal(data.questions[0].id, p.question.id); assert.equal(data.questions[0].revision, p.question.revision);
    assert.equal(data.questions[0].note, fields.note); assert.equal(data.questions[0].collectedAt, p.question.collectedAt);
    assert.equal(data.questions[0].parts[0].pageId, data.pages[0].id);
    assert.deepEqual(files.get(data.pages[0].path), p.bytes);
    assert.deepEqual(data.questions[0].parts[0].region, whole);
    assert.equal(files.size, manifest.files.length + 2);
    assert.doesNotMatch(files.get('data.json')!.toString(), /password|token|credential|accountId|deviceName|apiKey|previewSha256/);
  } finally { await f.close(); }
});

test('含跨页、共享阅读、答案、识别与更正、扩展学科的快照保留全部关联，排除草稿与回收站', async () => {
  let calls = 0;
  const f = await familyFixture({ ocrHttp: async () => {
    calls++;
    return Response.json({ header: { code: 0 }, payload: { result: { encoding: 'utf8', compress: 'raw', format: 'json', text: Buffer.from(JSON.stringify({ pages: [{ exception: 0, lines: [
      { exception: 0, coord: [{ x: 10, y: 10 }, { x: 140, y: 10 }, { x: 140, y: 40 }, { x: 10, y: 40 }], words: [{ content: '1. 计算 12 × 3 =' }] }
    ] }] })).toString('base64') } } });
  } });
  try {
    const p = await prepare(f), custom = randomUUID(), sourceId = randomUUID(), readingId = randomUUID();
    const upload = async (route = 'pages') => (await f.app.inject({ method: 'POST', url: `/api/v1/collection/${route}`, headers: { ...p.headers, 'content-type': 'image/png', 'idempotency-key': randomUUID() }, payload: p.bytes })).json();
    const page2 = await upload(), answer = await upload(), reading = await upload();
    assert.equal((await f.app.inject({ method: 'PUT', url: `/api/v1/admin/subjects/${custom}`, headers: p.parent, payload: { name: '综合实践' } })).statusCode, 200);
    await f.app.inject({ method: 'PUT', url: `/api/v1/admin/sources/${sourceId}`, headers: p.parent, payload: { operationId: randomUUID(), expectedRevision: 0, name: '秋季自编练习', active: true } });
    await f.app.inject({ method: 'PUT', url: `/api/v1/collection/reading-materials/${readingId}`, headers: p.headers, payload: { operationId: randomUUID(), expectedRevision: 0, title: '共同阅读原文', parts: [{ id: randomUUID(), pageId: reading.id, region: whole }] } });
    const credentials = { appId: 'collect-app', apiKey: 'apikeyXXXXXXXXXXXXXXXXXXXXXXXXXX', secretKey: 'apisecretXXXXXXXXXXXXXXXXXXXXXXX' };
    const config = { provider: 'xfyun', name: '仅测试供应商边界', enabled: true, language: 'CHN_ENG', handwriting: true, formulas: false, timeoutSeconds: 5, retries: 0, monthlyLimit: 20, monthlyBudgetCents: 100, priceCents: 3.5 };
    assert.equal((await f.app.inject({ method: 'PUT', url: '/api/v1/admin/ocr', headers: p.parent, payload: { operationId: randomUUID(), expectedRevision: 0, config, credentials } })).statusCode, 200);
    const runId = randomUUID(), pageId = p.question.originalPage.id;
    await f.app.inject({ method: 'PUT', url: `/api/v1/collection/pages/${pageId}/recognitions/${runId}`, headers: p.headers });
    let run;
    for (let i = 0; i < 100; i++) {
      run = (await f.app.inject({ url: `/api/v1/collection/pages/${pageId}/recognitions/${runId}`, headers: p.headers })).json();
      if (run.status !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(run.status, 'succeeded'); assert.equal(calls, 1);
    const parts = [{ id: randomUUID(), pageId: page2.id, region: whole, transcription: '第二页排在前面' },
      { id: p.question.parts[0].id, pageId, region: whole, transcription: '人工更正：12 × 3 = ?', recognition: { runId, candidateId: run.candidates[0].id } }];
    let first = (await f.app.inject({ method: 'PUT', url: `/api/v1/collection/questions/${p.question.id}`, headers: p.headers, payload: { ...fields, operationId: randomUUID(), expectedRevision: p.question.revision,
      subjectId: custom, sourceId, readingMaterialId: readingId, parts, studyStage: { schoolYear: '2025-2026', grade: '三年级', term: 'second' } } })).json<Question>();
    assert.equal(first.parts.length, 2);
    first = (await f.app.inject({ method: 'PUT', url: `/api/v1/collection/questions/${first.id}/answers`, headers: p.headers, payload: { operationId: randomUUID(), expectedRevision: first.revision,
      parts: [{ id: randomUUID(), pageId: answer.id, region: { x: .1, y: .1, width: .8, height: .8 } }] } })).json<Question>();
    const second = (await f.app.inject({ method: 'POST', url: `/api/v1/collection/pages/${pageId}/questions`, headers: p.headers, payload: { ...fields, operationId: randomUUID(), readingMaterialId: readingId,
      studyStage: { schoolYear: null, grade: null, term: null } } })).json<Question>();
    const excluded = await upload('drafts');
    const removed = (await f.app.inject({ method: 'POST', url: `/api/v1/collection/pages/${excluded.originalPage.id}/questions`, headers: p.headers, payload: { ...fields, operationId: randomUUID(), note: '回收站私有测试备注' } })).json();
    await f.app.inject({ method: 'PUT', url: `/api/v1/admin/trash/${removed.id}`, headers: p.parent, payload: { operationId: randomUUID(), expectedRevision: removed.revision, action: 'trash' } });
    await f.app.inject({ method: 'PUT', url: `/api/v1/admin/sources/${sourceId}`, headers: p.parent, payload: { operationId: randomUUID(), expectedRevision: 1, name: '秋季自编练习（旧）', active: false } });
    const preview = (await f.app.inject({ url: root, headers: p.parent })).json();
    assert.equal(preview.questionCount, 2); assert.equal(preview.pageCount, 4); assert.equal(preview.readingCount, 1);
    const id = randomUUID();
    await f.app.inject({ method: 'PUT', url: `${root}/${id}`, headers: p.parent, payload: { previewToken: preview.token } });
    assert.equal((await finished(f, p.parent, id)).status, 'ready');
    const files = await unpack((await f.app.inject({ url: `${root}/${id}/file`, headers: p.parent })).rawPayload);
    const data: LearningPackageData = JSON.parse(files.get('data.json')!.toString());
    assert.deepEqual(data.questions.map(q => q.id).sort(), [first.id, second.id].sort());
    const exported = data.questions.find(q => q.id === first.id)!;
    assert.equal(exported.revision, first.revision); assert.equal(exported.collectedAt, first.collectedAt);
    assert.deepEqual(exported.studyStage, first.studyStage); assert.deepEqual(data.questions.find(q => q.id === second.id)!.studyStage, second.studyStage);
    assert.deepEqual(exported.parts.map(p => p.pageId), [page2.id, pageId]);
    assert.equal(exported.parts[1]!.transcription, parts[1]!.transcription);
    assert.deepEqual(exported.parts[1]!.recognition, { runId, candidateId: run.candidates[0].id });
    assert.deepEqual(exported.answerParts.map(p => ({ pageId: p.pageId, region: p.region })), [{ pageId: answer.id, region: first.answerParts[0]!.region }]);
    assert.equal(data.readings[0]!.id, readingId); assert.equal(data.readings.length, 1);
    assert.ok(data.questions.every(q => q.readingMaterialId === readingId));
    assert.equal(data.readings[0]!.parts[0]!.pageId, reading.id);
    assert.deepEqual(data.sources, [{ id: sourceId, name: '秋季自编练习（旧）', active: false, revision: 2 }]);
    assert.ok(data.subjects.some(s => s.id === custom && s.name === '综合实践'));
    assert.equal(data.recognitions[0]!.lines[0]!.text, '1. 计算 12 × 3 =');
    assert.deepEqual(data.recognitions[0]!.candidates, run.candidates);
    assert.ok(!data.pages.some(p => p.id === excluded.originalPage.id));
    for (const page of data.pages) assert.deepEqual(files.get(page.path), p.bytes);
    assert.doesNotMatch(files.get('data.json')!.toString(), /apikeyXXXX|apisecretXXXX|parent|回收站私有测试备注|credentials|settings/);
    assert.equal(calls, 1, '导出不触发额外识别');
  } finally { await f.close(); }
});

test('预览过时需重新核对；已接受快照不受第二会话修改、永久删除或重试影响', async () => {
  const f = await familyFixture();
  try {
    const p = await prepare(f), second = (await f.login('平板')).json();
    const headers = auth(second.token), grant = (await f.app.inject({ method: 'POST', url: '/api/v1/admin/grants', headers, payload: { password } })).json().token;
    const parent = auth(second.token, grant);
    const old = (await f.app.inject({ url: root, headers: p.parent })).json();
    const changed = (await f.app.inject({ method: 'PUT', url: `/api/v1/collection/questions/${p.question.id}`, headers, payload: { ...fields, operationId: randomUUID(), expectedRevision: p.question.revision, note: '快照之前的修改' } })).json();
    assert.equal((await f.app.inject({ method: 'PUT', url: `${root}/${randomUUID()}`, headers: p.parent, payload: { previewToken: old.token } })).statusCode, 409);
    const preview = (await f.app.inject({ url: root, headers: p.parent })).json(), id = randomUUID(), payload = { previewToken: preview.token };
    assert.equal((await f.app.inject({ method: 'PUT', url: `${root}/${id}`, headers: p.parent, payload })).statusCode, 202);
    const deleted = (await f.app.inject({ method: 'PUT', url: `/api/v1/admin/trash/${changed.id}`, headers: parent, payload: { operationId: randomUUID(), expectedRevision: changed.revision, action: 'trash' } })).json();
    assert.equal((await f.app.inject({ method: 'PUT', url: `/api/v1/admin/trash/${changed.id}`, headers: parent, payload: { operationId: randomUUID(), expectedRevision: deleted.revision, action: 'purge', confirm: true } })).statusCode, 200);
    assert.equal((await finished(f, p.parent, id)).status, 'ready');
    assert.equal((await f.app.inject({ method: 'PUT', url: `${root}/${id}`, headers: p.parent, payload })).statusCode, 202);
    assert.equal((await f.app.inject({ method: 'PUT', url: `${root}/${id}`, headers: p.parent, payload: { previewToken: old.token } })).statusCode, 409);
    await f.app.inject({ method: 'POST', url: '/api/v1/admin/trash/cleanup', headers: parent });
    assert.equal((await f.app.inject({ url: `/api/v1/collection/pages/${changed.originalPage.id}/original`, headers })).statusCode, 410);
    const files = await unpack((await f.app.inject({ url: `${root}/${id}/file`, headers: p.parent })).rawPayload);
    const data: LearningPackageData = JSON.parse(files.get('data.json')!.toString());
    assert.equal(data.questions[0]!.note, '快照之前的修改'); assert.equal(data.questions[0]!.revision, changed.revision);
    assert.deepEqual(files.get(data.pages[0]!.path), p.bytes);
    f.advance(6 * 60_000);
    assert.equal((await f.app.inject({ url: `${root}/${id}/file`, headers: p.parent })).statusCode, 403);
    const freshGrant = (await f.app.inject({ method: 'POST', url: '/api/v1/admin/grants', headers: p.headers, payload: { password } })).json().token;
    assert.equal((await f.app.inject({ url: `${root}/${id}/file`, headers: auth(f.first.token, freshGrant) })).statusCode, 200);
    f.advance(10 * 60_000);
    const lastGrant = (await f.app.inject({ method: 'POST', url: '/api/v1/admin/grants', headers: p.headers, payload: { password } })).json().token;
    assert.equal((await f.app.inject({ url: `${root}/${id}`, headers: auth(f.first.token, lastGrant) })).statusCode, 404);
  } finally { await f.close(); }
});

test('缺图或临时目录故障不发布残包，修复后可重新生成；重启清除旧临时包', async () => {
  const f = await familyFixture();
  try {
    const p = await prepare(f), original = join(f.dataDir, 'attachments', 'pages', p.question.originalPage.id, 'original');
    const preview = (await f.app.inject({ url: root, headers: p.parent })).json();
    await rename(original, original + '.held');
    const broken = randomUUID();
    await f.app.inject({ method: 'PUT', url: `${root}/${broken}`, headers: p.parent, payload: { previewToken: preview.token } });
    assert.equal((await finished(f, p.parent, broken)).status, 'failed');
    assert.equal((await f.app.inject({ url: `${root}/${broken}/file`, headers: p.parent })).statusCode, 409);
    for (let attempt = 0; attempt < 3; attempt++) {
      const retry = randomUUID();
      const responses = await Promise.all([0, 1].map(() => f.app.inject({ method: 'PUT', url: `${root}/${retry}`, headers: p.parent, payload: { previewToken: preview.token } })));
      for (const response of responses) assert.equal(response.statusCode, 202, '失败任务不能耗尽后续重试名额，同一新任务并发重试应返回已有任务');
      assert.equal((await finished(f, p.parent, retry)).status, 'failed');
    }
    await rename(original + '.held', original);
    const work = join(f.dataDir, 'export-work');
    await rename(work, work + '.held'); await writeFile(work, 'not a directory');
    const unavailable = randomUUID();
    await f.app.inject({ method: 'PUT', url: `${root}/${unavailable}`, headers: p.parent, payload: { previewToken: preview.token } });
    assert.equal((await finished(f, p.parent, unavailable)).status, 'failed');
    await rename(work, work + '.fault'); await rename(work + '.held', work);
    const id = randomUUID();
    await f.app.inject({ method: 'PUT', url: `${root}/${id}`, headers: p.parent, payload: { previewToken: preview.token } });
    assert.equal((await finished(f, p.parent, id)).status, 'ready');
    assert.deepEqual(await readFile(original), p.bytes);
    assert.equal((await f.app.inject({ url: `/api/v1/collection/questions/${p.question.id}`, headers: p.headers })).statusCode, 200);
    await f.app.close();
    const restarted = createApp({ dataDir: f.dataDir });
    try {
      await restarted.ready();
      assert.equal((await restarted.inject({ url: `${root}/${id}`, headers: p.parent })).statusCode, 404);
      assert.deepEqual(await readdir(work), []);
      assert.deepEqual((await restarted.inject({ url: `/api/v1/collection/pages/${p.question.originalPage.id}/original`, headers: p.headers })).rawPayload, p.bytes);
    } finally { await restarted.close(); }
  } finally { await f.close(); }
});
