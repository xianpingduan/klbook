import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AccessError } from './family-access.ts';

/** The key belongs to this local installation, separately from the database. Never expose either via HTTP. */
export class CredentialVault {
  private path: string;
  constructor(dataDir: string) { this.path = join(dataDir, 'service-credentials.key'); }
  private key(create: boolean) {
    try {
      if (create && !existsSync(this.path)) writeFileSync(this.path, randomBytes(32), { flag: 'wx', mode: 0o600 });
      const key = readFileSync(this.path);
      if (key.length !== 32) throw new Error('invalid key');
      return key;
    } catch { throw new AccessError(503, '本机服务凭据密钥无法读取，请恢复数据目录中的 service-credentials.key 后重试'); }
  }
  seal(value: string, existing: boolean) {
    const key = this.key(!existing), iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from('klbook:ocr:credentials:v1'));
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), encrypted].map(part => part.toString('base64')).join('.');
  }
  open(value: string) {
    try {
      const parts = value.split('.');
      if (parts.length !== 3) throw new Error('invalid envelope');
      const [iv, tag, data] = parts.map(part => Buffer.from(part, 'base64'));
      const decipher = createDecipheriv('aes-256-gcm', this.key(false), iv!);
      decipher.setAAD(Buffer.from('klbook:ocr:credentials:v1')); decipher.setAuthTag(tag!);
      return Buffer.concat([decipher.update(data!), decipher.final()]).toString('utf8');
    } catch { throw new AccessError(503, '本机服务凭据无法解密，请恢复配套密钥文件后重试'); }
  }
}
