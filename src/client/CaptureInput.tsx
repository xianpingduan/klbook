import { useEffect, useRef } from 'react';

export function CaptureInput({ camera = false, label, busy, onChoose, onCancel }: {
  camera?: boolean; label: string; busy: boolean; onChoose(files: FileList | null): void; onCancel(): void;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const element = input.current;
    element?.addEventListener('cancel', onCancel);
    return () => element?.removeEventListener('cancel', onCancel);
  }, [onCancel]);
  return <label className="file-picker">{label}<input ref={input} type="file" accept="image/*" capture={camera ? 'environment' : undefined}
    multiple={!camera} disabled={busy} onChange={event => { onChoose(event.target.files); event.target.value = ''; }} /></label>;
}
