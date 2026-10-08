import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Cache public application assets only. Authenticated API data belongs to the
// account-scoped client store, never to a service-worker response cache.
export function offlineShell() {
  let output;
  return {
    name: 'klbook-offline-shell',
    configResolved(config) { output = resolve(config.root, config.build.outDir); },
    async writeBundle(_options, bundle) {
      const assets = Object.keys(bundle).filter(name => name === 'index.html' || name.startsWith('assets/')).map(name => '/' + name);
      const html = await readFile(resolve(output, 'index.html'), 'utf8');
      const version = createHash('sha256').update(html + assets.join('|')).digest('hex').slice(0, 16);
      const source = `const CACHE = 'klbook-shell-${version}';
const ASSETS = ${JSON.stringify(assets)};
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS))));
self.addEventListener('activate', event => event.waitUntil(Promise.all([self.clients.claim(), caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('klbook-shell-') && key !== CACHE).map(key => caches.delete(key))))])));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  const navigation = event.request.mode === 'navigate' && (url.pathname === '/' || url.pathname === '/learn' || url.pathname.startsWith('/learn/') || url.pathname === '/admin' || url.pathname.startsWith('/admin/'));
  if (!navigation && !ASSETS.includes(url.pathname)) return;
  event.respondWith(caches.open(CACHE).then(async cache => (await cache.match(navigation ? '/index.html' : url.pathname)) || fetch(event.request)));
});
`;
      await writeFile(resolve(output, 'offline-worker.js'), source);
    }
  };
}
