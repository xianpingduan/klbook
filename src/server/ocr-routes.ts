import type { FastifyInstance } from 'fastify';
import type { FamilyAccess } from './family-access.ts';
import type { OcrService } from './ocr-service.ts';
import type { OcrEdit, PageRecognitionRequest } from '../shared/ocr.ts';
import { ocrSample } from './ocr-sample.ts';
import { AccessError } from './family-access.ts';
import type { Region } from '../shared/collection.ts';

export function ocrRoutes(app: FastifyInstance, access: FamilyAccess, ocr: OcrService) {
  app.register(async routes => {
    const authorize = (headers: { authorization?: string; 'x-parent-authorization'?: unknown }) => {
      const token = /^Bearer [A-Za-z0-9_-]{43}$/.test(headers.authorization ?? '') ? headers.authorization!.slice(7) : '';
      return headers['x-parent-authorization'] === undefined ? access.home(token) : access.parentHome(token, String(headers['x-parent-authorization']));
    };
    const params = { type: 'object', required: ['pageId'], properties: { pageId: { type: 'string', format: 'uuid' }, id: { type: 'string', format: 'uuid' } } };
    routes.addHook('onRequest', async request => { authorize(request.headers); });
    routes.get<{ Params: { pageId: string }; Querystring: { region?: string } }>('/:pageId/recognitions', { schema: { params, querystring: { type: 'object', additionalProperties: false, properties: { region: { type: 'string', maxLength: 256 } } } } }, async request => {
      let region: Region | null | undefined;
      if (request.query.region !== undefined) {
        try { region = JSON.parse(request.query.region); } catch { throw new AccessError(422, '题目范围格式不正确'); }
      }
      return ocr.pageRuns(() => authorize(request.headers), request.params.pageId, region);
    });
    routes.get<{ Params: { pageId: string; id: string } }>('/:pageId/recognitions/:id', { schema: { params } }, async request => ocr.pageRun(() => authorize(request.headers), request.params.pageId, request.params.id));
    routes.put<{ Params: { pageId: string; id: string }; Body: PageRecognitionRequest | undefined }>('/:pageId/recognitions/:id', { preValidation: async request => { if (request.body === undefined) request.body = {}; }, schema: { params, body: {
      type: 'object', additionalProperties: false, properties: { automatic: { type: 'boolean' }, region: { type: 'object', additionalProperties: false, required: ['x', 'y', 'width', 'height'], properties: { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } } } }
    } } }, async (request, reply) => reply.code(202).send(ocr.startPage(() => authorize(request.headers), request.params.pageId, request.params.id, request.body)));
  }, { prefix: '/api/v1/collection/pages' });
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
        timeoutSeconds: { type: 'integer', minimum: 5, maximum: 30 }, retries: { type: 'integer', minimum: 0, maximum: 2 }, monthlyLimit: { type: 'integer', minimum: 0, maximum: 10000 }, monthlyBudgetCents: { type: 'integer', minimum: 0, maximum: 500000 }, priceCents: { type: 'number', minimum: 0, maximum: 10000 }
      } }
    } } } }, async request => ocr.save(() => parent(request.headers), request.body));
  }, { prefix: '/api/v1/admin/ocr' });
}
