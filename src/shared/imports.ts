import type { StudyStage } from './study.ts';

export const MAX_PACKAGE_BYTES = 512 * 1024 * 1024;
export interface ImportSubject { id: string; name: string; action: 'existing' | 'new' | 'blocked'; targetName: string | null }
export interface ImportPreview {
  id: string; status: 'preview'; token: string; sourceLearner: string; targetLearner: string;
  added: number; skipped: number; total: number; pageCount: number; readingCount: number;
  subjects: ImportSubject[]; stages: StudyStage[]; blockers: string[]; expiresAt: number;
}
export interface ImportReceipt { id: string; status: 'complete'; added: number; skipped: number; importedAt: number; questionIds: string[] }
export type ImportBatch = ImportPreview | ImportReceipt;
