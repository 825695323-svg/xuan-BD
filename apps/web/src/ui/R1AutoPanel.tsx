import { R1DuplicateResult } from './R1DuplicateResult';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { R1SourceDeclaration } from '../../../../contracts/r1-contracts';
import type { MaterialCategory, MaterialEnvelope, MaterialRecord } from '../../../../modules/collection/materials/contracts';
import type { XlsxTableSelection } from '../../../../modules/collection/data-processing/xlsx-table';
import { r1SourceGaps, r1SourceReadyForHandoff, type R1SourceAuthorization } from '../../../../modules/collection/r1-source';
import { dataBrowserApi } from '../data-browser-api';
import { RequestError } from '../api';
import { r1AutoApi, type R1AutoView } from '../r1-auto-api';
import { r1Api, type R1XlsxPreview } from '../r1-api';
import type { AlgorithmEntryFocus } from './algorithm-catalog';
import { ErrorNote, errorDetail, useWords } from './Controls';
import { R1AutoBatchPanel } from './R1AutoBatchPanel';

type SourceEditor = R1SourceDeclaration & { authorization: R1SourceAuthorization };
interface Props {
  materials: MaterialEnvelope[]; materialId: string; material: MaterialRecord | null;
  materialLoading: boolean; materialError: string | null; source: SourceEditor;
  ready: boolean; disabled: boolean;
  onChooseMaterial(id: string): void; onSourceChange(source: SourceEditor): void;
  onUpload(file: File, category: MaterialCategory): Promise<void>;
  focus?: Extract<AlgorithmEntryFocus, { kind: 'batch' }> | null;
}
const activeKey = 'xuan-bd.r1-auto.request';
function rememberedRequest(): string { try { return localStorage.getItem(activeKey) ?? ''; } catch { return ''; } }
function rememberRequest(id: string) { try { if (id) localStorage.setItem(activeKey, id); else localStorage.removeItem(activeKey); } catch { /* The visible ID remains available when browser storage is disabled. */ } }
const sourceFields = [ ['source_id', '来源身份'], ['provider', '提供者'], ['requested_url', '原始地址或 URI（资源标识）'],
  ['requested_at_utc', '请求时间（UTC，协调世界时）'], ['acquired_at_utc', '取得时间（UTC，协调世界时）'], ['usage_scope', '本次获准用途'] ] as const;
const stateLabels: Record<R1AutoView['state'], string> = {
  inspecting: '查验原件与证据中', awaiting_answers: '等待逐项补答', processing: '实际加工中', submitting: '交接与固定读回中',
  recovering: '原请求结果待核对', associated: '真实回执、固定读回及回链完成', conflicts_pending: '无冲突记录已处理，冲突保留待确认', blocked: '交接受阻', stopped: '自动交接已停止',
};
const ongoing = new Set(['inspecting', 'processing', 'submitting', 'recovering']);
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
function messages(value: unknown): { code: string; message: string }[] {
  const item = object(value), own = typeof item.message === 'string' ? [{ code: typeof item.code === 'string' ? item.code : '', message: item.message }] : [];
  return [...own, ...(Array.isArray(item.errors) ? item.errors.flatMap(messages) : [])];
}
const factLabels: Record<string, string> = { semantic_code: '稳定语义编码', subject_id: '业务对象编号', subject_kind: '业务对象类别',
  frequency: '业务频率', precision: '时间精度', timezone: '业务时区', key_column: '业务键列', start_column: '区间起点列', end_column: '开区间终点列', definition_predecessor: '既有定义与固定快照' };
function factLabel(key: string): string {
  if (factLabels[key]) return factLabels[key];
  if (key.startsWith('contractRevisionBasis:')) return '本次口径修订依据';
  const [prefix, ...column] = key.split('.');
  return ({ code: '字段编码', type: '保存类型', unit: '单位编码', measurement: '计量性质', state: '值状态依据' }[prefix] ?? key)
    + (column.length ? ` · ${column.join('.')}` : '');
}
function valueLabel(key: string, value: string): string {
  const vocabulary: Record<string, string> = key === 'subject_kind' ? { entity: '实体', instrument: '金融工具', listing: '挂牌对象', market: '市场', region: '地区', physical_object: '实物对象' }
    : key === 'precision' ? { day: '日', minute: '分钟', second: '秒' }
    : key.startsWith('type.') ? { text: '文本', decimal: '十进制', integer: '整数', boolean: '布尔值' }
    : key.startsWith('measurement.') ? { stock: '存量', flow: '流量', event: '事件', mixed_observation: '混合观察', relation: '关系' }
    : key.startsWith('state.') ? { '@all_valid': '我明确声明整列均为有效值' } : {};
  return vocabulary[value] ? `${value}（${vocabulary[value]}）` : value;
}
const emptyXlsx = () => ({ sheetName: '', headerRow: '', firstDataRow: '', lastDataRow: '', firstColumn: '', lastColumn: '' });
function columnNumber(value: string): number {
  return /^[A-Z]{1,3}$/u.test(value) ? [...value].reduce((result, letter) => result * 26 + letter.charCodeAt(0) - 64, 0) : 0;
}
function columnLetter(value: number): string {
  let result = '';
  for (let n = value; n; n = Math.floor((n - 1) / 26)) result = String.fromCharCode(65 + (n - 1) % 26) + result;
  return result;
}
function selectionColumns(firstColumn: string, lastColumn: string): string[] {
  const first = columnNumber(firstColumn.toUpperCase()), last = columnNumber(lastColumn.toUpperCase());
  return first && last >= first && last <= 16_384 && last - first < 256 ? Array.from({ length: last - first + 1 }, (_, i) => columnLetter(first + i)) : [];
}
function cellText(cell: R1XlsxPreview['preview']['rows'][number]['cells'][number]): string {
  return cell.formula ? '' : cell.resolvedSharedString ?? cell.inlineString ?? cell.rawStorage ?? '';
}

export function R1AutoPanel({ materials, materialId, material, materialLoading, materialError, source, ready, disabled, onChooseMaterial, onSourceChange, onUpload, focus = null }: Props) {
  const words = useWords();
  const [activeId, setActiveId] = useState(rememberedRequest), [current, setCurrent] = useState<R1AutoView | null>(null);
  const [recent, setRecent] = useState<R1AutoView[]>([]), [lookupId, setLookupId] = useState('');
  const [datasetId, setDatasetId] = useState(''), [priorRequestId, setPriorRequestId] = useState('');
  const [columnDraft, setColumnDraft] = useState({ materialId: '', names: '' });
  const selectedColumns = columnDraft.materialId === materialId ? columnDraft.names : '';
  const [consent, setConsent] = useState(false), [category, setCategory] = useState<MaterialCategory>('unclassified');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState(''), [searchPage, setSearchPage] = useState<{ items: MaterialEnvelope[]; nextCursor: string | null; query: string } | null>(null);
  const [xlsx, setXlsx] = useState<R1XlsxPreview | null>(null), [xlsxDraft, setXlsxDraft] = useState(emptyXlsx), [headers, setHeaders] = useState<Record<string, string>>({});
  const busyRef = useRef(false), epoch = useRef(0), selectedId = useRef(activeId), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const accept = useCallback((view: R1AutoView) => {
    if (!mounted.current || selectedId.current !== view.requestId) return;
    setCurrent(view); setError(null);
    setAnswers(previous => Object.fromEntries(view.questions.map(question => [question.key, previous[question.key] ?? ''])));
    setRecent(previous => [view, ...previous.filter(item => item.requestId !== view.requestId)]);
  }, []);
  const chooseRequest = (id: string) => {
    epoch.current++; selectedId.current = id; rememberRequest(id);
    setActiveId(id); setCurrent(null); setLoading(false); setAnswers({}); setConsent(false); setError(null);
  };
  const action = async (work: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true; epoch.current++; setBusy(true); setError(null);
    try { await work(); } catch (failure) { if (mounted.current) setError(errorDetail(failure)); }
    finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  };
  useEffect(() => { let live = true;
    void r1AutoApi.list().then(items => { if (live) setRecent(items); }).catch(failure => { if (live) setError(errorDetail(failure)); });
    return () => { live = false; };
  }, []);
  useEffect(() => { let live = true, timer: ReturnType<typeof setTimeout> | undefined;
    if (!activeId) return;
    setLoading(!current);
    const read = async () => {
      if (busyRef.current) { if (live) timer = setTimeout(() => void read(), 250); return; }
      const revision = epoch.current;
      try { const view = await r1AutoApi.get(activeId); if (live && revision === epoch.current) accept(view); }
      catch (failure) { if (live && revision === epoch.current) setError(errorDetail(failure)); }
      finally { if (live) setLoading(false); }
      if (live && (!current || ongoing.has(current.state))) timer = setTimeout(() => void read(), 2000);
    };
    void read();
    return () => { live = false; clearTimeout(timer); };
  }, [activeId, current?.state, accept]);
  useEffect(() => { setXlsx(null); setXlsxDraft(emptyXlsx()); setHeaders({}); setConsent(false); }, [materialId]);
  const locked = busy || disabled;
  const stored = material?.envelope.materialId === materialId ? material : null;
  const workbook = xlsx?.materialId === materialId && xlsx.sha256 === stored?.envelope.sha256 ? xlsx.preview : null;
  const columns = selectionColumns(xlsxDraft.firstColumn, xlsxDraft.lastColumn);
  const headerKey = (column: string) => `${xlsxDraft.sheetName}:${xlsxDraft.headerRow}:${column}`;
  const headerValue = (column: string) => headers[headerKey(column)] ?? (workbook?.previewSheet === xlsxDraft.sheetName
    ? workbook.rows.find(row => Number(row.row) === Number(xlsxDraft.headerRow))?.cells.find(cell => cell.address === `${column}${xlsxDraft.headerRow}`)
    : undefined);
  const headerText = (column: string): string => {
    const value = headerValue(column); return typeof value === 'string' ? value : value ? cellText(value) : '';
  };
  const readSelection = (): XlsxTableSelection => {
    const headerRow = Number(xlsxDraft.headerRow), firstDataRow = Number(xlsxDraft.firstDataRow), lastDataRow = Number(xlsxDraft.lastDataRow);
    if (!workbook || workbook.conversionStatus !== 'complete' || !workbook.sheets.some(sheet => sheet.name === xlsxDraft.sheetName)
      || !Number.isSafeInteger(headerRow) || headerRow < 1 || !Number.isSafeInteger(firstDataRow) || firstDataRow <= headerRow
      || !Number.isSafeInteger(lastDataRow) || lastDataRow < firstDataRow || lastDataRow > 1_048_576 || lastDataRow - firstDataRow >= 5000 || !columns.length) {
      throw new Error('请先检查完整工作簿结构，并明确工作表、表头、连续数据行和列范围；单次最多 5000 行、256 列。');
    }
    const mapped = columns.map(column => ({ column, header: headerText(column), name: headerText(column) }));
    if (mapped.some(item => !item.header.trim()) || new Set(mapped.map(item => item.name)).size !== mapped.length) throw new Error('请逐列核对原表头；表头不能为空或重复，后端还会核对真实单元格。');
    return { sheetName: xlsxDraft.sheetName, headerRow, firstDataRow, lastDataRow, firstColumn: columns[0]!, lastColumn: columns.at(-1)!, columns: mapped };
  };
  const searchMaterials = async (cursor?: string | null) => {
    const page = await dataBrowserApi.materials(cursor ? searchPage?.query ?? query.trim() : query.trim(), cursor);
    setSearchPage({ items: page.items, nextCursor: page.nextCursor, query: page.query });
  };
  const start = async () => {
    if (!ready || !stored || materialLoading || materialError || !datasetId.trim() || !consent) throw new Error('请选择已核对的保管原件、目标数据集，并明确允许本次自动交接。');
    if (!r1SourceReadyForHandoff(source)) throw new Error(r1SourceGaps(source).join('；'));
    const xlsxSelection = stored.preview.format === 'excel' ? readSelection() : undefined;
    const id = `web-r1-auto-${crypto.randomUUID()}`;
    chooseRequest(id);
    try {
      accept(await r1AutoApi.start({ requestId: id, materialId, source, datasetId: datasetId.trim(),
        ...(selectedColumns.trim() ? { sourceValueColumns: selectedColumns.split(/\r?\n/u).filter(name => name.trim()) } : {}),
        ...(priorRequestId.trim() ? { priorRequestId: priorRequestId.trim() } : {}), ...(xlsxSelection ? { xlsxSelection } : {}) }));
    } catch (failure) {
      // A lost response is resolved by reading the original ID. Only a definite rejection plus
      // an authoritative missing record returns the unaccepted draft to editing.
      try { accept(await r1AutoApi.get(id)); return; }
      catch (readFailure) {
        if (failure instanceof RequestError && failure.status !== null && failure.status >= 400 && failure.status < 500
          && readFailure instanceof RequestError && readFailure.code === 'R1_AUTO_NOT_FOUND') chooseRequest('');
      }
      throw failure;
    }
  };
  const completed = current?.state === 'associated' && current.currentRequest?.state === 'associated';
  const mayStartAnother = current && ['associated', 'conflicts_pending', 'blocked', 'stopped'].includes(current.state) && !current.currentRequest?.requiresRecovery;

  return <><R1AutoBatchPanel source={source} ready={ready} disabled={disabled || busy} onSourceChange={onSourceChange} focus={focus} onOpenAuto={view => {
    chooseRequest(view.requestId); accept(view);
  }} />
  <section className="r1-stage" aria-label={words('文件自动交接', 'Automatic file handoff')} aria-busy={busy || loading}>
    <h3>{words('文件自动交接', 'Automatic file handoff')}</h3>
    <p className="r1-help">{words('选择原件，声明来源授权和用途；证据充分时自动完成登记、五步加工、交接与固定读回。有缺口时只问需要补充的事实。',
      'Select an original and declare its authorization and usage. Sufficient evidence advances through registration, processing, handoff and fixed readback. Missing facts are asked individually.')}</p>
    <details><summary>{words('支持范围与语义证据', 'Supported scope and semantic evidence')}</summary>
      <p className="r1-help">{words('本入口按来源报告的普通观察表交接，覆盖保持部分。支持 8 MiB 内、1 至 5000 行的 CSV（逗号分隔表）、行对象 JSON（结构化文本）和明确选区的 XLSX（工作簿）；未适配或超限时保留原件并说明原因。',
        'This entry hands off source-reported observation tables with partial coverage: CSV, row-object JSON and explicitly selected XLSX, up to 8 MiB and 5000 rows. Unsupported or over-limit originals stay stored with a reason.')}</p>
      <p className="r1-help">{words('原件可用各行一致的 bd.*（语义声明列）说明对象、时区、频率及逐字段类型、单位；已有明确证据则自动采用，缺项再补答。业务时间须有明确 UTC（协调世界时）起止，业务键须唯一。来源字典不能授予许可、选择连接或证明行情、复权和历史公开时点资格。',
        'Consistent bd.* source columns can state the subject, timezone, frequency and field types or units. Available evidence is adopted; only missing facts are asked. Business intervals need explicit UTC bounds and unique keys. Source dictionaries cannot grant authorization, choose connections or prove market, adjustment or historical-publication qualifications.')}</p>
      <div className="r1-table-scroll"><table><thead><tr><th>{words('原件声明列', 'Source declaration columns')}</th><th>{words('说明', 'Meaning')}</th></tr></thead><tbody>
        <tr><td>bd.semantic_code, bd.subject_id, bd.subject_kind</td><td>{words('稳定语义与本表共同描述的对象', 'Stable semantics and the common subject')}</td></tr>
        <tr><td>bd.frequency, bd.precision, bd.timezone</td><td>{words('业务频率、时间精度与时区', 'Business frequency, precision and timezone')}</td></tr>
        <tr><td>bd.key_column, bd.start_column, bd.end_column</td><td>{words('业务键及明确区间端点的原列名', 'Original key and interval-bound column names')}</td></tr>
        <tr><td>bd.type.原列名, bd.unit.原列名, bd.measurement.原列名, bd.state.原列名</td><td>{words('逐列保存类型、单位、计量性质和状态依据；也可按出现的问题补答', 'Per-column type, unit, measurement nature and state evidence; these can also be answered when asked')}</td></tr>
      </tbody></table></div>
    </details>
    {error && <ErrorNote detail={error}>{activeId ? words('原自动交接尚未确认更新，请保留编号并读取原记录。', 'The original handoff update is unconfirmed. Preserve its ID and read its record.') : words('本次操作未完成，请查看具体原因。', 'The action did not complete. Inspect the reason.')}</ErrorNote>}
    {!activeId && <form className="r1-form" onSubmit={event => { event.preventDefault(); void action(start); }}>
      {disabled && <p className="r1-help">{words('手工交接正在操作或已有固定计划；结束该次编辑后可开始新的自动交接。原自动记录仍可读取。', 'The manual handoff is busy or has a frozen plan. Finish that edit before starting another automatic handoff. Existing automatic records remain readable.')}</p>}
      <fieldset disabled={locked}><legend>{words('选择原件与数据集', 'Original and dataset')}</legend>
        <div className="r1-actions"><label>{words('查找已保管原件', 'Find stored originals')}<input value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => {
          if (event.key === 'Enter') { event.preventDefault(); void action(() => searchMaterials()); }
        }} placeholder={words('按文件名或材料编号查询', 'Search filename or material ID')} /></label>
          <button type="button" className="text-button" onClick={() => void action(() => searchMaterials())}>{words('查找原件', 'Find originals')}</button>
          {searchPage?.nextCursor && <button type="button" className="text-button" onClick={() => void action(() => searchMaterials(searchPage.nextCursor))}>{words('下一页原件', 'Next originals')}</button>}</div>
        <label>{words('已保管原件', 'Stored original')}<select required value={materialId} onChange={event => onChooseMaterial(event.target.value)}>
          <option value="">{words('请选择原件', 'Select an original')}</option>
          {(searchPage?.items ?? materials).map(item => <option key={item.materialId} value={item.materialId}>{item.filename} · {item.materialId}</option>)}
          {materialId && !(searchPage?.items ?? materials).some(item => item.materialId === materialId) && <option value={materialId}>{stored?.envelope.filename ?? materialId} · {materialId}</option>}
        </select></label>
        {searchPage && <p className="r1-help">{searchPage.items.length} {words('份查询结果；可继续翻页查找早期原件。', 'results; continue paging for earlier originals.')}</p>}
        <div className="r1-grid"><label>{words('上传接收类别', 'Upload intake category')}<select value={category} onChange={event => setCategory(event.target.value as MaterialCategory)}>
          <option value="unclassified">{words('未分类，仅保管', 'Unclassified, custody only')}</option><option value="data">{words('数据材料', 'Data material')}</option><option value="tool">{words('代码或工具材料', 'Code or tool material')}</option></select></label>
          <label>{words('上传原件（保管上限 25 MiB）', 'Upload original (custody limit 25 MiB)')}<input type="file" onChange={event => {
            const file = event.target.files?.[0]; event.target.value = ''; if (file) void action(() => onUpload(file, category));
          }} /></label></div>
        {materialLoading ? <p className="r1-help" role="status">{words('核对原件保管记录中…', 'Checking original custody…')}</p> : materialError ? <p className="r1-help danger-text" role="alert">{materialError}</p>
          : stored && <div className="r1-material"><p><strong>{words('BD 已保管原件', 'Original stored in BD')}</strong> · {stored.envelope.filename} · {stored.envelope.byteLength.toLocaleString()} B</p>
            <p className="r1-help"><code>{stored.envelope.materialId}</code> · SHA-256（内容摘要）<code>{stored.envelope.sha256}</code></p></div>}
        {stored?.preview.format === 'excel' && <div className="r1-xlsx">
          <button type="button" className="text-button" onClick={() => void action(async () => {
            const value = await r1Api.xlsxPreview(materialId);
            if (value.sha256 !== stored.envelope.sha256) throw new Error('工作簿结构与所选原件摘要不一致。');
            setXlsx(value);
          })}>{words('查看工作簿结构', 'Inspect workbook structure')}</button>
          {workbook && <><p className="r1-help">{workbook.scopeGuidance}</p>
            {workbook.conversionStatus !== 'complete' && <p className="r1-help danger-text">{words('工作簿原生转换未完整，不能开始自动交接。', 'Native workbook conversion is incomplete; automatic handoff is unavailable.')}</p>}
            <div className="r1-table-scroll"><table><thead><tr><th>{words('工作表', 'Sheet')}</th><th>{words('实际行数', 'Native rows')}</th><th>{words('实际单元格数', 'Native cells')}</th></tr></thead><tbody>{workbook.sheets.map((sheet, i) => <tr key={i}><td>{sheet.name ?? '—'}</td><td>{sheet.rowCount}</td><td>{sheet.cellCount}</td></tr>)}</tbody></table></div>
            <details><summary>{words('查看原生单元格预览', 'Inspect native cell preview')} · {workbook.previewSheet}</summary><div className="r1-table-scroll"><table><tbody>{workbook.rows.map((row, i) => <tr key={i}><th>{row.row}</th><td>{row.cells.map(cell => `${cell.address}: ${cell.formula ? words('含公式', 'Formula') : cellText(cell)}`).join('；')}</td></tr>)}</tbody></table></div></details>
            <div className="r1-grid"><label>{words('工作表原名', 'Original sheet name')}<select value={xlsxDraft.sheetName} onChange={event => setXlsxDraft(value => ({ ...value, sheetName: event.target.value }))}>
              <option value="">{words('请选择工作表', 'Select a sheet')}</option>{workbook.sheets.filter(sheet => sheet.name).map((sheet, i) => <option key={i} value={sheet.name!}>{sheet.name}</option>)}</select></label>
              {([['headerRow', '表头行（1 基）'], ['firstDataRow', '首数据行（1 基）'], ['lastDataRow', '末数据行（含）'], ['firstColumn', '首列字母'], ['lastColumn', '末列字母（含）']] as const).map(([key, label]) =>
                <label key={key}>{label}<input type={key.endsWith('Row') ? 'number' : 'text'} min={key.endsWith('Row') ? 1 : undefined} value={xlsxDraft[key]} onChange={event => {
                  const value = key.endsWith('Column') ? event.target.value.toUpperCase() : event.target.value;
                  setXlsxDraft(previous => ({ ...previous, [key]: value }));
                }} /></label>)}</div>
            {columns.length > 0 && <><p className="r1-help">{words('逐列核对原表头，输出保留同名；预览未包含的表头请按原件补填，后端会再次逐格核对。', 'Check each original header; output retains its name. Fill headers outside the preview from the original. The backend verifies every cell again.')}</p>
              <div className="r1-grid">{columns.map(column => <label key={column}>{column} {words('列原表头', 'original header')}<input value={headerText(column)} onChange={event => setHeaders(previous => ({ ...previous, [headerKey(column)]: event.target.value }))} /></label>)}</div></>}
          </>}
        </div>}
        {stored && ['csv', 'excel', 'json-table'].includes(stored.preview.format) && <details>
          <summary>{words('限定本次原报字段（可选）', 'Select source-report columns (optional)')}</summary>
          <label>{words('本次原报字段，每行一个原列名', 'Source report columns, one original name per line')}
            <textarea value={selectedColumns} onChange={event => setColumnDraft({ materialId, names: event.target.value })} /></label>
          <p className="r1-help">{words('留空时审查全部字段。普通来源表始终核对完整原件并保留日期和身份列，只在本次输出中限定业务字段。', 'Leave blank to review all columns. Source reports retain the complete original, date and identity fields.')}</p>
          {stored.preview.table && <p className="r1-help">{words('原表列', 'Original columns')} · {stored.preview.table.columns.map(column => column.name).join(' · ')}</p>}
        </details>}
        <label>{words('目标数据集编号', 'Target dataset ID')}<input required value={datasetId} maxLength={128} onChange={event => setDatasetId(event.target.value)} /></label>
        <details><summary>{words('承接 WFD 已明确拒绝的旧请求（可选）', 'Continue an explicitly rejected WFD request (optional)')}</summary>
          <label>{words('已明确拒绝的原 R1 请求编号', 'Explicitly rejected original R1 request ID')}<input value={priorRequestId} onChange={event => setPriorRequestId(event.target.value)} /></label>
          <p className="r1-help">{words('只承接同一原件、来源授权、数据集与冻结连接的明确拒绝；结果未知的旧请求须按原编号恢复。', 'Only explicit rejections with the same original, source authorization, dataset and frozen connection can be continued. Unknown outcomes require recovery under the original identity.')}</p>
        </details>
      </fieldset>
      <fieldset disabled={locked}><legend>{words('来源与本次交接授权', 'Source and authorization for this handoff')}</legend>
        <div className="r1-grid">{sourceFields.map(([key, label]) => <label key={key}>{label}<input required value={source[key]} maxLength={4096}
          placeholder={key.endsWith('_utc') ? 'YYYY-MM-DDTHH:mm:ssZ' : undefined} onChange={event => onSourceChange({ ...source, [key]: event.target.value })} /></label>)}</div>
        <label>{words('本次正式交接授权', 'Formal handoff authorization')}<select value={source.authorization.status} onChange={event => onSourceChange({ ...source,
          authorization: { status: event.target.value as R1SourceAuthorization['status'], basis: null } })}>
          <option value="unknown">{words('待核：尚未确认授权', 'Unknown: not yet verified')}</option><option value="authorized">{words('有授权：提供明确依据', 'Authorized: provide the basis')}</option><option value="denied">{words('无授权：禁止本次交接', 'Denied: handoff prohibited')}</option></select></label>
        <label>{words('本次授权依据', 'Authorization basis')}<textarea className="r1-constants" rows={3} maxLength={4096} value={source.authorization.basis ?? ''}
          onChange={event => onSourceChange({ ...source, authorization: { ...source.authorization, basis: event.target.value || null } })} /></label>
        <label className="r1-confirm"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />{words('我允许本次在原件及补答证据充分时自动登记定义、加工并发布至已登记连接；收到明确退回后，可在本次授权内据证据修订重送。结果未知时，只沿原编号核对。',
          'I authorize registration, processing and publication to the registered connection when original and answered evidence is sufficient. Explicit returns may be corrected and resubmitted within this authorization. Unknown outcomes must be queried under their original identity.')}</label>
        <button type="submit" className="primary-button" disabled={!ready || !stored || materialLoading || !!materialError || !consent || !datasetId.trim() || !r1SourceReadyForHandoff(source)}>{words('开始自动交接', 'Start automatic handoff')}</button>
      </fieldset>
    </form>}
    {activeId && <div className="r1-material"><p><strong>{words('自动交接编号', 'Automatic handoff ID')}</strong> <code>{activeId}</code></p>
      {loading && !current && <p role="status" className="r1-help">{words('读取原自动交接记录中…', 'Reading the original automatic handoff…')}</p>}
      {current && <><p role="status" aria-live="polite"><strong>{stateLabels[current.state]}</strong> · {current.datasetId}</p><p className="r1-help">{words('原件编号', 'Material ID')} <code>{current.materialId}</code></p>
        {current.waitingReason && <p className="r1-help">{current.waitingReason} <code>{current.waitingForRequestId}</code></p>}
        {current.definitionReview && <div className="r1-proof"><p><strong>{words('WFD 定义预检原回执', 'Original WFD definition-preflight receipt')}</strong></p>
          <p>{current.definitionReview.code} · {current.definitionReview.disposition === 'return_to_bd' ? words('WFD 已明确退回 BD 补充定义', 'WFD explicitly returned the definition to BD') : words('WFD 已找到具备所列字段的候选定义', 'WFD found a candidate definition containing the listed fields')}</p>
          <p>{words('机器请求编号', 'Machine request ID')} <code>{current.definitionReview.machineRequestId}</code></p>
          <p>{words('预检固定快照', 'Preflight fixed snapshot')} <code>{current.definitionReview.snapshotId ?? words('无父快照', 'No parent snapshot')}</code></p>
          {current.definitionReview.missingFields.length > 0 && <p>{words('尚缺字段', 'Missing fields')}: {current.definitionReview.missingFields.join('、')}</p>}
          <p className="r1-help">{words('这是定义预检结果；正式发布仍以实际提交回执和固定读回为准。', 'This is the definition preflight result. Publication requires the actual submission receipt and fixed readback.')}</p>
        </div>}
        {messages(current.localReturn).map((item, i) => <p className={current.localReturn?.scope === 'processing' ? 'r1-help danger-text' : 'r1-help'} key={`local-${i}`}>{words('BD 目录与加工反馈', 'BD catalog and processing feedback')} · {item.code}: {item.message}</p>)}
        {current.definitionAction && <p className="r1-help">{words('本次定义处理', 'Definition action')}: {({ create_from_evidence: '按本次证据新建定义', reuse_same_definition: '沿用相同定义', evolve_additive_definition: '保留旧口径，按新增字段演化定义', evolve_explicit_revision: '按明确修订依据演化定义' } as Record<string, string>)[current.definitionAction] ?? current.definitionAction}</p>}
        {current.wfdRejection != null && <div className="r1-proof"><p><strong>{words('WFD（世界金融数据库）实际拒绝', 'Actual WFD rejection')}</strong></p>
          {messages(current.wfdRejection).length ? messages(current.wfdRejection).map((item, i) => <p key={i}>{item.code}: {item.message}</p>) : <p>{words('原拒绝回执已保存，请展开原记录核对。', 'The original rejection is saved. Expand the original record to inspect it.')}</p>}</div>}
        {messages(current.error).map((item, i) => <p className="r1-help danger-text" key={`error-${i}`}>{item.code}: {item.message}</p>)}
        {current.state === 'recovering' && <p className="r1-help">{words('正在沿冻结连接、原请求和固定快照核对结果，不更换编号或盲重发。', 'The frozen connection, original request and fixed snapshot are being reconciled without replacing the identity or blindly resending.')}</p>}
        {current.state === 'awaiting_answers' && current.questions.length > 0 && <form className="r1-form" onSubmit={event => { event.preventDefault(); const id = current.requestId;
          void action(async () => { accept(await r1AutoApi.answer(id, Object.fromEntries(current.questions.map(question => [question.key, answers[question.key] ?? ''])))); });
        }}><fieldset disabled={busy}><legend>{words('按问题逐项补答', 'Answer each missing fact')}</legend>
          {current.questions.map(question => <label key={question.key}>{question.label}{question.options ? <select required value={answers[question.key] ?? ''}
            onChange={event => setAnswers(previous => ({ ...previous, [question.key]: event.target.value }))}><option value="">{words('请明确选择', 'Choose explicitly')}</option>
            {question.options.map(option => <option key={option} value={option}>{valueLabel(question.key, option)}</option>)}</select>
              : question.key.startsWith('contractRevisionBasis:') ? <textarea required className="r1-constants" rows={3} minLength={8} maxLength={2000} value={answers[question.key] ?? ''}
                onChange={event => setAnswers(previous => ({ ...previous, [question.key]: event.target.value }))} />
                : <input required maxLength={128} value={answers[question.key] ?? ''} onChange={event => setAnswers(previous => ({ ...previous, [question.key]: event.target.value }))} />}</label>)}
          <p className="r1-help">{words('只补充已核实的事实；原件已有明确声明时，补答不能覆盖它。保存后自动继续。', 'Supply verified facts only. Answers cannot override explicit source declarations. Processing continues after saving.')}</p>
          <button type="submit" className="primary-button">{words('保存补答并继续', 'Save answers and continue')}</button>
        </fieldset></form>}
        {current.evidence.length > 0 && <details open={current.state === 'awaiting_answers'}><summary>{words('查看采用的事实与证据', 'Inspect adopted facts and evidence')} · {current.evidence.length}</summary>
          <div className="r1-table-scroll"><table><thead><tr><th>{words('事实', 'Fact')}</th><th>{words('取值', 'Value')}</th><th>{words('依据', 'Evidence')}</th></tr></thead><tbody>{current.evidence.map((item, i) => <tr key={i}><td>{factLabel(item.key)}</td><td>{valueLabel(item.key, item.value)}</td><td>{item.origin === 'file' ? words('保管原件', 'Stored original') : item.origin === 'operator' ? words('本次操作者声明', 'Operator declaration') : words('登记合同', 'Registered contract')}{(item.column || item.field) && <> · <code>{item.column ?? item.field}</code></>}</td></tr>)}</tbody></table></div>
        </details>}
        {current.currentRequest && <div className="database-receipt"><strong>{words('当前固定文档', 'Current frozen document')}</strong><code>{current.currentRequest.requestId}</code>
          <span>{current.currentRequest.rowCount} {words('行', 'rows')} · {current.currentRequest.datasetId} · {current.currentRequest.outputKey}</span><code>{current.currentRequest.documentSha256}</code></div>}
        {current.currentRequest && <R1DuplicateResult request={current.currentRequest} />}
        {completed && <p className="r1-success">{words('WFD 真实行身份已固定读回，BD 已完成回链。', 'Actual WFD row identities have been read back and linked in BD.')}</p>}
        <details><summary>{words('查看冻结来源、任务编号与原回执', 'Inspect frozen source, task IDs and original receipts')}</summary>
          <p className="r1-help">{words('加工计划', 'Processing plans')}: {current.planIds.join('、') || '—'}</p><p className="r1-help">{words('交接原请求', 'Handoff requests')}: {current.requestIds.join('、') || '—'}</p><p className="r1-help">{words('原任务', 'Original tasks')}: {current.taskIds.join('、') || '—'}</p>
          <pre className="database-text-preview">{JSON.stringify({ source: current.source, definitionReview: current.definitionReview, localReturn: current.localReturn, wfdRejection: current.wfdRejection, local: current.currentRequest?.local ?? null }, null, 2)}</pre>
        </details>
      </>}
      <div className="r1-actions"><button type="button" className="text-button" disabled={busy} onClick={() => void action(async () => { accept(await r1AutoApi.get(activeId)); })}>{words('读取原自动交接', 'Read original automatic handoff')}</button>
        {current && (current.state === 'recovering' || current.state === 'stopped') && <button type="button" className="text-button" disabled={busy} onClick={() => void action(async () => { accept(await r1AutoApi.advance(activeId)); })}>{words('继续原自动交接', 'Continue original automatic handoff')}</button>}
        {mayStartAnother && <button type="button" className="text-button" disabled={locked} onClick={() => { chooseRequest(''); setDatasetId(''); setPriorRequestId(''); onChooseMaterial(''); }}>{words('另选原件开始新交接', 'Select another original for a new handoff')}</button>}
      </div>
    </div>}
    <div className="r1-actions"><label>{words('已保存的自动交接编号', 'Saved automatic handoff ID')}<input value={lookupId} onChange={event => setLookupId(event.target.value)} /></label>
      <button type="button" className="text-button" disabled={busy || !lookupId.trim()} onClick={() => void action(async () => {
        const view = await r1AutoApi.get(lookupId.trim()); chooseRequest(view.requestId); accept(view);
      })}>{words('按编号读取自动交接', 'Read automatic handoff by ID')}</button>
      <button type="button" className="text-button" disabled={busy} onClick={() => void action(async () => { setRecent(await r1AutoApi.list()); })}>{words('刷新自动交接列表', 'Refresh automatic handoffs')}</button></div>
    <p className="r1-help">{words('刷新和重开仅恢复原编号并读取状态，后台任务继续；不会创建新请求。', 'Refresh and reopening restore the original ID and read its state while background work continues. They never create another request.')}</p>
    {recent.map(item => <button type="button" className="database-row database-row--button" key={item.requestId} disabled={busy} onClick={() => void action(async () => {
      const view = await r1AutoApi.get(item.requestId); chooseRequest(view.requestId); accept(view);
    })}><span>{item.requestId}</span><span>{stateLabels[item.state]}</span></button>)}
  </section></>;
}
