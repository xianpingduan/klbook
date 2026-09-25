import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import sharp from 'sharp';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { auth, familyFixture } from './fixture.ts';
import { ocrParent, finishedOcr } from './ocr-fixture.ts';

const config = { provider: 'xfyun', name: '收集识别', enabled: true, language: 'CHN_ENG', handwriting: true, formulas: false, timeoutSeconds: 5, retries: 0, monthlyLimit: 20, monthlyBudgetCents: 100, priceCents: 3.5 };
const credentials = { appId: 'collect-app', apiKey: 'apikeyXXXXXXXXXXXXXXXXXXXXXXXXXX', secretKey: 'apisecretXXXXXXXXXXXXXXXXXXXXXXX' };
const vendorResult = () => Response.json({ header: { code: 0 }, payload: { result: { encoding: 'utf8', compress: 'raw', format: 'json', text: Buffer.from(JSON.stringify({ pages: [{ exception: 0, lines: [
  { exception: 0, coord: [{ x: 40, y: 100 }, { x: 400, y: 100 }, { x: 400, y: 140 }, { x: 40, y: 140 }], words: [{ content: '1. 计算 12 × 3 =' }] },
  { exception: 0, coord: [{ x: 40, y: 300 }, { x: 450, y: 300 }, { x: 450, y: 340 }, { x: 40, y: 340 }], words: [{ content: '2. 计算 25 + 16 =' }] }
] }] })).toString('base64') } } });

test('收集调用超过最近记录上限后，后台仍保留当前配置的样例测试结果', async () => {
  const f = await familyFixture({ ocrHttp: async () => vendorResult() });
  try {
    const parent = await ocrParent(f), headers = auth(f.first.token);
    await f.app.inject({ method: 'PUT', url: '/api/v1/admin/ocr', headers: parent, payload: { operationId: randomUUID(), expectedRevision: 0, config: { ...config, monthlyLimit: 100, monthlyBudgetCents: 1000 }, credentials } });
    const sampleId = randomUUID();
    const sample = await f.app.inject({ method: 'PUT', url: `/api/v1/admin/ocr/tests/${sampleId}`, headers: parent, payload: { expectedRevision: 1, sample: 'school-v1' } });
    assert.equal(sample.statusCode, 202, sample.body);
    await finishedOcr(f, parent);
    const bytes = await sharp(await readFile(new URL('../fixtures/paper.svg', import.meta.url))).png().toBuffer();
    const draft = (await f.app.inject({ method: 'POST', url: '/api/v1/collection/drafts', headers: { ...headers, 'content-type': 'image/png', 'idempotency-key': randomUUID() }, payload: bytes })).json();
    const pageId = draft.originalPage.id;
    await completed(f, pageId);
    for (let i = 0; i < 20; i++) {
      assert.equal((await f.app.inject({ method: 'PUT', url: `/api/v1/collection/pages/${pageId}/recognitions/${randomUUID()}`, headers })).statusCode, 202);
      await completed(f, pageId);
    }
    const data = (await f.app.inject({ url: '/api/v1/admin/ocr', headers: parent })).json();
    assert.equal(data.tests.length, 20);
    assert.ok(data.tests.every((run: { sample: string }) => run.sample === 'original-page'));
    assert.equal(data.latestSample?.id, sampleId);
    assert.equal(data.latestSample.status, 'succeeded');
    assert.equal(data.usage.attempts, 22);
  } finally { await f.close(); }
});
async function completed(f: Awaited<ReturnType<typeof familyFixture>>, pageId: string) {
  for (let i = 0; i < 250; i++) {
    const response = await f.app.inject({ url: `/api/v1/collection/pages/${pageId}/recognitions`, headers: auth(f.first.token) });
    assert.equal(response.statusCode, 200, response.body);
    const data = response.json();
    if (data.runs[0]?.status !== 'running') return data;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('recognition did not finish');
}

test('升级前的上传即使没有自动识别标记，响应丢失后的重传也不自动调用', async () => {
  let calls = 0;
  const f = await familyFixture({ ocrHttp: async () => { calls++; return vendorResult(); } });
  try {
    const headers = auth(f.first.token), parent = await ocrParent(f);
    const bytes = await sharp(await readFile(new URL('../fixtures/paper.svg', import.meta.url))).png().toBuffer();
    const upload = { method: 'POST' as const, url: '/api/v1/collection/drafts', headers: { ...headers, 'content-type': 'image/png', 'idempotency-key': randomUUID() }, payload: bytes };
    const draft = (await f.app.inject(upload)).json();
    // A schema 11 upload has an operation receipt and original, but no initial recognition marker after upgrade.
    const legacy = new Database(join(f.dataDir, 'family.sqlite'));
    try { legacy.prepare('DELETE FROM initialPageRecognition WHERE pageId = ?').run(draft.originalPage.id); }
    finally { legacy.close(); }
    assert.equal((await f.app.inject({ method: 'PUT', url: '/api/v1/admin/ocr', headers: parent, payload: { operationId: randomUUID(), expectedRevision: 0, config, credentials } })).statusCode, 200);
    const replay = await f.app.inject(upload);
    assert.equal(replay.statusCode, 201); assert.equal(replay.json().id, draft.id);
    const result = await completed(f, draft.originalPage.id);
    assert.equal(calls, 0, '旧上传重传不能因缺少识别标记而自动发送');
    assert.deepEqual(result.runs, []);
    const start = await f.app.inject({ method: 'PUT', url: `/api/v1/collection/pages/${draft.originalPage.id}/recognitions/${randomUUID()}`, headers });
    assert.equal(start.statusCode, 202);
    assert.equal((await completed(f, draft.originalPage.id)).runs[0].status, 'succeeded');
    assert.equal(calls, 1, '仍可由用户明确请求识别旧材料');
  } finally { await f.close(); }
});

test('原图先保存；停用不识别，启用后主动识别历史页，结果跨设备可见且不自动收集', async () => {
  let calls = 0;
  const f = await familyFixture({ ocrHttp: async (_url, init) => {
    calls++;
    const sent = JSON.parse(String(init.body));
    const meta = await sharp(Buffer.from(sent.payload.sf8e6aca1_data_1.image, 'base64')).metadata();
    assert.equal(meta.width, 640); assert.equal(meta.height, 800);
    return vendorResult();
  } });
  try {
    const headers = auth(f.first.token), parent = await ocrParent(f);
    const bytes = await sharp(await readFile(new URL('../fixtures/paper.svg', import.meta.url))).png().toBuffer();
    const upload = { method: 'POST' as const, url: '/api/v1/collection/drafts', headers: { ...headers, 'content-type': 'image/png', 'idempotency-key': randomUUID() }, payload: bytes };
    const response = await f.app.inject(upload); assert.equal(response.statusCode, 201, response.body);
    const draft = response.json(), pageId = draft.originalPage.id;
    const inactive = await completed(f, pageId);
    assert.equal(inactive.service.enabled, false); assert.equal(calls, 0);
    assert.equal((await f.app.inject({ method: 'PUT', url: '/api/v1/admin/ocr', headers: parent, payload: { operationId: randomUUID(), expectedRevision: 0, config, credentials } })).statusCode, 200);
    await completed(f, pageId); assert.equal(calls, 0, '启用和读历史结果不发起识别');
    const id = randomUUID(), url = `/api/v1/collection/pages/${pageId}/recognitions/${id}`;
    const start = await f.app.inject({ method: 'PUT', url, headers }); assert.equal(start.statusCode, 202, start.body);
    const done = await completed(f, pageId);
    assert.equal(done.runs[0].status, 'succeeded'); assert.equal(done.runs[0].pageId, pageId);
    assert.equal(done.runs[0].candidates.length, 2);
    assert.equal(done.runs[0].candidates[0].questionNumber, '1');
    assert.equal(done.runs[0].candidates[0].subjectId, 'math');
    assert.equal(done.runs[0].candidates[0].text, '1. 计算 12 × 3 =');
    assert.equal(calls, 1);
    assert.equal((await f.app.inject({ method: 'PUT', url, headers })).statusCode, 202); assert.equal(calls, 1);
    const other = (await f.login('平板')).json();
    const elsewhere = await f.app.inject({ url: `/api/v1/collection/pages/${pageId}/recognitions`, headers: auth(other.token) });
    assert.equal(elsewhere.json().runs[0].id, id);
    assert.equal((await f.app.inject({ url: '/api/v1/collection/questions?state=collected', headers })).json().total, 0);
    assert.deepEqual((await f.app.inject({ url: `/api/v1/collection/pages/${pageId}/original`, headers })).rawPayload, bytes);
  } finally { await f.close(); }
});

test('新上传页只识别一次；候选经确认后保存更正文字，重试识别不改写已确认内容', async () => {
  let calls = 0;
  const f = await familyFixture({ ocrHttp: async () => { calls++; return vendorResult(); } });
  try {
    const headers = auth(f.first.token), parent = await ocrParent(f);
    await f.app.inject({ method: 'PUT', url: '/api/v1/admin/ocr', headers: parent, payload: { operationId: randomUUID(), expectedRevision: 0, config, credentials } });
    const bytes = await sharp(await readFile(new URL('../fixtures/paper.svg', import.meta.url))).png().toBuffer();
    const upload = { method: 'POST' as const, url: '/api/v1/collection/drafts', headers: { ...headers, 'content-type': 'image/png', 'idempotency-key': randomUUID() }, payload: bytes };
    const draft = (await f.app.inject(upload)).json();
    const pageId = draft.originalPage.id, result = await completed(f, pageId), run = result.runs[0];
    assert.equal(run?.status, 'succeeded', JSON.stringify(result)); assert.equal(calls, 1);
    await f.app.inject(upload); assert.equal(calls, 1, '上传响应丢失后不重复识别');
    const candidate = run.candidates[0];
    const region = { x: .02, y: .1, width: .9, height: .2 };
    const parts = [{ id: draft.parts[0].id, pageId, region, transcription: '1. 计算 12 × 3 = 36（已核对）', recognition: { runId: run.id, candidateId: candidate.id } }];
    const saved = await f.app.inject({ method: 'PUT', url: `/api/v1/collection/questions/${draft.id}`, headers, payload: { operationId: randomUUID(), expectedRevision: 1, state: 'collected', region, parts, subjectId: 'math', sourceId: null, pageNumber: '', questionNumber: '1', note: '' } });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(saved.json().parts[0]!.transcription, parts[0]!.transcription);
    assert.deepEqual(saved.json().parts[0]!.recognition, parts[0]!.recognition);
    await f.app.inject({ method: 'PUT', url: `/api/v1/collection/pages/${pageId}/recognitions/${randomUUID()}`, headers });
    await completed(f, pageId); assert.equal(calls, 2);
    const other = (await f.login('手机')).json();
    const reopened = (await f.app.inject({ url: `/api/v1/collection/questions/${draft.id}`, headers: auth(other.token) })).json();
    assert.equal(reopened.revision, 2); assert.equal(reopened.parts[0]!.transcription, parts[0]!.transcription); assert.deepEqual(reopened.parts[0].region, region);
    const original = (await f.app.inject({ url: `/api/v1/collection/pages/${pageId}/recognitions/${run.id}`, headers: auth(other.token) })).json();
    assert.equal(original.candidates[0].text, '1. 计算 12 × 3 =');
    assert.equal((await f.app.inject({ url: '/api/v1/collection/questions?state=collected', headers })).json().total, 1);
  } finally { await f.close(); }
});

test('学习端每次业务识别及重试检查启停和额度；停用保留在途成功并阻止后续重试', async () => {
  let calls = 0, respond: ((value: Response) => void) | undefined;
  const clearResponse = () => { respond = undefined; };
  const f = await familyFixture({ ocrHttp: async () => { calls++; return new Promise(resolve => { respond = resolve; }); } });
  try {
    const headers = auth(f.first.token), parent = await ocrParent(f);
    const bytes = await sharp(await readFile(new URL('../fixtures/paper.svg', import.meta.url))).png().toBuffer();
    const upload = { method: 'POST' as const, url: '/api/v1/collection/drafts', headers: { ...headers, 'content-type': 'image/png', 'idempotency-key': randomUUID() }, payload: bytes };
    const draft = (await f.app.inject(upload)).json(), pageId = draft.originalPage.id;
    const start = () => f.app.inject({ method: 'PUT', url: `/api/v1/collection/pages/${pageId}/recognitions/${randomUUID()}`, headers });
    let revision = 0;
    const save = async (changes: object = {}) => {
      const result = await f.app.inject({ method: 'PUT', url: '/api/v1/admin/ocr', headers: parent, payload: { operationId: randomUUID(), expectedRevision: revision, config: { ...config, ...changes }, credentials } });
      assert.equal(result.statusCode, 200, result.body); revision++;
    };
    assert.equal((await start()).statusCode, 422); assert.equal(calls, 0);
    await save(); await f.app.inject(upload); assert.equal(calls, 0, '启用后重传同一已保存草稿不识别旧页');
    await start();
    for (let i = 0; i < 100 && !respond; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(respond); await save({ enabled: false });
    respond(vendorResult()); clearResponse();
    const done = await completed(f, pageId); assert.equal(done.runs[0].status, 'succeeded');
    assert.equal((await start()).statusCode, 422); assert.equal(calls, 1);
    await save({ retries: 2 }); await start();
    for (let i = 0; i < 100 && !respond; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(respond); await save({ enabled: false });
    respond(new Response(null, { status: 503 })); clearResponse();
    const stopped = await completed(f, pageId); assert.equal(stopped.runs[0].status, 'stopped'); assert.equal(calls, 2);
    await save({ monthlyLimit: 2 }); assert.equal((await start()).statusCode, 422); assert.equal(calls, 2);
    await save({ monthlyBudgetCents: 7 }); assert.equal((await start()).statusCode, 422); assert.equal(calls, 2);
    await save({ enabled: false });
    const saved = await f.app.inject({ method: 'PUT', url: `/api/v1/collection/questions/${draft.id}`, headers, payload: { operationId: randomUUID(), expectedRevision: 1, state: 'collected', subjectId: 'math', sourceId: null, region: { x: 0, y: 0, width: 1, height: 1 }, pageNumber: '', questionNumber: '', note: '识别停用仍可手动保存' } });
    assert.equal(saved.statusCode, 200, saved.body);
    const usage = (await f.app.inject({ url: '/api/v1/admin/ocr', headers: parent })).json().usage;
    assert.equal(usage.attempts, 2); assert.equal(usage.estimatedCents, 7);
  } finally { respond?.(new Response(null, { status: 503 })); await f.close(); }
});

test('迟到结果不改写题目，跨页冒用识别引用被拒绝；撤销设备阻止后续重试', async () => {
  let calls = 0, respond: ((value: Response) => void) | undefined;
  const clearResponse = () => { respond = undefined; };
  const f = await familyFixture({ ocrHttp: async () => { calls++; return new Promise(resolve => { respond = resolve; }); } });
  try {
    const headers = auth(f.first.token), parent = await ocrParent(f);
    const other = (await f.login('收集手机')).json(), child = auth(other.token);
    await f.app.inject({ method: 'PUT', url: '/api/v1/admin/ocr', headers: parent, payload: { operationId: randomUUID(), expectedRevision: 0, config: { ...config, retries: 2 }, credentials } });
    const bytes = await sharp(await readFile(new URL('../fixtures/paper.svg', import.meta.url))).png().toBuffer();
    const draft = (await f.app.inject({ method: 'POST', url: '/api/v1/collection/drafts', headers: { ...child, 'content-type': 'image/png', 'idempotency-key': randomUUID() }, payload: bytes })).json();
    const pageId = draft.originalPage.id;
    for (let i = 0; i < 100 && !respond; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(respond);
    const edit = { operationId: randomUUID(), expectedRevision: 1, state: 'collected', subjectId: 'math', sourceId: null, region: { x: .1, y: .1, width: .8, height: .8 }, pageNumber: '', questionNumber: '手动', note: '未等识别结果' };
    assert.equal((await f.app.inject({ method: 'PUT', url: `/api/v1/collection/questions/${draft.id}`, headers: child, payload: edit })).statusCode, 200);
    respond(vendorResult()); clearResponse();
    const done = await completed(f, pageId), run = done.runs[0];
    assert.equal(run.status, 'succeeded');
    const saved = (await f.app.inject({ url: `/api/v1/collection/questions/${draft.id}`, headers })).json();
    assert.equal(saved.questionNumber, '手动'); assert.equal(saved.revision, 2); assert.deepEqual(saved.region, edit.region);
    assert.equal((await f.app.inject({ url: `/api/v1/collection/pages/${pageId}/recognitions` })).statusCode, 401);
    const second = (await f.app.inject({ method: 'POST', url: '/api/v1/collection/pages', headers: { ...headers, 'content-type': 'image/png', 'idempotency-key': randomUUID() }, payload: bytes })).json();
    const forged = await f.app.inject({ method: 'POST', url: `/api/v1/collection/pages/${second.id}/questions`, headers, payload: { ...edit, expectedRevision: undefined, operationId: randomUUID(), parts: [{ id: randomUUID(), pageId: second.id, region: edit.region, recognition: { runId: run.id, candidateId: '1' }, transcription: '伪造关联' }] } });
    assert.equal(forged.statusCode, 422, forged.body);
    assert.equal((await f.app.inject({ url: `/api/v1/collection/pages/${second.id}/recognitions/${run.id}`, headers })).statusCode, 404);
    await f.app.inject({ method: 'PUT', url: `/api/v1/collection/pages/${pageId}/recognitions/${randomUUID()}`, headers: child });
    for (let i = 0; i < 100 && !respond; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(respond);
    assert.equal((await f.app.inject({ method: 'DELETE', url: `/api/v1/admin/devices/${other.session.id}`, headers: parent })).statusCode, 204);
    respond(new Response(null, { status: 503 })); clearResponse();
    await completed(f, pageId); assert.equal(calls, 2);
    assert.equal((await f.app.inject({ url: `/api/v1/collection/pages/${pageId}/recognitions`, headers: child })).statusCode, 401);
  } finally { respond?.(new Response(null, { status: 503 })); await f.close(); }
});

test('带方向信息的图片用正向副本识别，原始文件保留；重启不重发页面识别', async () => {
  let calls = 0;
  const f = await familyFixture({ ocrHttp: async (_url, init) => {
    calls++;
    const buffer = Buffer.from(JSON.parse(String(init.body)).payload.sf8e6aca1_data_1.image, 'base64');
    const meta = await sharp(buffer).metadata();
    assert.equal(meta.width, 640); assert.equal(meta.height, 800); assert.equal(meta.format, 'png');
    assert.ok(buffer.length <= 3 * 1024 * 1024);
    return vendorResult();
  } });
  try {
    const headers = auth(f.first.token), parent = await ocrParent(f);
    await f.app.inject({ method: 'PUT', url: '/api/v1/admin/ocr', headers: parent, payload: { operationId: randomUUID(), expectedRevision: 0, config, credentials } });
    const original = await sharp({ create: { width: 800, height: 640, channels: 3, background: 'white' } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const draft = (await f.app.inject({ method: 'POST', url: '/api/v1/collection/drafts', headers: { ...headers, 'content-type': 'image/jpeg', 'idempotency-key': randomUUID() }, payload: original })).json();
    const done = await completed(f, draft.originalPage.id), run = done.runs[0];
    assert.equal(run.inputWidth, 640); assert.equal(run.inputHeight, 800);
    const region = run.candidates[0].region;
    assert.ok(region.x >= 0 && region.y >= 0 && region.x + region.width <= 1 && region.y + region.height <= 1);
    assert.deepEqual((await f.app.inject({ url: `/api/v1/collection/pages/${draft.originalPage.id}/original`, headers })).rawPayload, original);
    await f.app.close();
    const { createApp } = await import('../../src/server/app.ts');
    const restarted = createApp({ dataDir: f.dataDir, ocrHttp: async () => { calls++; throw new Error('must not replay'); } });
    try {
      const data = (await restarted.inject({ url: `/api/v1/collection/pages/${draft.originalPage.id}/recognitions`, headers })).json();
      assert.equal(data.runs[0].id, run.id); assert.equal(data.runs[0].status, 'succeeded'); assert.equal(calls, 1);
    } finally { await restarted.close(); }
  } finally { await f.close(); }
});
