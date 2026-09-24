import type { Question } from '../shared/collection.ts';

export function questionFields(question: Question) {
  return { subjectId: question.subjectId, parts: question.parts, sourceId: question.sourceId, pageNumber: question.pageNumber, questionNumber: question.questionNumber, note: question.note, readingMaterialId: question.readingMaterial?.id ?? null, studyStage: question.studyStage };
}
export type QuestionFields = ReturnType<typeof questionFields>;
export function questionContent(fields: QuestionFields, state: Question['state']) {
  return { state, subjectId: fields.subjectId, region: fields.parts[0]!.region,
    sourceId: fields.sourceId, pageNumber: fields.pageNumber.trim(), questionNumber: fields.questionNumber.trim(), note: fields.note.trim(),
    parts: fields.parts.map(part => ({ id: part.id, pageId: part.originalPage.id, region: part.region })), readingMaterialId: fields.readingMaterialId, studyStage: fields.studyStage };
}
