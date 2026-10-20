import type { FastifyInstance } from 'fastify';
import type { FamilyAccess } from './family-access.ts';
import type { Backups } from './backups.ts';
export function backupRoutes(app: FastifyInstance, access: FamilyAccess, backups: Backups) {
  app.register(async routes => {
    const authorize = (headers: { authorization?: string; 'x-parent-authorization'?: unknown }) => access.parentHome(/^Bearer [A-Za-z0-9_-]{43}$/.test(headers.authorization ?? '') ? headers.authorization!.slice(7) : '', String(headers['x-parent-authorization'] ?? ''));
    routes.addHook('onRequest', async request => { authorize(request.headers); });
    const revision = { type: 'integer', minimum: 0 };
    routes.get('/', async () => backups.settings());
    routes.put<{ Body: { directory: string; expectedRevision: number } }>('/settings', { schema: { body: {
      type: 'object', additionalProperties: false, required: ['directory', 'expectedRevision'],
      properties: { directory: { type: 'string', minLength: 1, maxLength: 1024 }, expectedRevision: revision }
    } } }, request => backups.configure(() => authorize(request.headers), request.body.directory, request.body.expectedRevision));
    const params = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } };
    routes.put<{ Params: { id: string }; Body: { expectedRevision: number } }>('/runs/:id', { schema: { params, body: {
      type: 'object', additionalProperties: false, required: ['expectedRevision'], properties: { expectedRevision: revision }
    } } }, async (request, reply) => reply.code(202).send(backups.start(() => authorize(request.headers), request.params.id, request.body.expectedRevision)));
    routes.get<{ Params: { id: string } }>('/runs/:id', { schema: { params } }, async request => backups.status(request.params.id));
  }, { prefix: '/api/v1/admin/backups' });
}
