import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createApp } from './app.ts';
import { checkExistingData, StartupStatus } from './startup.ts';

const dataDir = process.env.KLBOOK_DATA_DIR ?? join(process.env.LOCALAPPDATA ?? join(homedir(), '.local', 'share'), 'klbook', 'data');
const port = Number(process.env.KLBOOK_PORT ?? 8787);
const origins = (process.env.KLBOOK_ALLOWED_ORIGINS ?? 'http://127.0.0.1:5173').split(',').map(value => value.trim()).filter(Boolean);
const here = dirname(fileURLToPath(import.meta.url));
const staticDir = here.endsWith(join('src', 'server')) ? resolve(here, '../../dist/client') : resolve(here, '../../client');
const startup = new StartupStatus(process.env.KLBOOK_STARTUP_STATE);
let app: ReturnType<typeof createApp> | undefined;
try {
  await startup.report('checking', '正在检查本机资料与启动应用');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('KLBOOK_PORT 必须为有效端口');
  if (process.env.KLBOOK_REQUIRE_EXISTING === '1') {
    await checkExistingData(dataDir, process.env.KLBOOK_EXPECTED_LIBRARY_ID);
    const { access } = await import('node:fs/promises');
    await access(join(staticDir, 'index.html')).catch(() => { throw new Error('网页构建文件缺失，请重新部署完整版本'); });
  }
  const serviceCandidate = process.env.KLBOOK_STARTUP_STATE ? dirname(dirname(process.env.KLBOOK_STARTUP_STATE)) : undefined;
  const serviceDir = serviceCandidate && existsSync(join(serviceCandidate, 'deployment.json')) ? serviceCandidate : undefined;
  app = createApp({ dataDir, allowedOrigins: origins, staticDir, serviceDir });
  const address = await app.listen({ host: '127.0.0.1', port });
  origins.push(address, address.replace('127.0.0.1', 'localhost'));
  await startup.report('ready', '应用已就绪');
  console.log(`KLBOOK_LISTENING=${address}`);
  console.log(`数据目录：${dataDir}`);
  console.log(`首次使用请在本机读取设置码：${join(dataDir, 'setup-code.txt')}`);
} catch (error) {
  await app?.close();
  const message = error instanceof Error ? error.message : '应用启动失败，请检查维护日志';
  await startup.report('failed', message).catch(() => {});
  console.error(message);
  process.exitCode = 1;
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void app?.close().then(async () => { await startup.report('stopped', '应用已停止'); process.exitCode = 0; }); });
}
