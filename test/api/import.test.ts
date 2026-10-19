import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { ZipFile } from 'yazl';
import { packageFiles } from '../package-files.ts';
import { unlink, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createApp } from '../../src/server/app.ts';
import sharp from 'sharp';
import { auth, familyFixture, password } from './fixture.ts';

type Family = Awaited<ReturnType<typeof familyFixture>>;
const root = '/api/v1/admin/imports';
const whole = { x: 0, y: 0, width: 1, height: 1 };
async function parent(f: Family) {
  const grant = (await f.app.inject({ method: 'POST', url: '/api/v1/admin/grants', headers: auth(f.first.token), payload: { password } })).json().token;
  return auth(f.first.token, grant);
}
async function sample(f: Family) {
  const bytes = await sharp({ create: { width: 120, height: 180, channels: 3, background: 'white' } }).png().toBuffer();
  const headers = auth(f.first.token);
  const draft = (await f.app.inject({ method: 'POST', url: '/api/v1/collection/drafts', headers: { ...headers, 'content-type': 'image/png', 'idempotency-key': randomUUID() }, payload: bytes })).json();
  const response = await f.app.inject({ method: 'PUT', url: `/api/v1/collection/questions/${draft.id}`, headers, payload: {
    operationId: randomUUID(), expectedRevision: 1, state: 'collected', subjectId: 'math', region: whole,
    sourceId: null, pageNumber: '8', questionNumber: '2', note: '先读清题目', studyStage: { schoolYear: '2025-2026', grade: '三年级', term: 'second' }
  } });
  assert.equal(response.statusCode, 200, response.body);
  return { bytes, question: response.json() };
}
async function exported(f: Family, headers: ReturnType<typeof auth>) {
  const preview = (await f.app.inject({ url: '/api/v1/admin/exports', headers })).json(), id = randomUUID();
  await f.app.inject({ method: 'PUT', url: `/api/v1/admin/exports/${id}`, headers, payload: { previewToken: preview.token } });
  for (let i = 0; i < 250; i++) {
    const status = (await f.app.inject({ url: `/api/v1/admin/exports/${id}`, headers })).json();
    if (status.status === 'ready') return (await f.app.inject({ url: `/api/v1/admin/exports/${id}/file`, headers })).rawPayload;
    assert.notEqual(status.status, 'failed');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Export timed out');
}
const upload = (f: Family, headers: ReturnType<typeof auth>, id: string, bytes: Buffer) => f.app.inject({ method: 'PUT', url: `${root}/${id}`, headers: { ...headers, 'content-type': 'application/zip' }, payload: bytes });
const confirm = (f: Family, headers: ReturnType<typeof auth>, id: string, token: string) => f.app.inject({ method: 'POST', url: `${root}/${id}/confirm`, headers, payload: { previewToken: token } });
async function repack(bytes: Buffer, change: (files: Map<string, Buffer>, data: any, manifest: any) => void) {
  const files = await packageFiles(bytes), data = JSON.parse(files.get('data.json')!.toString()), manifest = JSON.parse(files.get('manifest.json')!.toString());
  change(files, data, manifest);
  files.set('data.json', Buffer.from(JSON.stringify(data)));
  const hash = (v: Buffer) => createHash('sha256').update(v).digest('hex');
  manifest.files = [...files].filter(([path]) => !path.startsWith('manifest.')).map(([path, content]) => ({ path, byteLength: content.length, sha256: hash(content) }));
  const json = Buffer.from(JSON.stringify(manifest)); files.set('manifest.json', json); files.set('manifest.sha256', Buffer.from(hash(json) + '\n'));
  const zip = new ZipFile(), chunks: Buffer[] = [];
  const finished = new Promise<Buffer>((resolve, reject) => { zip.outputStream.on('data', chunk => chunks.push(chunk)); zip.outputStream.on('end', () => resolve(Buffer.concat(chunks))); zip.outputStream.on('error', reject); });
  for (const [path, content] of files) zip.addBuffer(content, path);
  zip.end(); return finished;
}

test('家长校验预览真实导出包，确认后完整入库；同一提交与相同包重试不重复', async () => {
  const source = await familyFixture(), target = await familyFixture();
  try {
    const original = await sample(source), pack = await exported(source, await parent(source));
    const headers = await parent(target), id = randomUUID();
    assert.equal((await target.app.inject({ method: 'PUT', url: `${root}/${id}`, headers: { 'content-type': 'application/zip' }, payload: pack })).statusCode, 401);
    assert.equal((await upload(target, auth(target.first.token), id, pack)).statusCode, 403);
    const response = await upload(target, headers, id, pack);
    assert.equal(response.statusCode, 200, response.body);
    const preview = response.json();
    assert.equal(preview.status, 'preview'); assert.equal(preview.added, 1); assert.equal(preview.skipped, 0); assert.deepEqual(preview.blockers, []);
    assert.equal((await target.app.inject({ url: '/api/v1/collection/questions?state=collected', headers: auth(target.first.token) })).json().total, 0, '预览不能暴露资料');
    const payload = { previewToken: preview.token };
    const applied = await target.app.inject({ method: 'POST', url: `${root}/${id}/confirm`, headers, payload });
    assert.equal(applied.statusCode, 200, applied.body); assert.equal(applied.json().status, 'complete');
    assert.deepEqual((await target.app.inject({ method: 'POST', url: `${root}/${id}/confirm`, headers, payload })).json(), applied.json());
    const items = (await target.app.inject({ url: '/api/v1/collection/questions?state=collected', headers: auth(target.first.token) })).json();
    assert.equal(items.total, 1);
    const q = items.items[0];
    assert.equal(q.note, original.question.note); assert.equal(q.collectedAt, original.question.collectedAt);
    assert.deepEqual(q.studyStage, original.question.studyStage); assert.deepEqual(q.parts[0].region, whole);
    assert.ok(q.importedAt > 0); assert.notEqual(q.id, original.question.id);
    const image = await target.app.inject({ url: `/api/v1/collection/pages/${q.originalPage.id}/original`, headers: auth(target.first.token) });
    assert.deepEqual(image.rawPayload, original.bytes);
    const againId = randomUUID(), again = (await upload(target, headers, againId, pack)).json();
    assert.equal(again.added, 0); assert.equal(again.skipped, 1); assert.deepEqual(again.blockers, []);
    assert.equal((await target.app.inject({ method: 'POST', url: `${root}/${againId}/confirm`, headers, payload: { previewToken: again.token } })).statusCode, 200);
    assert.equal((await target.app.inject({ url: '/api/v1/collection/questions?state=collected', headers: auth(target.first.token) })).json().total, 1);
  } finally { await source.close(); await target.close(); }
});

test('完整往返保留跨页顺序、答案、共享原文、识别更正和自定义归档，所有服务停用仍可导入', async () => {
  const source = await familyFixture({ ocrHttp: async () => Response.json({ header: { code: 0 }, payload: { result: { encoding: 'utf8', compress: 'raw', format: 'json', text: Buffer.from(JSON.stringify({ pages: [{ exception: 0, lines: [
    { exception: 0, coord: [{ x: 10, y: 10 }, { x: 100, y: 10 }, { x: 100, y: 40 }, { x: 10, y: 40 }], words: [{ content: '1. 计算 12 × 3 =' }] }
  ] }] })).toString('base64') } } }) });
  let supplierCalls = 0;
  const target = await familyFixture({ ocrHttp: async () => { supplierCalls++; throw Error('Unexpected OCR'); }, aiHttp: async () => { supplierCalls++; throw Error('Unexpected AI'); }, speechSocket: () => { supplierCalls++; throw Error('Unexpected speech'); } });
  try {
    const first = await sample(source), sourceParent = await parent(source), headers = auth(source.first.token), targetParent = await parent(target);
    const page = async () => (await source.app.inject({ method: 'POST', url: '/api/v1/collection/pages', headers: { ...headers, 'content-type': 'image/png', 'idempotency-key': randomUUID() }, payload: first.bytes })).json();
    const secondPage = await page(), answer = await page(), readingPage = await page();
    const subjectId = randomUUID(), sourceId = randomUUID(), readingId = randomUUID();
    await source.app.inject({ method: 'PUT', url: `/api/v1/admin/subjects/${subjectId}`, headers: sourceParent, payload: { name: '综合实践' } });
    await source.app.inject({ method: 'PUT', url: `/api/v1/admin/sources/${sourceId}`, headers: sourceParent, payload: { operationId: randomUUID(), expectedRevision: 0, name: '自编练习', active: false } });
    await source.app.inject({ method: 'PUT', url: `/api/v1/collection/reading-materials/${readingId}`, headers, payload: { operationId: randomUUID(), expectedRevision: 0, title: '共同原文', parts: [{ id: randomUUID(), pageId: readingPage.id, region: whole }] } });
    const cfg = { provider: 'xfyun', name: '测试边界', enabled: true, language: 'CHN_ENG', handwriting: true, formulas: false, timeoutSeconds: 5, retries: 0, monthlyLimit: 20, monthlyBudgetCents: 100, priceCents: 3.5 };
    await source.app.inject({ method: 'PUT', url: '/api/v1/admin/ocr', headers: sourceParent, payload: { operationId: randomUUID(), expectedRevision: 0, config: cfg, credentials: { appId: 'sample', apiKey: 'apikeyXXXXXXXXXXXXXXXXXXXXXXXXXX', secretKey: 'apisecretXXXXXXXXXXXXXXXXXXXXXXX' } } });
    const runId = randomUUID(), pageId = first.question.originalPage.id;
    await source.app.inject({ method: 'PUT', url: `/api/v1/collection/pages/${pageId}/recognitions/${runId}`, headers });
    let run;
    for (let i = 0; i < 100; i++) { run = (await source.app.inject({ url: `/api/v1/collection/pages/${pageId}/recognitions/${runId}`, headers })).json(); if (run.status !== 'running') break; await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.equal(run.status, 'succeeded');
    // Select the source while active, then retain it after deactivation.
    await source.app.inject({ method: 'PUT', url: `/api/v1/admin/sources/${sourceId}`, headers: sourceParent, payload: { operationId: randomUUID(), expectedRevision: 1, name: '自编练习', active: true } });
    const fields = { state: 'collected', subjectId, sourceId, region: whole, pageNumber: '12', questionNumber: '4', note: '从另页开始读', readingMaterialId: readingId };
    const changed = await source.app.inject({ method: 'PUT', url: `/api/v1/collection/questions/${first.question.id}`, headers, payload: { ...fields, region: { x: .1, y: .2, width: .7, height: .6 }, operationId: randomUUID(), expectedRevision: first.question.revision,
      parts: [{ id: randomUUID(), pageId: secondPage.id, region: { x: .1, y: .2, width: .7, height: .6 }, transcription: '第二页在前' }, { id: first.question.parts[0].id, pageId, region: whole, transcription: '人工更正 12 × 3 = ?', recognition: { runId, candidateId: run.candidates[0].id } }] } });
    assert.equal(changed.statusCode, 200, changed.body);
    const answered = await source.app.inject({ method: 'PUT', url: `/api/v1/collection/questions/${first.question.id}/answers`, headers, payload: { operationId: randomUUID(), expectedRevision: changed.json().revision, parts: [{ id: randomUUID(), pageId: answer.id, region: whole }] } });
    assert.equal(answered.statusCode, 200, answered.body);
    const other = await source.app.inject({ method: 'POST', url: `/api/v1/collection/pages/${pageId}/questions`, headers, payload: { ...fields, subjectId: 'math', operationId: randomUUID(), studyStage: { schoolYear: null, grade: null, term: null } } });
    assert.equal(other.statusCode, 201, other.body);
    await source.app.inject({ method: 'PUT', url: `/api/v1/admin/sources/${sourceId}`, headers: sourceParent, payload: { operationId: randomUUID(), expectedRevision: 2, name: '自编练习（旧）', active: false } });
    const pack = await exported(source, sourceParent), id = randomUUID();
    const previewResponse = await upload(target, targetParent, id, pack); assert.equal(previewResponse.statusCode, 200, previewResponse.body);
    const preview = previewResponse.json(); assert.deepEqual(preview.blockers, []); assert.equal(preview.added, 2);
    assert.ok(preview.subjects.some((s: any) => s.name === '综合实践' && s.action === 'new'));
    const settingsBefore = await Promise.all(['ocr', 'speech', 'ai'].map(async name => (await target.app.inject({ url: `/api/v1/admin/${name}`, headers: targetParent })).json()));
    assert.ok(settingsBefore.every(s => s.config.enabled === false));
    const result = await confirm(target, targetParent, id, preview.token); assert.equal(result.statusCode, 200, result.body);
    const restored = (await target.app.inject({ url: '/api/v1/collection/questions?state=collected', headers: auth(target.first.token) })).json().items;
    const q = restored.find((q: any) => q.parts.length === 2), otherQ = restored.find((q: any) => q.parts.length === 1);
    assert.deepEqual(q.parts.map((p: any) => p.region), [{ x: .1, y: .2, width: .7, height: .6 }, whole]);
    assert.equal(q.parts[0].transcription, '第二页在前'); assert.equal(q.parts[1].transcription, '人工更正 12 × 3 = ?');
    assert.equal(q.answerParts.length, 1); assert.deepEqual(q.answerParts[0].region, whole);
    assert.equal(q.readingMaterial.id, otherQ.readingMaterial.id); assert.equal(q.readingMaterial.title, '共同原文'); assert.equal(q.readingMaterial.referenceCount, 2);
    assert.equal(q.source, '自编练习（旧）'); assert.equal(q.collectedAt, first.question.collectedAt); assert.equal(q.pageNumber, '12');
    assert.deepEqual(q.studyStage, first.question.studyStage); assert.deepEqual(otherQ.studyStage, { schoolYear: null, grade: null, term: null });
    for (const p of [...q.parts, ...q.answerParts, ...q.readingMaterial.parts]) assert.deepEqual((await target.app.inject({ url: `/api/v1/collection/pages/${p.originalPage.id}/original`, headers: auth(target.first.token) })).rawPayload, first.bytes);
    const importedRun = (await target.app.inject({ url: `/api/v1/collection/pages/${q.parts[1].originalPage.id}/recognitions/${q.parts[1].recognition.runId}`, headers: auth(target.first.token) })).json();
    assert.equal(importedRun.lines[0].text, '1. 计算 12 × 3 ='); assert.equal(importedRun.provider, 'imported'); assert.equal(importedRun.attempts, 0);
    assert.equal(importedRun.candidates[0].id, q.parts[1].recognition.candidateId);
    const again = (await upload(target, targetParent, randomUUID(), pack)).json(); assert.equal(again.skipped, 2); assert.deepEqual(again.blockers, []);
    assert.deepEqual(await Promise.all(['ocr', 'speech', 'ai'].map(async name => (await target.app.inject({ url: `/api/v1/admin/${name}`, headers: targetParent })).json())), settingsBefore);
    assert.equal(supplierCalls, 0);
  } finally { await source.close(); await target.close(); }
});

test('坏包、缺图、未知版本与非法关联不改变原资料；兼容缺少阶段的包保留未设置', async () => {
  const source = await familyFixture(), target = await familyFixture();
  try {
    await sample(source); const current = await sample(target), headers = await parent(target), pack = await exported(source, await parent(source));
    const invalid = [Buffer.from('not a zip'), pack.subarray(0, pack.length - 10),
      await repack(pack, (_files, _data, manifest) => { manifest.version = 999; }),
      await repack(pack, (files, data) => { files.delete(data.pages[0].path); }),
      await repack(pack, (_files, data) => { data.questions[0].parts[0].pageId = randomUUID(); }),
      await repack(pack, (files, data) => { files.set(data.pages[0].path, Buffer.from('invalid image')); }),
      await repack(pack, (_files, data) => { data.questions[0].studyStage = { grade: '三年级' }; }),
      await repack(pack, (_files, data, manifest) => {
        data.subjects = [{ id: randomUUID(), name: '同名扩展学科' }, { id: randomUUID(), name: '同名扩展学科' }];
        data.questions[0].subjectId = data.subjects[0].id;
        data.questions.push({ ...data.questions[0], id: randomUUID(), subjectId: data.subjects[1].id }); manifest.questionCount = 2;
      })];
    for (const bytes of invalid) {
      const response = await upload(target, headers, randomUUID(), bytes); assert.equal(response.statusCode, 422, response.body);
      const items = (await target.app.inject({ url: '/api/v1/collection/questions?state=collected', headers: auth(target.first.token) })).json(); assert.equal(items.total, 1); assert.equal(items.items[0].id, current.question.id);
    }
    const defaults = { schoolYear: '2026-2027', grade: '四年级', term: 'first' };
    await target.app.inject({ method: 'PUT', url: '/api/v1/admin/study-settings', headers, payload: { operationId: randomUUID(), expectedRevision: 0, stage: defaults } });
    const legacy = await repack(pack, (_files, data) => { delete data.questions[0].studyStage; }), id = randomUUID();
    const preview = (await upload(target, headers, id, legacy)).json(); assert.deepEqual(preview.stages, [{ schoolYear: null, grade: null, term: null }]);
    const result = await confirm(target, headers, id, preview.token); assert.equal(result.statusCode, 200, result.body);
    const restored = (await target.app.inject({ url: `/api/v1/collection/questions/${result.json().questionIds[0]}`, headers: auth(target.first.token) })).json();
    assert.deepEqual(restored.studyStage, { schoolYear: null, grade: null, term: null });
    assert.deepEqual((await target.app.inject({ url: '/api/v1/admin/study-settings', headers })).json().stage, defaults);
  } finally { await source.close(); await target.close(); }
});

test('已有修改、回收站和同名异源学科阻止整批提交，预览后变化也不能覆盖', async () => {
  const source = await familyFixture(), target = await familyFixture();
  try {
    const first = await sample(source), pack = await exported(source, await parent(source)), headers = await parent(target);
    const id = randomUUID(), preview = (await upload(target, headers, id, pack)).json();
    const result = await confirm(target, headers, id, preview.token); assert.equal(result.statusCode, 200, result.body);
    const qid = result.json().questionIds[0], localHeaders = auth(target.first.token);
    const repeatId = randomUUID(), old = (await upload(target, headers, repeatId, pack)).json(); assert.equal(old.skipped, 1);
    const q = (await target.app.inject({ url: `/api/v1/collection/questions/${qid}`, headers: localHeaders })).json();
    const edited = await target.app.inject({ method: 'PUT', url: `/api/v1/collection/questions/${qid}`, headers: localHeaders, payload: { operationId: randomUUID(), expectedRevision: q.revision, state: q.state, subjectId: q.subjectId, sourceId: q.sourceId, region: q.region, pageNumber: q.pageNumber, questionNumber: q.questionNumber, note: '目标库的新修改' } });
    assert.equal(edited.statusCode, 200, edited.body);
    assert.equal((await confirm(target, headers, repeatId, old.token)).statusCode, 409);
    const changed = (await target.app.inject({ url: `${root}/${repeatId}`, headers })).json(); assert.ok(changed.blockers.some((s: string) => /修改/.test(s)));
    assert.equal((await target.app.inject({ url: `/api/v1/collection/questions/${qid}`, headers: localHeaders })).json().note, '目标库的新修改');
    await target.app.inject({ method: 'PUT', url: `/api/v1/admin/trash/${qid}`, headers, payload: { operationId: randomUUID(), expectedRevision: edited.json().revision, action: 'trash' } });
    const trashed = (await target.app.inject({ url: `${root}/${repeatId}`, headers })).json(); assert.ok(trashed.blockers.some((s: string) => /回收站/.test(s)));
    assert.equal((await confirm(target, headers, repeatId, trashed.token)).statusCode, 409);
    await target.app.inject({ method: 'DELETE', url: `${root}/${repeatId}`, headers });
    const conflicting = await repack(pack, (_files, data) => { data.subjects[0].id = randomUUID(); data.questions[0].subjectId = data.subjects[0].id; data.questions[0].id = randomUUID(); });
    const collisionId = randomUUID(), collision = (await upload(target, headers, collisionId, conflicting)).json();
    assert.ok(collision.blockers.some((s: string) => /学科/.test(s))); assert.equal(collision.subjects[0].action, 'blocked');
    assert.equal((await confirm(target, headers, collisionId, collision.token)).statusCode, 409);
    assert.equal((await target.app.inject({ url: '/api/v1/collection/questions?state=collected', headers: localHeaders })).json().total, 0);
    // An unmodified native record in its original library is also a duplicate, never a new copy.
    const nativeHeaders = await parent(source), native = (await upload(source, nativeHeaders, randomUUID(), pack)).json(); assert.equal(native.skipped, 1); assert.equal(native.added, 0); assert.deepEqual(native.blockers, []);
    assert.equal((await source.app.inject({ url: `/api/v1/collection/questions/${first.question.id}`, headers: auth(source.first.token) })).json().note, '先读清题目');
    const draft = (await source.app.inject({ method: 'POST', url: '/api/v1/collection/drafts', headers: { ...auth(source.first.token), 'content-type': 'image/png', 'idempotency-key': randomUUID() }, payload: first.bytes })).json();
    const colliding = await repack(pack, (_files, data) => { data.questions[0].id = draft.id; });
    const noOverwriteDraft = (await upload(source, nativeHeaders, randomUUID(), colliding)).json();
    assert.ok(noOverwriteDraft.blockers.some((s: string) => /修改|状态/.test(s)), '资料包身份碰撞到现有草稿时，不能预览成新增');
  } finally { await source.close(); await target.close(); }
});

test('真实存储故障整批不可见，修复可重试；授权到期与重启保留成功回执且不重复', async () => {
  const source = await familyFixture(), target = await familyFixture();
  try {
    await sample(source); await sample(source);
    const pack = await exported(source, await parent(source)), headers = await parent(target), id = randomUUID();
    const preview = (await upload(target, headers, id, pack)).json(); assert.equal(preview.added, 2);
    const storage = join(target.dataDir, 'attachments', 'pages');
    await writeFile(storage, 'disk path is not a directory');
    assert.equal((await confirm(target, headers, id, preview.token)).statusCode, 503);
    assert.equal((await target.app.inject({ url: '/api/v1/collection/questions?state=collected', headers: auth(target.first.token) })).json().total, 0);
    await unlink(storage);
    target.advance(6 * 60000);
    assert.equal((await confirm(target, headers, id, preview.token)).statusCode, 403);
    const renewed = await parent(target);
    const success = await confirm(target, renewed, id, preview.token); assert.equal(success.statusCode, 200, success.body);
    assert.equal(success.json().added, 2);
    await target.app.close();
    const restarted = createApp({ dataDir: target.dataDir });
    try {
      const receipt = await restarted.inject({ url: `${root}/${id}`, headers: renewed }); assert.equal(receipt.statusCode, 200, receipt.body); assert.deepEqual(receipt.json(), success.json());
      assert.deepEqual((await restarted.inject({ method: 'POST', url: `${root}/${id}/confirm`, headers: renewed, payload: { previewToken: preview.token } })).json(), success.json());
      assert.equal((await restarted.inject({ url: '/api/v1/collection/questions?state=collected', headers: auth(target.first.token) })).json().total, 2);
      assert.deepEqual(await readdir(join(target.dataDir, 'import-work')), []);
    } finally { await restarted.close(); }
  } finally { await source.close(); await target.close(); }
});
