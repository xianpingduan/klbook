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

export class ApiError extends Error {
  status: number;
  conflict?: ConflictTarget;
  constructor(status: number, message: string, conflict?: ConflictTarget) { super(message); this.status = status; this.conflict = conflict; }
}

export class FamilyApi {
  private platform: ClientPlatform;
  private target: string;
  private credential: SavedCredential | null;

  private constructor(platform: ClientPlatform, target: string, credential: SavedCredential | null) {
    this.platform = platform; this.target = target; this.credential = credential;
  }
  get address() { return this.target; }
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
    const connection = await FamilyApi.probe(platform, await platform.target.read());
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
    } catch { throw new Error('无法连接家庭电脑，请确认电脑已开机且服务运行，再重试'); }
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      const unavailable = response.status === 502 || response.status === 504;
      throw new ApiError(response.status, typeof detail.message === 'string' ? detail.message : unavailable ? '家庭电脑上的服务暂时不可达，请确认服务运行后重试' : '请求失败，请重试', detail.conflict);
    }
    return response;
  }
  private async request<T>(path: string, method = 'GET', body?: unknown, grant?: string): Promise<T> {
    const response = await this.send(path, {
      method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(grant ? { 'X-Parent-Authorization': grant } : {}) }
    });
    return response.status === 204 ? undefined as T : response.json();
  }
  subjects() { return this.request<Subject[]>('/collection/subjects'); }
  ocrSettings(grant: string) { return this.request<OcrSettings>('/admin/ocr', 'GET', undefined, grant); }
  saveOcr(grant: string, input: OcrEdit) { return this.request<OcrSettings>('/admin/ocr', 'PUT', input, grant); }
  testOcr(grant: string, id: string, expectedRevision: number) { return this.request<OcrTest>(`/admin/ocr/tests/${encodeURIComponent(id)}`, 'PUT', { expectedRevision, sample: 'school-v1' }, grant); }
  async ocrSample(grant: string) { return (await this.send('/admin/ocr/sample', { headers: { 'X-Parent-Authorization': grant } })).blob(); }
  addSubject(grant: string, id: string, name: string) { return this.request<Subject>(`/admin/subjects/${encodeURIComponent(id)}`, 'PUT', { name }, grant); }
  studySettings(grant?: string) { return this.request<StudySettings>(grant ? '/admin/study-settings' : '/collection/study-settings', 'GET', undefined, grant); }
  saveStudySettings(grant: string, input: StudySettingsEdit) { return this.request<StudySettings>('/admin/study-settings', 'PUT', input, grant); }
  filterOptions(grant?: string) { return this.request<FilterOptions>('/collection/filter-options', 'GET', undefined, grant); }
  answerPages(offset = 0, grant?: string) { return this.request<AnswerPageList>(`/collection/answer-pages?offset=${offset}`, 'GET', undefined, grant); }
  saveAnswers(id: string, input: AnswerEdit, grant?: string) { return this.request<Question>(`/collection/questions/${encodeURIComponent(id)}/answers`, 'PUT', input, grant); }
  readingMaterials(offset = 0, grant?: string) { return this.request<ReadingMaterialList>(`/collection/reading-materials?offset=${offset}`, 'GET', undefined, grant); }
  readingMaterial(id: string, grant?: string) { return this.request<ReadingMaterial>(`/collection/reading-materials/${encodeURIComponent(id)}`, 'GET', undefined, grant); }
  saveReadingMaterial(id: string, input: ReadingMaterialEdit, grant?: string) { return this.request<ReadingMaterial>(`/collection/reading-materials/${encodeURIComponent(id)}`, 'PUT', input, grant); }
  sources() { return this.request<Source[]>('/collection/sources'); }
  managedSources(grant: string) { return this.request<Source[]>('/admin/sources', 'GET', undefined, grant); }
  saveSource(grant: string, id: string, input: SourceEdit) { return this.request<Source>(`/admin/sources/${encodeURIComponent(id)}`, 'PUT', input, grant); }
  questions(state: 'draft' | 'collected', offset = 0, grant?: string, filters: QuestionFilters = {}) {
    const query = new URLSearchParams({ state, offset: String(offset) });
    for (const [key, value] of Object.entries(filters)) if (value) query.set(key, value);
    return this.request<QuestionList>(`/collection/questions?${query}`, 'GET', undefined, grant);
  }
  question(id: string, grant?: string) { return this.request<Question>(`/collection/questions/${encodeURIComponent(id)}`, 'GET', undefined, grant); }
  saveQuestion(id: string, input: QuestionEdit, grant?: string) { return this.request<Question>(`/collection/questions/${encodeURIComponent(id)}`, 'PUT', input, grant); }
  createQuestion(pageId: string, input: QuestionCreate, grant?: string) { return this.request<Question>(`/collection/pages/${encodeURIComponent(pageId)}/questions`, 'POST', input, grant); }
  uploadImage(file: Blob, operationId: string, grant?: string, stage?: StudyStage) { return this.upload<Question>('drafts', file, operationId, grant, stage); }
  uploadPage(file: Blob, operationId: string, grant?: string) { return this.upload<OriginalPage>('pages', file, operationId, grant); }
  private async upload<T>(target: 'drafts' | 'pages', file: Blob, operationId: string, grant?: string, stage?: StudyStage): Promise<T> {
    const response = await this.send(`/collection/${target}`, { method: 'POST', body: file, headers: { 'Content-Type': ['image/jpeg', 'image/png', 'image/webp'].includes(file.type) ? file.type : 'image/png', 'Idempotency-Key': operationId, ...(grant ? { 'X-Parent-Authorization': grant } : {}), ...(stage ? { 'X-Learning-Stage': encodeURIComponent(JSON.stringify(stage)) } : {}) } });
    return response.json();
  }
  async pageImage(pageId: string, variant: 'original' | 'preview') {
    return (await this.send(`/collection/pages/${encodeURIComponent(pageId)}/${variant}`)).blob();
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
    try { await this.platform.credentials.write(this.credential); return true; }
    catch { return false; }
  }
  async home() {
    const home = await this.request<Home>('/home');
    if (home.library.id !== this.credential?.libraryId || home.account.id !== this.credential.accountId) {
      await this.forget();
      throw new ApiError(401, '资料库身份已变化，请由家长重新登录核对');
    }
    return home;
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
