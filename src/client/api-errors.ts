import type { ConflictTarget } from '../shared/conflicts.ts';

export class ConnectionError extends Error {}
export class ApiError extends Error {
  status: number;
  conflict?: ConflictTarget;
  constructor(status: number, message: string, conflict?: ConflictTarget) { super(message); this.status = status; this.conflict = conflict; }
}
