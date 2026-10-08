// Throwaway UI preview. Static files only; no API, storage, credentials or OCR.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
const base = '/prototype/collection-interaction/';
const files = new Map([[base, ['index.html', 'text/html; charset=utf-8']], [base + 'preview.css', ['preview.css', 'text/css; charset=utf-8']], [base + 'preview.js', ['preview.js', 'text/javascript; charset=utf-8']]]);
createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (!['GET', 'HEAD'].includes(req.method)) return res.writeHead(405).end();
  if (path === '/' || path === base.slice(0, -1)) return res.writeHead(302, { Location: base + '?variant=A&step=confirm&size=phone' }).end();
  if (path === '/favicon.ico') return res.writeHead(204).end();
  const entry = files.get(path);
  if (!entry) return res.writeHead(404).end('Not found');
  res.writeHead(200, { 'Content-Type': entry[1], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'none'; frame-ancestors 'none'" });
  res.end(req.method === 'HEAD' ? undefined : await readFile(new URL(entry[0], import.meta.url)));
}).listen(8788, '127.0.0.1', () => console.log('PREVIEW_READY=http://127.0.0.1:8788/prototype/collection-interaction/?variant=A&step=confirm&size=phone'));
