import { setTimeout as pause } from 'node:timers/promises';
import type { SpeechSocketFactory } from '../../src/server/xfyun-speech.ts';
import type { SpeechSettings } from '../../src/shared/speech.ts';
import type { familyFixture, auth } from './fixture.ts';

export function testWav(milliseconds = 80, sampleRate = 16000) {
  const size = Math.round(milliseconds * sampleRate / 1000) * 2;
  const bytes = Buffer.alloc(44 + size);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24); bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(size, 40);
  return bytes;
}
// Only the external WebSocket boundary is substituted; the adapter sends real protocol frames.
export class SpeechSocketStub extends EventTarget {
  frames: { common?: { app_id: string }; business?: { language: string }; data: { status: number; audio?: string; format?: string } }[] = [];
  closed = false;
  private finish: (socket: SpeechSocketStub) => void;
  constructor(finish: (socket: SpeechSocketStub) => void) { super(); this.finish = finish; queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
  send(value: string) { this.frames.push(JSON.parse(value)); if (this.frames.at(-1)?.data.status === 2) this.finish(this); }
  close() { this.closed = true; }
  reply(value: unknown) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
}
export function speechVendor(finish: (socket: SpeechSocketStub) => void = socket => socket.reply({ code: 0, data: { status: 2, result: { sn: 0, ws: [{ cw: [{ w: '我先读题，再列式。' }] }] } } })) {
  const sockets: SpeechSocketStub[] = [], urls: URL[] = [];
  const connect: SpeechSocketFactory = url => { urls.push(new URL(url)); const socket = new SpeechSocketStub(finish); sockets.push(socket); return socket; };
  return { sockets, urls, connect };
}
export async function finishedSpeech(f: Pick<Awaited<ReturnType<typeof familyFixture>>, 'app'>, headers: ReturnType<typeof auth>) {
  for (let index = 0; index < 400; index++) {
    const value = (await f.app.inject({ url: '/api/v1/admin/speech', headers })).json<SpeechSettings>();
    if (value.tests[0]?.status !== 'running') return value;
    await pause(20);
  }
  throw new Error('speech test did not settle');
}
