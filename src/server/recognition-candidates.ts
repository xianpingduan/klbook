import type { OcrCandidate, OcrLine } from '../shared/ocr.ts';
import type { Subject } from '../shared/collection.ts';

/** Conservative numbered text groups, never a claim that diagrams or full questions were detected. */
export function recognitionCandidates(lines: OcrLine[], width: number, height: number, subjects: Subject[]): OcrCandidate[] {
  const placed = lines.filter(line => line.box && line.box.width > 0 && line.box.height > 0 && line.box.left < width && line.box.top < height).sort((a, b) => a.box!.top - b.box!.top || a.box!.left - b.box!.left);
  const number = (text: string) => /^\s*(?:第\s*)?(\d{1,3})\s*[.．、:：)）题]/.exec(text)?.[1] ?? '';
  const anchors = placed.filter(line => number(line.text));
  const columns: number[] = [];
  for (const line of anchors) if (!columns.some(x => Math.abs(x - line.box!.left) < width * .18)) columns.push(line.box!.left);
  const groups: OcrLine[][] = [];
  for (const x of columns.length ? columns.sort((a, b) => a - b) : [0]) {
    const column = placed.filter(line => !columns.length || columns.reduce((nearest, next) => Math.abs(next - line.box!.left) < Math.abs(nearest - line.box!.left) ? next : nearest, columns[0]!) === x);
    let group: OcrLine[] | undefined;
    for (const line of column) {
      if (number(line.text) || !anchors.length) { group = []; groups.push(group); }
      group?.push(line);
    }
  }
  const subject = (text: string) => {
    const name = /科学|植物|动物|实验|物质/.test(text) ? '科学' : /English|[A-Za-z]{3,}\s+[A-Za-z]{2,}/.test(text) ? '英语' : /数学|计算|[×÷=]|\d\s*[+−-]\s*\d/.test(text) ? '数学' : /语文|拼音|词语|课文|汉字/.test(text) ? '语文' : null;
    return subjects.find(item => item.name === name)?.id ?? null;
  };
  const pageSubject = subject(lines.map(line => line.text).join('\n'));
  return groups.slice(0, 100).map((group, index) => {
    const left = Math.max(0, Math.min(...group.map(line => line.box!.left)) - width * .01);
    const top = Math.max(0, Math.min(...group.map(line => line.box!.top)) - height * .01);
    const right = Math.min(width, Math.max(...group.map(line => line.box!.left + line.box!.width)) + width * .01);
    const bottom = Math.min(height, Math.max(...group.map(line => line.box!.top + line.box!.height)) + height * .01);
    const text = group.map(line => line.text).join('\n').slice(0, 20000);
    return { id: String(index + 1), text, region: { x: left / width, y: top / height, width: (right - left) / width, height: (bottom - top) / height }, questionNumber: number(group[0]!.text), subjectId: subject(text) ?? pageSubject };
  });
}
