import type { FastifyInstance } from 'fastify';
import type { FamilyAccess } from './family-access.ts';
import type { Study } from './study.ts';
import type { StudySettingsEdit } from '../shared/study.ts';

export const stageSchema = { type: 'object', additionalProperties: false, required: ['schoolYear', 'grade', 'term'], properties: {
  schoolYear: { type: ['string', 'null'], pattern: '^\\d{4}-\\d{4}$' }, grade: { type: ['string', 'null'], minLength: 1, maxLength: 40 }, term: { enum: [null, 'first', 'second'] }
} };
export function studyRoutes(app: FastifyInstance, access: FamilyAccess, study: Study) {
  const token = (value: string | undefined) => /^Bearer [A-Za-z0-9_-]{43}$/.test(value ?? '') ? value!.slice(7) : '';
  app.get('/api/v1/collection/study-settings', async request => { access.home(token(request.headers.authorization)); return study.settings(); });
  app.register(async routes => {
    const parent = (headers: { authorization?: string; 'x-parent-authorization'?: unknown }) => access.parentHome(token(headers.authorization), String(headers['x-parent-authorization'] ?? ''));
    routes.addHook('onRequest', async request => { parent(request.headers); });
    routes.get('/study-settings', async () => study.settings());
    routes.put<{ Body: StudySettingsEdit }>('/study-settings', { schema: { body: { type: 'object', additionalProperties: false, required: ['operationId', 'expectedRevision', 'stage'], properties: {
      operationId: { type: 'string', format: 'uuid' }, expectedRevision: { type: 'integer', minimum: 0 }, stage: stageSchema
    } } } }, async request => study.save(() => parent(request.headers), request.body));
    routes.put<{ Params: { id: string }; Body: { name: string } }>('/subjects/:id', { schema: {
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      body: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string', minLength: 1, maxLength: 80 } } }
    } }, async request => study.addSubject(() => parent(request.headers), request.params.id, request.body.name));
  }, { prefix: '/api/v1/admin' });
}
