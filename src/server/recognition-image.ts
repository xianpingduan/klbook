import sharp from 'sharp';
import type { Region } from '../shared/collection.ts';
import { OcrFailure } from './ocr-provider.ts';

/** Prepare a disposable OCR crop; coordinates returned here map results back to the untouched original. */
export async function recognitionImage(original: Buffer, region: Region | null) {
  const oriented = await sharp(original).autoOrient().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = oriented.info;
  const left = Math.min(width - 1, Math.round((region?.x ?? 0) * width));
  const top = Math.min(height - 1, Math.round((region?.y ?? 0) * height));
  const right = Math.min(width, Math.max(left + 1, Math.round(((region?.x ?? 0) + (region?.width ?? 1)) * width)));
  const bottom = Math.min(height, Math.max(top + 1, Math.round(((region?.y ?? 0) + (region?.height ?? 1)) * height)));
  const crop = { left, top, width: right - left, height: bottom - top };
  let bound = Math.max(crop.width, crop.height);
  for (;;) {
    const prepared = await sharp(oriented.data, { raw: oriented.info }).extract(crop).flatten({ background: 'white' }).resize({ width: bound, height: bound, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 90, chromaSubsampling: '4:4:4' }).toBuffer({ resolveWithObject: true });
    if (prepared.data.length <= 3 * 1024 * 1024) return { image: prepared.data, width: prepared.info.width, height: prepared.info.height,
      region: { x: left / width, y: top / height, width: crop.width / width, height: crop.height / height } };
    if (bound <= 700) throw new OcrFailure('材料暂无法转换为识别图片，可以继续手动框题');
    bound = Math.floor(bound * .75);
  }
}
