import { useEffect, useRef, useState } from 'react';
import type { MaterialEnvelope } from '../../../../modules/collection/materials/contracts';
import type { CloudEvidenceBinding } from '../../../../modules/collection/cloud-evidence-source';
import type { CloudCustodyView } from '../../../../modules/collection/cloud-custody';
import { request, RequestError } from '../api';
import { dataBrowserApi } from '../data-browser-api';
import { ErrorNote, errorDetail, useWords } from './Controls';
import { taskStateText } from './TaskResults';

const base = '/api/bd/cloud-custody';
type Operation = 'names' | 'archive';
type Run = CloudCustodyView;
type EvidenceChoice = Partial<CloudEvidenceBinding> & { source: CloudEvidenceBinding['source']; available: boolean; reason: string | null };
type Classification = { materialId: string; topic: string; basis: string; directory: string; purpose: string };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

function readRun(raw: unknown): Run {
  if (!object(raw) || !object(raw.task) || typeof raw.task.id !== 'string' || typeof raw.task.status !== 'string'
    || !Number.isInteger(raw.task.version) || !object(raw.record) || typeof raw.record.state !== 'string' || !object(raw.record.material)) throw new RequestError('无法核对原件保管任务。');
  return raw as unknown as Run;
}

export function CloudCustodyPanel({ materials, initialId }: { materials: MaterialEnvelope[]; initialId: string }) {
  const words = useWords();
  const [open, setOpen] = useState(false), [materialId, setMaterialId] = useState('');
  const [files, setFiles] = useState<MaterialEnvelope[]>([]), [query, setQuery] = useState('');
  const [scope, setScope] = useState(''), [sourcePath, setSourcePath] = useState(''), [evidenceRoot, setEvidenceRoot] = useState('');
  const [topics, setTopics] = useState<string[]>([]), [topic, setTopic] = useState('');
  const [evidenceChoices, setEvidenceChoices] = useState<EvidenceChoice[]>([]), [evidenceChoice, setEvidenceChoice] = useState('');
  const [classification, setClassification] = useState<Classification | null>(null);
  const [mode, setMode] = useState<Operation>('names'), [basis, setBasis] = useState(''), [consent, setConsent] = useState(false);
  const [available, setAvailable] = useState(false), [capReason, setCapReason] = useState('');
  const [runs, setRuns] = useState<Run[]>([]), [current, setCurrent] = useState<Run | null>(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const pending = useRef<{ body: string; id: string } | null>(null), selected = useRef('');
  selected.current = materialId;
  const choices = new Map([...materials, ...files].map(file => [file.materialId, file]));
  const file = choices.get(materialId);
  const preview = classification?.materialId === materialId ? classification : null;
  const evidence = evidenceChoices.find(item => JSON.stringify(item.source) === evidenceChoice);
  const evidencePurpose = evidence ? '加工证据' : preview?.purpose;
  const directory = preview && evidenceRoot ? mode === 'archive' && topic
    ? [evidenceRoot, topic, evidencePurpose].join('/') : evidence ? [evidenceRoot, preview.topic, evidencePurpose].join('/') : preview.directory : '';
  const searchDirectory = scope.trim() || directory;
  const stateLabels: Record<Run['record']['state'], string> = {
    pending: '等待核对', checking: '正在通过网盘技能查询远端文件',
    uploading: '正在上传并查询远端文件', copying: '正在盘内复制并查询远端文件',
    candidates_found: '发现候选文件，尚未确认归档对象', missing: '指定范围内未找到匹配文件',
    source_verified: '旧版来源完整字节校验通过', copied_verified: '旧版盘内复制字节核验通过',
    reused_verified: '旧版归档字节核验对象已复用', uploaded_verified: '旧版归档完整字节核验通过',
    source_metadata_checked: '来源文件名、大小与编号已确认，尚未归档',
    reused_metadata_checked: '网盘归档对象已复用，名称、大小及编号一致',
    uploaded_metadata_checked: '网盘上传成功，名称、大小及编号一致',
    copied_metadata_checked: '盘内复制成功，名称、大小及编号一致',
    restored_verified: '按需取回原件并核对完成', needs_review: '结果尚未核对，不能认定已归档',
  };

  useEffect(() => {
    if (!open) return;
    let live = true;
    void request(base + '/capabilities').then(value => {
      if (!live) return;
      if (!object(value)) throw new RequestError('无法读取网盘支路能力。');
      if (typeof value.evidenceRoot !== 'string' || !value.evidenceRoot) throw new RequestError('此实例未提供专用证据盘位置。');
      setEvidenceRoot(value.evidenceRoot);
      if (!Array.isArray(value.evidenceTopics) || !value.evidenceTopics.every(item => typeof item === 'string')) throw new RequestError('无法读取受支持的证据主题。');
      setTopics(value.evidenceTopics);
      setAvailable(value.available === true);
      setCapReason(typeof value.reason === 'string' ? value.reason : '');
    }).catch(e => { if (live) setError(errorDetail(e)); });
    return () => { live = false; };
  }, [open]);

  useEffect(() => {
    setCurrent(null); setRuns([]); setError(''); setConsent(false); setClassification(null); setEvidenceChoices([]); setEvidenceChoice(''); setTopic(''); pending.current = null;
    if (!open || !materialId) return;
    let live = true;
    void request(base + '/materials/' + encodeURIComponent(materialId)).then(result => {
      if (!live) return;
      if (!object(result) || !Array.isArray(result.items)) throw new RequestError('无法读取这件原件的网盘保管记录。');
      if (Array.isArray(result.evidenceSources)) setEvidenceChoices(result.evidenceSources as EvidenceChoice[]);
      const row = result.evidenceClassification;
      if (object(row) && typeof row.topic === 'string' && typeof row.basis === 'string' && typeof row.directory === 'string' && typeof row.purpose === 'string') {
        setClassification({ materialId, topic: row.topic, basis: row.basis, directory: row.directory, purpose: row.purpose });
      }
      if (typeof result.knownSourceRemotePath === 'string') {
        const known = result.knownSourceRemotePath;
        setSourcePath(previous => previous || known);
        setConsent(false);
      }
      const items = result.items.map(readRun); setRuns(items); setCurrent(items[0] ?? null);
    }).catch(e => { if (live) setError(errorDetail(e)); });
    return () => { live = false; };
  }, [open, materialId]);

  const taskId = current?.task.id, taskStatus = current?.task.status;
  useEffect(() => {
    if (!open || !taskId || !['ready','running','waiting_approval','pausing','cancelling'].includes(taskStatus ?? '')) return;
    let live = true, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const view = readRun(await request(base + '/tasks/' + encodeURIComponent(taskId)));
        if (live) { setCurrent(view); setRuns(previous => [view, ...previous.filter(item => item.task.id !== taskId)]); }
      } catch (e) { if (live) setError(errorDetail(e)); }
      if (live) timer = setTimeout(() => void poll(), 1000);
    };
    timer = setTimeout(() => void poll(), 350);
    return () => { live = false; clearTimeout(timer); };
  }, [open, taskId, taskStatus]);

  const act = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError('');
    try { await work(); } catch (e) { setError(errorDetail(e)); } finally { setBusy(false); }
  };
  const submit = async () => {
    if (!available || !file || mode !== 'names' && !consent || mode === 'archive' && !directory) return;
    const input = { materialId, ...(evidence ? { evidenceSource: evidence.source } : {}), scopePath: searchDirectory, ...(sourcePath.trim() ? { sourceRemotePath: sourcePath.trim() } : {}),
      purpose: evidence ? '核对并保管所选 BD 加工证据及原件谱系' : '核对并保管所选 BD 原件', authorization: { status: 'authorized', basis: mode === 'names' ? '操作者在网盘保管页明确选择本件、远端范围并点击仅核对文件名。' : basis.trim() },
      verifyBytes: false, allowUpload: mode === 'archive', ...(mode === 'archive' && topic ? { evidenceTopic: topic } : {}) };
    const signature = JSON.stringify(input);
    if (pending.current?.body !== signature) pending.current = { body: signature, id: 'web-custody-' + crypto.randomUUID() };
    const value = readRun(await request(base + '/runs', 'POST', { requestId: pending.current.id, input }));
    if (selected.current !== materialId) return;
    pending.current = null; setCurrent(value); setRuns(previous => [value, ...previous.filter(item => item.task.id !== value.task.id)]); setConsent(false);
  };
  return <details className="r1-stage" onToggle={event => {
    const visible = event.currentTarget.open; setOpen(visible); if (visible && !materialId && initialId) setMaterialId(initialId);
  }}>
    <summary><strong>{words('原件与加工证据网盘保管', 'Cloud custody of originals and evidence')}</strong></summary>
    {open && <section aria-label={words('网盘保管支路', 'Cloud custody branch')}>
      <p className="r1-help">{words('归档复用百度网盘技能。上传或盘内复制后查询文件名、大小和远端文件编号，不进行下载读回；只有选择恢复原件时才下载。', 'Archive via the Baidu Drive skill. Verify remote filename, size and object ID after upload or copy without downloading. Only an explicit restore downloads the file.')}</p>
      {!available && <p role="status" className="r1-help">{capReason || words('此实例尚无可用网盘连接。', 'No cloud drive is available in this instance.')}</p>}
      {error && <ErrorNote>{error}</ErrorNote>}
      <fieldset disabled={busy}><label>{words('查找待归档原件', 'Find a stored original')}<input value={query} onChange={event => setQuery(event.target.value)} /></label>
        <button type="button" className="text-button" onClick={() => void act(async () => setFiles((await dataBrowserApi.materials(query.trim())).items))}>{words('查本机材料', 'Find local materials')}</button>
        <label>{words('网盘支路使用的原件', 'Original to check')}<select value={materialId} onChange={event => { setMaterialId(event.target.value); setSourcePath(''); }}>
          <option value="">{words('请选择已保管原件', 'Select an original')}</option>{[...choices.values()].map(f => <option key={f.materialId} value={f.materialId}>{f.filename} · {f.materialId}</option>)}</select></label>
        {file && <p className="r1-help">{file.byteLength} {words('字节', 'bytes')} · SHA-256（内容摘要） <code>{file.sha256}</code></p>}
        {file && <label>{words('本次归档内容', 'Content to archive')}<select value={evidenceChoice} onChange={event => { setEvidenceChoice(event.target.value); setSourcePath(''); setScope(''); setConsent(false); pending.current = null; }}>
          <option value="">{words('来源原件', 'Source original')}</option>
          {evidenceChoices.map(item => <option key={JSON.stringify(item.source)} value={JSON.stringify(item.source)} disabled={!item.available}>
            {item.source.kind === 'conversion' ? words('解析产物', 'Conversion artifact') : item.source.kind === 'processing' ? words('加工记录及产物', 'Processing evidence') : words('计算结果及依据', 'Calculation evidence')} · {item.filename ?? item.reason}
          </option>)}
        </select></label>}
        {evidence && <p className="r1-help">{words('所选加工证据', 'Selected evidence')} · {evidence.byteLength} {words('字节', 'bytes')} · SHA-256（内容摘要） <code>{evidence.sha256}</code></p>}
        <label>{words('直接查找的网盘目录', 'Remote directory to inspect')}<input placeholder={directory} value={scope} onChange={e => { setScope(e.target.value); setConsent(false); }} /></label>
        <label>{words('已知的原网盘文件位置（可选）', 'Known source file on the drive (optional)')}<input value={sourcePath} onChange={e => { setSourcePath(e.target.value); setConsent(false); }} /></label>
        <label>{words('本次网盘操作', 'Cloud operation')}<select value={mode} onChange={e => { setMode(e.target.value as Operation); setConsent(false); }}>
          <option value="names">{words('只查目录与候选文件名', 'Check candidate names only')}</option>
          <option value="archive">{words('归档到专用证据盘', 'Archive to the dedicated evidence directory')}</option>
        </select></label>
        {preview && <>
          {mode === 'archive' && <label>{words('证据主题', 'Evidence topic')}<select value={topic} onChange={e => { setTopic(e.target.value); setConsent(false); }}>
            <option value="">{words('按内容归类', 'Classify by content')} · {preview.topic}</option>
            {topics.filter(item => item !== preview.topic).map(item => <option key={item} value={item}>{item}</option>)}
          </select></label>}
          <p className="r1-help">{words('内容分类依据', 'Classification evidence')} · {preview.basis}</p>
          <p className="r1-help">{words('本件逻辑主题目录', 'Logical topic folder for this item')} <code>{directory}</code></p>
        </>}
        {mode === 'archive' && <p className="r1-help">{words('同账号的已有归档按远端文件名、大小和编号复用；首次归档则通过网盘技能上传或盘内复制并查询结果，不下载读回。', 'Reuse an existing archive by filename, size and object ID. New archives upload or copy through the skill and confirm metadata without a full download.')}</p>}
        {mode !== 'names' && <><label>{words('本次网盘操作的授权依据', 'Authorization for this operation')}<input value={basis} maxLength={1000} onChange={e => { setBasis(e.target.value); setConsent(false); }} /></label>
        <label className="r1-confirm"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />
          {words('授权使用网盘技能查询并归档所选文件；上传后仅确认文件名、大小和远端编号。', 'Authorize metadata lookup and archive using the drive skill; confirm filename, size and object ID after upload.')}</label></>}
        <button type="button" className="primary-button" disabled={!available || !file || evidence?.available === false || !searchDirectory || mode !== 'names' && (!basis.trim() || !consent) || mode === 'archive' && !directory} onClick={() => void act(submit)}>{mode === 'names' ? words('仅核对候选文件名', 'Check candidate names only') : words('办理本次网盘操作', 'Start this cloud operation')}</button>
      </fieldset>
      {current && <div className="r1-proof"><p role="status"><strong>{stateLabels[current.record.state]}</strong> · {words('任务', 'Task')} {taskStateText(current.task.status, words)} · <code>{current.task.id}</code></p>
        <button type="button" className="text-button" disabled={busy} onClick={() => void act(async () => setCurrent(readRun(await request(base + '/tasks/' + encodeURIComponent(current.task.id)))))}>{words('读取原保管回执', 'Read custody receipt')}</button>
        <p className="r1-help">{words('已列条目', 'Entries listed')} {current.record.coverage.entries} · {words('恢复时读回次数', 'Restore reads')} {current.record.coverage.readCandidates} · {words('盘内复制尝试', 'In-drive copy attempted')} {current.record.copyAttempted ? words('是', 'Yes') : words('否', 'No')} · {words('本次尝试上传', 'Upload attempted')} {current.record.uploadAttempted ? words('是', 'Yes') : words('否', 'No')}</p>
        {current.record.state === 'candidates_found' && <ul>{current.record.candidates.map(item => <li key={item.path}>{item.path}</li>)}</ul>}
        {current.record.evidence && <p>{words('关联原件摘要', 'Original content digest')} <code>{current.record.evidence.original.sha256}</code> · {words('归档内容', 'Archived content')} {current.record.evidence.filename}</p>}
        {current.record.evidenceClassification && <p>{words('本次任务的逻辑主题目录', 'Logical topic folder bound to this task')} <code>{current.record.evidenceClassification.directory}</code> · {current.record.evidenceClassification.basis}</p>}
        {current.record.archiveReference && <p>{words('共用归档对象的原任务回执', 'Original receipt for reused archive')} <code>{current.record.archiveReference.taskId}</code></p>}
        {current.record.directoryPreparation === 'pending' && <p className="r1-help">{words('本次分类目录仍待核实。', 'The folder for this task is awaiting verification.')}</p>}
        {current.record.remoteObject && <p>{words('远端文件', 'Remote file')} <code>{current.record.remoteObject.path}</code> · {current.record.remoteObject.size} {words('字节', 'bytes')} · fs_id <code>{current.record.remoteObject.id}</code></p>}
        {current.record.metadataConfirmed && <p>{words('网盘元数据已确认（未下载文件）', 'Cloud metadata confirmed; no download')}</p>}
        {current.record.verifiedSha256 && <p>SHA-256（仅恢复或旧记录已核摘要） <code>{current.record.verifiedSha256}</code></p>}
        {current.task.error && <p className="r1-help danger-text">{current.task.error.code} · {current.task.error.message}</p>}
        {current.record.gaps.map((gap, index) => <p key={index} className="r1-help danger-text">{gap.message}</p>)}
        {current.record.mode === 'check' && (current.record.remoteObject || current.record.writeIntent || current.record.uploadAttempted || current.record.copyAttempted) && <button type="button" className="text-button" disabled={busy || ['ready','running','waiting_approval'].includes(current.task.status)} onClick={() => void act(async () => {
          const result = readRun(await request(base + '/tasks/' + encodeURIComponent(current.task.id) + '/recover', 'POST',
            { requestId: 'web-restore-' + crypto.randomUUID(), expectedVersion: current.task.version }));
          if (selected.current === materialId) { setCurrent(result); setRuns(previous => [result, ...previous]); }
        })}>{words('按原网盘对象读回并核验', 'Restore and verify the original remote object')}</button>}
        {current.record && <details><summary>{words('查看检查范围与远端原件记录', 'Inspect scope and remote object')}</summary><pre className="database-text-preview">{JSON.stringify(current.record, null, 2)}</pre></details>}
      </div>}
      {runs.length > 1 && <label>{words('本件历史保管任务', 'Custody history for this original')}<select value={taskId} onChange={e => setCurrent(runs.find(row => row.task.id === e.target.value) ?? null)}>{runs.map(row => <option key={row.task.id} value={row.task.id}>{row.task.id} · {String(row.record?.state ?? row.task.status)}</option>)}</select></label>}
    </section>}
  </details>;
}
