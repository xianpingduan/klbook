export interface StudyStage { schoolYear: string | null; grade: string | null; term: 'first' | 'second' | null }
export interface StudySettings { revision: number; stage: StudyStage }
export interface StudySettingsEdit { operationId: string; expectedRevision: number; stage: StudyStage }
export const emptyStage: StudyStage = { schoolYear: null, grade: null, term: null };
export const termNames = { first: '上学期', second: '下学期' };
export function stageLabel(stage: StudyStage) {
  return [stage.schoolYear && `${stage.schoolYear} 学年`, stage.grade, stage.term && termNames[stage.term]].filter(Boolean).join(' · ') || '学习阶段未设置';
}
export function validStage(value: unknown): value is StudyStage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const stage = value as Record<string, unknown>;
  return Object.keys(stage).length === 3 && (stage.schoolYear === null || (typeof stage.schoolYear === 'string' && /^\d{4}-\d{4}$/.test(stage.schoolYear)
    && Number(stage.schoolYear.slice(5)) === Number(stage.schoolYear.slice(0, 4)) + 1))
    && (stage.grade === null || (typeof stage.grade === 'string' && stage.grade.trim().length > 0 && stage.grade.length <= 40))
    && (stage.term === null || stage.term === 'first' || stage.term === 'second');
}
