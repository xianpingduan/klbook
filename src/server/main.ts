import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.ts';

const dataDir = process.env.KLBOOK_DATA_DIR ?? join(process.env.LOCALAPPDATA ?? join(homedir(), '.local', 'share'), 'klbook', 'data');
const port = Number(process.env.KLBOOK_PORT ?? 8787);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('KLBOOK_PORT 必须为有效端口');
const origins = (process.env.KLBOOK_ALLOWED_ORIGINS ?? 'http://127.0.0.1:5173').split(',').map(value => value.trim()).filter(Boolean);
const here = dirname(fileURLToPath(import.meta.url));
const staticDir = here.endsWith(join('src', 'server')) ? resolve(here, '../../dist/client') : resolve(here, '../../client');
const app = createApp({ dataDir, allowedOrigins: origins, staticDir });
try {
  const address = await app.listen({ host: '127.0.0.1', port });
  origins.push(address, address.replace('127.0.0.1', 'localhost'));
  console.log(`KLBOOK_LISTENING=${address}`);
  console.log(`数据目录：${dataDir}`);
  console.log(`首次使用请在本机读取设置码：${join(dataDir, 'setup-code.txt')}`);
} catch (error) {
  await app.close();
  throw error;
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void app.close().then(() => { process.exitCode = 0; }); });
}
