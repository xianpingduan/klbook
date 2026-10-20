import type { StudyStage } from './study.ts';
import type { Region, Subject } from './collection.ts';

export const MAX_PACKAGE_BYTES = 512 * 1024 * 1024;
export interface ImportSubject { id: string; name: string; action: 'existing' | 'new' | 'blocked'; targetName: string | null }
export interface ImportDecisions { questions: { id: string; action: 'keep' | 'copy' | 'restore' }[]; subjects: { id: string; targetId?: string; newName?: string }[] }
export interface ImportMaterial { pageId: string; width: number; height: number; region: Region | null }
export interface ImportQuestionChoice {
  id: string; label: string; status: 'new' | 'unchanged' | 'conflict' | 'trash' | 'deleted';
  action: 'add' | 'skip' | 'keep' | 'copy' | 'restore'; canCopy: boolean; canRestore: boolean;
  incoming: { note: string; revision: number; collectedAt: number | null; studyStage: StudyStage; material: ImportMaterial };
  current: { id: string; note: string; revision: number; collectedAt: number | null; studyStage: StudyStage; material: ImportMaterial } | null;
}
export interface ImportPreview {
  id: string; status: 'preview'; token: string; sourceLearner: string; targetLearner: string;
  added: number; skipped: number; total: number; pageCount: number; readingCount: number;
  subjects: ImportSubject[]; stages: StudyStage[]; blockers: string[]; expiresAt: number;
  conflicts: number; trashed: number; kept: number; copied: number; restored: number;
  questions: ImportQuestionChoice[]; availableSubjects: Subject[]; decisions: ImportDecisions; choicesReset?: boolean;
}
export interface ImportReceipt { id: string; status: 'complete'; added: number; skipped: number; kept?: number; copied?: number; restored?: number; importedAt: number; questionIds: string[] }
export type ImportBatch = ImportPreview | ImportReceipt;
