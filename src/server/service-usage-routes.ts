import type { FastifyInstance } from 'fastify';
import type { FamilyAccess } from './family-access.ts';
import type { ServiceUsageStore } from './service-usage.ts';
import type { ServiceBudgetEdit, UsageQuery } from '../shared/service-usage.ts';

export function serviceUsageRoutes(app: FastifyInstance, access: FamilyAccess, usage: ServiceUsageStore) {
  app.register(async routes => {
    const parent = (headers: { authorization?: string; 'x-parent-authorization'?: unknown }) => access.parentHome(/^Bearer [A-Za-z0-9_-]{43}$/.test(headers.authorization ?? '') ? headers.authorization!.slice(7) : '', String(headers['x-parent-authorization'] ?? ''));
    routes.addHook('onRequest', async request => { parent(request.headers); });
    routes.get<{ Querystring: Omit<UsageQuery, 'offset'> & { offset?: string } }>('', { schema: { querystring: { type: 'object', additionalProperties: false, properties: {
      month: { type: 'string', pattern: '^20[0-9]{2}-(0[1-9]|1[0-2])$' }, capability: { enum: ['ocr', 'speech', 'ai'] }, offset: { type: 'string', pattern: '^(0|[1-9][0-9]{0,7})$' }
    } } } }, async request => usage.read({ ...request.query, offset: request.query.offset === undefined ? 0 : Number(request.query.offset) }));
    routes.put<{ Body: ServiceBudgetEdit }>('', { schema: { body: { type: 'object', additionalProperties: false, required: ['operationId', 'expectedRevision', 'config'], properties: {
      operationId: { type: 'string', format: 'uuid' }, expectedRevision: { type: 'integer', minimum: 0 },
      config: { type: 'object', additionalProperties: false, required: ['monthlyBudgetCents', 'hardwareCents', 'monthlyElectricityCents', 'capacityNote'], properties: {
        monthlyBudgetCents: { type: 'integer', minimum: 0, maximum: 500000 }, hardwareCents: { type: ['integer', 'null'], minimum: 0, maximum: 100000000 }, monthlyElectricityCents: { type: ['integer', 'null'], minimum: 0, maximum: 10000000 }, capacityNote: { type: 'string', maxLength: 256 }
      } }
    } } } }, async request => usage.save(() => parent(request.headers), request.body));
  }, { prefix: '/api/v1/admin/service-usage' });
}
