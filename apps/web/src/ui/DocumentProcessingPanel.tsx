import { useEffect, useRef, useState } from 'react';
import { request } from '../api';
import { taskStateText } from './TaskResults';
import { ErrorNote, errorDetail, useWords } from './Controls';

type Settings = { autoRegister: 'enabled' | 'disabled'; autoSegment: 'enabled' | 'disabled'; autoIndex: 'enabled' | 'disabled' };
type Registration = { conversionTaskId: string; task: { id: string; status: string } | null; error: { message?: string } | null };
const base = '/api/bd/retrieval';
export function DocumentProcessingPanel({ materialId }: { materialId: string }) {
  const words = useWords(), [open, setOpen] = useState(false), [settings, setSettings] = useState<Settings | null>(null);
  const conversionRequest = useRef<string | null>(null);
  const [conversion, setConversion] = useState<{ jobId: string; status: string; error?: { message?: string } | null } | null>(null);
  const [automatic, setAutomatic] = useState<Registration[]>([]), [artifacts, setArtifacts] = useState(0);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const loadMaterial = async () => {
    if (!materialId) { setAutomatic([]); setArtifacts(0); return; }
    const value = await request(base + '/documents/' + encodeURIComponent(materialId) + '/artifacts') as { automatic: Registration[]; items: unknown[] };
    setAutomatic(value.automatic); setArtifacts(value.items.length);
  };
  useEffect(() => {
    if (!open) return;
    let live = true;
    void request(base + '/settings').then(value => { if (live) setSettings(value as Settings); }).catch(e => { if (live) setError(errorDetail(e)); });
    return () => { live = false; };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    let live = true;
    setAutomatic([]); setArtifacts(0); setError(''); setConversion(null); conversionRequest.current = null;
    if (materialId) void request(base + '/documents/' + encodeURIComponent(materialId) + '/artifacts').then(raw => {
      const value = raw as { automatic: Registration[]; items: unknown[] };
      if (live) { setAutomatic(value.automatic); setArtifacts(value.items.length); }
    }).catch(e => { if (live) setError(errorDetail(e)); });
    return () => { live = false; };
  }, [open, materialId]);
  useEffect(() => {
    if (!open || !conversion || !['ready', 'running', 'waiting_approval', 'pausing', 'cancelling'].includes(conversion.status)) return;
    let live = true;
    const timer = window.setTimeout(() => {
      void request('/api/bd/jobs/' + encodeURIComponent(conversion.jobId)).then(async value => {
        if (!live) return;
        setConversion(value as typeof conversion); await loadMaterial();
      }).catch(e => { if (live) setError(errorDetail(e)); });
    }, 1000);
    return () => { live = false; window.clearTimeout(timer); };
  }, [open, conversion, materialId]);
  return <details className="r1-stage" onToggle={e => setOpen(e.currentTarget.open)}>
    <summary><strong>{words('文档自动登记与检索准备', 'Automatic document registration')}</strong></summary>
    {open && <section aria-label={words('文档自动处理设置', 'Document processing settings')}>
      <p className="r1-help">{words('已保管原件完成文档转换后，可自动登记解析产物、划分片段并加入检索索引。披露时间尚未核对的资料保留未知状态。', 'After document conversion, register artifacts, split passages and index them. Unverified disclosure times remain unknown.')}</p>
      {error && <ErrorNote>{error}</ErrorNote>}
      {settings && <fieldset disabled={busy}>
        {(['autoRegister', 'autoSegment', 'autoIndex'] as const).map((key, i) => <label key={key} className="r1-confirm">
          <input type="checkbox" checked={settings[key] === 'enabled'} onChange={e => setSettings({ ...settings, [key]: e.target.checked ? 'enabled' : 'disabled' })} />
          {[words('转换完成后自动登记', 'Register completed conversions'), words('自动划分文档片段', 'Create passages automatically'), words('自动加入检索索引', 'Index passages automatically')][i]}
        </label>)}
        <button type="button" className="text-button" onClick={() => { setBusy(true); setError(''); setMessage('');
          void request(base + '/settings', 'POST', { ...settings, requestId: 'document-settings-' + crypto.randomUUID() }).then(value => {
            setSettings(value as Settings); setMessage(words('设置已保存。', 'Settings saved.'));
          }).catch(e => setError(errorDetail(e))).finally(() => setBusy(false));
        }}>{words('保存文档处理设置', 'Save document settings')}</button>
      </fieldset>}
      {message && <p role="status">{message}</p>}
      {materialId && <div className="r1-proof"><p>{words('当前材料已登记产物', 'Registered artifacts for this material')} {artifacts}</p>
        <button type="button" className="text-button" disabled={busy || !!conversion && ['ready', 'running', 'waiting_approval'].includes(conversion.status)} onClick={() => {
          setBusy(true); setError(''); conversionRequest.current ??= 'document-conversion-' + crypto.randomUUID();
          void request(base + '/documents/' + encodeURIComponent(materialId) + '/convert', 'POST', { requestId: conversionRequest.current }).then(value => {
            setConversion(value as typeof conversion); conversionRequest.current = null;
          }).catch(e => setError(errorDetail(e))).finally(() => setBusy(false));
        }}>{words('转换本件文档', 'Convert selected document')}</button>
        {conversion && <p role="status">{words('文档转换', 'Document conversion')} · {taskStateText(conversion.status, words)} · {conversion.error?.message ?? conversion.jobId}</p>}
        <button type="button" className="text-button" onClick={() => void loadMaterial().catch(e => setError(errorDetail(e)))}>{words('刷新本件自动处理状态', 'Refresh processing status')}</button>
        {automatic.map(item => <p key={item.conversionTaskId}>{item.task ? taskStateText(item.task.status, words) : words('等待核对', 'Awaiting review')} · {item.error?.message ?? item.task?.id}</p>)}
      </div>}
    </section>}
  </details>;
}
