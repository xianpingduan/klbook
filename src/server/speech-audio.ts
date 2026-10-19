import { AccessError } from './family-access.ts';

export interface SpeechAudio { pcm: Buffer; sampleRate: number; durationMs: number }
export const maxSpeechUpload = 2 * 1024 * 1024;
/** Read RIFF chunks, not a fixed 44-byte offset: recorder metadata is allowed. */
export function speechAudio(bytes: Buffer): SpeechAudio {
  const invalid = () => new AccessError(422, '请选择完整的 PCM WAV 音频：16 位、单声道、8 kHz 或 16 kHz，时长不超过 60 秒');
  if (!Buffer.isBuffer(bytes) || bytes.length < 44 || bytes.length > maxSpeechUpload || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE' || bytes.readUInt32LE(4) + 8 !== bytes.length) throw invalid();
  let sampleRate = 0, pcm: Buffer | undefined, hasFormat = false, offset = 12;
  while (offset + 8 <= bytes.length) {
    const kind = bytes.toString('ascii', offset, offset + 4), size = bytes.readUInt32LE(offset + 4), start = offset + 8;
    if (start + size > bytes.length) throw invalid();
    if (kind === 'fmt ') {
      if (hasFormat || size < 16) throw invalid();
      hasFormat = true; sampleRate = bytes.readUInt32LE(start + 4);
      if (bytes.readUInt16LE(start) !== 1 || bytes.readUInt16LE(start + 2) !== 1 || ![8000, 16000].includes(sampleRate) || bytes.readUInt32LE(start + 8) !== sampleRate * 2 || bytes.readUInt16LE(start + 12) !== 2 || bytes.readUInt16LE(start + 14) !== 16) throw invalid();
    } else if (kind === 'data') {
      if (pcm || !size || size % 2) throw invalid();
      pcm = bytes.subarray(start, start + size);
    }
    offset = start + size + size % 2;
  }
  if (offset !== bytes.length || !hasFormat || !pcm || pcm.length > sampleRate * 2 * 60) throw invalid();
  return { pcm, sampleRate, durationMs: Math.ceil(pcm.length / (sampleRate * 2) * 1000) };
}
