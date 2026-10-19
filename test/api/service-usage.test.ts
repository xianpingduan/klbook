import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { auth, familyFixture } from './fixture.ts';
import { ocrParent, finishedOcr } from './ocr-fixture.ts';
import { aiVendor, finishedAi } from './ai-fixture.ts';
import { speechVendor, finishedSpeech, testWav } from './speech-fixture.ts';
import sharp from 'sharp';
import { createApp } from '../../src/server/app.ts';

const path = '/api/v1/admin/service-usage';
type Fixture = Awaited<ReturnType<typeof familyFixture>>;
type Headers = ReturnType<typeof auth>;
const ocrReply = () => Response.json({ words_result: [{ words: '示例题目' }] });
async function configure(f: Fixture, headers: Headers, capability: 'ocr' | 'speech' | 'ai', patch = {}) {
  const url = `/api/v1/admin/${capability}`, initial = (await f.app.inject({ url, headers })).json();
  const credentials = capability === 'ocr' ? { apiKey: 'ocr-test', secretKey: 'ocr-private' } : capability === 'speech' ? { appId: 'test-app', apiKey: 'K'.repeat(32), secretKey: 'S'.repeat(32) } : { apiPassword: 'test-ai-private' };
  const extra = capability === 'ai' ? { modelPrices: { lite: { inputCentsPerMillion: 100, outputCentsPerMillion: 0, confirmed: true }, '4.0Ultra': { inputCentsPerMillion: 0, outputCentsPerMillion: 0, confirmed: true } } } : { priceCents: 1 };
  const result = await f.app.inject({ method: 'PUT', url, headers, payload: { operationId: randomUUID(), expectedRevision: initial.revision, config: { ...initial.config, enabled: true, retries: 0, ...extra, ...patch }, credentials } });
  assert.equal(result.statusCode, 200, result.body); return result.json();
}
async function budget(f: Fixture, headers: Headers, cents: number) {
  const value = (await f.app.inject({ url: path, headers })).json();
  const result = await f.app.inject({ method: 'PUT', url: path, headers, payload: { operationId: randomUUID(), expectedRevision: value.revision, config: { ...value.config, monthlyBudgetCents: cents } } });
  assert.equal(result.statusCode, 200, result.body); return result.json();
}
const startOcr = (f: Fixture, headers: Headers, revision = 1) => f.app.inject({ method: 'PUT', url: `/api/v1/admin/ocr/tests/${randomUUID()}`, headers, payload: { expectedRevision: revision, sample: 'school-v1' } });
const startSpeech = (f: Fixture, headers: Headers, revision = 1) => f.app.inject({ method: 'PUT', url: `/api/v1/admin/speech/tests/${randomUUID()}?revision=${revision}`, headers: { ...headers, 'content-type': 'audio/wav' }, payload: testWav() });
const startAi = (f: Fixture, headers: Headers, revision = 1) => f.app.inject({ method: 'PUT', url: `/api/v1/admin/ai/tests/${randomUUID()}`, headers, payload: { expectedRevision: revision, prompt: '给一个解题提示' } });

test('等待免费鉴权时调低总预算会阻止 OCR 付费请求，释放未发送预留', async () => {
  let release: (() => void) | undefined, businessCalls = 0;
  const f = await familyFixture({ ocrHttp: async url => {
    if (url.pathname.includes('oauth')) return new Promise<Response>(resolve => { release = () => resolve(Response.json({ access_token: 'fake-token', expires_in: 3600 })); });
    businessCalls++; return ocrReply();
  } });
  try {
    const headers = await ocrParent(f); await configure(f, headers, 'ocr');
    assert.equal((await startOcr(f, headers)).statusCode, 202);
    for (let i = 0; !release && i < 200; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(release); await budget(f, headers, 0); release();
    const result = await finishedOcr(f, headers);
    assert.match(result.tests[0].message, /总预算/); assert.equal(businessCalls, 0);
    const usage = (await f.app.inject({ url: path, headers })).json();
    assert.equal(usage.totals.attempts, 1); assert.equal(usage.totals.failed, 1); assert.equal(usage.totals.estimatedMicros, 0);
  } finally { release?.(); await f.close(); }
});

for (const capability of ['ocr', 'speech', 'ai'] as const) test(`${capability} 自动重试重新检查已降低的总预算，未知结果保留预留且日志脱敏`, async () => {
  let headers: Headers, f: Fixture, businessCalls = 0;
  const ai = aiVendor(async () => { await budget(f, headers, 0); return Response.json({ secret: 'test-ai-private' }, { status: 503 }); });
  const voice = speechVendor(socket => { void budget(f, headers, 0).then(() => socket.reply({ code: 10114, message: 'S'.repeat(32) })); });
  f = await familyFixture({ aiHttp: ai.http, speechSocket: voice.connect, ocrHttp: async url => {
    if (url.pathname.includes('oauth')) return Response.json({ access_token: 'fake-token', expires_in: 3600 });
    businessCalls++; await budget(f, headers, 0); return Response.json({ secret: 'ocr-private' }, { status: 503 });
  } });
  try {
    headers = await ocrParent(f); await configure(f, headers, capability, { retries: 2 });
    assert.equal((await ({ ocr: startOcr, speech: startSpeech, ai: startAi }[capability])(f, headers)).statusCode, 202);
    await ({ ocr: finishedOcr, speech: finishedSpeech, ai: finishedAi }[capability])(f, headers);
    const state = (await f.app.inject({ url: path, headers })).json();
    assert.equal(state.totals.attempts, 1); assert.equal(state.totals.unknown, 1); assert.equal(state.totals.reservedMicros, capability === 'ai' ? 8192 : 10000);
    assert.equal(businessCalls + voice.sockets.length + ai.calls.length, 1);
    assert.equal(JSON.stringify(state).includes('ocr-private'), false); assert.equal(JSON.stringify(state).includes('test-ai-private'), false); assert.equal(JSON.stringify(state).includes('S'.repeat(32)), false);
  } finally { await f.close(); }
});

test('AI 异常计量保留预留并跨重启保留，预算耗尽仍可手动收集、查看和按零单价主动调用', async () => {
  const ai = aiVendor(() => Response.json({ choices: [{ message: { role: 'assistant', content: '示例提示' } }], usage: { prompt_tokens: -1, completion_tokens: 2, total_tokens: 1 } }));
  const voice = speechVendor(), f = await familyFixture({ aiHttp: ai.http, speechSocket: voice.connect });
  try {
    const headers = await ocrParent(f); await configure(f, headers, 'ai');
    const id = randomUUID(), input = { method: 'PUT' as const, url: `/api/v1/admin/ai/tests/${id}`, headers, payload: { expectedRevision: 1, prompt: '示例' } };
    assert.equal((await f.app.inject(input)).statusCode, 202); await finishedAi(f, headers);
    const state = (await f.app.inject({ url: path, headers })).json();
    assert.equal(state.totals.reservedMicros, 8192); assert.equal(state.categories[2].reportedAttempts, 0); assert.equal(state.records[0].totalTokens, null);
    await budget(f, headers, 0);
    const bytes = await sharp({ create: { width: 80, height: 80, channels: 3, background: 'white' } }).png().toBuffer();
    const draft = (await f.app.inject({ method: 'POST', url: '/api/v1/collection/drafts', headers: { ...auth(f.first.token), 'content-type': 'image/png', 'idempotency-key': randomUUID() }, payload: bytes })).json();
    const saved = await f.app.inject({ method: 'PUT', url: `/api/v1/collection/questions/${draft.id}`, headers: auth(f.first.token), payload: { operationId: randomUUID(), expectedRevision: 1, state: 'collected', subjectId: 'math', region: { x: 0, y: 0, width: 1, height: 1 }, sourceId: null, pageNumber: '', questionNumber: '', note: '' } });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal((await f.app.inject({ url: `/api/v1/collection/questions/${draft.id}`, headers: auth(f.first.token) })).json().state, 'collected');
    await configure(f, headers, 'speech', { priceCents: 0 });
    assert.equal((await startSpeech(f, headers)).statusCode, 202); await finishedSpeech(f, headers);
    await f.app.close();
    const reopened = createApp({ dataDir: f.dataDir, aiHttp: ai.http });
    try {
      const restored = (await reopened.inject({ url: path, headers })).json();
      assert.equal(restored.config.monthlyBudgetCents, 0); assert.equal(restored.totals.attempts, 2); assert.equal(restored.totals.reservedMicros, 8192);
      assert.equal((await reopened.inject(input)).statusCode, 202); assert.equal(ai.calls.length, 1);
    } finally { await reopened.close(); }
  } finally { await f.close(); }
});

test('分类与合计覆盖全部记录而非最近一页，计量来源明确，改价格不改历史且月界按北京时间', async () => {
  const voice = speechVendor(), ai = aiVendor();
  const f = await familyFixture({ speechSocket: voice.connect, aiHttp: ai.http, ocrHttp: async url => url.pathname.includes('oauth') ? Response.json({ access_token: 'fake-token', expires_in: 3600 }) : ocrReply() });
  try {
    f.setTime(Date.UTC(2026, 9, 31, 15, 59, 0));
    let headers = await ocrParent(f);
    for (const capability of ['ocr', 'speech', 'ai'] as const) await configure(f, headers, capability);
    assert.equal((await startOcr(f, headers)).statusCode, 202); await finishedOcr(f, headers);
    assert.equal((await startSpeech(f, headers)).statusCode, 202); await finishedSpeech(f, headers);
    for (let i = 0; i < 41; i++) { assert.equal((await startAi(f, headers)).statusCode, 202); await finishedAi(f, headers); }
    const state = (await f.app.inject({ url: path, headers })).json();
    assert.equal(state.month, '2026-10'); assert.equal(state.recordCount, 43); assert.equal(state.records.length, 40);
    assert.equal(state.totals.attempts, 43); assert.equal(state.totals.succeeded, 43); assert.equal(state.totals.estimatedMicros, 21148);
    assert.equal(state.categories[1].audioMs, 80); assert.equal(state.categories[1].reportedAttempts, 0);
    assert.equal(state.categories[2].totalTokens, 1927); assert.equal(state.categories[2].reportedAttempts, 41);
    assert.equal(state.categories[0].reportedAttempts, 0); assert.equal(state.categories[0].totalTokens, 0);
    const second = (await f.app.inject({ url: `${path}?offset=40`, headers })).json();
    assert.equal(second.records.length, 3); assert.equal(second.recordCount, 43);
    const filtered = (await f.app.inject({ url: `${path}?capability=ocr`, headers })).json();
    assert.equal(filtered.recordCount, 1); assert.equal(filtered.totals.attempts, 43);
    assert.equal(filtered.records[0].totalTokens, null); assert.equal(filtered.records[0].costBasis, 'local-call');
    await configure(f, headers, 'ai', { modelPrices: { lite: { inputCentsPerMillion: 200, outputCentsPerMillion: 600, confirmed: true }, '4.0Ultra': { inputCentsPerMillion: 0, outputCentsPerMillion: 0, confirmed: true } } });
    assert.equal((await f.app.inject({ url: path, headers })).json().totals.estimatedMicros, 21148);
    f.advance(60000); headers = await ocrParent(f);
    assert.equal((await f.app.inject({ url: path, headers })).json().totals.attempts, 0);
    await startAi(f, headers, 2); await finishedAi(f, headers);
    const next = (await f.app.inject({ url: path, headers })).json();
    assert.equal(next.month, '2026-11'); assert.equal(next.totals.estimatedMicros, 170);
    const old = (await f.app.inject({ url: `${path}?month=2026-10`, headers })).json();
    assert.equal(old.totals.estimatedMicros, 21148); assert.equal(old.recordCount, 43);
    for (const secret of ['ocr-private', 'test-ai-private', 'S'.repeat(32), 'fake-token']) assert.equal(JSON.stringify(old).includes(secret), false);
  } finally { await f.close(); }
});

test('两类调用并发竞争同一总预算，仅一项可预留；已发出结果如实结算，第三类不能绕过', async () => {
  let releaseOcr: (() => void) | undefined;
  const ocrCalls: number[] = [], voice = speechVendor(() => undefined), ai = aiVendor();
  const f = await familyFixture({ ocrHttp: async url => {
    if (url.pathname.includes('oauth')) return Response.json({ access_token: 'fake-token', expires_in: 3600 });
    ocrCalls.push(1); return new Promise<Response>(resolve => { releaseOcr = () => resolve(ocrReply()); });
  }, speechSocket: voice.connect, aiHttp: ai.http });
  try {
    const headers = await ocrParent(f);
    for (const capability of ['ocr', 'speech', 'ai'] as const) await configure(f, headers, capability);
    await budget(f, headers, 1);
    const starts = await Promise.all([startOcr(f, headers), startSpeech(f, headers)]);
    for (const result of starts) assert.ok([202, 422].includes(result.statusCode), result.body);
    let state;
    for (let i = 0; i < 100; i++) {
      state = (await f.app.inject({ url: path, headers })).json();
      if (state.totals.attempts && (ocrCalls.length || voice.sockets[0]?.frames.at(-1)?.data.status === 2)) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(state.totals.attempts, 1);
    assert.equal(state.totals.reservedMicros, 10000);
    assert.equal(ocrCalls.length + voice.sockets.length, 1);
    const blocked = await startAi(f, headers); assert.equal(blocked.statusCode, 422); assert.match(blocked.body, /总预算/); assert.equal(ai.calls.length, 0);
    await budget(f, headers, 0);
    releaseOcr?.(); voice.sockets[0]?.reply({ code: 0, data: { status: 2, result: { sn: 0, ws: [{ cw: [{ w: '示例' }] }] } } });
    await finishedOcr(f, headers); await finishedSpeech(f, headers);
    state = (await f.app.inject({ url: path, headers })).json();
    assert.equal(state.totals.succeeded, 1); assert.equal(state.totals.estimatedMicros, 10000); assert.equal(state.totals.reservedMicros, 0);
    assert.equal(state.records[0].costBasis, 'local-call');
  } finally { releaseOcr?.(); await f.close(); }
});
test('家长统一查看三类服务额度，保存总预算不产生调用，重放不重复审计且冲突不覆盖', async () => {
  const vendor = aiVendor(), f = await familyFixture({ aiHttp: vendor.http });
  try {
    assert.equal((await f.app.inject({ url: path })).statusCode, 401);
    assert.equal((await f.app.inject({ url: path, headers: auth(f.first.token) })).statusCode, 403);
    const headers = await ocrParent(f), response = await f.app.inject({ url: path, headers });
    assert.equal(response.statusCode, 200, response.body);
    const initial = response.json();
    assert.equal(initial.config.monthlyBudgetCents, 5000);
    assert.equal(initial.totals.attempts, 0); assert.equal(initial.totals.estimatedMicros, 0);
    assert.deepEqual(initial.categories.map((item: { capability: string }) => item.capability), ['ocr', 'speech', 'ai']);
    assert.equal(initial.config.hardwareCents, null); assert.equal(initial.config.monthlyElectricityCents, null);
    const input = { operationId: randomUUID(), expectedRevision: 0, config: { ...initial.config, monthlyBudgetCents: 3000, hardwareCents: 200000, monthlyElectricityCents: 1000, capacityNote: '现有电脑，512 GB SSD' } };
    const put = () => f.app.inject({ method: 'PUT', url: path, headers, payload: input });
    assert.equal((await put()).statusCode, 200);
    const replay = await put(); assert.equal(replay.statusCode, 200); assert.equal(replay.json().revision, 1);
    assert.equal(replay.json().audit.length, 1); assert.equal(replay.json().totals.attempts, 0);
    assert.equal((await f.app.inject({ method: 'PUT', url: path, headers, payload: { ...input, operationId: randomUUID() } })).statusCode, 409);
    assert.equal((await f.app.inject({ url: `${path}?month=2026-13`, headers })).statusCode, 400);
    assert.equal(vendor.calls.length, 0);
  } finally { await f.close(); }
});
