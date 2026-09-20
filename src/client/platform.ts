export interface SavedCredential {
  target: string;
  libraryId: string;
  accountId: string;
  token: string;
}
export interface DraftScope { libraryId: string; accountId: string }
export interface ClientPlatform {
  target: { read(): Promise<string>; write(value: string): Promise<void> };
  credentials: {
    read(target: string): Promise<SavedCredential | null>;
    write(value: SavedCredential): Promise<void>;
    remove(target: string): Promise<void>;
  };
  drafts: {
    put(scope: DraftScope, id: string, value: Blob): Promise<void>;
    get(scope: DraftScope, id: string): Promise<Blob | undefined>;
    remove(scope: DraftScope, id: string): Promise<void>;
  };
  request(url: string, init: RequestInit): Promise<Response>;
}

export function serverOrigin(value: string) {
  const url = new URL(value);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('服务地址需为 HTTPS 主机与端口；本机开发可使用 HTTP 回环地址');
  }
  return url.origin;
}
