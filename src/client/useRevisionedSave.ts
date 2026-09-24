import { useRef } from 'react';
import { ApiError } from './api.ts';
import type { ConflictTarget } from '../shared/conflicts.ts';

type Operation<Content> = Content & { operationId: string; expectedRevision: number };

// Retry an unacknowledged operation before saving newer edits against its confirmed revision.
export function useRevisionedSave<Value extends { revision: number }, Content extends object>({ initial, contentOf, persist, conflictMessage, conflictTarget }: {
  initial: Value; contentOf(value: Value): Content; persist(input: Operation<Content>): Promise<Value>; conflictMessage: string; conflictTarget?: ConflictTarget;
}) {
  const current = useRef(initial);
  const pending = useRef<Operation<Content> | null>(null);
  async function send(input: Operation<Content>) {
    pending.current = input;
    try {
      const saved = await persist(input);
      if (saved.revision !== input.expectedRevision + 1) throw new ApiError(409, conflictMessage, conflictTarget);
      current.current = saved; pending.current = null;
    } catch (failure) {
      if (failure instanceof ApiError && [400, 422].includes(failure.status)) pending.current = null;
      throw failure;
    }
  }
  return {
    async save(desired: Content, verifyUnchanged = false) {
      const replayed = !!pending.current;
      if (pending.current) await send(pending.current);
      if (!current.current.revision || JSON.stringify(desired) !== JSON.stringify(contentOf(current.current)) || (verifyUnchanged && !replayed)) {
        await send({ ...desired, operationId: crypto.randomUUID(), expectedRevision: current.current.revision });
      }
      return current.current;
    },
    discard() { pending.current = null; return current.current; },
    adopt(value: Value) { current.current = value; pending.current = null; }
  };
}
