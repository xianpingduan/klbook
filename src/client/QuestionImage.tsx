import { useEffect, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import type { OriginalPage, Region } from '../shared/collection.ts';
import type { FamilyApi } from './api.ts';

export function usePageImage(api: FamilyApi, pageId: string, variant: 'original' | 'preview') {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    let objectUrl = '';
    setUrl(''); setError('');
    void api.pageImage(pageId, variant).then(blob => {
      if (!live) return;
      objectUrl = URL.createObjectURL(blob); setUrl(objectUrl);
    }).catch(failure => { if (live) setError(failure instanceof Error ? failure.message : '图片读取失败'); });
    return () => { live = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [api, pageId, variant, attempt]);
  return { url, error, retry: () => setAttempt(value => value + 1) };
}

export function QuestionImage({ api, page, region, original = false }: { api: FamilyApi; page: OriginalPage; region?: Region | null; original?: boolean }) {
  const image = usePageImage(api, page.id, original ? 'original' : 'preview');
  if (image.error) return <p role="alert" className="message error">{image.error} <button className="quiet" onClick={image.retry}>重试加载图片</button></p>;
  if (!image.url) return <p>正在读取材料…</p>;
  if (!region || original) return <img className="paper-image" src={image.url} alt={original ? '原始页（保留作答和批改）' : '原始页预览'} />;
  return <svg className="question-crop" role="img" aria-label="已收集的题目区" viewBox={`${region.x * page.width} ${region.y * page.height} ${region.width * page.width} ${region.height * page.height}`}>
    <image href={image.url} width={page.width} height={page.height} />
  </svg>;
}

export function CropSelector({ api, page, region, onChange, disabled }: { api: FamilyApi; page: OriginalPage; region: Region | null; onChange(value: Region | null): void; disabled: boolean }) {
  const image = usePageImage(api, page.id, 'preview');
  const start = useRef<{ x: number; y: number } | null>(null);
  function point(event: PointerEvent<SVGSVGElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)), y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)) };
  }
  function move(event: PointerEvent<SVGSVGElement>) {
    if (!start.current || disabled) return;
    const end = point(event);
    const width = Math.abs(end.x - start.current.x), height = Math.abs(end.y - start.current.y);
    if (width < 1 / page.width || height < 1 / page.height) return;
    onChange({ x: Math.min(start.current.x, end.x), y: Math.min(start.current.y, end.y), width, height });
  }
  return <div>
    <p className="hint">在图片上拖动，框住一道可以独立作答的小题。可以重新拖动，也可以选择整页。</p>
    {image.error && <p role="alert" className="message error">{image.error} <button onClick={image.retry}>重试加载图片</button></p>}
    {image.url ? <div className="image-stage" style={{ width: `min(100%, ${62 * page.width / page.height}dvh)`, marginInline: 'auto' }}>
      <img src={image.url} width={page.width} height={page.height} alt="用于框题的原始页预览" draggable={false} />
      <svg role="img" aria-label="框选题目范围" viewBox="0 0 1000 1000" preserveAspectRatio="none"
        onPointerDown={event => { if (disabled) return; event.preventDefault(); start.current = point(event); event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerMove={move} onPointerUp={event => { move(event); start.current = null; }} onPointerCancel={() => { start.current = null; }}>
        {region && <rect x={region.x * 1000} y={region.y * 1000} width={region.width * 1000} height={region.height * 1000} className="crop-selection" />}
      </svg>
    </div> : !image.error && <p>正在读取图片…</p>}
    <button type="button" className="quiet" disabled={disabled || !image.url} onClick={() => onChange({ x: 0, y: 0, width: 1, height: 1 })}>选择整页</button>
    {region && <button type="button" className="quiet" disabled={disabled} onClick={() => onChange(null)}>清除当前框选</button>}
    {region && <details className="region-controls"><summary>精确调整范围（百分比）</summary><div className="region-grid">{(['x', 'y', 'width', 'height'] as const).map((key, index) => <label key={key}>{['左边位置', '上边位置', '范围宽度', '范围高度'][index]}<input type="number" min={key === 'width' || key === 'height' ? .01 : 0} max="100" step="0.01" disabled={disabled} value={Number((region[key] * 100).toFixed(2))} onChange={event => onChange({ ...region, [key]: Number(event.target.value) / 100 })} /></label>)}</div></details>}
  </div>;
}
