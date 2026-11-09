import { R1DuplicateResult } from './R1DuplicateResult';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { R1SourceDeclaration } from '../../../../contracts/r1-contracts';
import type { R1BatchFile } from '../../../../modules/collection/r1-auto-batch';
import { r1SourceGaps, r1SourceReadyForHandoff, type R1SourceAuthorization } from '../../../../modules/collection/r1-source';
import { RequestError } from '../api';
import type { AlgorithmEntryFocus } from './algorithm-catalog';
import { r1AutoApi, type R1AutoView, type R1BatchStartInput, type R1BatchView, type R1AlgorithmClassification, type R1AlgorithmSettings } from '../r1-auto-api';
import { ErrorNote, errorDetail, useWords } from './Controls';
import { R1ChunkedCsvPanel } from './R1ChunkedCsvPanel';

type SourceEditor = R1SourceDeclaration & { authorization: R1SourceAuthorization };
interface Props {
  source: SourceEditor; ready: boolean; disabled: boolean;
  onSourceChange(source: SourceEditor): void; onOpenAuto(view: R1AutoView): void;
  focus?: Extract<AlgorithmEntryFocus, { kind: 'batch' }> | null;
}
const storageKey = 'xuan-bd.r1-auto.batch';
function remembered(): string { try { return localStorage.getItem(storageKey) ?? ''; } catch { return ''; } }
function remember(id: string) { try { if (id) localStorage.setItem(storageKey, id); else localStorage.removeItem(storageKey); } catch { /* The batch ID remains visible. */ } }
const labels: Record<R1BatchView['items'][number]['state'], string> = {
  awaiting_upload: '等待依次上传', custody: '保管原件中', inspecting: '核对证据或等待前序请求', awaiting_answers: '待补事实',
  processing: '实际加工中', submitting: '发布并固定读回中', recovering: '原提交结果待核', associated: '已核实关联', conflicts_pending: '冲突待确认', blocked: '已明确退回或受阻', stopped: '已停止',
};
const batchLabels: Record<R1BatchView['state'], string> = { awaiting_upload: '等待下一件原文件', running: '按原清单依次推进',
  awaiting_answers: '其余已逐件办理，尚有事实待补', recovering: '等待核清原提交结果', completed: '本批已逐件办理', conflicts_pending: '其余已逐件办理，冲突保留待确认', stopped: '本批已停止', blocked: '本批受阻' };
const meanLabels: Record<NonNullable<R1BatchView['calculation']>['state'], string> = { waiting_inputs: '等待完整原报读回', calculating: '正在计算', custody: '正在保管计算产物', stopped: '已停止', processing: '加工与发布中', associated: '已发布并固定读回', blocked: '派生受阻', recovering: '原交接结果待核对' };
const fields = [['source_id', '来源身份'], ['provider', '提供者'], ['requested_url', '来源系列地址'],
  ['requested_at_utc', '请求时间（UTC，协调世界时）'], ['acquired_at_utc', '取得时间（UTC，协调世界时）'], ['usage_scope', '本批获准用途']] as const;
type SelectedFile = { file: File; manifest: R1BatchFile; classification: R1AlgorithmClassification | null };
const kindLabels = { daily_bar: '日K原报观察', minute_bar: '分钟K原报观察', sentiment: '情绪或专项报告', mixed: '混合报告或口径', other: '其他数据', unknown: '证据不足或不支持' };
function plannedAlgorithm(inspected: R1AlgorithmClassification | null, settings: R1AlgorithmSettings | null, columns: string): string {
  if (!inspected) return '沿用原批冻结规则';
  if (!['daily_bar', 'minute_bar'].includes(inspected.kind) || !inspected.complete || !inspected.valueColumn) return '当前无匹配算法';
  const period = inspected.kind === 'daily_bar' ? settings?.dailyPeriod : settings?.minutePeriod;
  if (!period) return '该类周期未设置，本批只办理原数据';
  if (columns.trim() && !columns.split(/\r?\n/u).includes(inspected.valueColumn)) return '本批选列不含收盘原列，只办理原数据';
  return `自动计算「${inspected.valueColumn}」的 ${period} 观测均线，并单独发布`;
}

export function R1AutoBatchPanel({ source, ready, disabled, onSourceChange, onOpenAuto, focus = null }: Props) {
  const words = useWords();
  const [activeId, setActiveId] = useState(remembered), [current, setCurrent] = useState<R1BatchView | null>(null);
  const [recent, setRecent] = useState<R1BatchView[]>([]), [lookup, setLookup] = useState('');
  const [selected, setSelected] = useState<SelectedFile[]>([]), [datasetId, setDatasetId] = useState('');
  const [directoryName, setDirectoryName] = useState('');
  const [selectedColumns, setSelectedColumns] = useState('');
  const [meanProof, setMeanProof] = useState<{ calculationId: string; proof: Record<string, unknown> } | null>(null);
  const [algorithmSettings, setAlgorithmSettings] = useState<R1AlgorithmSettings | null>(null);
  const [dailyPeriod, setDailyPeriod] = useState(''), [minutePeriod, setMinutePeriod] = useState('');
  const [showAlgorithmSettings, setShowAlgorithmSettings] = useState(false);
  const [consent, setConsent] = useState(false), [datePolicy, setDatePolicy] = useState(false), [duplicateBatch, setDuplicateBatch] = useState(false);
  const [busy, setBusy] = useState(false), [hashing, setHashing] = useState(false), [error, setError] = useState<string | null>(null);
  const activeRef = useRef(activeId), busyRef = useRef(false), selectionEpoch = useRef(0), mounted = useRef(true), sectionRef = useRef<HTMLElement>(null);
  const attempted = useRef(new Set<string>());
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; selectionEpoch.current++; }; }, []);
  useEffect(() => {
    if (!focus) return;
    // 只展开并定位对应周期的原设置；不读取批次、不保存周期、不开始交接。
    setShowAlgorithmSettings(true);
    const timer = window.setTimeout(() => sectionRef.current?.scrollIntoView({ block: 'start' }), 80);
    return () => window.clearTimeout(timer);
  }, [focus?.nonce]);
  useEffect(() => { setConsent(false); }, [source, datasetId, datePolicy, selectedColumns, algorithmSettings]);
  const selectBatch = useCallback((id: string) => {
    activeRef.current = id; setMeanProof(null); remember(id); setActiveId(id); setCurrent(null); setError(null); setConsent(false); setDuplicateBatch(false); attempted.current.clear();
  }, []);
  const accept = useCallback((view: R1BatchView) => {
    if (!mounted.current) return;
    setCurrent(view); setError(null); setRecent(previous => [view, ...previous.filter(item => item.batchId !== view.batchId)]);
  }, []);
  const action = async (work: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(null);
    try { await work(); } catch (failure) { if (mounted.current) setError(errorDetail(failure)); }
    finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  };
  useEffect(() => { let live = true;
    void r1AutoApi.listBatches().then(items => { if (live) setRecent(items); }).catch(failure => { if (live) setError(errorDetail(failure)); });
    void r1AutoApi.algorithmSettings().then(settings => { if (live) {
      setAlgorithmSettings(settings); setDailyPeriod(settings.dailyPeriod?.toString() ?? ''); setMinutePeriod(settings.minutePeriod?.toString() ?? '');
    } }).catch(failure => { if (live) setError(errorDetail(failure)); });
    return () => { live = false; };
  }, []);
  useEffect(() => {
    let live = true, timer: ReturnType<typeof setTimeout> | undefined;
    if (!activeId) return;
    const read = async () => {
      try { const view = await r1AutoApi.batch(activeId); if (live && activeRef.current === activeId && !busyRef.current) accept(view); }
      catch (failure) { if (live && activeRef.current === activeId && !busyRef.current) setError(errorDetail(failure)); }
      if (live) timer = setTimeout(() => void read(), 1500);
    };
    void read(); return () => { live = false; clearTimeout(timer); };
  }, [activeId, accept]);
  useEffect(() => {
    const item = current?.items.find(entry => entry.itemId === current.nextUploadItemId);
    if (!current || !item || disabled || busyRef.current) return;
    const match = selected.find(entry => entry.manifest.sha256 === item.sha256 && entry.manifest.byteLength === item.byteLength
      && entry.manifest.relativePath === item.relativePath);
    const key = `${current.batchId}:${item.itemId}`;
    if (!match || attempted.current.has(key)) return;
    attempted.current.add(key);
    void action(async () => {
      try {
        const view = await r1AutoApi.uploadBatchItem(current.batchId, item.itemId, match.file);
        if (activeRef.current === current.batchId) accept(view);
      } catch (failure) {
        // A lost reply is queried under the same batch/item identity. A manual continuation
        // can retry only the frozen upload; it cannot create a different auto request.
        try { const view = await r1AutoApi.batch(current.batchId); if (activeRef.current === current.batchId) accept(view); } catch { /* Retain the original failure and ID. */ }
        throw failure;
      }
    });
  }, [current, selected, disabled, accept]);
  const chooseFiles = async (files: File[], directory = false) => {
    const epoch = ++selectionEpoch.current; setHashing(true); setSelected([]); setDirectoryName(''); setConsent(false); setError(null); attempted.current.clear();
    try {
      if (!files.length) throw new Error('请明确选择本批原文件。');
      if (files.length > 100) throw new Error(`已选 ${files.length} 件，本批上限 100 件。请缩小选择范围后重新选择，未读取文件字节。`);
      const totalBytes = files.reduce((total, file) => total + file.size, 0);
      if (totalBytes > 128 * 1024 * 1024) throw new Error(`已选文件共 ${(totalBytes / 1024 / 1024).toFixed(2)} MiB，本批上限 128 MiB。请移出超限文件或分批重新选择，未读取文件字节。`);
      const invalid = files.find(file => !file.size || file.size > 25 * 1024 * 1024);
      if (invalid) throw new Error(`${invalid.name}：${invalid.size ? `单件 ${(invalid.size / 1024 / 1024).toFixed(2)} MiB，保管上限为 25 MiB` : '原件为空'}。请移出该件后重新选择，未读取文件字节。`);
      const result: SelectedFile[] = [];
      const inspected = new Map<string, R1AlgorithmClassification>();
      const root = directory ? files[0]!.webkitRelativePath.split('/')[0] : '';
      for (const file of files) {
        const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
        if (epoch !== selectionEpoch.current) return;
        if (directory && (!root || !file.webkitRelativePath.startsWith(root + '/'))) throw new Error('目录选择没有保留同一根目录的实际相对位置，请按来源系列分别选择原文件。');
        const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
        let classification: R1AlgorithmClassification | null = null;
        if (!activeRef.current) {
          classification = inspected.get(sha256) ?? await r1AutoApi.classify(file);
          if (classification.sha256 !== sha256 || classification.byteLength !== file.size) throw new Error(`${file.name} 的内容预检与本次原件摘要或长度不同，请重新选择原文件。`);
          inspected.set(sha256, classification);
        }
        if (epoch !== selectionEpoch.current) return;
        result.push({ file, classification, manifest: { name: file.name, relativePath: directory ? file.webkitRelativePath.slice(root!.length + 1) : file.name,
          byteLength: file.size, sha256 } });
      }
      const positions = new Map<string, string>();
      for (const item of result) {
        const previous = positions.get(item.manifest.relativePath);
        if (previous && previous !== item.manifest.sha256) throw new Error('所选不同文件使用了同一个来源位置。请选择来源目录以保留子目录，或按各自来源系列分批选择。');
        positions.set(item.manifest.relativePath, item.manifest.sha256);
      }
      if (mounted.current && epoch === selectionEpoch.current) { setSelected(result); setDirectoryName(root ?? '');
        if (result.some(item => item.classification?.kind === 'daily_bar' && !algorithmSettings?.dailyPeriod
          || item.classification?.kind === 'minute_bar' && !algorithmSettings?.minutePeriod)) setShowAlgorithmSettings(true);
      }
    } catch (failure) { if (mounted.current && epoch === selectionEpoch.current) setError(errorDetail(failure)); }
    finally { if (mounted.current && epoch === selectionEpoch.current) setHashing(false); }
  };
  const start = async () => {
    if (!ready || !selected.length || hashing || !datasetId.trim() || !consent) throw new Error('请选定本批文件、数据集，并明确允许本批自动交接。');
    if (!r1SourceReadyForHandoff(source)) throw new Error(r1SourceGaps(source).join('；'));
    if (!algorithmSettings || selected.some(item => !item.classification)) throw new Error('请先完成原件内容预检并读取已保存的算法周期。');
    const input: R1BatchStartInput = { batchId: `web-r1-batch-${crypto.randomUUID()}`, source, datasetId: datasetId.trim(), files: selected.map(item => item.manifest),
      ...(datePolicy ? { datePolicy: 'a_share_calendar_day_asia_shanghai' } : {}),
      algorithmRouting: { version: 'bd.r1-algorithm-routing/1', settings: algorithmSettings,
        files: [...new Map(selected.map(item => [item.manifest.sha256, item.classification!])).values()] },
      ...(selectedColumns.trim() ? { sourceValueColumns: selectedColumns.split(/\r?\n/u).filter(name => name.trim()) } : {}) };
    selectBatch(input.batchId);
    try {
      const view = await r1AutoApi.startBatch(input); activeRef.current = view.batchId; remember(view.batchId); setActiveId(view.batchId);
      setDuplicateBatch(view.duplicateBatch); accept(view);
    } catch (failure) {
      try { const view = await r1AutoApi.batch(input.batchId); activeRef.current = view.batchId; remember(view.batchId); setActiveId(view.batchId); accept(view); return; }
      catch (readFailure) {
        if (failure instanceof RequestError && failure.status !== null && failure.status >= 400 && failure.status < 500
          && readFailure instanceof RequestError && readFailure.code === 'R1_BATCH_NOT_FOUND') selectBatch('');
      }
      throw failure;
    }
  };
  const saveAlgorithmSettings = async () => {
    if (!algorithmSettings) throw new Error('请先读取当前算法周期设置。');
    const period = (value: string) => {
      if (!value.trim()) return null;
      if (!/^\d+$/u.test(value) || Number(value) < 2 || Number(value) > 1000) throw new Error('观测周期需要 2 至 1000 的整数；留空表示未设置。');
      return Number(value);
    };
    const saved = await r1AutoApi.saveAlgorithmSettings({ revision: algorithmSettings.revision, dailyPeriod: period(dailyPeriod), minutePeriod: period(minutePeriod) });
    setAlgorithmSettings(saved); setDailyPeriod(saved.dailyPeriod?.toString() ?? ''); setMinutePeriod(saved.minutePeriod?.toString() ?? ''); setConsent(false);
  };
  const locked = busy || disabled || hashing;
  const counts = current ? { associated: current.items.filter(item => item.state === 'associated').length,
    duplicate: current.items.filter(item => item.duplicateOf).length, pending: current.items.filter(item => item.state === 'awaiting_answers').length,
    conflicts: current.items.filter(item => item.state === 'conflicts_pending').length,
    returned: current.items.filter(item => item.state === 'blocked').length } : null;
  const missingFile = current?.items.find(item => item.itemId === current.nextUploadItemId && !selected.some(file => file.manifest.sha256 === item.sha256
    && file.manifest.byteLength === item.byteLength && file.manifest.relativePath === item.relativePath));

  return <><R1ChunkedCsvPanel source={source} ready={ready} disabled={disabled} onOpenAuto={onOpenAuto}/><section ref={sectionRef} id="batch-auto-calculation" className="r1-stage"
    aria-label={words('多文件批量交接', 'Multiple-file batch handoff')} aria-busy={busy || hashing} data-focus-method={focus?.methodId}>
    <h3>{words('多文件批量交接', 'Multiple-file batch handoff')}</h3>
    {focus && <p className="r1-help" role="status">已从算法目录定位到批量自动计算（{focus.methodId === 'daily_bar' ? '日K均线' : '分钟K均线'}）；仍需在本面板手动选择原文件、声明本批授权并确认，页面未读取批次或保存周期。</p>}
    <p className="r1-help">{words('一次选择同一来源系列的多份原文件，统一声明本批用途、数据集与授权。每件保管后沿自动交接办理，核实固定读回再推进下一件；事实待补或明确退回的文件保留原编号，其余文件继续。',
      'Select multiple originals from the same source series and declare this batch’s purpose, dataset and authorization. Each original is stored and handed off in sequence. Missing facts or explicit returns retain their original identities while unrelated files continue.')}</p>
    <p className="r1-help">{words('重复保护仅复用相同来源位置、文件字节、全部来源声明（含请求与取得时间、授权和用途）、数据集、日期口径、选列及目标连接。声明改变时保留为另一次取得，不能仅按相同字节合并。',
      'Duplicates are reused only when the source location, bytes, complete source declaration including request and acquisition times, authorization and purpose, dataset, date policy, selected columns and destination connection all match. Changed declarations remain separate acquisitions.')}</p>
    {error && <ErrorNote>{error}</ErrorNote>}
    <label>{activeId ? words('重新选择原批文件以继续上传', 'Reselect original batch files to continue uploading') : words('选择批量文件', 'Select batch files')}
      <input type="file" multiple disabled={locked} onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ''; void chooseFiles(files); }} /></label>
    <label>{words('选择来源系列目录（保留子目录）', 'Select a source series directory with subdirectories')}
      <input type="file" multiple {...{ webkitdirectory: '' }} disabled={locked} onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ''; void chooseFiles(files, true); }} /></label>
    <p className="r1-help">{directoryName ? words(`已选择目录 ${directoryName}。来源系列地址须为该目录的实际地址；各文件保留相对于它的子目录。`,
      `Selected directory: ${directoryName}. Set the source series address to this directory’s actual URI. Item paths retain its subdirectories.`)
      : words('普通多选只能取得文件名，请仅选择同一实际目录中的原件。跨子目录同名文件请使用目录选择；清单仍受 100 件、128 MiB 限制，不截取目录。',
        'Ordinary file selection exposes filenames only. Select originals from the same actual directory, or use directory selection to preserve subdirectories. The whole manifest remains limited to 100 files and 128 MiB; directories are never truncated.')}</p>
    {hashing && <p role="status">{words('逐件核对完整原件摘要与内容分类中…', 'Checking full original digests and content classifications…')}</p>}
    {selected.length > 0 && <details><summary>{words('本次选定文件', 'Selected files')} · {selected.length}</summary><ul>{selected.map((item, index) => <li key={index}>{item.manifest.relativePath} · {item.manifest.byteLength} {words('字节', 'bytes')}</li>)}</ul></details>}
    {!activeId && <>
      <details open={showAlgorithmSettings} onToggle={event => setShowAlgorithmSettings(event.currentTarget.open)}>
        <summary>{words('行情算法周期设置（保存后按类沿用）', 'Bar algorithm periods, saved once per kind')}</summary>
        <fieldset disabled={locked || !algorithmSettings} className="r1-form"><legend>{words('日K和分钟K独立设置', 'Separate daily and minute periods')}</legend>
          <div className="r1-grid">
            <label id="batch-daily-period">{words('日K均线观测周期', 'Daily moving average observations')}<input type="number" min="2" max="1000" step="1" value={dailyPeriod} placeholder={words('未设置', 'Not configured')} onChange={event => setDailyPeriod(event.target.value)} /></label>
            <label id="batch-minute-period">{words('分钟K均线观测周期', 'Minute moving average observations')}<input type="number" min="2" max="1000" step="1" value={minutePeriod} placeholder={words('未设置', 'Not configured')} onChange={event => setMinutePeriod(event.target.value)} /></label>
          </div>
          <p className="r1-help">{words(`当前已保存：日K ${algorithmSettings?.dailyPeriod ?? '未设置'}；分钟K ${algorithmSettings?.minutePeriod ?? '未设置'}。本批只使用已保存周期。`,
            `Saved periods: daily ${algorithmSettings?.dailyPeriod ?? 'not configured'}; minute ${algorithmSettings?.minutePeriod ?? 'not configured'}. This batch uses saved periods only.`)}</p>
          <p className="r1-help">{words('留空表示未设置；保存后后续批次自动沿用，不需逐批勾选。缺周期只影响该类派生计算，原数据与其他类别继续办理。修改不改变已接受批次的冻结规则。',
            'Empty means not configured. Saved periods apply automatically to future matching batches. An unset period skips that kind’s calculation while originals and other kinds continue. Accepted batches retain their frozen rules.')}</p>
          <button type="button" className="text-button" onClick={() => void action(saveAlgorithmSettings)}>{words('保存算法周期', 'Save algorithm periods')}</button>
        </fieldset>
        <button type="button" className="text-button" disabled={locked} onClick={() => void action(async () => {
          const settings = await r1AutoApi.algorithmSettings(); setAlgorithmSettings(settings);
          setDailyPeriod(settings.dailyPeriod?.toString() ?? ''); setMinutePeriod(settings.minutePeriod?.toString() ?? ''); setConsent(false);
        })}>{words('读取当前算法设置', 'Read current algorithm settings')}</button>
      </details>
      {selected.length > 0 && <div className="r1-proof" aria-label={words('本批内容分类与算法路由', 'Batch content classification and algorithm routing')}>
        <h4>{words('本批内容分类与自动算法', 'Content kinds and automatic algorithms')}</h4>
        <p className="r1-help">{words('按不同原件字节逐件预检，未完成完整检查或超预算时明示原因。算法按内容中的业务维度、日期或分钟标签及对象身份匹配；上传时服务端再次核对。情绪、榜单、混合与未知数据保留原数据，不推定算法。',
          'Each distinct original is preflighted, with incomplete or over-budget checks shown explicitly. Algorithms match business dimensions, date or minute labels and subject identity. Uploads are checked again. Sentiment, rankings, mixed and unknown data retain the original handoff without a guessed algorithm.')}</p>
        <div className="r1-table-scroll"><table><thead><tr><th>{words('原件', 'Original')}</th><th>{words('内容分类', 'Content kind')}</th><th>{words('本批算法', 'Batch algorithm')}</th></tr></thead><tbody>{selected.map((item, index) => <tr key={index}>
          <td>{item.manifest.relativePath}</td><td>{item.classification ? kindLabels[item.classification.kind] : words('沿用原批规则', 'Frozen batch rules')}
            {item.classification && <p className="r1-help">{item.classification.reason}</p>}</td>
          <td>{plannedAlgorithm(item.classification, algorithmSettings, selectedColumns)}</td>
        </tr>)}</tbody></table></div>
      </div>}
    </>}
    {!activeId && <form className="r1-form" onSubmit={event => { event.preventDefault(); void action(start); }}><fieldset disabled={locked}>
      <legend>{words('本批范围与来源授权', 'Batch scope and source authorization')}</legend>
      <label>{words('本批目标数据集编号', 'Batch target dataset ID')}<input required maxLength={128} value={datasetId} onChange={event => { setDatasetId(event.target.value); setConsent(false); }} /></label>
      <label>{words('本批仅交接这些原列（可选，每行一个原列名）', 'Original columns for this batch (optional, one exact name per line)')}<textarea rows={3} maxLength={65536} className="r1-constants" value={selectedColumns}
        onChange={event => { setSelectedColumns(event.target.value); setConsent(false); }} /></label>
      <p className="r1-help">{words('留空时按全表核对。明确选列只用于来源原报普通表，保留原始日期与身份列；任一文件缺少所选列时，该件具体退回，其余文件继续。原件完整保留。',
        'Leave empty to inspect all columns. Explicit selection applies to ordinary source-reported tables and retains original date and identity columns. A file missing a selected column is returned with a reason while other files continue. Originals remain complete.')}</p>
      <div className="r1-grid">{fields.map(([key, label]) => <label key={key}>{label}<input required maxLength={4096} value={source[key]}
        onChange={event => { onSourceChange({ ...source, [key]: event.target.value }); setConsent(false); }} /></label>)}</div>
      <p className="r1-help">{words('来源系列地址应指向这些原件的实际系列目录，例如原包的 file URI（文件资源标识）。每件保留该地址与实际文件名；不同系列分批办理。',
        'The source series address identifies the originals’ actual series directory, such as its file URI. Each item retains that address and its actual filename. Use separate batches for different series.')}</p>
      <label>{words('本批正式交接授权', 'Formal authorization for this batch')}<select value={source.authorization.status} onChange={event => {
        onSourceChange({ ...source, authorization: { status: event.target.value as R1SourceAuthorization['status'], basis: null } }); setConsent(false);
      }}><option value="unknown">{words('待核：尚未确认授权', 'Unknown: unverified')}</option><option value="authorized">{words('有授权：提供明确依据', 'Authorized: provide a basis')}</option><option value="denied">{words('无授权：禁止本批交接', 'Denied: batch prohibited')}</option></select></label>
      <label>{words('本批授权依据', 'Batch authorization basis')}<textarea rows={3} maxLength={4096} className="r1-constants" value={source.authorization.basis ?? ''} onChange={event => {
        onSourceChange({ ...source, authorization: { ...source.authorization, basis: event.target.value || null } }); setConsent(false);
      }} /></label>
      <label className="r1-confirm"><input type="checkbox" checked={datePolicy} onChange={event => { setDatePolicy(event.target.checked); setConsent(false); }} />{words('本批全部文件属于境内 A 股来源，原报交易日期按北京时间日历日解释；历史可得时间仍未知。仅在识别到原报交易日期问题时采用本声明。',
        'All selected files are mainland A-share sources. Reported trade dates mean Beijing calendar days; historical availability remains unknown. Apply this declaration only to a recognized source trade-date question.')}</label>
      <p className="r1-help">{words('本批按上述分类明细和已保存周期自动执行。来源原报先发布并完整固定读回，再按对象与原报时间标签计算本批观测窗口；不同产品分开，窗口不足或缺值保留原因。均线按原单位作为独立产品保存。',
        'The routing table and saved periods determine this batch’s calculations. Originals are published and fixed-read first. Windows use this batch’s observations by subject and source time label, keeping different products separate and preserving warmup or missing reasons. Means are published separately in the original unit.')}</p>
      <label className="r1-confirm"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />{words(`我允许仅对本批所列 ${selected.length} 份原件，按上述来源、用途和数据集自动登记、加工、发布并固定读回，并自动执行明细列出的算法及周期（设置修订 ${algorithmSettings?.revision ?? '未读取'}），将派生结果单独发布。未知结果沿原编号核对。`,
        `I authorize registration, processing, publication and fixed readback only for these ${selected.length} originals, including the algorithms and periods listed above under settings revision ${algorithmSettings?.revision ?? 'unread'}. Derived results are published separately. Unknown outcomes keep their original identities.`)}</label>
      <button type="submit" className="primary-button" disabled={!ready || !selected.length || !algorithmSettings || selected.some(item => !item.classification) || !datasetId.trim() || !consent || !r1SourceReadyForHandoff(source)}>{words('开始本批自动交接', 'Start this batch handoff')}</button>
    </fieldset></form>}
    {activeId && <div>
      <p><strong>{words('本批编号', 'Batch ID')}</strong> <code>{activeId}</code></p>
      {duplicateBatch && <p className="r1-help">{words('本清单和声明已有原批次，已返回原记录，没有再次保管或发布。', 'This manifest and declaration already have a batch. The original record is shown without another custody or publication.')}</p>}
      {!current && <p role="status">{words('读取原批次中…', 'Reading the original batch…')}</p>}
      {current && <>
        <p role="status" aria-live="polite"><strong>{batchLabels[current.state]}</strong> · {current.datasetId}</p>
        {counts && <p className="r1-help">{words(`关联 ${counts.associated} 件；重复引用 ${counts.duplicate} 件；待补 ${counts.pending} 件；冲突待确认 ${counts.conflicts} 件；退回或受阻 ${counts.returned} 件。`,
          `Associated: ${counts.associated}; duplicate references: ${counts.duplicate}; missing facts: ${counts.pending}; returned or blocked: ${counts.returned}.`)}</p>}
        {missingFile && <p className="r1-help">{words(`下一件 ${missingFile.relativePath} 尚未上传。请重新选择原批文件，核对摘要后继续。已保管文件的后台处理继续。`,
          `The next file, ${missingFile.relativePath}, has not been uploaded. Reselect original batch files to continue after digest verification. Stored originals continue processing in the background.`)}</p>}
        {current.error && <p className="r1-help danger-text">{current.error.code}: {current.error.message}</p>}
        <div className="r1-table-scroll"><table><thead><tr><th>{words('原件与来源位置', 'Original and source location')}</th><th>{words('逐件状态', 'Item status')}</th><th>{words('原记录', 'Original record')}</th></tr></thead><tbody>
          {current.items.map(item => <tr key={item.itemId}><td><strong>{item.relativePath}</strong><p className="r1-help">{item.requestedUrl}</p></td><td>{item.duplicateOf && <p>{words('重复引用原文件', 'Duplicate reference')}</p>}<strong>{labels[item.state]}</strong>
            {item.auto?.currentRequest && <R1DuplicateResult request={item.auto.currentRequest} />}
            {item.algorithmInspection && <p className="r1-help">{kindLabels[item.algorithmInspection.kind]} · {item.algorithmInspection.reason}</p>}
            {item.duplicateOf && <p className="r1-help">{item.duplicateOf.batchId} / {item.duplicateOf.itemId}</p>}
            {item.auto?.waitingReason && <p className="r1-help">{item.auto.waitingReason} <code>{item.auto.waitingForRequestId}</code></p>}
            {item.error && <p className="r1-help danger-text">{item.error.code}: {item.error.message}</p>}
            {item.auto?.localReturn && <p className="r1-help">{item.auto.localReturn.code}: {item.auto.localReturn.message}</p>}
            {!!Object.keys(item.policyAnswers ?? {}).length && <p className="r1-help">{words('已按本批声明记录：原报交易日期为北京时间日历日。', 'Recorded under this batch declaration: source trade dates mean Beijing calendar days.')}</p>}
          </td><td><code>{item.materialId ?? item.custodyTaskId ?? '—'}</code><p className="r1-help"><code>{item.auto ? item.autoRequestId : '—'}</code></p>
            <button type="button" className="text-button" disabled={locked || !item.auto} onClick={() => void action(async () => onOpenAuto(await r1AutoApi.get(item.autoRequestId)))}>{words('查看并补答', 'Inspect and answer')}</button></td></tr>)}
        </tbody></table></div>
        {(current.calculations ?? (current.calculation ? [current.calculation] : [])).map(calculation => <div className="r1-proof" key={calculation.calculationId}>
          <h4>{words('本批均线', 'Batch moving average')}{calculation.kind && ` · ${kindLabels[calculation.kind]}`}</h4>
          <p>{calculation.selection.valueColumn} · {calculation.selection.period} {words('期', 'observations')} · {meanLabels[calculation.state]}</p>
          {calculation.productId && <p>{words('派生产品', 'Derived product')} <code>{calculation.productId}</code></p>}
          {calculation.snapshotId && <p>{words('派生固定快照', 'Fixed derived snapshot')} <code>{calculation.snapshotId}</code></p>}
          {calculation.error && <p className="danger-text">{calculation.error.code} · {calculation.error.message}</p>}
          {calculation.proof && <p>{words('实际输出', 'Actual output')} {calculation.proof.counts.rows} {words('行，有效均值', 'rows, valid means')} {calculation.proof.counts.valid} · {words('窗口不足', 'Warmup')} {calculation.proof.counts.warmup} · {words('窗口含缺值', 'Missing in window')} {calculation.proof.counts.windowMissing}</p>}
          {calculation.proof && <button type="button" className="text-button" disabled={locked} onClick={() => void action(async () => {
            const proof = await r1AutoApi.calculationEvidence(current.batchId, calculation.calculationId);
            setMeanProof({ calculationId: calculation.calculationId, proof });
          })}>{words('读取原始记录与窗口明细', 'Read source record and window details')}</button>}
          {meanProof?.calculationId === calculation.calculationId && <details open><summary>{words('固定输入、行版本与窗口', 'Fixed inputs, record versions and windows')}</summary><pre className="database-text-preview">{JSON.stringify(meanProof.proof, null, 2)}</pre></details>}
          {calculation.auto && <button type="button" className="text-button" disabled={locked} onClick={() => void action(async () => onOpenAuto(await r1AutoApi.get(calculation.auto!.requestId)))}>{words('查看均线交接回执', 'Inspect moving average handoff')}</button>}
        </div>)}
        <details><summary>{words('本批冻结来源、用途、授权与算法规则', 'Frozen batch source, purpose, authorization and algorithms')}</summary><pre className="database-text-preview">{JSON.stringify({ source: current.source, datasetId: current.datasetId, datePolicy: current.datePolicy, sourceValueColumns: current.sourceValueColumns, algorithmRouting: current.algorithmRouting }, null, 2)}</pre></details>
      </>}
      <div className="r1-actions"><button type="button" className="text-button" disabled={locked} onClick={() => void action(async () => {
        accept(await r1AutoApi.advanceBatch(activeId)); attempted.current.clear();
      })}>{words('核对并继续原批次', 'Reconcile and continue original batch')}</button>
      <button type="button" className="text-button" disabled={locked} onClick={() => { selectBatch(''); setSelected([]); setDatasetId(''); setDatePolicy(false); setSelectedColumns(''); }}>{words('选定另一批文件', 'Select another batch')}</button></div>
    </div>}
    <div className="r1-actions"><label>{words('已保存的批次编号', 'Saved batch ID')}<input value={lookup} onChange={event => setLookup(event.target.value)} /></label>
      <button type="button" className="text-button" disabled={locked || !lookup.trim()} onClick={() => void action(async () => { const view = await r1AutoApi.batch(lookup.trim()); selectBatch(view.batchId); accept(view); })}>{words('读取原批次', 'Read original batch')}</button>
      <button type="button" className="text-button" disabled={locked} onClick={() => void action(async () => setRecent(await r1AutoApi.listBatches()))}>{words('刷新批次列表', 'Refresh batches')}</button></div>
    {recent.map(item => <button type="button" key={item.batchId} className="database-row database-row--button" disabled={locked} onClick={() => void action(async () => {
      const view = await r1AutoApi.batch(item.batchId); selectBatch(view.batchId); accept(view);
    })}><span>{item.batchId}</span><span>{item.items.length} {words('件', 'files')} · {batchLabels[item.state]}</span></button>)}
  </section></>;
}
