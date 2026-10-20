import { restoreBackup, verifyBackup } from './backup-files.ts';
const [action, ...args] = process.argv.slice(2);
const option = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
try {
  const source = option('--source');
  if (!source) throw Error('请用 --source 指定完整备份目录');
  if (action === 'verify') {
    const manifest = await verifyBackup(source);
    console.log(JSON.stringify({ status: 'verified', id: manifest.id, libraryId: manifest.libraryId, files: manifest.files.length }));
  } else if (action === 'restore') {
    const target = option('--target');
    if (!target) throw Error('请用 --target 指定新的隔离恢复目录');
    console.log(JSON.stringify(await restoreBackup(source, target, args.includes('--with-system'))));
  } else throw Error('请选择 verify 或 restore');
} catch (error) { console.error(error instanceof Error ? error.message : '备份校验或恢复失败'); process.exitCode = 1; }
