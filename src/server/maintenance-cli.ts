import { readFile } from 'node:fs/promises';
import { get } from 'node:https';
import { checkExistingData } from './startup.ts';

const [action, path] = process.argv.slice(2);
const ready = (info: unknown) => !!info && typeof info === 'object' && 'app' in info && info.app === 'klbook' && 'apiVersion' in info && info.apiVersion === 1 && 'initialized' in info && info.initialized === true;
try {
  if (!path) throw new Error('请提供数据目录或维护配置文件');
  if (action === 'check') {
    console.log(JSON.stringify(await checkExistingData(path)));
  } else if (action === 'probe') {
    const config = JSON.parse(await readFile(path, 'utf8'));
    const result = { app: false, gateway: false, message: '' };
    try {
      const response = await fetch(`http://127.0.0.1:${config.backendPort}/api/v1/info`, { signal: AbortSignal.timeout(2500) });
      const info = await response.json(); result.app = response.ok && ready(info);
    } catch { result.message = '应用尚未就绪或无法连接'; }
    try {
      const ca = await readFile(config.rootCertificate);
      result.gateway = await new Promise<boolean>(resolve => {
        const request = get(`${config.origin}/api/v1/info`, { ca, timeout: 2500 }, response => {
          let text = ''; response.on('data', data => { text += data; if (text.length > 4096) request.destroy(); });
          response.on('error', () => resolve(false)); response.on('end', () => { try { resolve(response.statusCode === 200 && ready(JSON.parse(text))); } catch { resolve(false); } });
        });
        request.on('timeout', () => request.destroy()); request.on('error', () => resolve(false));
      });
    } catch { /* Report unavailable without disabling certificate verification. */ }
    if (result.app && !result.gateway) result.message = '应用已启动，但局域网 HTTPS 尚未就绪，请检查地址、网关与证书';
    if (result.app && result.gateway) result.message = '应用与局域网 HTTPS 已就绪';
    console.log(JSON.stringify(result));
  } else throw new Error('未知维护命令');
} catch (error) { console.error(error instanceof Error ? error.message : '本机维护检查失败'); process.exitCode = 1; }
