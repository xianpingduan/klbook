import type { FastifyInstance } from 'fastify';
import type { Readable } from 'node:stream';
import type { FamilyAccess } from './family-access.ts';
import type { Imports } from './imports.ts';

export function importRoutes(app: FastifyInstance, access: FamilyAccess, imports: Imports) {
  app.register(async routes => {
    const authorize = (headers: { authorization?: string; 'x-parent-authorization'?: unknown }) => access.parentHome(/^Bearer [A-Za-z0-9_-]{43}$/.test(headers.authorization ?? '') ? headers.authorization!.slice(7) : '', String(headers['x-parent-authorization'] ?? ''));
    const params = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } };
    routes.addHook('onRequest', async request => { authorize(request.headers); });
    routes.addContentTypeParser('application/zip', (_request, payload, done) => done(null, payload));
    routes.put<{ Params: { id: string }; Body: Readable }>('/:id', { schema: { params } }, async request => imports.upload(() => authorize(request.headers), request.params.id, request.body));
    routes.get<{ Params: { id: string } }>('/:id', { schema: { params } }, async request => imports.status(() => authorize(request.headers), request.params.id));
    routes.post<{ Params: { id: string }; Body: { previewToken: string } }>('/:id/confirm', { schema: { params, body: { type: 'object', additionalProperties: false, required: ['previewToken'], properties: { previewToken: { type: 'string', pattern: '^[a-f0-9]{64}$' } } } } }, async request => imports.confirm(() => authorize(request.headers), request.params.id, request.body.previewToken));
    routes.delete<{ Params: { id: string } }>('/:id', { schema: { params } }, async (request, reply) => { await imports.remove(() => authorize(request.headers), request.params.id); return reply.code(204).send(); });
  }, { prefix: '/api/v1/admin/imports' });
}
