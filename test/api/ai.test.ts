import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { auth, familyFixture } from './fixture.ts';
import { ocrParent } from './ocr-fixture.ts';
import { aiReply, aiVendor, finishedAi } from './ai-fixture.ts';
import { createApp } from '../../src/server/app.ts';
import { setTimeout as pause } from 'node:timers/promises';
import { readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

const path = '/api/v1/admin/ai';
const credentials = { apiPassword: 'test-spark-password:keep-private' };

test('AI 超时和停服保留结果不确定的估算费用，重启不补发也不重复计量', async () => {
  const vendor = aiVendor(({ init }) => new Promise((_resolve, reject) => {
    if (init.signal?.aborted) reject(new Error('aborted'));
    else init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }));
  const f = await familyFixture({ aiHttp: vendor.http });
  try {
    let { headers, data } = await configure(f, { timeoutSeconds: 5, priceCents: 3 });
    assert.equal((await submit(f, headers, data.revision)).statusCode, 202);
    const timeout = await finishedAi(f, headers);
    assert.match(timeout.tests[0]!.message, /超时/); assert.equal(timeout.tests[0]?.status, 'failed');
    assert.equal(timeout.usage.estimatedCents, 3); assert.equal(timeout.usage.reportedAttempts, 0);
    ({ data } = await configure(f, { timeoutSeconds: 120 }, headers));
    const url = `${path}/tests/${randomUUID()}`, payload = { expectedRevision: data.revision, prompt: '停服测试' };
    assert.equal((await f.app.inject({ method: 'PUT', url, headers, payload })).statusCode, 202);
    for (let i = 0; vendor.calls.length < 2 && i < 50; i++) await pause(10);
    assert.equal(vendor.calls.length, 2);
    await f.app.close();
    const reopened = createApp({ dataDir: f.dataDir, aiHttp: vendor.http });
    try {
      const restored = (await reopened.inject({ url: path, headers })).json();
      assert.equal(restored.tests[0].status, 'interrupted'); assert.equal(restored.usage.attempts, 2); assert.equal(restored.usage.estimatedCents, 6);
      assert.equal((await reopened.inject({ method: 'PUT', url, headers, payload })).statusCode, 202);
      assert.equal(vendor.calls.length, 2);
    } finally { await reopened.close(); }
  } finally { await f.close(); }
});

test('家长授权到期后 AI 自动重试被拒绝，重新验证可查看已保存错误', async () => {
  const vendor = aiVendor(() => { f.advance(5 * 60000 + 1); return Response.json({}, { status: 429 }); });
  const f = await familyFixture({ aiHttp: vendor.http });
  try {
    const { headers, data } = await configure(f, { retries: 2 });
    assert.equal((await submit(f, headers, data.revision)).statusCode, 202);
    const renewed = await ocrParent(f), result = await finishedAi(f, renewed);
    assert.equal(result.tests[0]?.status, 'stopped'); assert.equal(vendor.calls.length, 1);
    assert.equal((await submit(f, headers, data.revision)).statusCode, 403);
    assert.equal(result.usage.attempts, 1);
  } finally { await f.close(); }
});

test('AI 凭据加密保存，密钥丢失不能借另一能力重建，恢复配套密钥后配置可用', async () => {
  const f = await familyFixture();
  try {
    const { headers, data } = await configure(f);
    const key = join(f.dataDir, 'service-credentials.key');
    const dbBytes = Buffer.concat(await Promise.all(['family.sqlite', 'family.sqlite-wal'].map(name => readFile(join(f.dataDir, name)))));
    assert.equal(dbBytes.includes(Buffer.from(credentials.apiPassword)), false);
    await rename(key, `${key}.backup`);
    const disabled = await f.app.inject({ method: 'PUT', url: path, headers, payload: { operationId: randomUUID(), expectedRevision: data.revision, config: { ...data.config, enabled: false } } });
    assert.equal(disabled.statusCode, 200); assert.equal(disabled.json().credentialAvailable, false);
    const replaced = await f.app.inject({ method: 'PUT', url: path, headers, payload: { operationId: randomUUID(), expectedRevision: disabled.json().revision, config: disabled.json().config, credentials } });
    assert.equal(replaced.statusCode, 503);
    const otherCredentials = { ocr: { apiKey: 'fake-ocr', secretKey: 'fake-secret' }, speech: { appId: 'speech-app', apiKey: 'K'.repeat(32), secretKey: 'S'.repeat(32) } };
    for (const name of ['ocr', 'speech'] as const) {
      const other = (await f.app.inject({ url: `/api/v1/admin/${name}`, headers })).json();
      const changed = await f.app.inject({ method: 'PUT', url: `/api/v1/admin/${name}`, headers, payload: { operationId: randomUUID(), expectedRevision: other.revision, config: other.config, credentials: otherCredentials[name] } });
      assert.equal(changed.statusCode, 503, changed.body);
    }
    await rename(`${key}.backup`, key);
    assert.equal((await f.app.inject({ url: path, headers })).json().credentialAvailable, true);
  } finally { await f.close(); }
});

test('AI 测试发送前验证文字和权限，自动重试受次数、预算与停用约束', async () => {
  let reply: () => Promise<Response> | Response = () => Response.json({}, { status: 429 });
  const vendor = aiVendor(() => reply()), f = await familyFixture({ aiHttp: vendor.http });
  try {
    let { headers, data } = await configure(f, { retries: 2, monthlyLimit: 1 });
    assert.equal((await submit(f, auth(f.first.token), data.revision)).statusCode, 403);
    assert.equal((await submit(f, headers, data.revision, '  ')).statusCode, 400);
    assert.equal((await submit(f, headers, data.revision, '字'.repeat(2001))).statusCode, 400);
    assert.equal((await submit(f, headers, 0)).statusCode, 409);
    assert.equal(vendor.calls.length, 0);
    assert.equal((await submit(f, headers, data.revision)).statusCode, 202);
    let result = await finishedAi(f, headers);
    assert.equal(result.tests[0]?.status, 'stopped'); assert.match(result.tests[0]!.message, /次数上限/);
    assert.equal(vendor.calls.length, 1); assert.equal(result.usage.estimatedCents, 0);
    assert.equal((await submit(f, headers, data.revision)).statusCode, 422);
    ({ data } = await configure(f, { monthlyLimit: 10, monthlyBudgetCents: 2, priceCents: 1.5 }, headers));
    reply = () => Response.json({}, { status: 503 });
    assert.equal((await submit(f, headers, data.revision)).statusCode, 202);
    result = await finishedAi(f, headers);
    assert.equal(result.tests[0]?.status, 'stopped'); assert.match(result.tests[0]!.message, /估算预算/);
    assert.equal(vendor.calls.length, 2); assert.equal(result.usage.estimatedCents, 1.5);
    ({ data } = await configure(f, { monthlyBudgetCents: 1000, priceCents: 0 }, headers));
    reply = async () => {
      const disabled = await f.app.inject({ method: 'PUT', url: path, headers, payload: { operationId: randomUUID(), expectedRevision: data.revision, config: { ...data.config, enabled: false } } });
      assert.equal(disabled.statusCode, 200); return Response.json({}, { status: 503 });
    };
    assert.equal((await submit(f, headers, data.revision)).statusCode, 202);
    result = await finishedAi(f, headers);
    assert.equal(result.tests[0]?.status, 'stopped'); assert.match(result.tests[0]!.message, /停用/);
    assert.equal(vendor.calls.length, 3);
    await configure(f, { enabled: true }, headers); await pause(600); assert.equal(vendor.calls.length, 3);
  } finally { await f.close(); }
});

test('AI 错误不回显供应商秘密，缺失或无效计量不伪报零 token，截断文字明确提示', async () => {
  let reply = aiReply;
  const vendor = aiVendor(() => reply()), f = await familyFixture({ aiHttp: vendor.http });
  try {
    const { headers, data } = await configure(f, { priceCents: 2 });
    const cases = [
      { reply: () => Response.json({ error: { message: credentials.apiPassword } }, { status: 401 }), status: 'failed', message: '鉴权', estimated: 0 },
      { reply: () => Response.json({ code: 10013, message: credentials.apiPassword }), status: 'failed', message: '业务错误', estimated: 0 },
      { reply: () => new Response('invalid ' + credentials.apiPassword), status: 'failed', message: '无法读取', estimated: 2 },
      { reply: () => Response.json({ code: 0, choices: [{ message: { role: 'assistant', content: '缺少计量仍有文字' } }] }), status: 'succeeded', message: '测试成功', estimated: 4 },
      { reply: () => Response.json({ code: 0, choices: [{ message: { role: 'assistant', content: '计量无效仍保留文字' } }], usage: { prompt_tokens: -1, completion_tokens: 3, total_tokens: 2 } }), status: 'succeeded', message: '测试成功', estimated: 6 },
      { reply: () => Response.json({ code: 0, choices: [{ message: { role: 'assistant', content: credentials.apiPassword }, finish_reason: 'length' }], usage: { prompt_tokens: 28, completion_tokens: 19, total_tokens: 47 } }), status: 'succeeded', message: '部分文字', estimated: 8 },
      { reply: () => Response.json({ code: 0, choices: [{ message: { role: 'assistant', content: 'x'.repeat(1024 * 1024) } }] }), status: 'failed', message: '无法读取', estimated: 10 }
    ];
    for (const item of cases) {
      reply = item.reply;
      assert.equal((await submit(f, headers, data.revision)).statusCode, 202);
      const result = await finishedAi(f, headers);
      assert.equal(result.tests[0]?.status, item.status);
      assert.ok(result.tests[0]?.message.includes(item.message));
      assert.equal(result.usage.estimatedCents, item.estimated);
      assert.equal(JSON.stringify(result).includes(credentials.apiPassword), false);
      if (item.message !== '部分文字') assert.equal(result.tests[0]?.totalTokens, null);
    }
    const last = (await f.app.inject({ url: path, headers })).json();
    assert.equal(last.usage.attempts, 7); assert.equal(last.usage.reportedAttempts, 1); assert.equal(last.usage.totalTokens, 47);
    assert.equal(vendor.calls.length, 7);
  } finally { await f.close(); }
});

test('AI 学习配置只供家长管理，保存不调用，凭据不回显，切换模型独立保管且不影响其他能力', async () => {
  const f = await familyFixture();
  try {
    assert.equal((await f.app.inject({ url: path })).statusCode, 401);
    assert.equal((await f.app.inject({ url: path, headers: auth(f.first.token) })).statusCode, 403);
    const headers = await ocrParent(f);
    const initial = await f.app.inject({ url: path, headers });
    assert.equal(initial.statusCode, 200);
    const others = await Promise.all(['/ocr', '/speech'].map(async name => (await f.app.inject({ url: `/api/v1/admin${name}`, headers })).body));
    const edit = { operationId: randomUUID(), expectedRevision: 0, config: initial.json().config, credentials };
    const saved = await f.app.inject({ method: 'PUT', url: path, headers, payload: edit });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(saved.json().credentialAvailable, true);
    assert.equal(saved.json().config.enabled, false);
    assert.equal(saved.json().usage.attempts, 0);
    assert.deepEqual(saved.json().tests, []);
    assert.equal(saved.body.includes(credentials.apiPassword), false);
    assert.equal((await f.app.inject({ method: 'PUT', url: path, headers, payload: edit })).json().revision, 1);
    assert.equal((await f.app.inject({ method: 'PUT', url: path, headers, payload: { ...edit, operationId: randomUUID() } })).statusCode, 409);
    const switched = await f.app.inject({ method: 'PUT', url: path, headers, payload: { operationId: randomUUID(), expectedRevision: 1, config: { ...edit.config, model: '4.0Ultra' } } });
    assert.equal(switched.statusCode, 200, switched.body);
    assert.equal(switched.json().credentialsConfigured, false);
    assert.equal(switched.json().models.lite.credentialsConfigured, true);
    const enabled = await f.app.inject({ method: 'PUT', url: path, headers, payload: { operationId: randomUUID(), expectedRevision: 2, config: { ...edit.config, model: '4.0Ultra', enabled: true } } });
    assert.equal(enabled.statusCode, 422);
    assert.deepEqual(await Promise.all(['/ocr', '/speech'].map(async name => (await f.app.inject({ url: `/api/v1/admin${name}`, headers })).body)), others);
  } finally { await f.close(); }
});

async function configure(f: Awaited<ReturnType<typeof familyFixture>>, changes: Record<string, unknown> = {}, existingHeaders?: ReturnType<typeof auth>) {
  const headers = existingHeaders ?? await ocrParent(f), initial = (await f.app.inject({ url: path, headers })).json();
  const saved = await f.app.inject({ method: 'PUT', url: path, headers, payload: { operationId: randomUUID(), expectedRevision: initial.revision, config: { ...initial.config, enabled: true, ...changes }, credentials } });
  assert.equal(saved.statusCode, 200, saved.body);
  return { headers, data: saved.json() };
}
const submit = (f: Pick<Awaited<ReturnType<typeof familyFixture>>, 'app'>, headers: ReturnType<typeof auth>, revision: number, prompt = '测试文字') => f.app.inject({ method: 'PUT', url: `${path}/tests/${randomUUID()}`, headers, payload: { expectedRevision: revision, prompt } });

test('停用保留在途结果，恢复不补发；切换模型只使用对应凭据并关闭额外联网搜索', async () => {
  let resolveReply!: (value: Response) => void;
  const waiting = new Promise<Response>(resolve => { resolveReply = resolve; });
  const vendor = aiVendor(() => vendor.calls.length === 1 ? waiting : aiReply());
  const f = await familyFixture({ aiHttp: vendor.http });
  try {
    const { headers, data } = await configure(f);
    assert.equal((await submit(f, headers, data.revision)).statusCode, 202);
    for (let i = 0; !vendor.calls.length && i < 50; i++) await pause(10);
    assert.equal(vendor.calls.length, 1);
    const disabled = await f.app.inject({ method: 'PUT', url: path, headers, payload: { operationId: randomUUID(), expectedRevision: 1, config: { ...data.config, enabled: false } } });
    assert.equal(disabled.statusCode, 200);
    assert.equal(disabled.json().tests[0].status, 'running');
    resolveReply(aiReply());
    assert.equal((await finishedAi(f, headers)).tests[0]?.status, 'succeeded');
    assert.equal((await submit(f, headers, 2)).statusCode, 422);
    const ultraPassword = 'ultra-only:credential';
    const switched = await f.app.inject({ method: 'PUT', url: path, headers, payload: { operationId: randomUUID(), expectedRevision: 2, config: { ...data.config, model: '4.0Ultra' }, credentials: { apiPassword: ultraPassword } } });
    assert.equal(switched.statusCode, 200, switched.body); assert.equal(vendor.calls.length, 1);
    assert.equal((await submit(f, headers, 3)).statusCode, 202);
    const result = await finishedAi(f, headers);
    assert.equal(result.tests[0]?.model, '4.0Ultra'); assert.equal(result.tests[1]?.model, 'lite');
    assert.equal(result.usage.attempts, 2);
    assert.equal(new Headers(vendor.calls[1]!.init.headers).get('authorization'), `Bearer ${ultraPassword}`);
    const payload = JSON.parse(String(vendor.calls[1]!.init.body));
    assert.equal(payload.model, '4.0Ultra'); assert.deepEqual(payload.tools, [{ type: 'web_search', web_search: { enable: false } }]); assert.equal(payload.tool_choice, 'none');
    const back = await f.app.inject({ method: 'PUT', url: path, headers, payload: { operationId: randomUUID(), expectedRevision: 3, config: data.config } });
    assert.equal(back.json().credentialAvailable, true);
    assert.equal((await submit(f, headers, 4)).statusCode, 202); await finishedAi(f, headers);
    assert.equal(new Headers(vendor.calls[2]!.init.headers).get('authorization'), `Bearer ${credentials.apiPassword}`);
  } finally { resolveReply(aiReply()); await f.close(); }
});

test('明确发送测试文字，按所选模型调用，记录 token 与结果，响应丢失重试和重启均不重复调用', async () => {
  const vendor = aiVendor(), f = await familyFixture({ aiHttp: vendor.http });
  try {
    const headers = await ocrParent(f), initial = (await f.app.inject({ url: path, headers })).json();
    const saved = await f.app.inject({ method: 'PUT', url: path, headers, payload: { operationId: randomUUID(), expectedRevision: 0, config: { ...initial.config, enabled: true, priceCents: 1.5 }, credentials } });
    assert.equal(saved.statusCode, 200, saved.body); assert.equal(vendor.calls.length, 0);
    const url = `${path}/tests/${randomUUID()}`, payload = { expectedRevision: 1, prompt: '请提示如何计算长方形周长。' };
    const submit = () => f.app.inject({ method: 'PUT', url, headers, payload });
    assert.equal((await submit()).statusCode, 202);
    assert.equal((await submit()).statusCode, 202);
    const result = await finishedAi(f, headers);
    assert.equal(result.tests[0]?.status, 'succeeded');
    assert.equal(result.tests[0]?.text, '先想想长方形有几条长边和几条短边。');
    assert.equal(result.tests[0]?.prompt, payload.prompt);
    assert.equal(result.tests[0]?.model, 'lite');
    assert.equal(result.tests[0]?.totalTokens, 47);
    assert.ok(result.tests[0]!.durationMs! >= 0);
    assert.equal(result.usage.attempts, 1); assert.equal(result.usage.reportedAttempts, 1);
    assert.equal(result.usage.promptTokens, 28); assert.equal(result.usage.completionTokens, 19); assert.equal(result.usage.totalTokens, 47); assert.equal(result.usage.estimatedCents, 1.5);
    assert.equal(vendor.calls.length, 1);
    const call = vendor.calls[0]!;
    assert.equal(call.url.href, 'https://spark-api-open.xf-yun.com/v1/chat/completions');
    assert.equal(new Headers(call.init.headers).get('authorization'), `Bearer ${credentials.apiPassword}`);
    assert.deepEqual(JSON.parse(String(call.init.body)), { model: 'lite', messages: [{ role: 'user', content: payload.prompt }], stream: false, max_tokens: 512 });
    assert.equal(call.init.redirect, 'error');
    assert.equal((await f.app.inject({ method: 'PUT', url, headers, payload: { ...payload, prompt: '其他内容' } })).statusCode, 409);
    await f.app.close();
    const reopened = createApp({ dataDir: f.dataDir, aiHttp: vendor.http });
    try {
      const restored = await reopened.inject({ url: path, headers });
      assert.equal(restored.json().tests[0].text, result.tests[0]?.text);
      assert.equal((await reopened.inject({ method: 'PUT', url, headers, payload })).statusCode, 202);
      assert.equal(vendor.calls.length, 1);
    } finally { await reopened.close(); }
  } finally { await f.close(); }
});
