import type { CaptureBatch, PendingCapture } from './capture-cache.ts';

export function CaptureQueue({ batch, busy, onUpload, onCancel }: {
  batch: CaptureBatch; busy: boolean; onUpload(item: PendingCapture): void; onCancel(item: PendingCapture): void;
}) {
  return <section className="card pending-materials" aria-label="本机待上传图片">
    <h2>本机待上传</h2><p>还有 {batch.items.length} 张图片等待上传</p>
    <p className="hint">已上传 {batch.uploaded} / {batch.total} 张，已取消 {batch.cancelled} 张</p>
    <p className="hint">当前设备保留的图片，上传结果等待确认。家庭电脑已接收的草稿在下方继续整理。</p>
    {busy && <p role="status">正在暂存并上传，请稍候…</p>}
    <ul className="capture-queue">{batch.items.map(item => <li key={item.operationId}><div><strong>{item.name}</strong><p className="hint">等待上传确认，重试不会重复创建</p></div><div className="queue-actions"><button disabled={busy} aria-label={`继续上传 ${item.name}`} onClick={() => onUpload(item)}>继续上传</button><button className="quiet" disabled={busy} aria-label={`取消 ${item.name}`} onClick={() => onCancel(item)}>取消这张</button></div></li>)}</ul>
  </section>;
}
