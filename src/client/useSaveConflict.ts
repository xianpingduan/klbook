import { useEffect, useRef, useState } from 'react';
import { ApiError } from './api.ts';

/** Keep the local editor untouched until the user chooses against a readable current snapshot. */
export function useSaveConflict<Value>({ read, onAccessError }: { read(): Promise<Value>; onAccessError(error: ApiError): Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState<Value>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function refresh() {
    setLoading(true); setError(''); setCurrent(undefined);
    try { const value = await read(); if (mounted.current) setCurrent(value); }
    catch (failure) {
      if (!mounted.current) return;
      setError('暂时无法读取当前版本，本次编辑仍保留。请恢复连接或完成验证后重试读取。');
      if (failure instanceof ApiError && [401, 403].includes(failure.status)) await onAccessError(failure);
    } finally { if (mounted.current) setLoading(false); }
  }
  return { open, current, loading, error, refresh,
    async show() { setOpen(true); await refresh(); },
    clear() { setOpen(false); setCurrent(undefined); setError(''); }
  };
}
