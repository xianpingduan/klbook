import { useEffect, useRef } from 'react';

export function CaptureInput({ camera = false, multiple = !camera, label, busy, onChoose, onCancel }: {
  camera?: boolean; multiple?: boolean; label: string; busy: boolean; onChoose(files: FileList | null): void; onCancel(): void;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const element = input.current;
    element?.addEventListener('cancel', onCancel);
    return () => element?.removeEventListener('cancel', onCancel);
  }, [onCancel]);
  return <label className="file-picker"><span className="capture-symbol" aria-hidden="true">{camera ? <svg viewBox="0 0 24 24"><path d="M8 5l2-2h4l2 2h4a2 2 0 0 1 2 2v12H2V7a2 2 0 0 1 2-2z" /><circle cx="12" cy="12" r="4" /></svg> : <svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="9" cy="9" r="2" /><path d="M3 18l6-5 4 3 3-5 5 7" /></svg>}</span><span>{label}</span><input ref={input} type="file" accept="image/*" capture={camera ? 'environment' : undefined}
    multiple={multiple} disabled={busy} onChange={event => { onChoose(event.target.files); event.target.value = ''; }} /></label>;
}
