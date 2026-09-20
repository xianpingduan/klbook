import type { FastifyInstance } from 'fastify';
import type { FamilyAccess } from './family-access.ts';
import { CollectionStore } from './collection-store.ts';
import { MAX_IMAGE_BYTES } from '../shared/collection.ts';
import type { QuestionEdit } from '../shared/collection.ts';
import { AccessError } from './family-access.ts';

export function collectionRoutes(app: FastifyInstance, access: FamilyAccess, collection: CollectionStore) {
  app.register(async routes => {
    const token = (value: string | undefined) => /^Bearer [A-Za-z0-9_-]{43}$/.test(value ?? '') ? value!.slice(7) : '';
    routes.addHook('onRequest', async request => { access.home(token(request.headers.authorization)); });
    routes.addContentTypeParser(['image/jpeg', 'image/png', 'image/webp'], { parseAs: 'buffer', bodyLimit: MAX_IMAGE_BYTES }, (_request, body, done) => done(null, body));
    routes.get('/subjects', async () => collection.subjects());
    routes.post<{ Body: Buffer; Headers: { 'idempotency-key': string } }>('/drafts', { bodyLimit: MAX_IMAGE_BYTES, schema: { headers: {
      type: 'object', required: ['idempotency-key'], properties: { 'idempotency-key': { type: 'string', format: 'uuid' } }
    } } }, async (request, reply) => {
      if (!Buffer.isBuffer(request.body)) throw new AccessError(415, '请选择 JPEG、PNG 或 WebP 图片文件');
      return reply.code(201).send(await collection.upload(() => access.home(token(request.headers.authorization)), request.headers['idempotency-key'], request.body));
    });
    routes.get<{ Querystring: { state: 'draft' | 'collected'; offset?: string } }>('/questions', { schema: { querystring: {
      type: 'object', required: ['state'], additionalProperties: false, properties: { state: { enum: ['draft', 'collected'] }, offset: { type: 'string', pattern: '^[0-9]{1,7}$' } }
    } } }, async request => collection.list(access.home(token(request.headers.authorization)).library.id, request.query.state, Number(request.query.offset ?? 0)));
    routes.get<{ Params: { id: string } }>('/questions/:id', async request => collection.get(access.home(token(request.headers.authorization)).library.id, request.params.id));
    routes.put<{ Params: { id: string }; Body: QuestionEdit }>('/questions/:id', { schema: {
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      body: { type: 'object', required: ['operationId', 'expectedRevision', 'state', 'subjectId', 'region', 'source', 'pageNumber', 'questionNumber', 'note'], additionalProperties: false,
        properties: {
          operationId: { type: 'string', format: 'uuid' }, expectedRevision: { type: 'integer', minimum: 1 }, state: { enum: ['draft', 'collected'] },
          subjectId: { type: ['string', 'null'], minLength: 1, maxLength: 64 },
          region: { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, required: ['x', 'y', 'width', 'height'], properties: {
            x: { type: 'number', minimum: 0, maximum: 1 }, y: { type: 'number', minimum: 0, maximum: 1 },
            width: { type: 'number', exclusiveMinimum: 0, maximum: 1 }, height: { type: 'number', exclusiveMinimum: 0, maximum: 1 }
          } }] },
          source: { type: 'string', maxLength: 200 }, pageNumber: { type: 'string', maxLength: 32 }, questionNumber: { type: 'string', maxLength: 32 }, note: { type: 'string', maxLength: 2000 }
        }
      }
    } }, async request => collection.save(() => access.home(token(request.headers.authorization)), request.params.id, request.body));
    routes.get<{ Params: { id: string; variant: 'original' | 'preview' } }>('/pages/:id/:variant', { schema: { params: {
      type: 'object', required: ['id', 'variant'], properties: { id: { type: 'string', format: 'uuid' }, variant: { enum: ['original', 'preview'] } }
    } } }, async (request, reply) => {
      const home = access.home(token(request.headers.authorization));
      const file = await collection.attachment(home.library.id, request.params.id, request.params.variant);
      access.home(token(request.headers.authorization));
      return reply.type(file.mimeType).header('Content-Disposition', 'inline').send(file.bytes);
    });
  }, { prefix: '/api/v1/collection' });
}
