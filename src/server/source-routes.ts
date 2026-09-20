import type { FastifyInstance } from 'fastify';
import type { SourceEdit } from '../shared/sources.ts';
import type { FamilyAccess } from './family-access.ts';
import type { Sources } from './sources.ts';

export function sourceRoutes(app: FastifyInstance, access: FamilyAccess, sources: Sources) {
  const token = (value: string | undefined) => /^Bearer [A-Za-z0-9_-]{43}$/.test(value ?? '') ? value!.slice(7) : '';
  app.get('/api/v1/collection/sources', async request => {
    access.home(token(request.headers.authorization));
    return sources.list();
  });
  app.register(async routes => {
    const parent = (headers: { authorization?: string; 'x-parent-authorization'?: unknown }) => access.parentHome(token(headers.authorization), String(headers['x-parent-authorization'] ?? ''));
    routes.addHook('onRequest', async request => { parent(request.headers); });
    routes.get('/sources', async () => sources.list(true));
    routes.put<{ Params: { id: string }; Body: SourceEdit }>('/sources/:id', { schema: {
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      body: { type: 'object', additionalProperties: false, required: ['operationId', 'expectedRevision', 'name', 'active'], properties: {
        operationId: { type: 'string', format: 'uuid' }, expectedRevision: { type: 'integer', minimum: 0 },
        name: { type: 'string', minLength: 1, maxLength: 200 }, active: { type: 'boolean' }
      } }
    } }, async request => sources.save(() => parent(request.headers), request.params.id, request.body));
  }, { prefix: '/api/v1/admin' });
}
