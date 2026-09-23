import { CaptureInput } from './CaptureInput.tsx';
import { useTouchInput } from './useTouchInput.ts';

export function CaptureChoices({ busy, onChoose, onNotice }: { busy: boolean; onChoose(files: FileList | null): void; onNotice(message: string): void }) {
  const touch = useTouchInput();
  return <div className="capture-inputs">
    {touch && <CaptureInput camera label="拍照" busy={busy} onChoose={onChoose} onCancel={() => onNotice('没有取得照片。相机未打开或权限被拒绝时，可以从相册选择；已有材料仍保留。')} />}
    <CaptureInput label={touch ? '从相册选择（可多选）' : '选择题目图片'} busy={busy} onChoose={onChoose} onCancel={() => onNotice('已取消选择，已有材料保留。')} />
    <p className="hint">支持 JPEG、PNG、静态 WebP；每张最多 15 MB、4000 万像素。每批最多 10 张、合计 75 MB。HEIC 原件请先在相册导出为 JPEG。</p>
  </div>;
}
