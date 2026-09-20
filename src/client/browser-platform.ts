import type { ClientPlatform, DraftScope, SavedCredential } from './platform.ts';
import { serverOrigin } from './platform.ts';

function draftKey(scope: DraftScope, id: string) { return [scope.libraryId, scope.accountId, id]; }
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
      async read() { return serverOrigin(localStorage.getItem('klbook.target') ?? window.location.origin); },
      async write(value) { localStorage.setItem('klbook.target', serverOrigin(value)); }
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
      async put(scope, id, value) { await drafts('readwrite', store => store.put(value, draftKey(scope, id))); },
      async get(scope, id) { return drafts<Blob | undefined>('readonly', store => store.get(draftKey(scope, id))); },
      async remove(scope, id) { await drafts('readwrite', store => store.delete(draftKey(scope, id))); }
    },
    request: (url, init) => fetch(url, init)
  };
}
