import type { Question } from './collection.ts';

export interface TrashChange { operationId: string; expectedRevision: number; action: 'trash' | 'restore' | 'purge'; confirm?: boolean }
export interface Deletion { id: string; revision: number; deletedAt: number; expiresAt: number; purgedAt: number | null }
export interface TrashReceipt { id: string; revision: number; deletedAt: number | null; expiresAt: number | null; purgedAt: number | null }
export interface TrashItem extends Deletion { question: Question }
export interface TrashList { items: TrashItem[]; total: number; offset: number; limit: number; cleanup: { pending: number; failed: number } }
