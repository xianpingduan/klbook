import type { FastifyInstance } from 'fastify';
import type { FamilyAccess } from './family-access.ts';
import type { TrashStore } from './trash.ts';
import type { TrashChange } from '../shared/trash.ts';

export function trashRoutes(app: FastifyInstance, access: FamilyAccess, trash: TrashStore) {
  app.get('/api/v1/collection/deleted-questions', async request => trash.deleted(access.home(/^Bearer [A-Za-z0-9_-]{43}$/.test(request.headers.authorization ?? '') ? request.headers.authorization!.slice(7) : '').library.id));
  app.register(async routes => {
    const authorize = (headers: { authorization?: string; 'x-parent-authorization'?: unknown }) => access.parentHome(/^Bearer [A-Za-z0-9_-]{43}$/.test(headers.authorization ?? '') ? headers.authorization!.slice(7) : '', String(headers['x-parent-authorization'] ?? ''));
    routes.addHook('onRequest', async request => { authorize(request.headers); });
    routes.get<{ Querystring: { offset?: string } }>('/', { schema: { querystring: { type: 'object', additionalProperties: false, properties: { offset: { type: 'string', pattern: '^[0-9]{1,7}$' } } } } }, async request => { await trash.sweep(); return trash.list(authorize(request.headers).library.id, Number(request.query.offset ?? 0)); });
    routes.post('/cleanup', async request => { await trash.sweep(); return trash.list(authorize(request.headers).library.id); });
    routes.put<{ Params: { id: string }; Body: TrashChange }>('/:id', { schema: {
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      body: { type: 'object', additionalProperties: false, required: ['operationId', 'expectedRevision', 'action'], properties: {
        operationId: { type: 'string', format: 'uuid' }, expectedRevision: { type: 'integer', minimum: 1 }, action: { enum: ['trash', 'restore', 'purge'] }, confirm: { type: 'boolean' }
      } }
    } }, async request => { const result = trash.change(() => authorize(request.headers), request.params.id, request.body); await trash.sweep(); authorize(request.headers); return result; });
  }, { prefix: '/api/v1/admin/trash' });
}
