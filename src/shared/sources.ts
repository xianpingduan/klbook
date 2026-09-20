export interface Source { id: string; name: string; active: boolean; revision: number }
export interface SourceEdit { operationId: string; expectedRevision: number; name: string; active: boolean }
