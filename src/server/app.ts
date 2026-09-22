import Fastify from 'fastify';
import cors from '@fastify/cors';
import staticFiles from '@fastify/static';
import type { LoginInput, RecoveryInput, SetupInput } from '../shared/contracts.ts';
import { AccessError, FamilyAccess } from './family-access.ts';
import { openDatabase } from './database.ts';
import { CollectionStore } from './collection-store.ts';
import { collectionRoutes } from './collection-routes.ts';
import { Sources } from './sources.ts';
import { sourceRoutes } from './source-routes.ts';
import { pages } from '../shared/app-routes.ts';

export function createApp(options: { dataDir: string; now?: () => number; allowedOrigins?: string[]; staticDir?: string }) {
  const db = openDatabase(options.dataDir);
  const access = new FamilyAccess(db, options.dataDir, options.now);
  const collection = new CollectionStore(db, options.dataDir, options.now);
  const app = Fastify({ bodyLimit: 16 * 1024, logger: false, ajv: { customOptions: { removeAdditional: false, coerceTypes: false } } });
  const origins = options.allowedOrigins ?? ['http://127.0.0.1:8787', 'http://localhost:8787', 'http://127.0.0.1:5173'];
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self' https: http://127.0.0.1:* http://localhost:*; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (request.headers.origin && !origins.includes(request.headers.origin)) throw new AccessError(403, '此网页来源未获允许');
  });
  app.register(cors, { origin: origins, methods: ['GET', 'POST', 'PUT', 'DELETE'], allowedHeaders: ['Content-Type', 'Authorization', 'X-Parent-Authorization', 'Idempotency-Key'], credentials: false });
  app.addHook('preHandler', async request => {
    if (request.method === 'POST' && ['/api/v1/setup', '/api/v1/sessions', '/api/v1/recovery', '/api/v1/admin/grants'].includes(request.routeOptions.url ?? '')) {
      access.limitAttempt(request.routeOptions.url!, request.ip);
    }
  });
  app.addHook('onClose', async () => db.close());
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AccessError) return reply.code(error.statusCode).send({ message: error.message });
    if (error instanceof Error && 'validation' in error) return reply.code(400).send({ message: '请检查填写内容' });
    if (error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500) return reply.code(error.statusCode).send({ message: '请求格式不正确' });
    return reply.code(500).send({ message: '本地服务暂时无法处理，请稍后重试' });
  });
  const text = (maxLength: number, minLength = 1) => ({ type: 'string', minLength, maxLength, pattern: '\\S' });
  const bearer = (value: string | undefined) => /^Bearer [A-Za-z0-9_-]{43}$/.test(value ?? '') ? value!.slice(7) : '';
  app.get('/api/v1/info', async () => access.info());
  app.post<{ Body: SetupInput }>('/api/v1/setup', { schema: { body: {
    type: 'object', required: ['setupCode', 'username', 'password', 'learnerName', 'deviceName'], additionalProperties: false,
    properties: { setupCode: text(128), username: text(64), password: text(128, 12), learnerName: text(64), deviceName: text(64) }
  } } }, async (request, reply) => reply.code(201).send(await access.setup(request.body)));
  app.get('/api/v1/home', async request => access.home(bearer(request.headers.authorization)));
  app.post<{ Body: LoginInput }>('/api/v1/sessions', { schema: { body: {
    type: 'object', required: ['username', 'password', 'deviceName'], additionalProperties: false,
    properties: { username: text(64), password: text(128, 12), deviceName: text(64) }
  } } }, async (request, reply) => reply.code(201).send(await access.login(request.body)));
  app.delete('/api/v1/sessions/current', async (request, reply) => {
    access.logout(bearer(request.headers.authorization));
    return reply.code(204).send();
  });
  app.post<{ Body: { password: string } }>('/api/v1/admin/grants', { schema: { body: {
    type: 'object', required: ['password'], additionalProperties: false, properties: { password: text(128, 12) }
  } } }, async (request, reply) => reply.code(201).send(await access.unlock(bearer(request.headers.authorization), request.body.password)));
  app.delete('/api/v1/admin/grants', async (request, reply) => {
    access.lock(bearer(request.headers.authorization), String(request.headers['x-parent-authorization'] ?? ''));
    return reply.code(204).send();
  });
  app.get('/api/v1/admin/devices', async request => access.devices(bearer(request.headers.authorization), String(request.headers['x-parent-authorization'] ?? '')));
  app.post('/api/v1/admin/recovery-code', async request => access.rotateRecoveryCode(bearer(request.headers.authorization), String(request.headers['x-parent-authorization'] ?? '')));
  app.delete<{ Params: { id: string } }>('/api/v1/admin/devices/:id', async (request, reply) => {
    access.revoke(bearer(request.headers.authorization), String(request.headers['x-parent-authorization'] ?? ''), request.params.id);
    return reply.code(204).send();
  });
  app.post<{ Body: RecoveryInput }>('/api/v1/recovery', { schema: { body: {
    type: 'object', required: ['recoveryCode', 'newPassword', 'deviceName'], additionalProperties: false,
    properties: { recoveryCode: text(128), newPassword: text(128, 12), deviceName: text(64) }
  } } }, async (request, reply) => reply.code(201).send(await access.recover(request.body)));
  collectionRoutes(app, access, collection);
  sourceRoutes(app, access, new Sources(db));
  if (options.staticDir) {
    app.register(staticFiles, { root: options.staticDir, index: 'index.html' });
    for (const path of Object.keys(pages)) app.get(path, async (_request, reply) => reply.sendFile('index.html'));
  }
  return app;
}
