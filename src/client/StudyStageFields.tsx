import type { StudyStage } from '../shared/study.ts';

export function StudyStageFields({ value, onChange }: { value: StudyStage; onChange(value: StudyStage): void }) {
  return <div className="study-fields">
    <label>学年（选填）<input value={value.schoolYear ?? ''} maxLength={9} placeholder="例如：2026-2027" onChange={event => onChange({ ...value, schoolYear: event.target.value || null })} /></label>
    <label>年级（选填）<input value={value.grade ?? ''} maxLength={40} placeholder="例如：小学四年级" onChange={event => onChange({ ...value, grade: event.target.value || null })} /></label>
    <label>学期（选填）<select aria-label="学期（选填）" value={value.term ?? ''} onChange={event => onChange({ ...value, term: event.target.value === 'first' ? 'first' : event.target.value === 'second' ? 'second' : null })}><option value="">未设置</option><option value="first">上学期</option><option value="second">下学期</option></select></label>
  </div>;
}
