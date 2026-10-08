import { useRef } from 'react';
import { revisionedSave } from './revisioned-save.ts';
import type { SaveOptions } from './revisioned-save.ts';

export function useRevisionedSave<Value extends { revision: number }, Content extends object>(options: SaveOptions<Value, Content>) {
  const latest = useRef(options); latest.current = options;
  const saver = useRef<ReturnType<typeof revisionedSave<Value, Content>> | undefined>(undefined);
  if (!saver.current) saver.current = revisionedSave(() => latest.current);
  return saver.current;
}
