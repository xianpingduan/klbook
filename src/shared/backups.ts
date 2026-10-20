export interface BackupJob {
  id: string; status: 'running' | 'succeeded' | 'failed'; createdAt: number; finishedAt: number | null;
  path: string; message: string; byteLength: number | null;
}
export interface BackupSettings {
  directory: string; revision: number; lastSuccess: BackupJob | null; latest: BackupJob | null;
}
