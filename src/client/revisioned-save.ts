import { ApiError } from './api-errors.ts';
import type { ConflictTarget } from '../shared/conflicts.ts';

type Operation<Content> = Content & { operationId: string; expectedRevision: number };
export interface SaveCheckpoint<Value, Content> { current: Value; pending: Operation<Content> | null; intent?: Content }
export interface SaveOptions<Value, Content> {
  initial: Value; contentOf(value: Value): Content; persist(input: Operation<Content>): Promise<Value>;
  conflictMessage: string; conflictTarget?: ConflictTarget;
  checkpoint?: { initial?: SaveCheckpoint<Value, Content>; write(value: SaveCheckpoint<Value, Content>): void };
  defer?(value: Value, desired: Content): Value;
}

/** The same replay protocol is used by mounted editors and reconnect synchronization. */
export function revisionedSave<Value extends { revision: number }, Content extends object>(options: () => SaveOptions<Value, Content>) {
  let current = options().checkpoint?.initial?.current ?? options().initial;
  let pending = options().checkpoint?.initial?.pending ?? null;
  let intent = options().checkpoint?.initial?.intent;
  let queue: Promise<unknown> = Promise.resolve();
  const snapshot = () => ({ current, pending, intent });
  const checkpoint = () => options().checkpoint?.write(snapshot());
  const deferred = (value: Value) => 'syncState' in value && value.syncState === 'pending';
  async function send(input: Operation<Content>) {
    pending = input; checkpoint();
    try {
      const saved = await options().persist(input);
      if (deferred(saved)) return saved;
      if (saved.revision !== input.expectedRevision + 1) throw new ApiError(409, options().conflictMessage, options().conflictTarget);
      current = saved; pending = null; checkpoint(); return saved;
    } catch (failure) {
      if (failure instanceof ApiError && [400, 422].includes(failure.status)) { pending = null; checkpoint(); }
      throw failure;
    }
  }
  return {
    save(desired: Content, verifyUnchanged = false) {
      const operation = queue.catch(() => {}).then(async () => {
        intent = desired; checkpoint();
        const replayed = !!pending;
        if (pending) {
          const replay = await send(pending);
          if (deferred(replay)) return options().defer?.(replay, desired) ?? replay;
        }
        if (!current.revision || JSON.stringify(desired) !== JSON.stringify(options().contentOf(current)) || (verifyUnchanged && !replayed)) {
          const result = await send({ ...desired, operationId: crypto.randomUUID(), expectedRevision: current.revision });
          if (deferred(result)) return result;
        }
        intent = undefined; checkpoint(); return current;
      });
      queue = operation; return operation;
    },
    idle: () => queue.catch(() => {}), snapshot,
    discard() { pending = null; intent = undefined; return current; },
    adopt(value: Value) { current = value; pending = null; intent = undefined; }
  };
}
