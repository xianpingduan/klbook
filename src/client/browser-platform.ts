import type { ClientPlatform, DraftScope, SavedCredential } from './platform.ts';
import { serverOrigin } from './platform.ts';

function draftKey(scope: DraftScope, id: string) { return [scope.libraryId, scope.accountId, id]; }
function connectionSettings(): { active: string; pending: string | null } {
  const raw = localStorage.getItem('klbook.connection');
  if (!raw) return { active: localStorage.getItem('klbook.target') ?? window.location.origin, pending: null };
  const value = JSON.parse(raw);
  if (!value || typeof value.active !== 'string' || (value.pending !== null && typeof value.pending !== 'string')) throw new Error('本机连接配置无法读取，请重新设置服务地址');
  return value;
}
async function drafts<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('klbook-device-drafts', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('drafts');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('请关闭旧的错题集页面后重试'));
  });
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction('drafts', mode);
      const request = operation(transaction.objectStore('drafts'));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () => reject(transaction.error ?? new Error('设备暂存失败'));
      transaction.onerror = () => reject(transaction.error);
    });
  } finally { db.close(); }
}

export function browserPlatform(): ClientPlatform {
  return {
    target: {
      async read() { return serverOrigin(connectionSettings().active); },
      async write(value) { localStorage.setItem('klbook.connection', JSON.stringify({ active: serverOrigin(value), pending: null })); },
      async readPending() { return connectionSettings().pending; },
      async writePending(value) { localStorage.setItem('klbook.connection', JSON.stringify({ ...connectionSettings(), pending: serverOrigin(value) })); }
    },
    credentials: {
      async read(target) {
        const raw = localStorage.getItem(`klbook.credential:${target}`);
        if (!raw) return null;
        try {
          const value: Partial<SavedCredential> = JSON.parse(raw);
          if (value.target === target && typeof value.libraryId === 'string' && typeof value.accountId === 'string' && typeof value.token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value.token)) return value as SavedCredential;
        } catch { /* A damaged credential is treated as signed out. */ }
        localStorage.removeItem(`klbook.credential:${target}`);
        return null;
      },
      async write(value) { localStorage.setItem(`klbook.credential:${value.target}`, JSON.stringify(value)); },
      async remove(target) { localStorage.removeItem(`klbook.credential:${target}`); }
    },
    drafts: {
      async put(scope, id, value) {
        // WebKit on Windows cannot persist Blob objects; keep bytes and MIME in one transaction.
        const stored = { bytes: await value.arrayBuffer(), type: value.type };
        await drafts('readwrite', store => store.put(stored, draftKey(scope, id)));
      },
      async get(scope, id) {
        const stored = await drafts<Blob | { bytes: ArrayBuffer; type: string } | undefined>('readonly', store => store.get(draftKey(scope, id)));
        if (!stored || stored instanceof Blob) return stored;
        if (!(stored.bytes instanceof ArrayBuffer) || typeof stored.type !== 'string') throw new Error('设备暂存数据无法读取');
        return new Blob([stored.bytes], { type: stored.type });
      },
      async remove(scope, id) { await drafts('readwrite', store => store.delete(draftKey(scope, id))); }
    },
    request: (url, init) => fetch(url, init)
  };
}
