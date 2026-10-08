import { useEffect, useRef, useState } from 'react';
import { validQuestionRegion, type QuestionPart, type Region } from '../shared/collection.ts';
import type { FamilyApi } from './api.ts';

export const recognitionScope = (pageId: string, region: Region | null) => JSON.stringify([pageId, region?.x, region?.y, region?.width, region?.height]);

/** Next-step recognition runs independently of editor saving and survives a panel being collapsed. */
export function useCropRecognition(api: FamilyApi, grant?: string) {
  const attempts = useRef(new Map<string, string>());
  const live = useRef(true);
  const [refresh, setRefresh] = useState(0);
  const [messages, setMessages] = useState<Record<string, string>>({});
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  function start(parts: QuestionPart[], retry = false) {
    for (const part of parts) {
      if (!validQuestionRegion(part.region)) continue;
      const key = recognitionScope(part.originalPage.id, part.region);
      if (attempts.current.has(key) && !retry) continue;
      const id = attempts.current.get(key) ?? crypto.randomUUID(); attempts.current.set(key, id);
      setMessages(current => ({ ...current, [key]: '正在识别，可直接保存' }));
      void api.recognizePage(part.originalPage.id, id, grant, { region: part.region, automatic: true }).then(() => {
        if (!live.current) return;
        setMessages(current => ({ ...current, [key]: '' })); setRefresh(value => value + 1);
      }).catch(failure => {
        if (live.current) setMessages(current => ({ ...current, [key]: `${failure instanceof Error ? failure.message : '识别暂不可用'}；可继续保存图片。` }));
      });
    }
  }
  return { start, refresh, messages };
}
