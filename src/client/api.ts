import type { Device, Home, LoginInput, ParentGrant, RecoveryInput, ServerInfo, SessionResult, SetupInput } from '../shared/contracts.ts';
import type { ClientPlatform, SavedCredential } from './platform.ts';
import { serverOrigin } from './platform.ts';
import type { AnswerEdit, AnswerPageList, OriginalPage, Question, QuestionCreate, QuestionEdit, QuestionList, Subject } from '../shared/collection.ts';
import type { Source, SourceEdit } from '../shared/sources.ts';
import type { ReadingMaterial, ReadingMaterialEdit, ReadingMaterialList } from '../shared/reading-materials.ts';
import type { StudySettings, StudySettingsEdit, StudyStage } from '../shared/study.ts';
import type { FilterOptions, QuestionFilters } from '../shared/collection.ts';
import type { ConflictTarget } from '../shared/conflicts.ts';
import type { OcrEdit, OcrSettings, OcrTest } from '../shared/ocr.ts';
import type { PageRecognition, PageRecognitions, PageRecognitionRequest } from '../shared/ocr.ts';
import type { DraftCancellation, DraftCancellationEdit } from '../shared/collection.ts';
import type { Region } from '../shared/collection.ts';
import { QuestionJournal } from './question-journal.ts';
import { LocalLibrary } from './local-library.ts';
import { OfflineCaptures } from './offline-captures.ts';
import { questionContent, questionFields } from './question-edit.ts';
import { revisionedSave } from './revisioned-save.ts';
import { ApiError, ConnectionError } from './api-errors.ts';
export { ApiError, ConnectionError } from './api-errors.ts';

function questionContentFromOperation(input: ReturnType<typeof questionContent> & { operationId?: string; expectedRevision?: number }) {
  const { operationId: _operation, expectedRevision: _revision, ...content } = input;
  return content;
}

export class FamilyApi {
  private platform: ClientPlatform;
  private target: string;
  private credential: SavedCredential | null;
  private disconnected = false;
  private listeners = new Set<() => void>();
  get offline() { return this.disconnected; }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.disconnected;
  private connection(offline: boolean) { if (this.disconnected !== offline) { this.disconnected = offline; this.listeners.forEach(fn => fn()); } }
  private get local() { return this.credential ? new LocalLibrary(this.platform, this.credential) : undefined; }
  private get captures() { return this.credential ? new OfflineCaptures(this.platform, this.credential) : undefined; }
  private syncing?: Promise<void>;
  private remoteId(id: string) { return this.captures?.remoteId(id) ?? id; }
  private rememberQuestion(value: Question) { const question = this.captures?.question(value) ?? value; this.local?.question(question); return question; }
  private remoteEdit(input: QuestionEdit): QuestionEdit { return { ...input, parts: input.parts?.map(part => ({ ...part, id: this.remoteId(part.id), pageId: this.remoteId(part.pageId) })) }; }

  private constructor(platform: ClientPlatform, target: string, credential: SavedCredential | null) {
    this.platform = platform; this.target = target; this.credential = credential;
  }
  get address() { return this.target; }
  questionJournal(id: string) {
    if (!this.credential) throw new Error('请先登录资料库');
    return new QuestionJournal(this.platform, this.credential, id);
  }
  adoptQuestionProgress(current: Question, readingMaterialId = current.readingMaterial?.id ?? null) {
    this.questionJournal(current.id).write({ version: 1, fields: { ...questionFields(current), readingMaterialId }, step: current.region ? 'confirm' : 'crop', checkpoint: { current, pending: null }, updatedAt: Date.now() });
  }
  hasQuestionProgress(id: string) { return !!this.credential && QuestionJournal.entries(this.platform, this.credential, id).length > 0; }
  advanceQuestionProgress(previous: Question, current: Question, readingChanged = false) {
    if (!this.credential) return;
    for (const entry of QuestionJournal.entries(this.platform, this.credential, previous.id)) {
      const progress = entry.value;
      // Only this editor's acknowledged base can advance; divergent tabs still conflict.
      if (progress.checkpoint.pending || progress.checkpoint.current.revision !== previous.revision) continue;
      entry.write({ ...progress,
        fields: { ...progress.fields, ...(readingChanged ? { readingMaterialId: current.readingMaterial?.id ?? null } : {}) },
        checkpoint: { current, pending: null } });
    }
  }
  static async probe(platform: ClientPlatform, address: string) {
    const target = serverOrigin(address);
    const api = new FamilyApi(platform, target, null);
    const response = await api.send('/info');
    const info: ServerInfo = await response.json().catch(() => { throw new Error('此服务与当前客户端不兼容，请确认填写的是错题集后端地址'); });
    if (!info || info.app !== 'klbook' || info.apiVersion !== 1 || typeof info.initialized !== 'boolean') throw new Error('此服务与当前客户端不兼容');
    return { api, info };
  }
  static async connect(platform: ClientPlatform) {
    // Remembered sessions are read only after the anonymous compatibility check.
    const target = await platform.target.read();
    let connection;
    try { connection = await FamilyApi.probe(platform, target); }
    catch (failure) {
      if (!(failure instanceof ConnectionError)) throw failure;
      const credential = await platform.credentials.read(target);
      if (!credential) throw failure;
      const api = new FamilyApi(platform, target, credential);
      if (!api.local?.home()) throw failure;
      api.connection(true);
      return { api, info: { app: 'klbook' as const, apiVersion: 1 as const, initialized: true } };
    }
    connection.api.credential = await platform.credentials.read(connection.api.address);
    return connection;
  }
  static async select(platform: ClientPlatform, address: string) {
    const connection = await FamilyApi.probe(platform, address);
    // An explicit selection always requires a new login, including a previously used address.
    await platform.credentials.remove(connection.api.address);
    await platform.target.write(connection.api.address);
    return connection;
  }
  private async send(path: string, options: RequestInit = {}): Promise<Response> {
    let response: Response;
    try {
      response = await this.platform.request(`${this.target}/api/v1${path}`, {
        ...options, headers: { ...options.headers, ...(this.credential ? { Authorization: `Bearer ${this.credential.token}` } : {}) },
        credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(30000)
      });
    } catch { this.connection(true); throw new ConnectionError('无法连接家庭电脑，请确认电脑已开机且服务运行，再重试'); }
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      const unavailable = response.status === 502 || response.status === 504;
      if (unavailable) { this.connection(true); throw new ConnectionError('家庭电脑上的服务暂时不可达，请确认服务运行后重试'); }
      throw new ApiError(response.status, typeof detail.message === 'string' ? detail.message : unavailable ? '家庭电脑上的服务暂时不可达，请确认服务运行后重试' : '请求失败，请重试', detail.conflict);
    }
    this.connection(false);
    return response;
  }
  private async request<T>(path: string, method = 'GET', body?: unknown, grant?: string): Promise<T> {
    try {
      const response = await this.send(path, {
      method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(grant ? { 'X-Parent-Authorization': grant } : {}) }
    });
      const value: T = response.status === 204 ? undefined as T : await response.json();
      if (method === 'GET' && !grant && path.startsWith('/collection/') && !path.includes('/recognition') && !path.startsWith('/collection/questions')) {
        try { this.local?.remember(path, value); } catch { /* Read remains available online; never claim this snapshot was prepared offline. */ }
      }
      return value;
    } catch (failure) {
      if (failure instanceof ConnectionError && method === 'GET' && !grant && path.startsWith('/collection/') && !path.includes('/recognition')) {
        const saved = this.local?.read<T>(path);
        if (saved !== undefined) return saved;
      }
      throw failure;
    }
  }
  subjects() { return this.request<Subject[]>('/collection/subjects'); }
  pageRecognitions(pageId: string, grant?: string, region?: Region | null) { return this.request<PageRecognitions>(`/collection/pages/${encodeURIComponent(this.remoteId(pageId))}/recognitions${region === undefined ? '' : `?region=${encodeURIComponent(JSON.stringify(region))}`}`, 'GET', undefined, grant); }
  pageRecognition(pageId: string, id: string, grant?: string) { return this.request<PageRecognition>(`/collection/pages/${encodeURIComponent(this.remoteId(pageId))}/recognitions/${encodeURIComponent(id)}`, 'GET', undefined, grant); }
  async recognizePage(pageId: string, id: string, grant?: string, input?: PageRecognitionRequest) { await this.syncCaptures(); return this.request<PageRecognition>(`/collection/pages/${encodeURIComponent(this.remoteId(pageId))}/recognitions/${encodeURIComponent(id)}`, 'PUT', input, grant); }
  ocrSettings(grant: string) { return this.request<OcrSettings>('/admin/ocr', 'GET', undefined, grant); }
  saveOcr(grant: string, input: OcrEdit) { return this.request<OcrSettings>('/admin/ocr', 'PUT', input, grant); }
  testOcr(grant: string, id: string, expectedRevision: number) { return this.request<OcrTest>(`/admin/ocr/tests/${encodeURIComponent(id)}`, 'PUT', { expectedRevision, sample: 'school-v1' }, grant); }
  async ocrSample(grant: string) { return (await this.send('/admin/ocr/sample', { headers: { 'X-Parent-Authorization': grant } })).blob(); }
  addSubject(grant: string, id: string, name: string) { return this.request<Subject>(`/admin/subjects/${encodeURIComponent(id)}`, 'PUT', { name }, grant); }
  studySettings(grant?: string) { return this.request<StudySettings>(grant ? '/admin/study-settings' : '/collection/study-settings', 'GET', undefined, grant); }
  saveStudySettings(grant: string, input: StudySettingsEdit) { return this.request<StudySettings>('/admin/study-settings', 'PUT', input, grant); }
  filterOptions(grant?: string) { return this.request<FilterOptions>('/collection/filter-options', 'GET', undefined, grant); }
  answerPages(offset = 0, grant?: string) { return this.request<AnswerPageList>(`/collection/answer-pages?offset=${offset}`, 'GET', undefined, grant); }
  async saveAnswers(id: string, input: AnswerEdit, grant?: string) { await this.syncCaptures(); return this.rememberQuestion(await this.request<Question>(`/collection/questions/${encodeURIComponent(this.remoteId(id))}/answers`, 'PUT', { ...input, parts: input.parts.map(part => ({ ...part, pageId: this.remoteId(part.pageId), id: this.remoteId(part.id) })) }, grant)); }
  readingMaterials(offset = 0, grant?: string) { return this.request<ReadingMaterialList>(`/collection/reading-materials?offset=${offset}`, 'GET', undefined, grant); }
  readingMaterial(id: string, grant?: string) { return this.request<ReadingMaterial>(`/collection/reading-materials/${encodeURIComponent(id)}`, 'GET', undefined, grant); }
  async saveReadingMaterial(id: string, input: ReadingMaterialEdit, grant?: string) { await this.syncCaptures(); return this.request<ReadingMaterial>(`/collection/reading-materials/${encodeURIComponent(id)}`, 'PUT', { ...input, parts: input.parts.map(part => ({ ...part, pageId: this.remoteId(part.pageId) })) }, grant); }
  sources() { return this.request<Source[]>('/collection/sources'); }
  managedSources(grant: string) { return this.request<Source[]>('/admin/sources', 'GET', undefined, grant); }
  saveSource(grant: string, id: string, input: SourceEdit) { return this.request<Source>(`/admin/sources/${encodeURIComponent(id)}`, 'PUT', input, grant); }
  async questions(state: 'draft' | 'collected', offset = 0, grant?: string, filters: QuestionFilters = {}) {
    const query = new URLSearchParams({ state, offset: String(offset) });
    for (const [key, value] of Object.entries(filters)) if (value) query.set(key, value);
    try {
      const result = await this.request<QuestionList>(`/collection/questions?${query}`, 'GET', undefined, grant);
      if (this.offline && !grant) return this.local!.list(state, offset, filters);
      return { ...result, items: result.items.map(question => this.rememberQuestion(question)) };
    } catch (failure) { if (failure instanceof ConnectionError && !grant && this.local) return this.local.list(state, offset, filters); throw failure; }
  }
  async question(id: string, grant?: string) {
    try { return this.rememberQuestion(await this.request<Question>(`/collection/questions/${encodeURIComponent(this.remoteId(id))}`, 'GET', undefined, grant)); }
    catch (failure) { if (failure instanceof ConnectionError && !grant) { const saved = this.local?.read<Question>(`/collection/questions/${id}`); if (saved) return saved; } throw failure; }
  }
  async cancelledDrafts(grant?: string) {
    const items = await this.request<DraftCancellation[]>('/collection/cancelled-drafts', 'GET', undefined, grant);
    const result = items.map(item => ({ ...item, id: this.captures?.localId(item.id) ?? item.id }));
    for (const item of result) this.local?.removeQuestion(item.id);
    return result;
  }
  async cancelDraft(id: string, input: DraftCancellationEdit, grant?: string) {
    await this.syncCaptures();
    const result = await this.request<DraftCancellation>(`/collection/questions/${encodeURIComponent(this.remoteId(id))}/cancellation`, 'PUT', input, grant);
    if (result.cancelledAt) {
      this.local?.removeQuestion(id);
      // Only remove snapshots proven to be included in the acknowledged cancellation.
      // A different tab/device may still have newer, unsubmitted edits.
      if (this.credential) for (const entry of QuestionJournal.entries(this.platform, this.credential, id)) {
        const { fields, checkpoint } = entry.value;
        if (!checkpoint.pending && !checkpoint.intent && checkpoint.current.revision === input.expectedRevision &&
          JSON.stringify(questionContent(fields, 'draft')) === JSON.stringify(questionContent(questionFields(checkpoint.current), 'draft'))) entry.remove();
      }
    }
    const items = this.local?.read<DraftCancellation[]>('/collection/cancelled-drafts') ?? [];
    this.local?.remember('/collection/cancelled-drafts', [...items.filter(item => item.id !== id && item.id !== result.id), ...(result.cancelledAt ? [{ ...result, id }] : [])]);
    return { ...result, id };
  }
  async saveQuestion(id: string, input: QuestionEdit, grant?: string, allowDeferred = false) {
    try {
      await this.verifiedHome();
      await this.syncCaptures();
      return this.rememberQuestion(await this.request<Question>(`/collection/questions/${encodeURIComponent(this.remoteId(id))}`, 'PUT', this.remoteEdit(input), grant));
    } catch (failure) {
      if (!(failure instanceof ConnectionError) || grant || !allowDeferred) throw failure;
      return this.deferQuestion(id, input);
    }
  }
  deferQuestion(id: string, input: Omit<QuestionEdit, 'operationId' | 'expectedRevision'> & { expectedRevision?: number }) {
      const current = this.local?.read<Question>(`/collection/questions/${id}`);
      if (!current) throw new Error('本机尚未保留这道题，请恢复连接后重试');
      // The edit journal retains the exact operation and base revision for replay.
      // A pending result is not a server acknowledgement and must not advance its revision.
      const pages = new Map(current.parts.map(part => [part.originalPage.id, part.originalPage]));
      for (const capture of this.captures?.records() ?? []) pages.set(capture.page.id, capture.page);
      const parts = input.parts?.map(part => {
        const page = pages.get(part.pageId); if (!page) throw new Error('这张材料尚未在本机准备，请恢复连接后继续');
        return { ...part, originalPage: page };
      }) ?? current.parts;
      const pending: Question = { ...current, ...input, parts, originalPage: parts[0]!.originalPage, revision: input.expectedRevision ?? current.revision, syncState: 'pending', sourceId: input.sourceId ?? null, source: current.source, studyStage: input.studyStage ?? current.studyStage, updatedAt: Date.now(), collectedAt: input.state === 'collected' ? current.collectedAt ?? Date.now() : null };
      this.local?.question(pending);
      return pending;
  }
  async createQuestion(pageId: string, input: QuestionCreate, grant?: string) { await this.syncCaptures(); return this.rememberQuestion(await this.request<Question>(`/collection/pages/${encodeURIComponent(this.remoteId(pageId))}/questions`, 'POST', { ...input, parts: input.parts?.map(part => ({ ...part, pageId: this.remoteId(part.pageId), id: this.remoteId(part.id) })) }, grant)); }
  async prepareQuestion(question: Question) {
    if (!this.captures || !this.local?.home()) throw new Error('请先连接家庭资料库');
    this.captures.remember({ operationId: question.id, kind: 'questions', page: question.originalPage, question, stage: question.studyStage });
    this.local.question(question);
    try { await this.syncCaptures(); return await this.question(question.id); }
    catch (failure) { if (failure instanceof ConnectionError) return question; throw failure; }
  }
  uploadImage(file: Blob, operationId: string, grant?: string, stage?: StudyStage) { return this.upload<Question>('drafts', file, operationId, grant, stage); }
  uploadPage(file: Blob, operationId: string, grant?: string) { return this.upload<OriginalPage>('pages', file, operationId, grant); }
  private async upload<T>(target: 'drafts' | 'pages', file: Blob, operationId: string, grant?: string, stage?: StudyStage): Promise<T> {
    let response: Response;
    try { response = await this.send(`/collection/${target}`, { method: 'POST', body: file, headers: { 'Content-Type': ['image/jpeg', 'image/png', 'image/webp'].includes(file.type) ? file.type : 'image/png', 'Idempotency-Key': operationId, ...(grant ? { 'X-Parent-Authorization': grant } : {}), ...(stage ? { 'X-Learning-Stage': encodeURIComponent(JSON.stringify(stage)) } : {}) } }); }
    catch (failure) {
      const home = this.local?.home();
      if (!(failure instanceof ConnectionError) || grant || !home || !this.captures) throw failure;
      const saved = await this.captures.create(file, operationId, target, home, stage);
      return (target === 'drafts' ? saved.question! : saved.page) as T;
    }
    const result: T = await response.json();
    const page = target === 'drafts' ? (result as Question).originalPage : result as OriginalPage;
    if (this.local) {
      await this.local.putImage(page.id, 'original', file);
      await this.local.putImage(page.id, 'preview', file);
      if (target === 'drafts') return this.rememberQuestion(result as Question) as T;
    }
    return result;
  }
  async pageImage(pageId: string, variant: 'original' | 'preview') {
    if (this.captures?.records().some(record => record.page.id === pageId && !record.remote)) {
      const saved = await this.local?.image(pageId, variant);
      if (saved) return saved;
    }
    try {
      const image = await (await this.send(`/collection/pages/${encodeURIComponent(this.remoteId(pageId))}/${variant}`)).blob();
      try { await this.local?.putImage(pageId, variant, image); } catch { /* Display online; offline retrieval only succeeds for stored bytes. */ }
      return image;
    } catch (failure) {
      if (failure instanceof ConnectionError) { const saved = await this.local?.image(pageId, variant); if (saved) return saved; }
      throw failure;
    }
  }
  info() { return this.request<ServerInfo>('/info'); }
  setup(input: SetupInput) { return this.request<SessionResult>('/setup', 'POST', input); }
  login(input: LoginInput) { return this.request<SessionResult>('/sessions', 'POST', input); }
  recover(input: RecoveryInput) { return this.request<SessionResult>('/recovery', 'POST', input); }
  unlock(password: string) { return this.request<ParentGrant>('/admin/grants', 'POST', { password }); }
  lock(grant: string) { return this.request<void>('/admin/grants', 'DELETE', undefined, grant); }
  devices(grant: string) { return this.request<Device[]>('/admin/devices', 'GET', undefined, grant); }
  revoke(grant: string, id: string) { return this.request<void>(`/admin/devices/${encodeURIComponent(id)}`, 'DELETE', undefined, grant); }
  rotateRecoveryCode(grant: string) { return this.request<{ recoveryCode: string }>('/admin/recovery-code', 'POST', undefined, grant); }
  async remember(result: SessionResult) {
    this.credential = { target: this.target, libraryId: result.library.id, accountId: result.account.id, token: result.token };
    try { await this.platform.credentials.write(this.credential); this.local?.remember('/home', { account: result.account, library: result.library, session: result.session }); return true; }
    catch { return false; }
  }
  async home() {
    let home: Home;
    try { home = await this.request<Home>('/home'); }
    catch (failure) { const saved = failure instanceof ConnectionError ? this.local?.home() : undefined; if (saved) return saved; throw failure; }
    if (home.library.id !== this.credential?.libraryId || home.account.id !== this.credential.accountId) {
      await this.forget();
      throw new ApiError(401, '资料库身份已变化，请由家长重新登录核对');
    }
    try { this.local?.remember('/home', home); } catch { /* Existing local preparation remains; no new success is claimed. */ }
    return home;
  }
  private async verifiedHome() {
    const home = await this.request<Home>('/home');
    if (home.library.id !== this.credential?.libraryId || home.account.id !== this.credential.accountId) { await this.forget(); throw new ApiError(401, '资料库身份已变化，请重新登录核对'); }
    return home;
  }
  private async syncCaptures() {
    const records = this.captures?.records().filter(record => !record.remote) ?? [];
    if (!records.length) return;
    await this.verifiedHome();
    for (const record of records) {
      if (record.kind === 'questions') {
        const content = questionContent(questionFields(record.question!), 'draft');
        const { expectedRevision: _revision, ...input } = this.remoteEdit({ ...content, expectedRevision: 0, operationId: record.operationId });
        record.remote = await this.request<Question>(`/collection/pages/${encodeURIComponent(this.remoteId(record.page.id))}/questions`, 'POST', input);
        this.captures!.remember(record);
        continue;
      }
      const file = await this.local!.image(record.page.id, 'original');
      if (!file) throw new Error('本机原始图片未能读取，请保留材料后重试');
      const response = await this.send(`/collection/${record.kind}`, { method: 'POST', body: file, headers: { 'Content-Type': file.type, 'Idempotency-Key': record.operationId, ...(record.kind === 'drafts' ? { 'X-Learning-Stage': encodeURIComponent(JSON.stringify(record.stage)) } : {}) } });
      record.remote = await response.json();
      this.captures!.remember(record);
      if (record.question && !this.local!.read<Question>(`/collection/questions/${record.question.id}`)) this.rememberQuestion(record.remote as Question);
    }
  }
  syncProgress() {
    if (this.syncing) return this.syncing;
    const scope = this.credential;
    if (!scope) return Promise.resolve();
    this.syncing = (async () => {
      await this.verifiedHome();
      await this.syncCaptures();
      const cancelled = new Set((await this.cancelledDrafts()).map(item => item.id));
      for (const entry of QuestionJournal.entries(this.platform, scope)) {
        const progress = entry.value;
        const base = progress.checkpoint.current;
        // Cancellation is never undone by automatic replay; preserve divergent edits for explicit undo and comparison.
        if (cancelled.has(base.id) || !entry.unchanged()) continue;
        const confirmed = progress.checkpoint.intent ?? progress.checkpoint.pending;
        if (base.state === 'collected' && !confirmed) continue;
        const contentOf = (value: Question) => questionContent(questionFields(value), value.state);
        // Once collected, only the explicitly confirmed content may be sent. Later edits stay local.
        const desired = confirmed?.state === 'collected' ? questionContentFromOperation(confirmed) : questionContent(progress.fields, base.state);
        if (!progress.checkpoint.pending) {
          const current = await this.question(base.id);
          if (current.revision !== base.revision) throw new ApiError(409, '这道题已在其他页面更新，请打开本机草稿核对后再同步', { entity: 'question', id: base.id });
        }
        const saver = revisionedSave(() => ({ initial: base, contentOf,
          persist: (input: QuestionEdit) => this.saveQuestion(base.id, input, undefined, true),
          defer: (_value: Question, content: ReturnType<typeof questionContent>) => this.deferQuestion(base.id, content),
          conflictMessage: '这道题已在其他页面更新，请打开本机草稿核对后再同步', conflictTarget: { entity: 'question' as const, id: base.id },
          checkpoint: { initial: progress.checkpoint, write: checkpoint => entry.write({ ...progress, checkpoint }) }
        }));
        const current = await saver.save(desired);
        if (current.syncState !== 'synced' || !entry.unchanged()) continue;
        if (current.state === 'collected' && JSON.stringify(questionContent(progress.fields, 'collected')) === JSON.stringify(desired)) entry.remove();
        // Otherwise keep the newer unsubmitted fields with their now-acknowledged base.
      }
    })().finally(() => { this.syncing = undefined; });
    return this.syncing;
  }
  async forget() {
    this.credential = null;
    await this.platform.credentials.remove(this.target);
  }
  async logout() {
    try { await this.request('/sessions/current', 'DELETE'); }
    catch (error) { if (!(error instanceof ApiError && error.status === 401)) throw error; }
    await this.forget();
  }
}
