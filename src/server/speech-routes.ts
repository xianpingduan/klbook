import type { FastifyInstance } from 'fastify';
import type { FamilyAccess } from './family-access.ts';
import type { SpeechService } from './speech-service.ts';
import type { SpeechEdit } from '../shared/speech.ts';
import { maxSpeechUpload } from './speech-audio.ts';

export function speechRoutes(app: FastifyInstance, access: FamilyAccess, speech: SpeechService) {
  app.register(async routes => {
    const parent = (headers: { authorization?: string; 'x-parent-authorization'?: unknown }) => access.parentHome(/^Bearer [A-Za-z0-9_-]{43}$/.test(headers.authorization ?? '') ? headers.authorization!.slice(7) : '', String(headers['x-parent-authorization'] ?? ''));
    routes.addHook('onRequest', async request => { parent(request.headers); });
    routes.get('', async () => speech.settings());
    routes.addContentTypeParser(['audio/wav', 'audio/x-wav'], { parseAs: 'buffer', bodyLimit: maxSpeechUpload }, (_request, body, done) => done(null, body));
    routes.put<{ Params: { id: string }; Querystring: { revision: string }; Body: Buffer }>('/tests/:id', { bodyLimit: maxSpeechUpload, schema: {
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      querystring: { type: 'object', additionalProperties: false, required: ['revision'], properties: { revision: { type: 'string', pattern: '^(0|[1-9][0-9]{0,9})$' } } }
    } }, async (request, reply) => reply.code(202).send(speech.startTest(() => parent(request.headers), request.params.id, Number(request.query.revision), request.body)));
    routes.put<{ Body: SpeechEdit }>('', { schema: { body: { type: 'object', additionalProperties: false, required: ['operationId', 'expectedRevision', 'config'], properties: {
      operationId: { type: 'string', format: 'uuid' }, expectedRevision: { type: 'integer', minimum: 0 },
      credentials: { type: 'object', additionalProperties: false, required: ['appId', 'apiKey', 'secretKey'], properties: { appId: { type: 'string', minLength: 1, maxLength: 64 }, apiKey: { type: 'string', minLength: 1, maxLength: 256 }, secretKey: { type: 'string', minLength: 1, maxLength: 256 } } },
      config: { type: 'object', additionalProperties: false, required: ['provider', 'name', 'enabled', 'language', 'timeoutSeconds', 'retries', 'monthlyLimit', 'monthlyBudgetCents', 'priceCents'], properties: {
        provider: { const: 'xfyun' }, name: { type: 'string', minLength: 1, maxLength: 80 }, enabled: { type: 'boolean' }, language: { enum: ['zh_cn', 'en_us'] },
        timeoutSeconds: { type: 'integer', minimum: 5, maximum: 120 }, retries: { type: 'integer', minimum: 0, maximum: 2 }, monthlyLimit: { type: 'integer', minimum: 0, maximum: 10000 }, monthlyBudgetCents: { type: 'integer', minimum: 0, maximum: 500000 }, priceCents: { type: 'number', minimum: 0, maximum: 10000 }
      } }
    } } } }, async request => speech.save(() => parent(request.headers), request.body));
  }, { prefix: '/api/v1/admin/speech' });
}
