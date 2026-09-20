import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/server/app.ts';
import type { SessionResult } from '../../src/shared/contracts.ts';

export const password = 'family password 123';
export const auth = (token: string, grant?: string) => ({ authorization: `Bearer ${token}`, ...(grant ? { 'x-parent-authorization': grant } : {}) });
export async function familyFixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'klbook-api-'));
  let now = Date.now();
  const app = createApp({ dataDir, now: () => now });
  const setupCode = (await readFile(join(dataDir, 'setup-code.txt'), 'utf8')).trim();
  const response = await app.inject({ method: 'POST', url: '/api/v1/setup', payload: { setupCode, username: 'parent', password, learnerName: '小明', deviceName: '电脑' } });
  if (response.statusCode !== 201) throw new Error(response.body);
  const first = response.json<SessionResult>();
  return {
    app, dataDir, first,
    advance: (milliseconds: number) => { now += milliseconds; },
    login: (deviceName: string, loginPassword = password) => app.inject({ method: 'POST', url: '/api/v1/sessions', payload: { username: 'parent', password: loginPassword, deviceName } }),
    async close() { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
  };
}
