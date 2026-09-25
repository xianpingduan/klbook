import type { FastifyInstance } from 'fastify';
import type { FamilyAccess } from './family-access.ts';
import type { OcrService } from './ocr-service.ts';
import type { OcrEdit } from '../shared/ocr.ts';
import { ocrSample } from './ocr-sample.ts';

export function ocrRoutes(app: FastifyInstance, access: FamilyAccess, ocr: OcrService) {
  app.register(async routes => {
    const parent = (headers: { authorization?: string; 'x-parent-authorization'?: unknown }) => access.parentHome(/^Bearer [A-Za-z0-9_-]{43}$/.test(headers.authorization ?? '') ? headers.authorization!.slice(7) : '', String(headers['x-parent-authorization'] ?? ''));
    routes.addHook('onRequest', async request => { parent(request.headers); });
    routes.get('', async () => ocr.settings());
    routes.get('/sample', async (_request, reply) => reply.type('image/png').send(await ocrSample()));
    routes.put<{ Params: { id: string }; Body: { expectedRevision: number; sample: 'school-v1' } }>('/tests/:id', { schema: {
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      body: { type: 'object', additionalProperties: false, required: ['expectedRevision', 'sample'], properties: { expectedRevision: { type: 'integer', minimum: 0 }, sample: { const: 'school-v1' } } }
    } }, async (request, reply) => reply.code(202).send(ocr.startTest(() => parent(request.headers), request.params.id, request.body.expectedRevision)));
    routes.put<{ Body: OcrEdit }>('', { schema: { body: { type: 'object', additionalProperties: false, required: ['operationId', 'expectedRevision', 'config'], properties: {
      operationId: { type: 'string', format: 'uuid' }, expectedRevision: { type: 'integer', minimum: 0 },
      credentials: { type: 'object', additionalProperties: false, required: ['apiKey', 'secretKey'], properties: { appId: { type: 'string', minLength: 1, maxLength: 64 }, apiKey: { type: 'string', minLength: 1, maxLength: 256 }, secretKey: { type: 'string', minLength: 1, maxLength: 256 } } },
      config: { type: 'object', additionalProperties: false, required: ['provider', 'name', 'enabled', 'language', 'handwriting', 'formulas', 'timeoutSeconds', 'retries', 'monthlyLimit', 'monthlyBudgetCents', 'priceCents'], properties: {
        provider: { enum: ['baidu', 'xfyun'] },
        name: { type: 'string', minLength: 1, maxLength: 80 }, enabled: { type: 'boolean' }, language: { enum: ['CHN_ENG', 'ENG'] }, handwriting: { type: 'boolean' }, formulas: { type: 'boolean' },
        timeoutSeconds: { type: 'integer', minimum: 5, maximum: 30 }, retries: { type: 'integer', minimum: 0, maximum: 2 }, monthlyLimit: { type: 'integer', minimum: 0, maximum: 10000 }, monthlyBudgetCents: { type: 'integer', minimum: 0, maximum: 500000 }, priceCents: { type: 'number', minimum: 0, maximum: 10000, multipleOf: 0.1 }
      } }
    } } } }, async request => ocr.save(() => parent(request.headers), request.body));
  }, { prefix: '/api/v1/admin/ocr' });
}
