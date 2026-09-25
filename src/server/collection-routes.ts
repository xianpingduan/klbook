import type { FastifyInstance } from 'fastify';
import type { FamilyAccess } from './family-access.ts';
import { CollectionStore } from './collection-store.ts';
import { MAX_IMAGE_BYTES } from '../shared/collection.ts';
import type { AnswerEdit, QuestionCreate, QuestionEdit, QuestionFilters } from '../shared/collection.ts';
import { AccessError } from './family-access.ts';
import type { ReadingMaterialEdit } from '../shared/reading-materials.ts';
import { stageSchema } from './study-routes.ts';
import { normalizeStage } from './study.ts';
import type { OcrService } from './ocr-service.ts';

const regionSchema = { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, required: ['x', 'y', 'width', 'height'], properties: {
  x: { type: 'number', minimum: 0, maximum: 1 }, y: { type: 'number', minimum: 0, maximum: 1 },
  width: { type: 'number', exclusiveMinimum: 0, maximum: 1 }, height: { type: 'number', exclusiveMinimum: 0, maximum: 1 }
} }] };
const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } };
const createBody = {
  type: 'object', required: ['operationId', 'state', 'subjectId', 'region', 'pageNumber', 'questionNumber', 'note'], additionalProperties: false,
  oneOf: [{ required: ['sourceId'] }, { required: ['source'] }],
  properties: {
    operationId: { type: 'string', format: 'uuid' }, state: { enum: ['draft', 'collected'] },
    subjectId: { type: ['string', 'null'], minLength: 1, maxLength: 64 }, region: regionSchema,
    parts: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'object', additionalProperties: false, required: ['id', 'pageId', 'region'], properties: {
      id: { type: 'string', format: 'uuid' }, pageId: { type: 'string', format: 'uuid' }, region: regionSchema,
      transcription: { type: 'string', maxLength: 20000 }, recognition: { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, required: ['runId', 'candidateId'], properties: { runId: { type: 'string', format: 'uuid' }, candidateId: { type: ['string', 'null'], maxLength: 20 } } }] }
    } } },
    sourceId: { type: ['string', 'null'], format: 'uuid' }, source: { type: 'string', maxLength: 200 },
    readingMaterialId: { type: ['string', 'null'], format: 'uuid' },
    studyStage: stageSchema,
    pageNumber: { type: 'string', maxLength: 32 }, questionNumber: { type: 'string', maxLength: 32 }, note: { type: 'string', maxLength: 2000 }
  }
};

export function collectionRoutes(app: FastifyInstance, access: FamilyAccess, collection: CollectionStore, ocr: OcrService) {
  app.register(async routes => {
    const token = (value: string | undefined) => /^Bearer [A-Za-z0-9_-]{43}$/.test(value ?? '') ? value!.slice(7) : '';
    // Learning keeps device-session access; management requests also validate their grant.
    const authorize = (headers: { authorization?: string; 'x-parent-authorization'?: unknown }) => headers['x-parent-authorization'] === undefined
      ? access.home(token(headers.authorization))
      : access.parentHome(token(headers.authorization), String(headers['x-parent-authorization']));
    routes.addHook('onRequest', async request => { authorize(request.headers); });
    routes.addContentTypeParser(['image/jpeg', 'image/png', 'image/webp'], { parseAs: 'buffer', bodyLimit: MAX_IMAGE_BYTES }, (_request, body, done) => done(null, body));
    routes.get('/subjects', async () => collection.subjects());
    routes.get('/filter-options', async request => collection.filterOptions(authorize(request.headers).library.id));
    routes.get<{ Querystring: { offset?: string } }>('/answer-pages', { schema: { querystring: { type: 'object', additionalProperties: false, properties: { offset: { type: 'string', pattern: '^[0-9]{1,7}$' } } } } }, async request => collection.answerPages(authorize(request.headers).library.id, Number(request.query.offset ?? 0)));
    routes.put<{ Params: { id: string }; Body: AnswerEdit }>('/questions/:id/answers', { schema: { params: idParams, body: {
      type: 'object', additionalProperties: false, required: ['operationId', 'expectedRevision', 'parts'], properties: {
        operationId: { type: 'string', format: 'uuid' }, expectedRevision: { type: 'integer', minimum: 1 }, parts: { ...createBody.properties.parts, minItems: 0 }
      }
    } } }, async request => collection.saveAnswers(() => authorize(request.headers), request.params.id, request.body));
    routes.get<{ Querystring: { offset?: string } }>('/reading-materials', { schema: { querystring: { type: 'object', additionalProperties: false, properties: { offset: { type: 'string', pattern: '^[0-9]{1,7}$' } } } } }, async request => collection.readings.list(authorize(request.headers).library.id, Number(request.query.offset ?? 0)));
    routes.get<{ Params: { id: string } }>('/reading-materials/:id', { schema: { params: idParams } }, async request => collection.readings.get(authorize(request.headers).library.id, request.params.id));
    routes.put<{ Params: { id: string }; Body: ReadingMaterialEdit }>('/reading-materials/:id', { schema: { params: idParams, body: {
      type: 'object', additionalProperties: false, required: ['operationId', 'expectedRevision', 'title', 'parts'], properties: {
        operationId: { type: 'string', format: 'uuid' }, expectedRevision: { type: 'integer', minimum: 0 }, title: { type: 'string', minLength: 1, maxLength: 120 }, parts: createBody.properties.parts
      }
    } } }, async request => collection.readings.save(() => authorize(request.headers), request.params.id, request.body));
    for (const path of ['/drafts', '/pages']) routes.post<{ Body: Buffer; Headers: { 'idempotency-key': string } }>(path, { bodyLimit: MAX_IMAGE_BYTES, schema: { headers: {
      type: 'object', required: ['idempotency-key'], properties: { 'idempotency-key': { type: 'string', format: 'uuid' } }
    } } }, async (request, reply) => {
      if (!Buffer.isBuffer(request.body)) throw new AccessError(415, '请选择 JPEG、PNG 或 WebP 图片文件');
      let stage;
      if (path === '/drafts' && request.headers['x-learning-stage'] !== undefined) {
        try { stage = normalizeStage(JSON.parse(decodeURIComponent(String(request.headers['x-learning-stage'])))); }
        catch { throw new AccessError(422, '暂存的学习阶段格式不正确，请核对材料后重试'); }
      }
      const result = path === '/drafts' ? await collection.upload(() => authorize(request.headers), request.headers['idempotency-key'], request.body, stage)
        : await collection.uploadPage(() => authorize(request.headers), request.headers['idempotency-key'], request.body);
      if ('originalPage' in result) ocr.uploadedPage(() => authorize(request.headers), result.originalPage.id);
      return reply.code(201).send(result);
    });
    routes.get<{ Querystring: QuestionFilters & { state: 'draft' | 'collected'; offset?: string } }>('/questions', { schema: { querystring: {
      type: 'object', required: ['state'], additionalProperties: false, properties: {
        state: { enum: ['draft', 'collected'] }, offset: { type: 'string', pattern: '^[0-9]{1,7}$' },
        subjectId: { type: 'string', minLength: 1, maxLength: 64 }, sourceId: { anyOf: [{ const: '__unset__' }, { type: 'string', format: 'uuid' }] },
        schoolYear: { type: 'string', pattern: '^(\\d{4}-\\d{4}|__unset__)$' }, grade: { type: 'string', minLength: 1, maxLength: 40 }, term: { enum: ['first', 'second', '__unset__'] },
        collectedFrom: { type: 'string', pattern: '^[0-9]{1,15}$' }, collectedBefore: { type: 'string', pattern: '^[0-9]{1,15}$' }
      }
    } } }, async request => collection.list(authorize(request.headers).library.id, request.query.state, Number(request.query.offset ?? 0), request.query));
    routes.get<{ Params: { id: string } }>('/questions/:id', async request => collection.get(access.home(token(request.headers.authorization)).library.id, request.params.id));
    routes.post<{ Params: { id: string }; Body: QuestionCreate }>('/pages/:id/questions', { schema: { params: idParams, body: createBody } }, async (request, reply) => reply.code(201).send(await collection.create(() => authorize(request.headers), request.params.id, request.body)));
    routes.put<{ Params: { id: string }; Body: QuestionEdit }>('/questions/:id', { schema: {
      params: idParams, body: { ...createBody, required: [...createBody.required, 'expectedRevision'], properties: { ...createBody.properties, expectedRevision: { type: 'integer', minimum: 1 } } }
    } }, async request => collection.save(() => authorize(request.headers), request.params.id, request.body));
    routes.get<{ Params: { id: string; variant: 'original' | 'preview' } }>('/pages/:id/:variant', { schema: { params: {
      type: 'object', required: ['id', 'variant'], properties: { id: { type: 'string', format: 'uuid' }, variant: { enum: ['original', 'preview'] } }
    } } }, async (request, reply) => {
      const home = access.home(token(request.headers.authorization));
      const file = await collection.attachment(home.library.id, request.params.id, request.params.variant);
      authorize(request.headers);
      return reply.type(file.mimeType).header('Content-Disposition', 'inline').send(file.bytes);
    });
  }, { prefix: '/api/v1/collection' });
}
