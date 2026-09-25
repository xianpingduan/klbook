import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApp } from '../../src/server/app.ts';
import { auth, familyFixture, password } from './fixture.ts';

const path = '/api/v1/admin/ocr';
const credentials = { apiKey: 'test-baidu-api-key', secretKey: 'test-baidu-secret-key' };
const config = { name: '家庭试卷识别', enabled: false, language: 'CHN_ENG', handwriting: true, formulas: true, timeoutSeconds: 10, retries: 1, monthlyLimit: 300, monthlyBudgetCents: 5000, priceCents: 16 };
async function finish(f: Awaited<ReturnType<typeof familyFixture>>, headers: ReturnType<typeof auth>) {
  for (let i = 0; i < 200; i++) {
    const data = (await f.app.inject({ url: path, headers })).json();
    if (data.tests[0]?.status !== 'running') return data;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('test did not settle');
}
async function parent(f: Awaited<ReturnType<typeof familyFixture>>) {
  const grant = (await f.app.inject({ method: 'POST', url: '/api/v1/admin/grants', headers: auth(f.first.token), payload: { password } })).json().token;
  return auth(f.first.token, grant);
}

test('图片识别配置只供家长管理，保存不出网，密钥加密持久化且不回显，重复保存和冲突受控', async () => {
  const f = await familyFixture();
  try {
    const headers = await parent(f);
    assert.equal((await f.app.inject({ url: path })).statusCode, 401);
    assert.equal((await f.app.inject({ url: path, headers: auth(f.first.token) })).statusCode, 403);
    const initial = await f.app.inject({ url: path, headers });
    assert.equal(initial.statusCode, 200, initial.body);
    assert.equal(initial.json().config.enabled, false);
    assert.equal(initial.json().credentialsConfigured, false);
    const input = { operationId: randomUUID(), expectedRevision: 0, config, credentials };
    const save = (payload: object) => f.app.inject({ method: 'PUT', url: path, headers, payload });
    const result = await save(input);
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.json().revision, 1);
    assert.equal(result.json().credentialsConfigured, true);
    assert.equal(result.json().usage.attempts, 0);
    assert.equal((await save(input)).json().revision, 1);
    assert.equal((await save({ ...input, operationId: randomUUID() })).statusCode, 409);
    assert.equal((await save({ ...input, config: { ...config, name: '不同内容' } })).statusCode, 409);
    assert.equal((await save({ operationId: randomUUID(), expectedRevision: 1, config: { ...config, enabled: true, retries: 99 } })).statusCode, 400);
    assert.equal(result.body.includes(credentials.apiKey), false);
    assert.equal(result.body.includes(credentials.secretKey), false);
    assert.equal(result.json().audit.length, 1);
    assert.equal(result.json().audit[0].actor, 'parent');
    await f.app.close();
    const database = await readFile(join(f.dataDir, 'family.sqlite'));
    assert.equal(database.includes(Buffer.from(credentials.secretKey)), false);
    assert.equal(database.includes(Buffer.from(credentials.apiKey)), false);
    const restarted = createApp({ dataDir: f.dataDir });
    try {
      const loaded = await restarted.inject({ url: path, headers });
      assert.equal(loaded.statusCode, 200, loaded.body);
      assert.deepEqual(loaded.json().config, config);
      assert.equal(loaded.json().credentialsConfigured, true);
      assert.equal(loaded.json().credentialAvailable, true);
    } finally { await restarted.close(); }
  } finally { await f.close(); }
});

test('未配置、无授权、次数或预算耗尽均不出网；供应商错误有界重试且不泄漏密钥', async () => {
  let calls = 0;
  const f = await familyFixture({ ocrHttp: async url => {
    calls++;
    if (url.pathname.includes('/token')) return Response.json({ access_token: 'test-token', expires_in: 6000 });
    return Response.json({ error_code: 18, error_msg: credentials.secretKey });
  } });
  try {
    const headers = await parent(f);
    const save = (revision: number, changes = {}) => f.app.inject({ method: 'PUT', url: path, headers, payload: { operationId: randomUUID(), expectedRevision: revision, config: { ...config, ...changes }, credentials } });
    const start = (revision: number, authorization = headers) => f.app.inject({ method: 'PUT', url: `${path}/tests/${randomUUID()}`, headers: authorization, payload: { expectedRevision: revision, sample: 'school-v1' } });
    assert.equal((await start(0)).statusCode, 422);
    assert.equal((await start(0, auth(f.first.token))).statusCode, 403);
    assert.equal((await save(0, { monthlyLimit: 1, retries: 2 })).statusCode, 200);
    assert.equal((await start(1)).statusCode, 202);
    const data = await finish(f, headers);
    assert.equal(data.usage.attempts, 1); assert.equal(data.usage.estimatedCents, 0);
    assert.equal(data.tests[0].status, 'failed'); assert.match(data.tests[0].message, /次数上限/);
    assert.equal(JSON.stringify(data).includes(credentials.secretKey), false);
    assert.equal((await start(1)).statusCode, 422); assert.equal(calls, 2);
    await save(1, { monthlyBudgetCents: 15 });
    assert.equal((await start(2)).statusCode, 422); assert.equal(calls, 2);
    await save(2, { retries: 2 });
    await start(3);
    const retried = await finish(f, headers);
    assert.equal(retried.tests[0].attempts, 3); assert.equal(calls, 5);
    f.advance(5 * 60000);
    assert.equal((await start(3)).statusCode, 403);
  } finally { await f.close(); }
});

test('停用保留在途成功结果并阻止失败重试；再次启用不扫描历史', async () => {
  let resolveVendor: ((response: Response) => void) | undefined, calls = 0;
  const f = await familyFixture({ ocrHttp: async (url, init) => {
    if (url.pathname.includes('/token')) return Response.json({ access_token: 'token', expires_in: 6000 });
    assert.equal(new URLSearchParams(String(init.body)).get('recg_formula'), 'false');
    calls++; return new Promise(resolve => { resolveVendor = resolve; });
  } });
  try {
    const headers = await parent(f);
    const save = (revision: number, enabled: boolean) => f.app.inject({ method: 'PUT', url: path, headers, payload: { operationId: randomUUID(), expectedRevision: revision, config: { ...config, enabled, formulas: false }, ...(revision === 0 ? { credentials } : {}) } });
    const start = (revision: number) => f.app.inject({ method: 'PUT', url: `${path}/tests/${randomUUID()}`, headers, payload: { expectedRevision: revision, sample: 'school-v1' } });
    const waitForCall = async (count: number) => { for (let i = 0; i < 100 && calls < count; i++) await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(calls, count); };
    await save(0, true); await start(1); await waitForCall(1);
    assert.equal((await start(1)).statusCode, 409);
    await save(1, false);
    resolveVendor!(Response.json({ results: [{ words_type: 'print', words: { word: '原请求的结果', words_location: { left: 10, top: 20, width: 100, height: 24 } } }] }));
    const completed = await finish(f, headers);
    assert.equal(completed.tests[0].status, 'succeeded');
    assert.deepEqual(completed.tests[0].lines, [{ text: '原请求的结果', box: { left: 10, top: 20, width: 100, height: 24 } }]);
    await save(2, true); assert.equal(calls, 1);
    await start(3); await waitForCall(2); await save(3, false);
    resolveVendor!(Response.json({ error_code: 282000 }));
    const stopped = await finish(f, headers);
    assert.equal(stopped.tests[0].status, 'stopped'); assert.equal(stopped.tests[0].attempts, 1);
    assert.equal(calls, 2); assert.equal(stopped.usage.estimatedCents, 16);
  } finally { resolveVendor?.(Response.json({ error_code: 282000 })); await f.close(); }
});

test('服务凭据密钥丢失时允许停用但不覆盖旧凭据，恢复配套密钥后可测试', async () => {
  let calls = 0;
  const f = await familyFixture({ ocrHttp: async () => { calls++; return Response.json({ error: 'bad client' }); } });
  try {
    const headers = await parent(f);
    const save = (revision: number, enabled: boolean, replace = false) => f.app.inject({ method: 'PUT', url: path, headers, payload: { operationId: randomUUID(), expectedRevision: revision, config: { ...config, enabled }, ...(replace ? { credentials } : {}) } });
    assert.equal((await save(0, true, true)).statusCode, 200);
    const key = join(f.dataDir, 'service-credentials.key'); await rename(key, `${key}.backup`);
    const missing = (await f.app.inject({ url: path, headers })).json();
    assert.equal(missing.credentialsConfigured, true); assert.equal(missing.credentialAvailable, false);
    assert.equal((await save(1, false)).statusCode, 200);
    assert.equal((await save(2, true, true)).statusCode, 503);
    assert.equal((await f.app.inject({ method: 'PUT', url: `${path}/tests/${randomUUID()}`, headers, payload: { expectedRevision: 2, sample: 'school-v1' } })).statusCode, 503);
    assert.equal(calls, 0);
    await rename(`${key}.backup`, key);
    assert.equal((await save(2, true)).statusCode, 200);
    assert.equal((await f.app.inject({ url: path, headers })).json().credentialAvailable, true);
  } finally { await f.close(); }
});

test('停服保留不确定调用的估算费用，重启不重发；授权期间撤回配置会阻止图片发送', async () => {
  let calls = 0;
  const f = await familyFixture({ ocrHttp: async (url, init) => {
    if (url.pathname.includes('/token')) return Response.json({ access_token: 'token', expires_in: 6000 });
    calls++;
    return new Promise((_resolve, reject) => { init.signal!.addEventListener('abort', () => reject(new Error('vendor-token must never leak')), { once: true }); });
  } });
  try {
    const headers = await parent(f);
    await f.app.inject({ method: 'PUT', url: path, headers, payload: { operationId: randomUUID(), expectedRevision: 0, config: { ...config, monthlyBudgetCents: 16 }, credentials } });
    await f.app.inject({ method: 'PUT', url: `${path}/tests/${randomUUID()}`, headers, payload: { expectedRevision: 1, sample: 'school-v1' } });
    for (let i = 0; i < 100 && !calls; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(calls, 1);
    await f.app.close();
    const restarted = createApp({ dataDir: f.dataDir, ocrHttp: async () => { calls++; throw new Error('must not replay'); } });
    try {
      const data = (await restarted.inject({ url: path, headers })).json();
      assert.equal(data.tests[0].status, 'interrupted'); assert.equal(data.usage.estimatedCents, 16);
      assert.equal(JSON.stringify(data).includes('vendor-token'), false);
      assert.equal((await restarted.inject({ method: 'PUT', url: `${path}/tests/${randomUUID()}`, headers, payload: { expectedRevision: 1, sample: 'school-v1' } })).statusCode, 422);
      assert.equal(calls, 1);
    } finally { await restarted.close(); }
  } finally { await f.close(); }
  let resolveToken: ((response: Response) => void) | undefined, paid = 0;
  const g = await familyFixture({ ocrHttp: async url => {
    if (url.pathname.includes('/token')) return new Promise(resolve => { resolveToken = resolve; });
    paid++; return Response.json({ words_result: [{ words: 'should not send' }] });
  } });
  try {
    const headers = await parent(g);
    await g.app.inject({ method: 'PUT', url: path, headers, payload: { operationId: randomUUID(), expectedRevision: 0, config, credentials } });
    await g.app.inject({ method: 'PUT', url: `${path}/tests/${randomUUID()}`, headers, payload: { expectedRevision: 1, sample: 'school-v1' } });
    for (let i = 0; i < 100 && !resolveToken; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(resolveToken);
    await g.app.inject({ method: 'PUT', url: path, headers, payload: { operationId: randomUUID(), expectedRevision: 1, config } });
    resolveToken(Response.json({ access_token: 'token', expires_in: 6000 }));
    const data = await finish(g, headers);
    assert.equal(data.tests[0].status, 'stopped'); assert.equal(data.usage.estimatedCents, 0); assert.equal(paid, 0);
  } finally { resolveToken?.(Response.json({ error: 'cancel' })); await g.close(); }
});

test('主动测试只发合成样例，遵守百度协议，结果持久化，丢失响应重试不重复计费', async () => {
  let tokens = 0, recognitions = 0;
  const f = await familyFixture({ ocrHttp: async (url, init) => {
    assert.equal(url.origin, 'https://aip.baidubce.com');
    assert.equal(init.redirect, 'error');
    if (url.pathname === '/oauth/2.0/token') {
      tokens++; assert.equal(url.searchParams.get('client_secret'), credentials.secretKey);
      return Response.json({ access_token: 'vendor-token', expires_in: 2592000 });
    }
    recognitions++;
    assert.equal(url.pathname, '/rest/2.0/ocr/v1/doc_analysis');
    assert.equal(url.searchParams.get('access_token'), 'vendor-token');
    const body = new URLSearchParams(String(init.body));
    assert.equal(body.get('language_type'), 'CHN_ENG');
    assert.equal(body.get('words_type'), 'handprint_mix');
    assert.equal(body.get('recg_formula'), 'true');
    assert.equal(body.get('detect_direction'), 'true');
    assert.equal(Buffer.from(body.get('image')!, 'base64').subarray(1, 4).toString(), 'PNG');
    return Response.json({ words_result: [{ words: '12 × 3 = 36', location: { left: 10, top: 20, width: 100, height: 24 } }], debug: credentials });
  } });
  try {
    const headers = await parent(f);
    await f.app.inject({ method: 'PUT', url: path, headers, payload: { operationId: randomUUID(), expectedRevision: 0, config, credentials } });
    assert.equal(tokens + recognitions, 0, '保存和停用状态均不自动出网');
    const sample = await f.app.inject({ url: `${path}/sample`, headers });
    assert.equal(sample.statusCode, 200); assert.match(sample.headers['content-type']!, /^image\/png/);
    const id = randomUUID();
    const start = () => f.app.inject({ method: 'PUT', url: `${path}/tests/${id}`, headers, payload: { expectedRevision: 1, sample: 'school-v1' } });
    assert.equal((await start()).statusCode, 202);
    assert.equal((await start()).statusCode, 202);
    const data = await finish(f, headers);
    assert.equal(data.tests[0].status, 'succeeded');
    assert.deepEqual(data.tests[0].lines, [{ text: '12 × 3 = 36', box: { left: 10, top: 20, width: 100, height: 24 } }]);
    assert.equal(data.usage.attempts, 1); assert.equal(data.usage.estimatedCents, 16);
    assert.equal(recognitions, 1); assert.equal(tokens, 1);
    assert.equal(JSON.stringify(data).includes('vendor-token'), false);
    assert.equal(JSON.stringify(data).includes(credentials.secretKey), false);
    assert.equal((await start()).statusCode, 202); assert.equal(recognitions, 1);
    await f.app.close();
    const restarted = createApp({ dataDir: f.dataDir, ocrHttp: async () => { throw new Error('must not replay'); } });
    try { assert.deepEqual((await restarted.inject({ url: path, headers })).json().tests, data.tests); } finally { await restarted.close(); }
  } finally { await f.close(); }
});
