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
const decide = (f: Family, headers: ReturnType<typeof auth>, id: string, token: string, decisions: unknown) => f.app.inject({ method: 'PUT', url: `${root}/${id}/decisions`, headers, payload: { previewToken: token, decisions } });
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
    const material = preview.questions[0].incoming.material;
    const pictureUrl = `${root}/${id}/pages/${material.pageId}/preview`;
    assert.equal((await target.app.inject({ url: pictureUrl })).statusCode, 401);
    assert.equal((await target.app.inject({ url: pictureUrl, headers: auth(target.first.token) })).statusCode, 403);
    const picture = await target.app.inject({ url: pictureUrl, headers }); assert.equal(picture.statusCode, 200, picture.body);
    const meta = await sharp(picture.rawPayload).metadata(); assert.equal(meta.width, 120); assert.equal(meta.height, 180);
    assert.equal((await target.app.inject({ url: '/api/v1/collection/questions?state=collected', headers: auth(target.first.token) })).json().total, 0, '预览不能暴露资料');
    const payload = { previewToken: preview.token };
    const applied = await target.app.inject({ method: 'POST', url: `${root}/${id}/confirm`, headers, payload });
    assert.equal(applied.statusCode, 200, applied.body); assert.equal(applied.json().status, 'complete');
    assert.equal((await target.app.inject({ url: pictureUrl, headers })).statusCode, 404, '完成后不再提供暂存包图片');
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
    // The public APIs preserve uppercase UUIDs; an unmodified export must still round-trip.
    const subjectId = randomUUID().toUpperCase(), sourceId = randomUUID().toUpperCase(), readingId = randomUUID().toUpperCase();
    await source.app.inject({ method: 'PUT', url: `/api/v1/admin/subjects/${subjectId}`, headers: sourceParent, payload: { name: '综合实践' } });
    await source.app.inject({ method: 'PUT', url: `/api/v1/admin/sources/${sourceId}`, headers: sourceParent, payload: { operationId: randomUUID(), expectedRevision: 0, name: '自编练习', active: false } });
    await source.app.inject({ method: 'PUT', url: `/api/v1/collection/reading-materials/${readingId}`, headers, payload: { operationId: randomUUID(), expectedRevision: 0, title: '共同原文', parts: [{ id: randomUUID(), pageId: readingPage.id, region: whole }] } });
    const cfg = { provider: 'xfyun', name: '测试边界', enabled: true, language: 'CHN_ENG', handwriting: true, formulas: false, timeoutSeconds: 5, retries: 0, monthlyLimit: 20, monthlyBudgetCents: 100, priceCents: 3.5 };
    await source.app.inject({ method: 'PUT', url: '/api/v1/admin/ocr', headers: sourceParent, payload: { operationId: randomUUID(), expectedRevision: 0, config: cfg, credentials: { appId: 'sample', apiKey: 'apikeyXXXXXXXXXXXXXXXXXXXXXXXXXX', secretKey: 'apisecretXXXXXXXXXXXXXXXXXXXXXXX' } } });
    const runId = randomUUID().toUpperCase(), pageId = first.question.originalPage.id;
    await source.app.inject({ method: 'PUT', url: `/api/v1/collection/pages/${pageId}/recognitions/${runId}`, headers });
    let run;
    for (let i = 0; i < 100; i++) { run = (await source.app.inject({ url: `/api/v1/collection/pages/${pageId}/recognitions/${runId}`, headers })).json(); if (run.status !== 'running') break; await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.equal(run.status, 'succeeded');
    const unusedRunId = randomUUID();
    await source.app.inject({ method: 'PUT', url: `/api/v1/collection/pages/${pageId}/recognitions/${unusedRunId}`, headers });
    for (let i = 0; i < 100; i++) {
      const unused = (await source.app.inject({ url: `/api/v1/collection/pages/${pageId}/recognitions/${unusedRunId}`, headers })).json();
      if (unused.status !== 'running') { assert.equal(unused.status, 'succeeded'); break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    // Select the source while active, then retain it after deactivation.
    await source.app.inject({ method: 'PUT', url: `/api/v1/admin/sources/${sourceId}`, headers: sourceParent, payload: { operationId: randomUUID(), expectedRevision: 1, name: '自编练习', active: true } });
    const fields = { state: 'collected', subjectId, sourceId, region: whole, pageNumber: '12', questionNumber: '4', note: '从另页开始读', readingMaterialId: readingId };
    const changed = await source.app.inject({ method: 'PUT', url: `/api/v1/collection/questions/${first.question.id}`, headers, payload: { ...fields, region: { x: .1, y: .2, width: .7, height: .6 }, operationId: randomUUID(), expectedRevision: first.question.revision,
      parts: [{ id: randomUUID().toUpperCase(), pageId: secondPage.id, region: { x: .1, y: .2, width: .7, height: .6 }, transcription: '第二页在前' }, { id: first.question.parts[0].id, pageId, region: whole, transcription: '人工更正 12 × 3 = ?', recognition: { runId, candidateId: run.candidates[0].id } }] } });
    assert.equal(changed.statusCode, 200, changed.body);
    const answered = await source.app.inject({ method: 'PUT', url: `/api/v1/collection/questions/${first.question.id}/answers`, headers, payload: { operationId: randomUUID(), expectedRevision: changed.json().revision, parts: [{ id: randomUUID(), pageId: answer.id, region: whole }] } });
    assert.equal(answered.statusCode, 200, answered.body);
    const other = await source.app.inject({ method: 'POST', url: `/api/v1/collection/pages/${pageId}/questions`, headers, payload: { ...fields, subjectId: 'math', operationId: randomUUID(), studyStage: { schoolYear: null, grade: null, term: null } } });
    assert.equal(other.statusCode, 201, other.body);
    await source.app.inject({ method: 'PUT', url: `/api/v1/admin/sources/${sourceId}`, headers: sourceParent, payload: { operationId: randomUUID(), expectedRevision: 2, name: '自编练习（旧）', active: false } });
    const pack = await exported(source, sourceParent), id = randomUUID();
    const previewResponse = await upload(target, targetParent, id, pack); assert.equal(previewResponse.statusCode, 200, previewResponse.body);
    assert.equal(previewResponse.json().subjects.find((s: any) => s.id === subjectId).action, 'blocked');
    const mapped = await decide(target, targetParent, id, previewResponse.json().token, { questions: [], subjects: [{ id: subjectId, newName: '综合实践' }] });
    assert.equal(mapped.statusCode, 200, mapped.body);
    const preview = mapped.json(); assert.deepEqual(preview.blockers, []); assert.equal(preview.added, 2);
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
    assert.equal((await target.app.inject({ url: `/api/v1/collection/pages/${q.parts[1].originalPage.id}/recognitions`, headers: auth(target.first.token) })).json().runs.length, 2, '保留页面上未被题目采用的识别记录');
    const again = (await upload(target, targetParent, randomUUID(), pack)).json(); assert.equal(again.skipped, 2); assert.deepEqual(again.blockers, []);
    assert.deepEqual(await Promise.all(['ocr', 'speech', 'ai'].map(async name => (await target.app.inject({ url: `/api/v1/admin/${name}`, headers: targetParent })).json())), settingsBefore);
    assert.equal(supplierCalls, 0);
    const peer = (await target.login('另一台设备')).json(), reading = q.readingMaterial;
    const localSource = (await target.app.inject({ url: '/api/v1/admin/sources', headers: targetParent })).json().find((s: any) => s.id === q.sourceId);
    assert.equal((await target.app.inject({ method: 'PUT', url: `/api/v1/admin/sources/${q.sourceId}`, headers: targetParent, payload: { operationId: randomUUID(), expectedRevision: localSource.revision, name: '本机已更正的来源', active: false } })).statusCode, 200);
    const matchingSourceId = randomUUID();
    assert.equal((await target.app.inject({ method: 'PUT', url: `/api/v1/admin/sources/${matchingSourceId}`, headers: targetParent, payload: { operationId: randomUUID(), expectedRevision: 0, name: '自编练习（旧）', active: true } })).statusCode, 200);
    const update = await target.app.inject({ method: 'PUT', url: `/api/v1/collection/reading-materials/${reading.id}`, headers: auth(peer.token), payload: { operationId: randomUUID(), expectedRevision: reading.revision, title: '本机已经更正的原文', parts: reading.parts.map((p: any) => ({ id: p.id, pageId: p.originalPage.id, region: p.region })) } });
    assert.equal(update.statusCode, 200, update.body);
    // A shared material change affects both questions even when their own revisions did not change.
    const copyId = randomUUID(), conflicts = (await upload(target, targetParent, copyId, pack)).json();
    assert.equal(conflicts.conflicts, 2);
    const choices = await decide(target, targetParent, copyId, conflicts.token, { questions: [{ id: first.question.id, action: 'copy' }], subjects: [] });
    assert.equal(choices.statusCode, 200, choices.body);
    const copied = await confirm(target, targetParent, copyId, choices.json().token); assert.equal(copied.statusCode, 200, copied.body); assert.equal(copied.json().copied, 1);
    const copy = (await target.app.inject({ url: `/api/v1/collection/questions/${copied.json().questionIds[0]}`, headers: auth(peer.token) })).json();
    assert.equal(copy.parts[0].transcription, '第二页在前'); assert.equal(copy.answerParts.length, 1); assert.equal(copy.readingMaterial.title, '共同原文');
    assert.equal(copy.sourceId, matchingSourceId); assert.equal(copy.source, '自编练习（旧）');
    assert.notEqual(copy.readingMaterial.id, reading.id); assert.deepEqual(copy.studyStage, q.studyStage); assert.equal(copy.collectedAt, q.collectedAt);
    for (const p of [...copy.parts, ...copy.answerParts, ...copy.readingMaterial.parts]) assert.deepEqual((await target.app.inject({ url: `/api/v1/collection/pages/${p.originalPage.id}/original`, headers: auth(peer.token) })).rawPayload, first.bytes);
    assert.equal((await target.app.inject({ url: `/api/v1/collection/questions/${q.id}`, headers: auth(peer.token) })).json().readingMaterial.title, '本机已经更正的原文');
    const nextId = randomUUID(), next = (await upload(target, targetParent, nextId, pack)).json();
    assert.equal(next.skipped, 1); assert.equal(next.conflicts, 1, '已有共享原文副本时，另一个原题仍需核对本机已改的原文');
    const otherChoice = await decide(target, targetParent, nextId, next.token, { questions: [{ id: other.json().id, action: 'copy' }], subjects: [] });
    assert.equal(otherChoice.statusCode, 200, otherChoice.body);
    const both = await confirm(target, targetParent, nextId, otherChoice.json().token); assert.equal(both.statusCode, 200, both.body);
    const all = (await target.app.inject({ url: '/api/v1/collection/questions?state=collected', headers: auth(peer.token) })).json(); assert.equal(all.total, 4);
    assert.equal(all.items.filter((q: any) => q.readingMaterial.id === copy.readingMaterial.id).length, 2);
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

test('已有修改和回收站明确分类，未对应学科及陈旧预览不能静默提交', async () => {
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
    const changed = (await target.app.inject({ url: `${root}/${repeatId}`, headers })).json(); assert.equal(changed.conflicts, 1); assert.equal(changed.kept, 1);
    assert.equal((await target.app.inject({ url: `/api/v1/collection/questions/${qid}`, headers: localHeaders })).json().note, '目标库的新修改');
    await target.app.inject({ method: 'PUT', url: `/api/v1/admin/trash/${qid}`, headers, payload: { operationId: randomUUID(), expectedRevision: edited.json().revision, action: 'trash' } });
    const trashed = (await target.app.inject({ url: `${root}/${repeatId}`, headers })).json(); assert.equal(trashed.trashed, 1); assert.equal(trashed.kept, 1);
    assert.equal((await confirm(target, headers, repeatId, trashed.token)).statusCode, 200);
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
    assert.equal(noOverwriteDraft.kept, 1, '资料包身份碰撞到现有草稿时，不能预览成新增'); assert.equal(noOverwriteDraft.added, 0);
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

test('导入修改冲突默认保留当前版本；明确另存副本且重导同版本不重复', async () => {
  const source = await familyFixture(), target = await familyFixture();
  try {
    const original = await sample(source), pack = await exported(source, await parent(source)), headers = await parent(target);
    const firstId = randomUUID(), first = (await upload(target, headers, firstId, pack)).json();
    const saved = (await confirm(target, headers, firstId, first.token)).json();
    const qid = saved.questionIds[0], peer = (await target.login('第二设备')).json();
    const local = (await target.app.inject({ url: `/api/v1/collection/questions/${qid}`, headers: auth(peer.token) })).json();
    const edit = await target.app.inject({ method: 'PUT', url: `/api/v1/collection/questions/${qid}`, headers: auth(peer.token), payload: {
      operationId: randomUUID(), expectedRevision: local.revision, state: local.state, subjectId: local.subjectId, sourceId: local.sourceId,
      region: local.region, pageNumber: local.pageNumber, questionNumber: local.questionNumber, note: '本机新的思考'
    } });
    assert.equal(edit.statusCode, 200, edit.body);
    const keepId = randomUUID(), keep = (await upload(target, headers, keepId, pack)).json();
    assert.equal(keep.conflicts, 1); assert.equal(keep.kept, 1); assert.deepEqual(keep.blockers, []);
    assert.equal(keep.questions[0].action, 'keep'); assert.equal(keep.questions[0].current.note, '本机新的思考');
    const kept = await confirm(target, headers, keepId, keep.token); assert.equal(kept.statusCode, 200, kept.body); assert.equal(kept.json().kept, 1);
    const copyId = randomUUID(), preview = (await upload(target, headers, copyId, pack)).json();
    const choice = await decide(target, headers, copyId, preview.token, { questions: [{ id: original.question.id, action: 'copy' }], subjects: [] });
    assert.equal(choice.statusCode, 200, choice.body); assert.equal(choice.json().copied, 1);
    const applied = await confirm(target, headers, copyId, choice.json().token); assert.equal(applied.statusCode, 200, applied.body);
    assert.equal(applied.json().copied, 1); assert.equal(applied.json().added, 0);
    assert.deepEqual((await confirm(target, headers, copyId, choice.json().token)).json(), applied.json());
    const all = (await target.app.inject({ url: '/api/v1/collection/questions?state=collected', headers: auth(peer.token) })).json();
    assert.equal(all.total, 2); assert.equal(all.items.find((q: any) => q.id === qid).note, '本机新的思考');
    const copied = all.items.find((q: any) => q.id !== qid); assert.equal(copied.note, original.question.note);
    assert.equal(copied.importedFrom.questionId, original.question.id); assert.equal(copied.importedFrom.libraryId, original.question.libraryId);
    assert.equal(copied.importedFrom.copy, true); assert.equal(copied.importedFrom.revision, original.question.revision);
    assert.equal(copied.collectedAt, original.question.collectedAt); assert.deepEqual(copied.studyStage, original.question.studyStage);
    const againId = randomUUID(), again = (await upload(target, headers, againId, pack)).json();
    assert.equal(again.skipped, 1); assert.equal(again.copied, 0); assert.deepEqual(again.blockers, []);
    assert.equal((await confirm(target, headers, againId, again.token)).statusCode, 200);
    assert.equal((await target.app.inject({ url: '/api/v1/collection/questions?state=collected', headers: auth(peer.token) })).json().total, 2);
    const changedCopy = await target.app.inject({ method: 'PUT', url: `/api/v1/collection/questions/${copied.id}`, headers: auth(peer.token), payload: { operationId: randomUUID(), expectedRevision: copied.revision, state: copied.state, subjectId: copied.subjectId, sourceId: copied.sourceId, region: copied.region, pageNumber: copied.pageNumber, questionNumber: copied.questionNumber, note: '副本也继续整理了' } });
    assert.equal(changedCopy.statusCode, 200, changedCopy.body);
    const editedId = randomUUID(), editedCopy = (await upload(target, headers, editedId, pack)).json();
    assert.equal(editedCopy.kept, 1); assert.equal(editedCopy.questions[0].canCopy, false);
    const unsupported = await decide(target, headers, editedId, editedCopy.token, { questions: [{ id: original.question.id, action: 'copy' }], subjects: [] });
    assert.equal((await confirm(target, headers, editedId, unsupported.json().token)).statusCode, 409, '不能因副本后续修改而反复创建同版本副本');
    await target.app.inject({ method: 'DELETE', url: `${root}/${editedId}`, headers });
    const originalQ = original.question;
    const changedSource = await source.app.inject({ method: 'PUT', url: `/api/v1/collection/questions/${originalQ.id}`, headers: auth(source.first.token), payload: { operationId: randomUUID(), expectedRevision: originalQ.revision, state: originalQ.state, subjectId: originalQ.subjectId, sourceId: originalQ.sourceId, region: originalQ.region, pageNumber: originalQ.pageNumber, questionNumber: originalQ.questionNumber, note: '来源的新版本' } });
    assert.equal(changedSource.statusCode, 200, changedSource.body);
    const newer = await exported(source, await parent(source)), newId = randomUUID(), newPreview = (await upload(target, headers, newId, newer)).json();
    assert.equal(newPreview.questions[0].canCopy, true);
    const newChoice = await decide(target, headers, newId, newPreview.token, { questions: [{ id: originalQ.id, action: 'copy' }], subjects: [] });
    assert.equal((await confirm(target, headers, newId, newChoice.json().token)).statusCode, 200);
    const versions = (await target.app.inject({ url: '/api/v1/collection/questions?state=collected', headers: auth(peer.token) })).json(); assert.equal(versions.total, 3);
    assert.ok(versions.items.some((q: any) => q.note === '副本也继续整理了')); assert.ok(versions.items.some((q: any) => q.note === '来源的新版本'));
  } finally { await source.close(); await target.close(); }
});

test('回收站同源题默认保持删除，明确恢复保留回收站当前内容和关联', async () => {
  const source = await familyFixture(), target = await familyFixture();
  try {
    const original = await sample(source), headers = await parent(target), pack = await exported(source, await parent(source));
    const firstId = randomUUID(), first = (await upload(target, headers, firstId, pack)).json();
    const qid = (await confirm(target, headers, firstId, first.token)).json().questionIds[0];
    const q = (await target.app.inject({ url: `/api/v1/collection/questions/${qid}`, headers: auth(target.first.token) })).json();
    const changed = (await target.app.inject({ method: 'PUT', url: `/api/v1/collection/questions/${qid}`, headers: auth(target.first.token), payload: { operationId: randomUUID(), expectedRevision: q.revision, state: q.state, subjectId: q.subjectId, sourceId: q.sourceId, region: q.region, pageNumber: q.pageNumber, questionNumber: q.questionNumber, note: '删除前已经更正' } })).json();
    const deletion = await target.app.inject({ method: 'PUT', url: `/api/v1/admin/trash/${qid}`, headers, payload: { operationId: randomUUID(), expectedRevision: changed.revision, action: 'trash' } });
    assert.equal(deletion.statusCode, 200, deletion.body);
    const keepId = randomUUID(), keep = (await upload(target, headers, keepId, pack)).json();
    assert.equal(keep.trashed, 1); assert.equal(keep.kept, 1); assert.equal(keep.questions[0].current.note, '删除前已经更正');
    assert.deepEqual(keep.blockers, []); assert.equal((await confirm(target, headers, keepId, keep.token)).statusCode, 200);
    assert.equal((await target.app.inject({ url: '/api/v1/collection/questions?state=collected', headers: auth(target.first.token) })).json().total, 0);
    const id = randomUUID(), preview = (await upload(target, headers, id, pack)).json();
    assert.equal(preview.questions[0].canRestore, true);
    const chosen = await decide(target, headers, id, preview.token, { questions: [{ id: original.question.id, action: 'restore' }], subjects: [] });
    assert.equal(chosen.statusCode, 200, chosen.body); assert.equal(chosen.json().restored, 1);
    const restored = await confirm(target, headers, id, chosen.json().token); assert.equal(restored.statusCode, 200, restored.body); assert.equal(restored.json().restored, 1);
    assert.deepEqual((await confirm(target, headers, id, chosen.json().token)).json(), restored.json());
    const result = (await target.app.inject({ url: `/api/v1/collection/questions/${qid}`, headers: auth(target.first.token) })).json();
    assert.equal(result.note, '删除前已经更正'); assert.equal(result.collectedAt, original.question.collectedAt); assert.deepEqual(result.studyStage, original.question.studyStage);
    assert.ok(result.revision > deletion.json().revision);
    assert.deepEqual((await target.app.inject({ url: `/api/v1/collection/pages/${result.originalPage.id}/original`, headers: auth(target.first.token) })).rawPayload, original.bytes);
    const againId = randomUUID(), again = (await upload(target, headers, againId, pack)).json();
    assert.equal(again.restored, 0); assert.equal(again.kept, 1); assert.equal((await confirm(target, headers, againId, again.token)).statusCode, 200);
    assert.equal((await target.app.inject({ url: '/api/v1/collection/questions?state=collected', headers: auth(target.first.token) })).json().total, 1);
  } finally { await source.close(); await target.close(); }
});

test('同名异源与未知学科都需确认对应或新增，导入后记住选择并保留实际学习阶段', async () => {
  const source = await familyFixture(), target = await familyFixture();
  try {
    const sourceParent = await parent(source), headers = await parent(target), subjectA = randomUUID(), subjectB = randomUUID(), targetA = randomUUID();
    for (const [id, name] of [[subjectA, '综合实践'], [subjectB, '信息技术']]) assert.equal((await source.app.inject({ method: 'PUT', url: `/api/v1/admin/subjects/${id}`, headers: sourceParent, payload: { name } })).statusCode, 200);
    assert.equal((await target.app.inject({ method: 'PUT', url: `/api/v1/admin/subjects/${targetA}`, headers, payload: { name: '综合实践' } })).statusCode, 200);
    for (const subjectId of [subjectA, subjectB]) {
      const { question: q } = await sample(source);
      assert.equal((await source.app.inject({ method: 'PUT', url: `/api/v1/collection/questions/${q.id}`, headers: auth(source.first.token), payload: { operationId: randomUUID(), expectedRevision: q.revision, state: q.state, subjectId, sourceId: q.sourceId, region: q.region, pageNumber: q.pageNumber, questionNumber: q.questionNumber, note: q.note } })).statusCode, 200);
    }
    const settingsBefore = (await target.app.inject({ url: '/api/v1/admin/study-settings', headers })).json(), pack = await exported(source, sourceParent), id = randomUUID();
    const preview = (await upload(target, headers, id, pack)).json();
    assert.equal(preview.subjects.filter((s: any) => s.action === 'blocked').length, 2);
    assert.equal((await confirm(target, headers, id, preview.token)).statusCode, 409);
    const choice = await decide(target, headers, id, preview.token, { questions: [], subjects: [{ id: subjectA, targetId: targetA }, { id: subjectB, newName: '信息科技' }] });
    assert.equal(choice.statusCode, 200, choice.body); assert.deepEqual(choice.json().blockers, []);
    const result = await confirm(target, headers, id, choice.json().token); assert.equal(result.statusCode, 200, result.body); assert.equal(result.json().added, 2);
    const items = (await target.app.inject({ url: '/api/v1/collection/questions?state=collected', headers: auth(target.first.token) })).json().items;
    assert.equal(items.filter((q: any) => q.subjectId === targetA).length, 1);
    const options = (await target.app.inject({ url: '/api/v1/collection/subjects', headers: auth(target.first.token) })).json();
    assert.ok(options.some((s: any) => s.name === '信息科技')); assert.equal(options.filter((s: any) => s.name === '综合实践').length, 1);
    assert.ok(items.every((q: any) => q.studyStage.grade === '三年级'));
    assert.deepEqual((await target.app.inject({ url: '/api/v1/admin/study-settings', headers })).json(), settingsBefore);
    const again = (await upload(target, headers, randomUUID(), pack)).json(); assert.equal(again.skipped, 2); assert.deepEqual(again.blockers, []);
  } finally { await source.close(); await target.close(); }
});

test('选择回执丢失可安全重试，另一会话更新后旧选择失效并重新核对', async () => {
  const source = await familyFixture(), target = await familyFixture();
  try {
    const original = await sample(source), pack = await exported(source, await parent(source)), headers = await parent(target);
    const firstId = randomUUID(), first = (await upload(target, headers, firstId, pack)).json();
    const qid = (await confirm(target, headers, firstId, first.token)).json().questionIds[0], peer = (await target.login('另一设备')).json();
    const edit = async (note: string) => {
      const q = (await target.app.inject({ url: `/api/v1/collection/questions/${qid}`, headers: auth(peer.token) })).json();
      const response = await target.app.inject({ method: 'PUT', url: `/api/v1/collection/questions/${qid}`, headers: auth(peer.token), payload: { operationId: randomUUID(), expectedRevision: q.revision, state: q.state, subjectId: q.subjectId, sourceId: q.sourceId, region: q.region, pageNumber: q.pageNumber, questionNumber: q.questionNumber, note } });
      assert.equal(response.statusCode, 200, response.body);
    };
    await edit('第一次修改');
    const id = randomUUID(), preview = (await upload(target, headers, id, pack)).json(), choices = { questions: [{ id: original.question.id, action: 'copy' }], subjects: [] };
    const selected = await decide(target, headers, id, preview.token, choices); assert.equal(selected.statusCode, 200, selected.body);
    const retry = await decide(target, headers, id, preview.token, choices); assert.equal(retry.statusCode, 200, retry.body); assert.equal(retry.json().token, selected.json().token);
    await edit('另一设备再次修改');
    assert.equal((await confirm(target, headers, id, selected.json().token)).statusCode, 409);
    const refreshed = (await target.app.inject({ url: `${root}/${id}`, headers })).json();
    assert.equal(refreshed.choicesReset, true); assert.equal(refreshed.copied, 0); assert.equal(refreshed.kept, 1);
    assert.equal(refreshed.questions[0].current.note, '另一设备再次修改');
    assert.equal((await decide(target, headers, id, preview.token, choices)).statusCode, 409);
    const reselected = await decide(target, headers, id, refreshed.token, choices); assert.equal(reselected.statusCode, 200, reselected.body);
    const result = await confirm(target, headers, id, reselected.json().token); assert.equal(result.statusCode, 200, result.body);
    const all = (await target.app.inject({ url: '/api/v1/collection/questions?state=collected', headers: auth(peer.token) })).json(); assert.equal(all.total, 2); assert.equal(all.items.find((q: any) => q.id === qid).note, '另一设备再次修改');
  } finally { await source.close(); await target.close(); }
});

test('来源大小写不同时复用本机来源名称与停用状态，重复导入不产生假冲突', async () => {
  const source = await familyFixture(), target = await familyFixture();
  try {
    const sourceParent = await parent(source), headers = await parent(target), sourceId = randomUUID(), targetId = randomUUID();
    for (const [f, grant, id, name, active] of [[source, sourceParent, sourceId, 'Workbook', true], [target, headers, targetId, 'workbook', false]] as const) {
      const result = await f.app.inject({ method: 'PUT', url: `/api/v1/admin/sources/${id}`, headers: grant, payload: { operationId: randomUUID(), expectedRevision: 0, name, active } });
      assert.equal(result.statusCode, 200, result.body);
    }
    const { question: q } = await sample(source);
    assert.equal((await source.app.inject({ method: 'PUT', url: `/api/v1/collection/questions/${q.id}`, headers: auth(source.first.token), payload: { operationId: randomUUID(), expectedRevision: q.revision, state: q.state, subjectId: q.subjectId, sourceId, region: q.region, pageNumber: q.pageNumber, questionNumber: q.questionNumber, note: q.note } })).statusCode, 200);
    const pack = await exported(source, sourceParent), id = randomUUID();
    const preview = (await upload(target, headers, id, pack)).json();
    assert.deepEqual(preview.blockers, []); assert.equal(preview.added, 1);
    const applied = await confirm(target, headers, id, preview.token); assert.equal(applied.statusCode, 200, applied.body);
    const items = (await target.app.inject({ url: '/api/v1/collection/questions?state=collected', headers: auth(target.first.token) })).json();
    assert.equal(items.total, 1); assert.equal(items.items[0].sourceId, targetId); assert.equal(items.items[0].source, 'workbook');
    const options = (await target.app.inject({ url: '/api/v1/admin/sources', headers })).json();
    assert.deepEqual(options.filter((s: any) => s.name.toLowerCase() === 'workbook'), [{ id: targetId, name: 'workbook', active: false, revision: 1 }]);
    const againId = randomUUID(), again = (await upload(target, headers, againId, pack)).json();
    assert.equal(again.skipped, 1); assert.equal(again.conflicts, 0);
    assert.equal((await confirm(target, headers, againId, again.token)).statusCode, 200);
  } finally { await source.close(); await target.close(); }
});

test('恢复选择在 30 天期限跨过后失效，永久删除的同源记录不会重建', async () => {
  const source = await familyFixture(), target = await familyFixture();
  try {
    const original = await sample(source), pack = await exported(source, await parent(source)), headers = await parent(target);
    const firstId = randomUUID(), first = (await upload(target, headers, firstId, pack)).json();
    const qid = (await confirm(target, headers, firstId, first.token)).json().questionIds[0];
    const q = (await target.app.inject({ url: `/api/v1/collection/questions/${qid}`, headers: auth(target.first.token) })).json();
    const deletion = (await target.app.inject({ method: 'PUT', url: `/api/v1/admin/trash/${qid}`, headers, payload: { operationId: randomUUID(), expectedRevision: q.revision, action: 'trash' } })).json();
    target.advance(30 * 86400000 - 10 * 60000);
    const peer = (await target.login('新登录设备')).json();
    const unlock = async () => auth(peer.token, (await target.app.inject({ method: 'POST', url: '/api/v1/admin/grants', headers: auth(peer.token), payload: { password } })).json().token);
    let renewed = await unlock();
    const id = randomUUID(), before = (await upload(target, renewed, id, pack)).json(); assert.equal(before.questions[0].canRestore, true);
    const selected = (await decide(target, renewed, id, before.token, { questions: [{ id: original.question.id, action: 'restore' }], subjects: [] })).json(); assert.equal(selected.restored, 1);
    target.advance(11 * 60000); renewed = await unlock();
    assert.equal((await confirm(target, renewed, id, selected.token)).statusCode, 409);
    const after = (await target.app.inject({ url: `${root}/${id}`, headers: renewed })).json();
    assert.equal(after.choicesReset, true); assert.equal(after.questions[0].canRestore, false); assert.equal(after.kept, 1);
    assert.equal((await confirm(target, renewed, id, after.token)).statusCode, 200);
    assert.equal((await target.app.inject({ method: 'PUT', url: `/api/v1/admin/trash/${qid}`, headers: renewed, payload: { operationId: randomUUID(), expectedRevision: deletion.revision, action: 'purge', confirm: true } })).statusCode, 200);
    const purgedId = randomUUID(), purged = (await upload(target, renewed, purgedId, pack)).json();
    assert.equal(purged.questions[0].status, 'deleted'); assert.equal(purged.questions[0].canRestore, false);
    const invalid = await decide(target, renewed, purgedId, purged.token, { questions: [{ id: original.question.id, action: 'restore' }], subjects: [] });
    assert.equal((await confirm(target, renewed, purgedId, invalid.json().token)).statusCode, 409);
    assert.equal((await target.app.inject({ url: '/api/v1/collection/questions?state=collected', headers: auth(peer.token) })).json().total, 0);
  } finally { await source.close(); await target.close(); }
});
