import type { FastifyInstance } from 'fastify';
import type { FamilyAccess } from './family-access.ts';
import type { AiService } from './ai-service.ts';
import type { AiEdit } from '../shared/ai.ts';

export function aiRoutes(app: FastifyInstance, access: FamilyAccess, ai: AiService) {
  const price = { type: 'object', additionalProperties: false, required: ['inputCentsPerMillion', 'outputCentsPerMillion', 'confirmed'], properties: { inputCentsPerMillion: { type: 'integer', minimum: 0, maximum: 10000000 }, outputCentsPerMillion: { type: 'integer', minimum: 0, maximum: 10000000 }, confirmed: { type: 'boolean' } } };
  app.register(async routes => {
    const parent = (headers: { authorization?: string; 'x-parent-authorization'?: unknown }) => access.parentHome(/^Bearer [A-Za-z0-9_-]{43}$/.test(headers.authorization ?? '') ? headers.authorization!.slice(7) : '', String(headers['x-parent-authorization'] ?? ''));
    routes.addHook('onRequest', async request => { parent(request.headers); });
    routes.get('', async () => ai.settings());
    routes.put<{ Params: { id: string }; Body: { expectedRevision: number; prompt: string } }>('/tests/:id', { schema: {
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      body: { type: 'object', additionalProperties: false, required: ['expectedRevision', 'prompt'], properties: { expectedRevision: { type: 'integer', minimum: 0 }, prompt: { type: 'string', minLength: 1, maxLength: 2000, pattern: '\\S' } } }
    } }, async (request, reply) => reply.code(202).send(ai.startTest(() => parent(request.headers), request.params.id, request.body.expectedRevision, request.body.prompt)));
    routes.put<{ Body: AiEdit }>('', { schema: { body: { type: 'object', additionalProperties: false, required: ['operationId', 'expectedRevision', 'config'], properties: {
      operationId: { type: 'string', format: 'uuid' }, expectedRevision: { type: 'integer', minimum: 0 },
      credentials: { type: 'object', additionalProperties: false, required: ['apiPassword'], properties: { apiPassword: { type: 'string', minLength: 1, maxLength: 512 } } },
      config: { type: 'object', additionalProperties: false, required: ['provider', 'model', 'name', 'enabled', 'maxOutputTokens', 'timeoutSeconds', 'retries', 'monthlyLimit', 'monthlyBudgetCents', 'modelPrices'], properties: {
        provider: { const: 'xfyun' }, model: { enum: ['lite', '4.0Ultra'] }, name: { type: 'string', minLength: 1, maxLength: 80 }, enabled: { type: 'boolean' }, maxOutputTokens: { type: 'integer', minimum: 1, maximum: 2048 },
        timeoutSeconds: { type: 'integer', minimum: 5, maximum: 120 }, retries: { type: 'integer', minimum: 0, maximum: 2 }, monthlyLimit: { type: 'integer', minimum: 0, maximum: 10000 }, monthlyBudgetCents: { type: 'integer', minimum: 0, maximum: 500000 }, modelPrices: { type: 'object', additionalProperties: false, required: ['lite', '4.0Ultra'], properties: { lite: price, '4.0Ultra': price } }
      } }
    } } } }, async request => ai.save(() => parent(request.headers), request.body));
  }, { prefix: '/api/v1/admin/ai' });
}
