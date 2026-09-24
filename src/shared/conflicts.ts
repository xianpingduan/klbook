/** Identifies the authorized record to reread after a revision conflict; never authorizes a write. */
export interface ConflictTarget { entity: 'question' | 'readingMaterial'; id: string }
