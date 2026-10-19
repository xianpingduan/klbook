import type { OriginalPage, Question, QuestionPart, Subject } from './collection.ts';
import type { ReadingMaterial } from './reading-materials.ts';
import type { Source } from './sources.ts';
import type { StudyStage } from './study.ts';
import type { OcrCandidate, OcrLine } from './ocr.ts';

export interface PackagePart extends Omit<QuestionPart, 'originalPage'> { pageId: string }
export interface PackageQuestion extends Pick<Question, 'id' | 'learnerId' | 'revision' | 'subjectId' | 'sourceId' | 'source' | 'pageNumber' | 'questionNumber' | 'note' | 'createdAt' | 'updatedAt' | 'collectedAt' | 'studyStage'> {
  parts: PackagePart[]; answerParts: PackagePart[]; readingMaterialId: string | null;
}
export interface PackageReading extends Pick<ReadingMaterial, 'id' | 'title' | 'revision' | 'createdAt' | 'updatedAt'> { parts: PackagePart[] }
export interface PackageRecognition {
  id: string; pageId: string; revision: number; createdAt: number; finishedAt: number | null;
  inputWidth: number | null; inputHeight: number | null; inputRegion: QuestionPart['region']; lines: OcrLine[]; candidates: OcrCandidate[];
}
export interface LearningPackageData {
  library: { id: string; learnerId: string; learnerName: string };
  questions: PackageQuestion[]; readings: PackageReading[]; pages: (OriginalPage & { path: string })[];
  subjects: Subject[]; sources: Source[]; recognitions: PackageRecognition[];
}
export interface PackageFile { path: string; byteLength: number; sha256: string }
export interface LearningPackageManifest {
  format: 'klbook-learning-package'; version: 1; packageId: string; snapshotAt: number;
  sourceLibraryId: string; questionCount: number; files: PackageFile[];
}
export interface ExportPreview {
  token: string; checkedAt: number; learnerName: string; questionCount: number; pageCount: number; readingCount: number; originalBytes: number;
  subjects: Subject[]; stages: StudyStage[]; collectedFrom: number | null; collectedTo: number | null;
}
export interface ExportJob {
  id: string; status: 'preparing' | 'ready' | 'failed'; snapshotAt: number; expiresAt: number;
  questionCount: number; filename: string; byteLength?: number; message: string;
}
