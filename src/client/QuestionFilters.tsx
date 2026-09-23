import { useState } from 'react';
import type { FilterOptions, QuestionFilters as Filters, Subject } from '../shared/collection.ts';

function localDate(value: string | undefined, inclusiveEnd = false) {
  if (!value) return '';
  const date = new Date(Number(value) - (inclusiveEnd ? 1 : 0));
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function QuestionFilters({ value, subjects, options, disabled, dates, onChange }: {
  value: Filters; subjects: Subject[]; options: FilterOptions; disabled: boolean; dates: boolean; onChange(value: Filters): void;
}) {
  const [fields, setFields] = useState(value);
  const [from, setFrom] = useState(() => localDate(value.collectedFrom)); const [through, setThrough] = useState(() => localDate(value.collectedBefore, true)); const [error, setError] = useState('');
  function select(key: keyof Filters, label: string, items: { id: string; name: string }[]) {
    return <label>{label}<select aria-label={label} value={fields[key] ?? ''} onChange={event => setFields(previous => ({ ...previous, [key]: event.target.value }))}><option value="">全部</option><option value="__unset__">未设置</option>{items.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>;
  }
  function apply() {
    if (from && through && from > through) { setError('开始日期不能晚于结束日期'); return; }
    const start = from ? new Date(`${from}T00:00:00`) : undefined;
    const end = through ? new Date(`${through}T00:00:00`) : undefined;
    if (end) end.setDate(end.getDate() + 1);
    setError(''); onChange({ ...fields, collectedFrom: dates && start ? String(start.getTime()) : undefined, collectedBefore: dates && end ? String(end.getTime()) : undefined });
  }
  return <details className="question-filters"><summary>筛选错题</summary>
    <p className="hint">{Object.values(value).some(Boolean) ? '已应用筛选。清空可查看全部题目。' : '可组合选择，也可查找尚未设置归属的题目。'}</p>
    {error && <p role="alert" className="message error">{error}</p>}
    <fieldset disabled={disabled}><div className="filter-grid">
      {select('subjectId', '筛选学科', subjects)}{select('schoolYear', '筛选学年', options.schoolYears.map(id => ({ id, name: id })))}{select('grade', '筛选年级', options.grades.map(id => ({ id, name: id })))}
      {select('term', '筛选学期', [{ id: 'first', name: '上学期' }, { id: 'second', name: '下学期' }])}{select('sourceId', '筛选来源', options.sources.map(source => ({ id: source.id, name: `${source.name}${source.active ? '' : '（已停用）'}` })))}
      {dates && <><label>收集开始日期<input type="date" value={from} onChange={event => setFrom(event.target.value)} /></label><label>收集结束日期<input type="date" value={through} onChange={event => setThrough(event.target.value)} /></label></>}
    </div><p className="hint">日期按当前设备的本地日期，包含开始和结束当天。</p><button onClick={apply}>应用筛选</button><button className="quiet" onClick={() => { setFields({}); setFrom(''); setThrough(''); setError(''); onChange({}); }}>清空筛选</button></fieldset>
  </details>;
}
