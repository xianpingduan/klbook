import type { Device, Home, LoginInput, ParentGrant, RecoveryInput, ServerInfo, SessionResult, SetupInput } from '../shared/contracts.ts';
import type { ClientPlatform, SavedCredential } from './platform.ts';
import { serverOrigin } from './platform.ts';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export class FamilyApi {
  private platform: ClientPlatform;
  private target: string;
  private credential: SavedCredential | null;

  private constructor(platform: ClientPlatform, target: string, credential: SavedCredential | null) {
    this.platform = platform; this.target = target; this.credential = credential;
  }
  static async connect(platform: ClientPlatform) {
    const target = serverOrigin(await platform.target.read());
    const api = new FamilyApi(platform, target, null);
    // Probe without credentials, even when the device remembers a session.
    const info = await api.info();
    if (info.app !== 'klbook' || info.apiVersion !== 1) throw new Error('此服务与当前客户端不兼容');
    api.credential = await platform.credentials.read(target);
    return { api, info };
  }
  private async request<T>(path: string, method = 'GET', body?: unknown, grant?: string): Promise<T> {
    let response: Response;
    try {
      response = await this.platform.request(`${this.target}/api/v1${path}`, {
        method, body: body === undefined ? undefined : JSON.stringify(body),
        headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(this.credential ? { Authorization: `Bearer ${this.credential.token}` } : {}), ...(grant ? { 'X-Parent-Authorization': grant } : {}) },
        credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(10000)
      });
    } catch { throw new Error('无法连接家庭电脑，请确认电脑已开机且服务运行，再重试'); }
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      throw new ApiError(response.status, typeof detail.message === 'string' ? detail.message : '请求失败，请重试');
    }
    return response.status === 204 ? undefined as T : response.json();
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
