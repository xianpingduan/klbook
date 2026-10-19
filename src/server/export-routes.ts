import type { FastifyInstance } from 'fastify';
import type { FamilyAccess } from './family-access.ts';
import type { Exports } from './exports.ts';

export function exportRoutes(app: FastifyInstance, access: FamilyAccess, exports: Exports) {
  app.register(async routes => {
    const authorize = (headers: { authorization?: string; 'x-parent-authorization'?: unknown }) => access.parentHome(/^Bearer [A-Za-z0-9_-]{43}$/.test(headers.authorization ?? '') ? headers.authorization!.slice(7) : '', String(headers['x-parent-authorization'] ?? ''));
    const params = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } };
    routes.addHook('onRequest', async request => { authorize(request.headers); });
    routes.get('/', async request => exports.preview(() => authorize(request.headers)));
    routes.put<{ Params: { id: string }; Body: { previewToken: string } }>('/:id', { schema: { params, body: { type: 'object', additionalProperties: false,
      required: ['previewToken'], properties: { previewToken: { type: 'string', pattern: '^[a-f0-9]{64}$' } } } } }, async (request, reply) => {
      const job = await exports.start(() => authorize(request.headers), request.params.id, request.body.previewToken);
      authorize(request.headers); return reply.code(202).send(job);
    });
    routes.get<{ Params: { id: string } }>('/:id', { schema: { params } }, async request => exports.status(authorize(request.headers), request.params.id));
    routes.get<{ Params: { id: string } }>('/:id/file', { schema: { params } }, async (request, reply) => {
      const { stream, info } = exports.download(authorize(request.headers), request.params.id);
      return reply.type('application/zip').header('Content-Disposition', `attachment; filename="${info.filename}"`).header('Content-Length', info.byteLength!).send(stream);
    });
  }, { prefix: '/api/v1/admin/exports' });
}
