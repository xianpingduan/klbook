import sharp from 'sharp';

// Synthetic material only. No learner photographs or identifying information.
let sample: Promise<Buffer> | undefined;
export function ocrSample() {
  return sample ??= sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="600"><rect width="1000" height="600" fill="white"/><g fill="#111" font-family="sans-serif" font-size="36"><text x="50" y="80">错题集 · 图片识别测试材料</text><text x="50" y="180">语文：春天来了，小树长出了新叶。</text><text x="50" y="280">数学：12 × 3 = 36</text><text x="50" y="380">English: I read a book every day.</text><text x="50" y="480">科学：植物生长需要水和阳光。</text></g></svg>`)).png().toBuffer();
}
