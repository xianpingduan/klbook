export interface BackupJob {
  id: string; status: 'running' | 'succeeded' | 'failed'; createdAt: number; finishedAt: number | null;
  path: string; message: string; byteLength: number | null;
  trigger: 'manual' | 'automatic'; removedAt: number | null; retiredAt: number | null;
}
export interface BackupSettings {
  directory: string; revision: number; lastSuccess: BackupJob | null; latest: BackupJob | null;
  automatic: { enabled: boolean; status: string; message: string; lastCheckedAt: number | null; nextCheckAt: number | null; cleanupMessage: string };
  successful: BackupJob[];
}
