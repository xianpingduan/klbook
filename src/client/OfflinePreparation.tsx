import { useEffect, useState } from 'react';

export function OfflinePreparation() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const check = () => setReady(!!navigator.serviceWorker.controller?.scriptURL.endsWith('/offline-worker.js'));
    check(); navigator.serviceWorker.addEventListener('controllerchange', check);
    return () => navigator.serviceWorker.removeEventListener('controllerchange', check);
  }, []);
  return <p className="hint" role="status">{ready
    ? '已准备离线页面。已在本机保留的图片和草稿可在断网时继续整理；重新打开后会核对资料库并补传。'
    : '离线页面尚未准备完成，请保持连接后重新打开；当前页面里的进度仍会尝试保留在本机。'}</p>;
}
