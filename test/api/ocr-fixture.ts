import { auth, familyFixture, password } from './fixture.ts';

export const ocrPath = '/api/v1/admin/ocr';

export async function ocrParent(f: Awaited<ReturnType<typeof familyFixture>>) {
  const grant = (await f.app.inject({ method: 'POST', url: '/api/v1/admin/grants', headers: auth(f.first.token), payload: { password } })).json().token;
  return auth(f.first.token, grant);
}

export async function finishedOcr(f: Awaited<ReturnType<typeof familyFixture>>, headers: ReturnType<typeof auth>) {
  for (let i = 0; i < 200; i++) {
    const data = (await f.app.inject({ url: ocrPath, headers })).json();
    if (data.tests[0]?.status !== 'running') return data;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('test did not settle');
}
