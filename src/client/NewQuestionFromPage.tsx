import { useState } from 'react';
import type { OriginalPage, QuestionPart } from '../shared/collection.ts';

export function NewQuestionFromPage({ parts, disabled, onChoose }: { parts: QuestionPart[]; disabled: boolean; onChoose(page: OriginalPage): void }) {
  const pages = parts.map(part => part.originalPage).filter((page, index, all) => all.findIndex(other => other.id === page.id) === index);
  const [pageId, setPageId] = useState(pages[0]!.id);
  const selected = pages.find(page => page.id === pageId) ?? pages[0]!;
  return <div className="new-from-page">
    {pages.length > 1 && <label>继续选题的原始页<select value={selected.id} disabled={disabled} onChange={event => setPageId(event.target.value)}>{pages.map((page, index) => <option key={page.id} value={page.id}>原始页 {index + 1}</option>)}</select></label>}
    <button className="quiet" disabled={disabled} onClick={() => onChoose(selected)}>从此原始页再收集一道</button>
  </div>;
}
