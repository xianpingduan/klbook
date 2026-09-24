export interface SavedCredential {
  target: string;
  libraryId: string;
  accountId: string;
  token: string;
}
export interface DraftScope { libraryId: string; accountId: string }
export interface ClientPlatform {
  target: { read(): Promise<string>; write(value: string): Promise<void>; readPending(): Promise<string | null>; writePending(value: string): Promise<void> };
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
  const message = '服务地址需为 HTTPS 主机与端口，不含账号、路径或查询参数；本机开发可使用 HTTP 回环地址';
  try {
    const input = value.trim();
    if (!/^https?:\/\/[^/?#\\\s]+\/?$/i.test(input)) throw new Error(message);
    const url = new URL(input);
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.port === '0' || url.pathname !== '/') throw new Error(message);
    return url.origin;
  } catch { throw new Error(message); }
}
