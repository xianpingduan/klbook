import type { ReadingMaterial } from './reading-materials.ts';

export interface Subject { id: string; name: string }
export interface Region { x: number; y: number; width: number; height: number }
export function validQuestionRegion(region: Region | null): region is Region {
  return !!region && Object.values(region).every(Number.isFinite) && region.x >= 0 && region.y >= 0 && region.width > 0 && region.height > 0
    && region.x + region.width <= 1.000001 && region.y + region.height <= 1.000001;
}
export interface OriginalPage {
  id: string; mimeType: string; byteLength: number; sha256: string; width: number; height: number;
}
export interface QuestionPart { id: string; originalPage: OriginalPage; region: Region | null }
export interface QuestionPartEdit { id: string; pageId: string; region: Region | null }
export interface Question {
  id: string; libraryId: string; learnerId: string; revision: number;
  state: 'draft' | 'collected'; syncState: 'synced'; subjectId: string | null; region: Region | null;
  sourceId: string | null; source: string; pageNumber: string; questionNumber: string; note: string;
  createdAt: number; updatedAt: number; collectedAt: number | null;
  originalPage: OriginalPage;
  parts: QuestionPart[];
  readingMaterial: ReadingMaterial | null;
  answerParts: QuestionPart[];
}
export interface AnswerEdit { operationId: string; expectedRevision: number; parts: QuestionPartEdit[] }
export interface AnswerPageList { items: OriginalPage[]; total: number; offset: number; limit: number }
export interface QuestionList { items: Question[]; total: number; offset: number; limit: number }
export interface QuestionEdit {
  operationId: string; expectedRevision: number; state: 'draft' | 'collected';
  subjectId: string | null; region: Region | null;
  sourceId?: string | null; source?: string; pageNumber: string; questionNumber: string; note: string;
  parts?: QuestionPartEdit[];
  readingMaterialId?: string | null;
}
export type QuestionCreate = Omit<QuestionEdit, 'expectedRevision'>;
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
