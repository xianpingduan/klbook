import type { QuestionPart, QuestionPartEdit } from './collection.ts';

export interface ReadingMaterialSummary { id: string; title: string; revision: number; referenceCount: number; partCount: number }
export interface ReadingMaterial extends ReadingMaterialSummary { libraryId: string; createdAt: number; updatedAt: number; parts: QuestionPart[] }
export interface ReadingMaterialList { items: ReadingMaterialSummary[]; total: number; offset: number; limit: number }
export interface ReadingMaterialEdit { operationId: string; expectedRevision: number; title: string; parts: QuestionPartEdit[] }
