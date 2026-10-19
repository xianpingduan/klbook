import { fromBuffer } from 'yauzl';

/** Read the public ZIP artifact using an independent ZIP implementation. */
export async function packageFiles(bytes: Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => fromBuffer(bytes, { lazyEntries: true }, (error, zip) => {
    if (error) return reject(error);
    const files = new Map<string, Buffer>();
    zip.on('error', reject); zip.on('end', () => resolve(files));
    zip.on('entry', entry => zip.openReadStream(entry, (failure, stream) => {
      if (failure) return reject(failure);
      const chunks: Buffer[] = [];
      stream.on('error', reject); stream.on('data', chunk => chunks.push(chunk));
      stream.on('end', () => { files.set(entry.fileName, Buffer.concat(chunks)); zip.readEntry(); });
    }));
    zip.readEntry();
  }));
}
