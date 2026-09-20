import { spawn } from 'node:child_process';
import { once } from 'node:events';

export async function startServer(dataDir: string, port = 0) {
  const child = spawn(process.execPath, ['dist/node/server/main.js'], {
    env: { ...process.env, KLBOOK_DATA_DIR: dataDir, KLBOOK_PORT: String(port), KLBOOK_ALLOWED_ORIGINS: '' },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  const url = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`启动超时：${output}`)); }, 15000);
    child.stderr.on('data', data => { output += String(data); });
    child.stdout.on('data', data => {
      output += String(data);
      const match = /KLBOOK_LISTENING=(http:\/\/127\.0\.0\.1:\d+)/.exec(output);
      if (match?.[1]) { clearTimeout(timeout); resolve(match[1]); }
    });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`服务退出 ${code}：${output}`)); });
  });
  return { url, async stop() {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  } };
}
