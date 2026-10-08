import { useRef } from 'react';
import { ApiError } from './api.ts';
import type { ConflictTarget } from '../shared/conflicts.ts';

type Operation<Content> = Content & { operationId: string; expectedRevision: number };

// Retry an unacknowledged operation before saving newer edits against its confirmed revision.
export function useRevisionedSave<Value extends { revision: number }, Content extends object>({ initial, contentOf, persist, conflictMessage, conflictTarget, checkpoint, defer }: {
  initial: Value; contentOf(value: Value): Content; persist(input: Operation<Content>): Promise<Value>; conflictMessage: string; conflictTarget?: ConflictTarget;
  checkpoint?: { initial?: { current: Value; pending: Operation<Content> | null; intent?: Content }; write(value: { current: Value; pending: Operation<Content> | null; intent?: Content }): void };
  defer?(value: Value, desired: Content): Value;
}) {
  const current = useRef(checkpoint?.initial?.current ?? initial);
  const pending = useRef<Operation<Content> | null>(checkpoint?.initial?.pending ?? null);
  const intent = useRef<Content | undefined>(checkpoint?.initial?.intent);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const saveCheckpoint = () => checkpoint?.write({ current: current.current, pending: pending.current, intent: intent.current });
  async function send(input: Operation<Content>) {
    pending.current = input;
    saveCheckpoint();
    try {
      const saved = await persist(input);
      if ('syncState' in saved && saved.syncState === 'pending') return saved;
      if (saved.revision !== input.expectedRevision + 1) throw new ApiError(409, conflictMessage, conflictTarget);
      current.current = saved; pending.current = null;
      saveCheckpoint();
      return saved;
    } catch (failure) {
      if (failure instanceof ApiError && [400, 422].includes(failure.status)) { pending.current = null; saveCheckpoint(); }
      throw failure;
    }
  }
  return {
    save(desired: Content, verifyUnchanged = false) {
      const operation = queue.current.catch(() => {}).then(async () => {
      intent.current = desired; saveCheckpoint();
      const replayed = !!pending.current;
      if (pending.current) {
        const replay = await send(pending.current);
        if (replay && 'syncState' in replay && replay.syncState === 'pending') {
          // The old key and body are immutable even if its receipt was lost.
          // Keep newer desired content separately until replay is acknowledged.
          return defer ? defer(replay, desired) : replay;
        }
      }
      if (!current.current.revision || JSON.stringify(desired) !== JSON.stringify(contentOf(current.current)) || (verifyUnchanged && !replayed)) {
        const result = await send({ ...desired, operationId: crypto.randomUUID(), expectedRevision: current.current.revision });
        if (result && 'syncState' in result && result.syncState === 'pending') return result;
      }
      intent.current = undefined; saveCheckpoint(); return current.current;
      });
      queue.current = operation;
      return operation;
    },
    idle: () => queue.current.catch(() => {}),
    snapshot: () => ({ current: current.current, pending: pending.current, intent: intent.current }),
    discard() { pending.current = null; intent.current = undefined; return current.current; },
    adopt(value: Value) { current.current = value; pending.current = null; intent.current = undefined; }
  };
}
