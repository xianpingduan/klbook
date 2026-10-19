import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createApp } from '../../src/server/app.ts';
import { SpeechSocketStub } from './speech-fixture.ts';
import { auth, familyFixture } from './fixture.ts';
import { ocrParent, ocrPath } from './ocr-fixture.ts';
import { finishedSpeech, speechVendor, testWav } from './speech-fixture.ts';

const path = '/api/v1/admin/speech';
const credentials = { appId: 'speech-app', apiKey: 'K'.repeat(32), secretKey: 'S'.repeat(32) };

test('语音配置需要家长权限，保存不调用且独立于图片识别，凭据不回传，重试与冲突可区分', async () => {
  const f = await familyFixture();
  try {
    assert.equal((await f.app.inject({ url: path })).statusCode, 401);
    assert.equal((await f.app.inject({ url: path, headers: auth(f.first.token) })).statusCode, 403);
    const headers = await ocrParent(f);
    const initial = await f.app.inject({ url: path, headers });
    assert.equal(initial.statusCode, 200);
    const data = initial.json();
    const ocr = (await f.app.inject({ url: ocrPath, headers })).body;
    const edit = { operationId: randomUUID(), expectedRevision: data.revision, config: { ...data.config, enabled: true }, credentials };
    const saved = await f.app.inject({ method: 'PUT', url: path, headers, payload: edit });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(saved.json().credentialAvailable, true);
    assert.equal(saved.json().usage.attempts, 0);
    assert.equal(saved.json().tests.length, 0);
    for (const secret of Object.values(credentials)) assert.equal(saved.body.includes(secret), false);
    assert.equal((await f.app.inject({ method: 'PUT', url: path, headers, payload: edit })).json().revision, 1);
    assert.equal((await f.app.inject({ method: 'PUT', url: path, headers, payload: { ...edit, operationId: randomUUID() } })).statusCode, 409);
    assert.equal((await f.app.inject({ url: ocrPath, headers })).body, ocr);
  } finally { await f.close(); }
});

test('明确上传 WAV 后签名并分帧转写，响应丢失重放不重复调用且保留音频计量与结果', async () => {
  const vendor = speechVendor();
  const f = await familyFixture({ speechSocket: vendor.connect });
  try {
    const headers = await ocrParent(f);
    const initial = (await f.app.inject({ url: path, headers })).json();
    const saved = await f.app.inject({ method: 'PUT', url: path, headers, payload: { operationId: randomUUID(), expectedRevision: 0, config: { ...initial.config, enabled: true, priceCents: 2 }, credentials } });
    assert.equal(saved.statusCode, 200);
    assert.equal(vendor.sockets.length, 0);
    const url = `${path}/tests/${randomUUID()}?revision=1`, audio = testWav();
    const upload = () => f.app.inject({ method: 'PUT', url, headers: { ...headers, 'content-type': 'audio/wav' }, payload: audio });
    assert.equal((await upload()).statusCode, 202);
    assert.equal((await upload()).statusCode, 202);
    const result = await finishedSpeech(f, headers);
    assert.equal(result.tests[0]?.status, 'succeeded');
    assert.equal(result.tests[0]?.text, '我先读题，再列式。');
    assert.equal(result.tests[0]?.audioMs, 80);
    assert.equal(result.usage.audioMs, 80); assert.equal(result.usage.attempts, 1); assert.equal(result.usage.estimatedCents, 2);
    assert.equal(vendor.sockets.length, 1);
    const frames = vendor.sockets[0]!.frames;
    assert.equal(frames[0]?.common?.app_id, credentials.appId);
    assert.equal(frames[0]?.data.status, 0); assert.equal(frames.at(-1)?.data.status, 2);
    assert.deepEqual(Buffer.concat(frames.map(frame => Buffer.from(frame.data.audio ?? '', 'base64'))), audio.subarray(44));
    assert.equal(vendor.urls[0]?.origin, 'wss://iat-api.xfyun.cn');
    const signed = vendor.urls[0]!;
    const signature = createHmac('sha256', credentials.secretKey).update(`host: ${signed.host}\ndate: ${signed.searchParams.get('date')}\nGET /v2/iat HTTP/1.1`).digest('base64');
    assert.ok(Buffer.from(signed.searchParams.get('authorization')!, 'base64').toString().includes(`signature="${signature}"`));
    assert.equal((await f.app.inject({ method: 'PUT', url, headers: { ...headers, 'content-type': 'audio/wav' }, payload: testWav(40) })).statusCode, 409);
  } finally { await f.close(); }
});

async function configure(f: Awaited<ReturnType<typeof familyFixture>>, changes: Record<string, unknown> = {}, existingHeaders?: ReturnType<typeof auth>) {
  const headers = existingHeaders ?? await ocrParent(f), data = (await f.app.inject({ url: path, headers })).json();
  const saved = await f.app.inject({ method: 'PUT', url: path, headers, payload: { operationId: randomUUID(), expectedRevision: data.revision, config: { ...data.config, enabled: true, ...changes }, credentials } });
  assert.equal(saved.statusCode, 200, saved.body);
  return { headers, data: saved.json() };
}
const submit = (f: Pick<Awaited<ReturnType<typeof familyFixture>>, 'app'>, headers: ReturnType<typeof auth>, revision: number, payload = testWav()) => f.app.inject({ method: 'PUT', url: `${path}/tests/${randomUUID()}?revision=${revision}`, headers: { ...headers, 'content-type': 'audio/wav' }, payload });

test('停用禁止新测试，已发出的测试仍保存真实结果，重新启用不处理历史音频', async () => {
  let complete: (() => void) | undefined;
  const vendor = speechVendor(socket => { complete = () => socket.reply({ code: 0, data: { status: 2, result: { sn: 0, ws: [{ cw: [{ w: '在途结果' }] }] } } }); });
  const f = await familyFixture({ speechSocket: vendor.connect });
  try {
    const { headers, data } = await configure(f);
    assert.equal((await submit(f, auth(f.first.token), data.revision)).statusCode, 403);
    assert.equal((await submit(f, headers, data.revision)).statusCode, 202);
    while (!complete) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal((await submit(f, headers, data.revision)).statusCode, 409);
    const disabled = (await f.app.inject({ method: 'PUT', url: path, headers, payload: { operationId: randomUUID(), expectedRevision: data.revision, config: { ...data.config, enabled: false } } })).json();
    assert.equal(disabled.tests[0].status, 'running');
    complete();
    assert.equal((await finishedSpeech(f, headers)).tests[0]?.text, '在途结果');
    assert.equal((await submit(f, headers, disabled.revision)).statusCode, 422);
    await configure(f, {}, headers);
    assert.equal(vendor.sockets.length, 1);
    await f.app.close();
    const reopened = createApp({ dataDir: f.dataDir, speechSocket: vendor.connect });
    try {
      const value = (await reopened.inject({ url: path, headers })).json();
      assert.equal(value.tests[0].text, '在途结果'); assert.equal(value.usage.attempts, 1); assert.equal(value.credentialAvailable, true);
      assert.equal(vendor.sockets.length, 1);
    } finally { await reopened.close(); }
  } finally { await f.close(); }
});

test('动态修正替换原片段；格式错误与授权错误可理解且不回传供应商原始秘密', async () => {
  let mode = 'correction';
  const vendor = speechVendor(socket => {
    if (mode === 'correction') {
      socket.reply({ code: 0, data: { status: 1, result: { sn: 0, pgs: 'apd', ws: [{ cw: [{ w: '错' }, { w: '候选' }] }] } } });
      socket.reply({ code: 0, data: { status: 2, result: { sn: 1, pgs: 'rpl', rg: [0, 0], ws: [{ cw: [{ w: '正确' }] }] } } });
    } else if (mode === 'authorization') socket.reply({ code: 10005, message: credentials.secretKey });
    else socket.reply({ code: 0, data: { status: 2, result: { sn: 0, ws: 'invalid' } } });
  });
  const f = await familyFixture({ speechSocket: vendor.connect });
  try {
    const { headers, data } = await configure(f, { retries: 2 });
    await submit(f, headers, data.revision);
    assert.equal((await finishedSpeech(f, headers)).tests[0]?.text, '正确');
    mode = 'authorization'; await submit(f, headers, data.revision);
    const unauthorized = await finishedSpeech(f, headers);
    assert.equal(unauthorized.tests[0]?.status, 'failed'); assert.equal(unauthorized.tests[0]?.attempts, 1);
    assert.match(unauthorized.tests[0]!.message, /未获授权/); assert.equal(JSON.stringify(unauthorized).includes(credentials.secretKey), false);
    mode = 'malformed'; await submit(f, headers, data.revision);
    assert.match((await finishedSpeech(f, headers)).tests[0]!.message, /格式异常/);
  } finally { await f.close(); }
});

test('格式、超长、陈旧配置、月度次数与预算在发送前检查，失败重试也受额度约束', async () => {
  const vendor = speechVendor(socket => socket.reply({ code: 11202 }));
  const f = await familyFixture({ speechSocket: vendor.connect });
  try {
    const { headers, data } = await configure(f, { retries: 2, monthlyLimit: 1 });
    for (const bytes of [Buffer.from('not audio'), testWav(80, 44100), testWav(60001), testWav().subarray(0, 45)]) assert.equal((await submit(f, headers, data.revision, bytes)).statusCode, 422);
    assert.equal((await submit(f, headers, 0)).statusCode, 409);
    assert.equal(vendor.sockets.length, 0);
    await submit(f, headers, data.revision);
    const exhausted = await finishedSpeech(f, headers);
    assert.equal(exhausted.usage.attempts, 1); assert.match(exhausted.tests[0]!.message, /次数上限/);
    const updated = await configure(f, { monthlyLimit: 100, priceCents: 1, monthlyBudgetCents: 0 }, headers);
    assert.equal((await submit(f, headers, updated.data.revision)).statusCode, 422);
    assert.equal(vendor.sockets.length, 1);
  } finally { await f.close(); }
});

test('停用阻止自动重试，恢复不补发；超时和停服保留结果不确定与估算费用', async () => {
  const vendor = speechVendor(socket => socket.reply({ code: 11202 }));
  const f = await familyFixture({ speechSocket: vendor.connect });
  try {
    const { headers, data } = await configure(f, { retries: 2 });
    await submit(f, headers, data.revision);
    await configure(f, { enabled: false }, headers);
    const stopped = await finishedSpeech(f, headers);
    assert.equal(stopped.tests[0]?.status, 'stopped'); assert.ok(vendor.sockets.length <= 1);
  } finally { await f.close(); }
  const silent = speechVendor(() => {}), waiting = await familyFixture({ speechSocket: silent.connect });
  try {
    const { headers, data } = await configure(waiting, { timeoutSeconds: 5, priceCents: 3 });
    await submit(waiting, headers, data.revision);
    const timed = await finishedSpeech(waiting, headers);
    assert.match(timed.tests[0]!.message, /超时/); assert.equal(timed.usage.estimatedCents, 3); assert.ok(silent.sockets[0]?.closed);
    await submit(waiting, headers, data.revision);
    await waiting.app.close();
    const reopened = createApp({ dataDir: waiting.dataDir, speechSocket: silent.connect });
    try {
      const after = (await reopened.inject({ url: path, headers })).json();
      assert.equal(after.tests[0].status, 'interrupted'); assert.equal(after.usage.estimatedCents, 6); assert.equal(silent.sockets.length, 2);
    } finally { await reopened.close(); }
  } finally { await waiting.close(); }
});

test('加密保存并在凭据密钥缺失时阻止重新创建而仍可停用语音服务', async () => {
  const f = await familyFixture();
  try {
    const { headers } = await configure(f);
    for (const file of ['family.sqlite', 'family.sqlite-wal']) {
      const bytes = await readFile(join(f.dataDir, file));
      assert.equal(bytes.includes(Buffer.from(credentials.secretKey)), false);
    }
    await rename(join(f.dataDir, 'service-credentials.key'), join(f.dataDir, 'saved-key'));
    const missing = (await f.app.inject({ url: path, headers })).json();
    assert.equal(missing.credentialAvailable, false);
    assert.equal((await submit(f, headers, missing.revision)).statusCode, 503);
    const disabled = await f.app.inject({ method: 'PUT', url: path, headers, payload: { operationId: randomUUID(), expectedRevision: missing.revision, config: { ...missing.config, enabled: false } } });
    assert.equal(disabled.statusCode, 200);
    const ocr = (await f.app.inject({ url: ocrPath, headers })).json();
    const overwrite = await f.app.inject({ method: 'PUT', url: ocrPath, headers, payload: { operationId: randomUUID(), expectedRevision: ocr.revision, config: ocr.config, credentials: { apiKey: 'fake-ocr-key', secretKey: 'fake-ocr-secret' } } });
    assert.equal(overwrite.statusCode, 503);
    await rename(join(f.dataDir, 'saved-key'), join(f.dataDir, 'service-credentials.key'));
    assert.equal((await f.app.inject({ url: path, headers })).json().credentialAvailable, true);
  } finally { await f.close(); }
});

test('8 kHz WAV 允许额外元数据块，英文按所选语言发送，早停不能记为完整成功', async () => {
  const vendor = speechVendor();
  const f = await familyFixture({ speechSocket: vendor.connect });
  try {
    const { headers, data } = await configure(f, { language: 'en_us' });
    const source = testWav(80, 8000), metadata = Buffer.alloc(12);
    metadata.write('JUNK'); metadata.writeUInt32LE(4, 4);
    const audio = Buffer.concat([source.subarray(0, 36), metadata, source.subarray(36)]);
    audio.writeUInt32LE(audio.length - 8, 4);
    assert.equal((await submit(f, headers, data.revision, audio)).statusCode, 202);
    assert.equal((await finishedSpeech(f, headers)).tests[0]?.sampleRate, 8000);
    assert.equal(vendor.sockets[0]?.frames[0]?.business?.language, 'en_us');
    assert.equal(vendor.sockets[0]?.frames[0]?.data.format, 'audio/L16;rate=8000');
    assert.deepEqual(Buffer.concat(vendor.sockets[0]!.frames.map(frame => Buffer.from(frame.data.audio ?? '', 'base64'))), source.subarray(44));
  } finally { await f.close(); }
  const early = await familyFixture({ speechSocket: () => {
    const socket = new SpeechSocketStub(() => {});
    socket.addEventListener('open', () => setTimeout(() => socket.reply({ code: 0, data: { status: 2 } }), 5));
    return socket;
  } });
  try {
    const { headers, data } = await configure(early);
    await submit(early, headers, data.revision, testWav(300));
    const result = await finishedSpeech(early, headers);
    assert.equal(result.tests[0]?.status, 'failed'); assert.match(result.tests[0]!.message, /未完整处理/);
  } finally { await early.close(); }
});
