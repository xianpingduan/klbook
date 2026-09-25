import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { auth, familyFixture, password } from './fixture.ts';

const path = '/api/v1/admin/ocr';
const config = { provider: 'baidu', name: '家庭识别', enabled: false, language: 'CHN_ENG', handwriting: true, formulas: true, timeoutSeconds: 10, retries: 0, monthlyLimit: 300, monthlyBudgetCents: 5000, priceCents: 16 };
const baidu = { apiKey: 'saved-baidu-key', secretKey: 'saved-baidu-secret' };
const xfyun = { appId: 'test-app', apiKey: 'apikeyXXXXXXXXXXXXXXXXXXXXXXXXXX', secretKey: 'apisecretXXXXXXXXXXXXXXXXXXXXXXX' };
async function parent(f: Awaited<ReturnType<typeof familyFixture>>) {
  const grant = (await f.app.inject({ method: 'POST', url: '/api/v1/admin/grants', headers: auth(f.first.token), payload: { password } })).json().token;
  return auth(f.first.token, grant);
}
async function finish(f: Awaited<ReturnType<typeof familyFixture>>, headers: ReturnType<typeof auth>) {
  for (let i = 0; i < 200; i++) {
    const data = (await f.app.inject({ url: path, headers })).json();
    if (data.tests[0]?.status !== 'running') return data;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('test did not settle');
}
test('家长切换识别供应商分别保存凭据，旧供应商凭据不串用，不支持的参数不能保存', async () => {
  let calls = 0;
  const f = await familyFixture({ ocrHttp: async () => { calls++; throw new Error('saving never calls vendor'); } });
  try {
    const headers = await parent(f);
    const save = (expectedRevision: number, chosen: object, credentials?: object) => f.app.inject({ method: 'PUT', url: path, headers, payload: { operationId: randomUUID(), expectedRevision, config: chosen, ...(credentials ? { credentials } : {}) } });
    const first = await save(0, config, baidu);
    assert.equal(first.statusCode, 200, first.body);
    const chosen = { ...config, provider: 'xfyun', formulas: false, priceCents: 3.5 };
    assert.equal((await save(1, { ...chosen, enabled: true })).statusCode, 422, '不能沿用百度凭据启用讯飞');
    assert.equal((await save(1, { ...chosen, formulas: true }, xfyun)).statusCode, 422);
    assert.equal((await save(1, chosen, { apiKey: xfyun.apiKey, secretKey: xfyun.secretKey })).statusCode, 422);
    const switched = await save(1, chosen, xfyun);
    assert.equal(switched.statusCode, 200, switched.body);
    assert.equal(switched.json().config.provider, 'xfyun');
    assert.deepEqual(switched.json().credentialStatus, { baidu: { configured: true, available: true }, xfyun: { configured: true, available: true } });
    assert.equal(JSON.stringify(switched.json()).includes(xfyun.appId), false);
    assert.equal(JSON.stringify(switched.json()).includes(baidu.secretKey), false);
    const back = await save(2, { ...config, enabled: true });
    assert.equal(back.statusCode, 200, back.body); assert.equal(back.json().credentialAvailable, true);
    assert.match(back.json().audit[0].action, /百度/);
    assert.equal(calls, 0);
  } finally { await f.close(); }
});

test('讯飞按官方签名向指定接口发送PNG，解码文字及坐标，重复提交和切换不重置额度', async () => {
  let calls = 0;
  const f = await familyFixture({ ocrHttp: async (url, init) => {
    calls++;
    assert.equal(url.origin, 'https://api.xf-yun.com'); assert.equal(url.pathname, '/v1/private/sf8e6aca1');
    assert.equal(url.searchParams.get('host'), 'api.xf-yun.com');
    assert.equal(url.searchParams.get('date'), 'Wed, 11 Aug 2021 06:55:18 GMT');
    // Signature literal from the official protocol example; not recomputed by this test.
    const authorization = Buffer.from(url.searchParams.get('authorization')!, 'base64').toString();
    assert.match(authorization, /signature="\/mg2h9BCkespilZ94HUBaQVPq2v7PxYF90teTBlaxd8="/);
    assert.match(authorization, /api_key="apikeyXXXXXXXXXXXXXXXXXXXXXXXXXX"/);
    assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error');
    const body = JSON.parse(String(init.body));
    assert.deepEqual(body.header, { app_id: xfyun.appId, status: 3 });
    assert.deepEqual(body.parameter, { sf8e6aca1: { category: 'ch_en_public_cloud', result: { encoding: 'utf8', compress: 'raw', format: 'json' } } });
    assert.equal(body.payload.sf8e6aca1_data_1.encoding, 'png');
    assert.equal(Buffer.from(body.payload.sf8e6aca1_data_1.image, 'base64').subarray(1, 4).toString(), 'PNG');
    return Response.json({ header: { code: 0, message: xfyun.secretKey }, payload: { result: { compress: 'raw', encoding: 'utf8', format: 'json', text: Buffer.from(JSON.stringify({ pages: [{ exception: 0, lines: [{ exception: 0, coord: [{ x: 23, y: 7 }, { x: 154, y: 7 }, { x: 154, y: 38 }, { x: 23, y: 38 }], words: [{ content: '爱我中华' }] }] }] })).toString('base64') } } });
  } });
  try {
    f.setTime(Date.parse('Wed, 11 Aug 2021 06:55:18 GMT'));
    const headers = await parent(f);
    const chosen = { ...config, provider: 'xfyun', formulas: false, priceCents: 3.5, monthlyBudgetCents: 7 };
    const saved = await f.app.inject({ method: 'PUT', url: path, headers, payload: { operationId: randomUUID(), expectedRevision: 0, config: chosen, credentials: xfyun } });
    assert.equal(saved.statusCode, 200, saved.body);
    const start = (id: string, revision = 1) => f.app.inject({ method: 'PUT', url: `${path}/tests/${id}`, headers, payload: { expectedRevision: revision, sample: 'school-v1' } });
    const id = randomUUID(); assert.equal((await start(id)).statusCode, 202);
    const data = await finish(f, headers);
    assert.equal(data.tests[0].status, 'succeeded', JSON.stringify(data.tests[0]));
    assert.equal(data.tests[0].provider, 'xfyun');
    assert.deepEqual(data.tests[0].lines, [{ text: '爱我中华', box: { left: 23, top: 7, width: 131, height: 31 } }]);
    assert.equal(data.usage.estimatedCents, 3.5);
    assert.equal((await start(id)).statusCode, 202); assert.equal(calls, 1);
    await start(randomUUID()); const second = await finish(f, headers);
    assert.equal(second.usage.estimatedCents, 7); assert.equal(calls, 2);
    assert.equal((await start(randomUUID())).statusCode, 422);
    const switched = await f.app.inject({ method: 'PUT', url: path, headers, payload: { operationId: randomUUID(), expectedRevision: 1, config: { ...config, monthlyBudgetCents: 7 }, credentials: baidu } });
    assert.equal(switched.json().usage.estimatedCents, 7); assert.equal(switched.json().usage.attempts, 2);
    assert.equal(switched.json().tests[0].provider, 'xfyun');
    assert.equal((await start(randomUUID(), 2)).statusCode, 422); assert.equal(calls, 2);
    assert.equal(JSON.stringify(second).includes(xfyun.secretKey), false);
  } finally { await f.close(); }
});

test('讯飞鉴权和嵌套业务异常均不伪报成功，错误与畸形响应不回显凭据', async () => {
  let mode: 'auth' | 'service' | 'page' | 'line' | 'invalid' = 'auth', calls = 0;
  const f = await familyFixture({ ocrHttp: async () => {
    calls++;
    if (mode === 'auth') return new Response(xfyun.secretKey, { status: 403 });
    if (mode === 'service') return Response.json({ header: { code: 11200, message: xfyun.apiKey } });
    if (mode === 'invalid') return Response.json({ header: { code: 0 }, payload: { result: { text: 'invalid data' } } });
    const decoded = { pages: [{ exception: mode === 'page' ? -1 : 0, lines: [{ exception: mode === 'line' ? -1 : 0, words: [{ content: xfyun.secretKey }] }] }] };
    return Response.json({ header: { code: 0 }, payload: { result: { compress: 'raw', encoding: 'utf8', format: 'json', text: Buffer.from(JSON.stringify(decoded)).toString('base64') } } });
  } });
  try {
    const headers = await parent(f);
    await f.app.inject({ method: 'PUT', url: path, headers, payload: { operationId: randomUUID(), expectedRevision: 0, config: { ...config, provider: 'xfyun', formulas: false, retries: 2, priceCents: 3.5 }, credentials: xfyun } });
    for (const error of ['auth', 'service', 'page', 'line', 'invalid'] as const) {
      mode = error;
      assert.equal((await f.app.inject({ method: 'PUT', url: `${path}/tests/${randomUUID()}`, headers, payload: { expectedRevision: 1, sample: 'school-v1' } })).statusCode, 202);
      const data = await finish(f, headers);
      assert.equal(data.tests[0].status, 'failed'); assert.equal(data.tests[0].attempts, 1);
      assert.deepEqual(data.tests[0].lines, []);
      assert.equal(JSON.stringify(data).includes(xfyun.secretKey), false); assert.equal(JSON.stringify(data).includes(xfyun.apiKey), false);
      if (error === 'auth') assert.match(data.tests[0].message, /系统时间/);
    }
    assert.equal(calls, 5);
    const data = (await f.app.inject({ url: path, headers })).json();
    assert.equal(data.usage.estimatedCents, 10.5);
  } finally { await f.close(); }
});

test('讯飞在途调用切换百度后保留原供应商结果，重试不会把旧凭据发送给新供应商', async () => {
  let resolveRequest: ((value: Response) => void) | undefined, calls = 0;
  const f = await familyFixture({ ocrHttp: async url => {
    assert.equal(url.host, 'api.xf-yun.com'); calls++;
    return new Promise(resolve => { resolveRequest = resolve; });
  } });
  try {
    const headers = await parent(f);
    const save = (expectedRevision: number, chosen: object, credentials: object) => f.app.inject({ method: 'PUT', url: path, headers, payload: { operationId: randomUUID(), expectedRevision, config: chosen, credentials } });
    await save(0, { ...config, provider: 'xfyun', formulas: false, retries: 2, priceCents: 3.5 }, xfyun);
    await f.app.inject({ method: 'PUT', url: `${path}/tests/${randomUUID()}`, headers, payload: { expectedRevision: 1, sample: 'school-v1' } });
    for (let i = 0; i < 100 && !resolveRequest; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(resolveRequest); await save(1, config, baidu);
    resolveRequest(new Response('server error', { status: 503 }));
    const stopped = await finish(f, headers);
    assert.equal(stopped.tests[0].status, 'stopped'); assert.equal(stopped.tests[0].provider, 'xfyun'); assert.equal(stopped.tests[0].attempts, 1);
    assert.equal(stopped.usage.estimatedCents, 3.5); assert.equal(calls, 1);
  } finally { resolveRequest?.(new Response(null, { status: 500 })); await f.close(); }
});
