import type { QuestionPart } from '../shared/collection.ts';
import type { FamilyApi } from './api.ts';
import { CropSelector, QuestionImage } from './QuestionImage.tsx';

const purposes = {
  question: { name: '题目区', image: '已收集的题目区', selection: '框选题目范围', instruction: '一道可以独立作答的小题', hint: '补充区域仍属于这道题；另一道独立题请保存后选择“从此原始页再收集一道”。' },
  reading: { name: '原文区', image: '阅读材料区', selection: '框选原文范围', instruction: '阅读原文', hint: '原文区属于同一篇共享材料；修改后，所有引用它的小题都会看到更新。' },
  answer: { name: '解答区', image: '纸质解答区', selection: '框选解答范围', instruction: '这道题的纸质答案或批改', hint: '解答区只关联当前小题，更正范围不改变其他题目的答案。' }
};
type Purpose = keyof typeof purposes;

export function QuestionParts({ api, parts, original = false, kind = 'question' }: { api: FamilyApi; parts: QuestionPart[]; original?: boolean; kind?: Purpose }) {
  const visible = original ? parts.filter((part, index) => parts.findIndex(other => other.originalPage.id === part.originalPage.id) === index) : parts;
  return <div className="question-parts">{visible.map((part, index) => <div key={part.id}>{visible.length > 1 && <p className="part-caption">{original ? '原始页' : purposes[kind].name} {index + 1}</p>}<QuestionImage api={api} page={part.originalPage} region={part.region} original={original} label={purposes[kind].image} /></div>)}</div>;
}

export function QuestionPartsEditor({ api, parts, selectedId, onSelect, onChange, disabled, kind = 'question' }: {
  api: FamilyApi; parts: QuestionPart[]; selectedId: string; onSelect(id: string): void; onChange(parts: QuestionPart[]): void; disabled: boolean; kind?: Purpose;
}) {
  const index = Math.max(0, parts.findIndex(part => part.id === selectedId));
  const selected = parts[index]!;
  const { name, instruction, selection, hint } = purposes[kind];
  function move(direction: number) {
    const next = [...parts]; [next[index], next[index + direction]] = [next[index + direction]!, next[index]!]; onChange(next);
  }
  return <div className="parts-editor">
    {parts.length > 1 && <><p className="hint">共 {parts.length} 个{name}，按下列顺序显示。点击编号后调整范围或顺序。</p><div className="part-navigation" aria-label={`${name}顺序`}>{parts.map((part, position) => <button key={part.id} className="quiet" disabled={disabled} aria-pressed={selected.id === part.id} onClick={() => onSelect(part.id)}>{name} {position + 1}</button>)}</div></>}
    <CropSelector api={api} page={selected.originalPage} region={selected.region} disabled={disabled} instruction={instruction} label={selection} onChange={region => onChange(parts.map(part => part.id === selected.id ? { ...part, region } : part))} />
    <div className="part-actions">
      {parts.length > 1 && <><button className="quiet" disabled={disabled || index === 0} onClick={() => move(-1)}>向前移动</button><button className="quiet" disabled={disabled || index === parts.length - 1} onClick={() => move(1)}>向后移动</button></>}
      {(parts.length > 1 || kind === 'answer') && <button className="quiet" disabled={disabled} onClick={() => { const next = parts.filter(part => part.id !== selected.id); onChange(next); onSelect(next[Math.min(index, next.length - 1)]?.id ?? ''); }}>移除此{name}</button>}
      <button className="quiet" disabled={disabled || parts.length >= 50} onClick={() => { const next = { id: crypto.randomUUID(), originalPage: selected.originalPage, region: null }; onChange([...parts, next]); onSelect(next.id); }}>在本页补充{name}</button>
    </div>
    <p className="hint">{hint}移除区域会保留原始图片。</p>
  </div>;
}
