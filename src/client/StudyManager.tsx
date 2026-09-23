import { useEffect, useRef, useState } from 'react';
import type { Subject } from '../shared/collection.ts';
import type { StudySettings } from '../shared/study.ts';
import { validStage } from '../shared/study.ts';
import { ApiError, FamilyApi } from './api.ts';
import { useRevisionedSave } from './useRevisionedSave.ts';
import { useEditorLeave } from './useEditorLeave.tsx';
import { StudyStageFields } from './StudyStageFields.tsx';

interface Props { api: FamilyApi; grant?: string; active: boolean; onAccessError(error: ApiError): Promise<void> }
export function StudyManager(props: Props) {
  const { api, grant, active, onAccessError } = props;
  const [data, setData] = useState<{ subjects: Subject[]; settings: StudySettings }>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!active || !grant) return;
    let live = true; setLoading(true); setError('');
    void Promise.all([api.subjects(), api.studySettings(grant)]).then(([subjects, settings]) => { if (live) setData({ subjects, settings }); }).catch(async failure => {
      if (!live) return;
      if (failure instanceof ApiError && [401, 403].includes(failure.status)) await onAccessError(failure);
      else setError(failure instanceof Error ? failure.message : '读取设置失败');
    }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [api, grant, active, refresh, onAccessError]);
  return <section className="card study-manager"><h1>学科与学习阶段</h1>
    {loading && <p role="status">正在读取设置…</p>}
    {error && <p className="message error" role="alert">{error}<button className="quiet" disabled={loading || !grant || !active} onClick={() => setRefresh(value => value + 1)}>重试读取设置</button></p>}
    {data && <StudyForm {...props} data={data} loading={loading} onSubject={subject => setData(value => value && ({ ...value, subjects: [...value.subjects.filter(item => item.id !== subject.id), subject] }))} onReload={() => { setData(undefined); setRefresh(value => value + 1); }} />}
  </section>;
}
function StudyForm({ api, grant, active, onAccessError, data, loading, onSubject, onReload }: Props & {
  data: { subjects: Subject[]; settings: StudySettings }; loading: boolean; onSubject(subject: Subject): void; onReload(): void;
}) {
  const [stage, setStage] = useState(data.settings.stage);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const subjectId = useRef(crypto.randomUUID());
  const baseline = useRef(JSON.stringify(data.settings.stage));
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const saver = useRevisionedSave({ initial: data.settings, contentOf: value => ({ stage: value.stage }), persist: input => api.saveStudySettings(grant!, input), conflictMessage: '学习阶段已在其他页面更新，请重新读取设置后核对' });
  const dirtyStage = JSON.stringify(stage) !== baseline.current;
  const leave = useEditorLeave({ dirty: dirtyStage || !!name, busy, canSave: active && !!grant && !loading, title: '学科与学习阶段还有未保存的修改', error,
    description: <p>保存设置只影响之后新建的记录；已收集题目和已暂存材料保留原归属。</p>, save: () => save('all'),
    discard: () => { const saved = saver.discard(); setStage(saved.stage); baseline.current = JSON.stringify(saved.stage); setName(''); subjectId.current = crypto.randomUUID(); } });
  async function save(kind: 'all' | 'subject' | 'stage') {
    if (busy || loading || !active || !grant) return false;
    if (kind !== 'subject' && !validStage(stage)) { setError('学年请填写连续两年，例如 2026-2027；不确定时可以留空。'); return false; }
    if (kind === 'subject' && !name.trim()) { setError('请填写学科名称'); return false; }
    setBusy(true); setError(''); setNotice('');
    try {
      if (kind !== 'stage' && name.trim()) {
        const saved = await api.addSubject(grant, subjectId.current, name.trim());
        if (!mounted.current) return false;
        onSubject(saved); setName(''); subjectId.current = crypto.randomUUID(); setNotice('学科已添加，收集和查找时可以选择。');
      }
      if (kind === 'stage' || (kind === 'all' && dirtyStage)) {
        const saved = await saver.save({ stage });
        if (!mounted.current) return false;
        setStage(saved.stage); baseline.current = JSON.stringify(saved.stage); setNotice('学习阶段已保存，只影响之后新建的记录。');
      }
      return true;
    } catch (failure) {
      if (!mounted.current) return false;
      if (failure instanceof ApiError && [401, 403].includes(failure.status)) { leave.dismiss(); await onAccessError(failure); }
      else setError(`${failure instanceof Error ? failure.message : '保存失败'}。当前输入仍保留，可重试或重新读取设置。`);
      return false;
    } finally { if (mounted.current) setBusy(false); }
  }
  return <>
    {error && !leave.leaving && <p className="message error" role="alert">{error}</p>}{leave.dialog}
    {notice && <p className="message" role="status">{notice}</p>}
    <fieldset disabled={busy || loading || !active || !grant}>
      <h2>当前学习阶段</h2><p className="hint">只为新收集提供默认值。补收以前的题时，可在题目中更正；留空也能收集。</p>
      <StudyStageFields value={stage} onChange={setStage} /><button onClick={() => void save('stage')}>保存学习阶段</button>
      <h2>学科</h2><label>新学科名称<input value={name} maxLength={80} placeholder="例如：历史、地理" onChange={event => setName(event.target.value)} /></label><button onClick={() => void save('subject')}>添加学科</button>
    </fieldset>
    <div className="table-scroll"><table className="management-table" aria-label="学科列表"><thead><tr><th scope="col">名称</th></tr></thead><tbody>{data.subjects.map(subject => <tr key={subject.id}><td>{subject.name}</td></tr>)}</tbody></table></div>
    <button className="quiet" disabled={busy || loading || !grant || !active} onClick={() => leave.requestLeave(onReload)}>重新读取设置</button>
  </>;
}
