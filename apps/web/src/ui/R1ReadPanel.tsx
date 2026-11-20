import { useEffect, useRef, useState, type Ref } from 'react';
import type { R1ProductDiscovery, R1ProductRead, R1ProductReadInput, R1SnapshotStatus } from '../../../../contracts/r1-contracts';
import { isExplicitUtcInstant } from '../../../../contracts/financial-value';
import { RequestError } from '../api';
import { r1Api } from '../r1-api';
import { localDataGeneration, localDataRevision, subscribeLocalDataRevoked } from '../local-data-context';
import { buildR1ReadHistory, R1HistoryError, sameR1ReadConnection } from '../r1-read-history';
import { PageButton, PageEmpty, PageField, PageHeading } from './PageUI';
import { recordIdentity, type RecordIdentity } from '../record-evidence-api';
import { RecordEvidencePanel } from './RecordEvidencePanel';
import { ErrorNote, errorDetail, useWords } from './Controls';
import { DetailFacts } from './ObjectDetailPanel';

type Pair = readonly [string, string];
type Words = ReturnType<typeof useWords>;
type HistoryMode = NonNullable<R1ProductReadInput['historyMode']>;

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const json = (value: unknown) => JSON.stringify(value, null, 2);
const modeLabels: Record<string, Pair> = {
  snapshot_contents: ['快照内容', 'Snapshot contents'], market_known_at: ['市场当时已知', 'Market known at'], system_held_at: ['本实例当时持有', 'This instance held at'],
};
const stageLabels: Record<string, Pair> = { acquired: ['已取得', 'Acquired'], custodied: ['已保管', 'Custodied'], published_readable: ['正式可读', 'Published readable'] };
const stateLabels: Record<string, Pair> = {
  reported_zero: ['报告为零', 'Reported zero'], unknown: ['未知', 'Unknown'], not_applicable: ['不适用', 'Not applicable'],
  missing_unknown: ['缺失，原因未知', 'Missing, reason unknown'], not_disclosed: ['未披露', 'Not disclosed'],
};
const unitLabels: Record<string, Pair> = {
  count: ['计数', 'Count'], ratio: ['比率', 'Ratio'], percent: ['%', '%'],
  cny: ['人民币元', 'CNY'], cny_per_share: ['元/股', 'CNY/share'], share: ['股', 'Shares'],
};
const productKinds: Record<string, Pair> = {
  scalar_rows: ['单项数值', 'Single measure'], tabular_rows: ['表格数据', 'Tabular data'],
  event_records: ['事件记录', 'Event records'], relation_edges: ['关系记录', 'Relationship records'],
};
const readErrors: Record<string, Pair> = {
  INSTANCE_HOLDING_UNKNOWN: ['缺少所选阶段的持有证据。', 'There is no holding evidence for the selected stage.'],
  INSTANCE_HOLDING_NOT_YET_AVAILABLE: ['截至所选时间，本实例还未达到所选阶段。', 'This instance had not reached the selected stage by the cutoff.'],
  R1_READ_HISTORY_METADATA_UNSUPPORTED: ['固定快照中的定义或字段缺少适用的历史证据，无法按所选视角读取。', 'The snapshot definitions or fields lack evidence for the selected historical view.'],
};
const pick = (labels: Record<string, Pair>, key: unknown) => typeof key === 'string' && Object.hasOwn(labels, key) ? labels[key] : undefined;
const utc = (value: unknown) => typeof value === 'string' && value ? value.replace('T', ' ').replace(/Z$/u, ' UTC') : '';
function fail(code: string, chinese: string, english: string): never { throw new R1HistoryError(code, chinese, english); }
const connectionChanged = () => fail('R1_READ_CONNECTION_CHANGED', '数据连接在查询期间发生变化，结果未显示；请重新载入数据。',
  'The data connection changed during the query, so nothing was shown. Reload the data.');
const snapshotChanged = () => fail('R1_READ_SNAPSHOT_CHANGED', '返回内容与所查快照或产品不一致，结果未显示。',
  'The response does not match the requested snapshot or product, so nothing was shown.');

// Only labels from the fixed source-report contract have this reversible encoding.
function sourceLabel(code: string, prefix: string) {
  if (!code.startsWith(prefix)) return code;
  try {
    const encoded = code.slice(prefix.length).replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
    const original = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return original && !/[\u0000-\u001f\u007f]/u.test(original) ? original : code;
  } catch { return code; }
}

function sourceReportIdentity(product: Record<string, unknown>) {
  const declaration = object(product.declaration);
  const identity = object(object(declaration.semantic_context).identity);
  if (!String(declaration.semantic_code).startsWith('source_report.')
    || !String(identity.identity_resolution_rule).startsWith('source_reported_date_and_identity_columns:')) return null;
  return identity;
}

function reportSeries(product: Record<string, unknown>) {
  const scope = sourceReportIdentity(product)?.alias_scope;
  if (typeof scope !== 'string') return '';
  return /^来源原报表系列「([^\u0000-\u001f\u007f]+)」$/u.exec(scope)?.[1] ?? '';
}

function readableField(code: string, words: Words) {
  if (code === 'amount') return words('数值', 'amount');
  if (code === 'reading') return words('读数', 'reading');
  return /^(?:[a-z]{2,})(?:_[a-z]{2,}){0,2}$/u.test(code) && code.length <= 28 ? code.replaceAll('_', ' ') : '';
}

const initialProjection = (fields: string[] | undefined, limit: number) => fields?.slice(0, Math.min(4, limit)) ?? [];

function productLabels(discovery: R1ProductDiscovery, bindings: Map<unknown, Record<string, unknown>[]>, words: Words) {
  const base = discovery.selections.map(item => {
    const contracts = bindings.get(item.productId) ?? [];
    const series = new Set(contracts.map(reportSeries));
    if (series.size === 1 && !series.has('')) return [...series][0]!;
    if (contracts.length > 0 && contracts.every(sourceReportIdentity)) {
      const labels = item.fields.map(code => sourceLabel(code, 'src_')).filter((name, index) => name !== item.fields[index]).slice(0, 2);
      return labels.length > 0 ? labels.join(words('、', ', ')) : words('来源原报表', 'Source report');
    }
    return words(...(pick(productKinds, item.payloadKind) ?? ['数据产品', 'Data product']));
  });
  const baseTotals = new Map<string, number>();
  for (const label of base) baseTotals.set(label, (baseTotals.get(label) ?? 0) + 1);
  const contextual = discovery.selections.map((item, index) => {
    const label = base[index]!;
    const contracts = bindings.get(item.productId) ?? [];
    if ((baseTotals.get(label) ?? 0) < 2 || contracts.length > 0 && contracts.every(sourceReportIdentity)) return label;
    const fields = item.fields.map(code => readableField(code, words)).filter(Boolean).slice(0, 3);
    return fields.length ? `${label} · ${fields.join(words('、', ', '))}` : label;
  });
  const totals = new Map<string, number>(), seen = new Map<string, number>();
  for (const label of contextual) totals.set(label, (totals.get(label) ?? 0) + 1);
  return new Map(discovery.selections.map((item, index) => {
    const label = contextual[index]!, ordinal = (seen.get(label) ?? 0) + 1;
    seen.set(label, ordinal);
    const text = (totals.get(label) ?? 0) > 1 ? `${label} · ${ordinal}` : label;
    return [item.productId, item.readable ? text : `${text} ${words('（不可读）', '(unavailable)')}`] as const;
  }));
}

/** Independent of the local preparation/receipt editor; all data comes from fresh fixed WFD reads. */
export function R1ReadPanel({ ready, ref }: { ready: boolean; ref?: Ref<HTMLElement> }) {
  const words = useWords();
  const [snapshotId, setSnapshotId] = useState('');
  const [status, setStatus] = useState<R1SnapshotStatus | null>(null);
  const [discovery, setDiscovery] = useState<R1ProductDiscovery | null>(null);
  const [source, setSource] = useState<'' | 'empty' | 'current' | 'explicit'>('');
  const [productId, setProductId] = useState('');
  const [projection, setProjection] = useState<string[]>([]);
  const [result, setResult] = useState<R1ProductRead | null>(null);
  const [evidenceRun, setEvidenceRun] = useState(0);
  const [evidenceIdentity, setEvidenceIdentity] = useState<RecordIdentity | null>(null);
  const [pageIndex, setPageIndex] = useState(1);
  const [historyMode, setHistoryMode] = useState<HistoryMode>('snapshot_contents');
  const [at, setAt] = useState(''), [usableStage, setUsableStage] = useState('');
  const [lastRequest, setLastRequest] = useState<R1ProductReadInput | null>(null);
  const epoch = useRef(0), active = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; code: string } | null>(null);
  useEffect(() => {
    const clearScope = () => {
      epoch.current++; active.current = false; setBusy(false); setStatus(null); setSource(''); setSnapshotId('');
      setDiscovery(null); setProductId(''); setProjection([]); setEvidenceIdentity(null); setResult(null); setLastRequest(null); setPageIndex(1); setError(null);
    };
    clearScope();
    const unsubscribe = subscribeLocalDataRevoked(clearScope);
    return () => { epoch.current++; active.current = false; unsubscribe(); };
  }, [ready]);

  const selected = discovery?.selections.find(item => item.productId === productId);
  const bindings = new Map<unknown, Record<string, unknown>[]>();
  for (const product of discovery?.products ?? []) {
    const versions = bindings.get(product.product_id);
    if (versions) versions.push(product);
    else bindings.set(product.product_id, [product]);
  }
  const contracts = bindings.get(productId) ?? [];
  const sourceReport = contracts.length > 0 && contracts.every(sourceReportIdentity);
  const fieldLabel = (code: string) => {
    const original = sourceReport ? sourceLabel(code, 'src_') : code;
    if (original !== code) return original;
    if (code === 'value_decimal' && selected?.payloadKind === 'scalar_rows') return words('数值', 'Value');
    if (!sourceReport) {
      const label = readableField(code, words);
      if (label) return label;
    }
    const index = (selected?.fields.indexOf(code) ?? -1) + 1;
    return index > 0 ? words(`字段 ${index}`, `Field ${index}`) : words('声明字段', 'Declared field');
  };
  const labels = discovery ? productLabels(discovery, bindings, words) : new Map<string, string>();
  const maxFields = discovery?.limits.maxFields ?? 64;
  const fieldsReady = !!selected?.readable && projection.length > 0 && projection.length <= maxFields;
  const trustedHolding = status && discovery && sameR1ReadConnection(status.connection, discovery.connection) ? status.holdingInstance : null;
  const data = result?.result, page = object(data?.page);
  const rows = Array.isArray(data?.rows) ? data.rows.map(object) : [];
  const fields = Array.isArray(data?.fields) ? data.fields.filter((value): value is string => typeof value === 'string') : [];
  const diagnostics = Array.isArray(data?.diagnostics) ? data.diagnostics : [];
  const fieldGaps = diagnostics.filter(item => object(item).code === 'FIELD_NOT_DEFINED_IN_ROW_CONTRACT');
  const resultSelection = result ? discovery?.selections.find(item => item.productId === result.productId) : undefined;
  const identities = rows.map(row => result && resultSelection && result.historyMode === 'snapshot_contents'
    ? recordIdentity(resultSelection.datasetId, result.productId, result.snapshotId, row.record_ref) : null);
  const canVerify = identities.some(Boolean);
  const total = typeof page.total_rows === 'number' ? page.total_rows : null, lastPage = page.has_more !== true;

  const stateText = (code: unknown) => { const label = pick(stateLabels, code) ?? (['不支持的状态', 'Unsupported state'] as const); return words(label[0], label[1]); };
  const perspective = (mode: unknown, cutoff: unknown, stage: unknown) => {
    const parts = [pick(modeLabels, mode), mode === 'system_held_at' ? pick(stageLabels, stage) : undefined]
      .flatMap(label => label ? [words(label[0], label[1])] : []);
    if (mode !== 'snapshot_contents' && utc(cutoff)) parts.push(words('截至 ', 'as of ') + utc(cutoff));
    return parts.join(' · ');
  };
  const fieldNote = !selected?.readable ? '' : !selected.fields.length ? words('此产品没有可显示的字段。', 'This product has no fields to show.')
    : !projection.length ? words('请在“选择显示字段”中至少选择一项。', 'Choose at least one field in “Choose fields”.')
    : projection.length > maxFields ? words(`最多同时显示 ${maxFields} 个字段，当前已选 ${projection.length} 个；请在“选择显示字段”中减少。`,
      `Up to ${maxFields} fields can be shown at once; ${projection.length} are selected. Reduce them in “Choose fields”.`) : '';

  const changed = () => { setEvidenceIdentity(null); setResult(null); setLastRequest(null); setPageIndex(1); setError(null); };
  const reset = () => { setDiscovery(null); setSource(''); setProductId(''); setProjection([]); changed(); };
  const show = (found: R1ProductDiscovery, from: 'current' | 'explicit') => {
    const only = found.selections.length === 1 ? found.selections[0] : undefined;
    setDiscovery(found); setSource(from); setProductId(only?.productId ?? ''); setProjection(initialProjection(only?.fields, found.limits.maxFields));
  };
  const act = async (work: (current: () => boolean) => Promise<void>) => {
    if (active.current || !ready) return;
    active.current = true; const requestEpoch = ++epoch.current;
    const generation = localDataGeneration(), revision = localDataRevision();
    const current = () => epoch.current === requestEpoch && generation === localDataGeneration() && revision === localDataRevision();
    setBusy(true); setError(null);
    try { await work(current); }
    catch (caught) {
      if (current()) {
        const code = caught instanceof RequestError || caught instanceof R1HistoryError ? caught.code : null;
        const label = pick(readErrors, code);
        const text = caught instanceof R1HistoryError ? words(caught.message, caught.english) : label ? words(...label)
          : words('查询未完成。请核对数据连接和查询条件。', 'The query could not complete. Check the connection and query settings.');
        setError({ text, code: [code, errorDetail(caught)].filter(Boolean).join(': ') });
      }
    }
    finally { if (epoch.current === requestEpoch) { active.current = false; setBusy(false); } }
  };
  const loadCurrent = () => act(async current => {
    reset(); setStatus(null);
    const fresh = await r1Api.snapshotStatus();
    if (!current()) return;
    setStatus(fresh);
    if (fresh.empty && fresh.snapshotId === null) { setSource('empty'); return; }
    if (fresh.empty || !fresh.snapshotId) fail('R1_READ_SNAPSHOT_UNAVAILABLE', '当前快照状态不一致，无法确定要查看的数据。',
      'The current snapshot status is inconsistent, so the data to view cannot be determined.');
    const fixed = fresh.snapshotId, found = await r1Api.discoverProducts(fixed);
    if (!current()) return;
    if (found.snapshotId !== fixed) snapshotChanged();
    if (!sameR1ReadConnection(found.connection, fresh.connection)) connectionChanged();
    show(found, 'current');
  });
  const loadExplicit = () => act(async current => {
    const fixed = snapshotId.trim();
    reset();
    const found = await r1Api.discoverProducts(fixed);
    if (!current()) return;
    if (found.snapshotId !== fixed) snapshotChanged();
    setSnapshotId(fixed); show(found, 'explicit');
  });
  const read = (cursor: string | null, nextPage: number) => act(async current => {
    if (!discovery || !fieldsReady) return;
    setEvidenceIdentity(null); setResult(null);
    let input: R1ProductReadInput;
    if (cursor && lastRequest) input = { ...lastRequest, cursor };
    else {
      let holding = historyMode === 'system_held_at' ? status : null;
      if (historyMode === 'system_held_at' && !(holding && sameR1ReadConnection(holding.connection, discovery.connection))) {
        holding = await r1Api.snapshotStatus();
        if (!current()) return;
        if (!sameR1ReadConnection(holding.connection, discovery.connection)) connectionChanged();
        setStatus(holding);
      }
      input = { snapshotId: discovery.snapshotId, productId, fields: projection.slice(), cursor: null,
        ...buildR1ReadHistory({ historyMode, ...(historyMode !== 'snapshot_contents' ? { at } : {}),
          ...(historyMode === 'system_held_at' ? { usableStage } : {}) }, holding) };
    }
    const response = await r1Api.readProduct(input);
    if (!current()) return;
    if (!sameR1ReadConnection(response.connection, discovery.connection)) connectionChanged();
    if (response.snapshotId !== input.snapshotId || response.productId !== input.productId) snapshotChanged();
    setResult(response); setLastRequest(input); setPageIndex(nextPage);
  });

  const timeCell = (time: Record<string, unknown>) => {
    const start = time.earliest_utc, end = time.latest_exclusive_utc;
    if (time.status !== 'known' || !isExplicitUtcInstant(start) || !isExplicitUtcInstant(end) || Date.parse(start) >= Date.parse(end))
      return <span className="r1-cell-state">{time.status === 'known' || time.status === undefined ? words('时间未知', 'Time unknown') : stateText(time.status)}</span>;
    const utcDates = time.source_timezone === 'UTC' && start.slice(11) === '00:00:00Z' && end.slice(11) === '00:00:00Z';
    const year = start.slice(0, 4);
    if (utcDates && start.slice(5, 10) === '01-01' && end.slice(5, 10) === '01-01' && Number(end.slice(0, 4)) === Number(year) + 1)
      return words(`${year} 年`, year);
    if (utcDates && Date.parse(end) - Date.parse(start) === 86_400_000) return <time dateTime={start}>{start.slice(0, 10)}</time>;
    return <><time dateTime={start}>{utcDates ? start.slice(0, 10) : utc(start)}</time>
      <small>{words('至 ', 'Until ')}<time dateTime={end}>{utcDates ? end.slice(0, 10) : utc(end)}</time> {words('（不含）', '(exclusive)')}{utcDates && ' UTC'}</small></>;
  };
  const cellUnit = (cell: Record<string, unknown>) => {
    const unit = object(cell.unit), code = unit.unit_code;
    if (typeof code !== 'string' || unit.resolved !== true) return null;
    const original = sourceReport ? sourceLabel(code, 'srcunit_') : code;
    const label = pick(unitLabels, code.toLowerCase());
    const text = label ? words(...label) : original !== code ? original : '';
    return text ? { text, key: JSON.stringify([code, unit.digest ?? null, cell.data_type ?? null]) } : null;
  };
  const fieldUnits = new Map<string, string>();
  for (const field of fields) {
    const cells = rows.map(row => object(object(row.values)[field])).filter(cell => cell.value_state === 'valid_value' || cell.value_state === 'reported_zero');
    const first = cellUnit(cells[0] ?? {});
    if (first && cells.every(cell => cellUnit(cell)?.key === first.key)) fieldUnits.set(field, first.text);
  }
  const valueCell = (values: Record<string, unknown>, field: string) => {
    if (!Object.hasOwn(values, field)) return <span className="r1-cell-state">{words('未返回', 'Not returned')}</span>;
    const cell = object(values[field]), state = cell.value_state, value = cell.value, unitData = object(cell.unit);
    const code = unitData.unit_code;
    const numeric = cell.data_type === 'decimal' || cell.data_type === 'integer' || typeof value === 'number';
    let unit = '';
    const dateLabel = code === 'date' && unitData.resolved === true && object(unitData.definition).dimension === 'date';
    if (!fieldUnits.has(field) && code !== 'not_applicable' && !dateLabel) {
      const known = cellUnit(cell);
      if (known) unit = known.text;
      else if (numeric || typeof code === 'string' && code.length > 0)
        unit = unitData.resolved === true ? words('单位见读取详情', 'See read details for unit') : words('单位未核实', 'Unit unverified');
    }
    const unitNote = unit && (state === 'valid_value' || state === 'reported_zero') ? <small>{unit}</small> : null;
    const text = state !== 'valid_value' && state !== 'reported_zero' ? null : typeof value === 'number' ? String(value) : typeof value === 'string' && value ? value
      : typeof value === 'boolean' ? words(value ? '是' : '否', value ? 'Yes' : 'No') : null;
    const note = state !== 'valid_value' ? stateText(state) : value === '' ? words('空文本', 'Empty text')
      : value === null || value === undefined ? words('无值', 'No value') : words('复合值，见“读取详情”', 'Composite value; see Read details');
    return <>{text === null ? <span className="r1-cell-state">{note}</span> : <span className="r1-cell-value">{text}</span>}
      {text !== null && state === 'reported_zero' && <small>{note}</small>}{unitNote}</>;
  };
  const fact = (label: string, value: string) => ({ label, value });
  const facts = discovery ? [
    fact(words('快照编号', 'Snapshot ID'), discovery.snapshotId),
    fact(words('载入方式', 'Loaded by'), source === 'explicit' ? words('指定快照编号', 'Specified snapshot ID') : words('当前数据', 'Current data')),
    fact(words('连接', 'Connection'), JSON.stringify(discovery.connection)),
    ...(trustedHolding ? [fact(words('持有实例', 'Holding instance'), `${trustedHolding.instanceId} · ${trustedHolding.bindingSource}`)] : []),
    ...(selected ? [fact(words('产品编号', 'Product ID'), selected.productId), fact(words('数据集', 'Dataset'), selected.datasetId),
      fact(words('主体', 'Subject'), JSON.stringify(selected.subject)), fact(words('载荷类型', 'Payload kind'), selected.payloadKind),
      fact(words('声明字段', 'Declared fields'), selected.fields.join(', ') || '—'),
      ...(selected.reason ? [fact(words('不可读原因', 'Unreadable reason'), selected.reason)] : [])] : []),
    ...(result ? [fact(words('读取回显', 'Read echo'), [result.historyMode, object(data?.knowledge_cutoff).earliest_utc, data?.held_scope, data?.usable_stage]
      .map(value => typeof value === 'string' ? value : '—').join(' · '))] : []),
  ] : [];
  const limits = discovery?.limits;

  return <section className="r1-stage r1-read-panel" ref={ref} tabIndex={-1}
    aria-label={words('WFD 持久数据查询', 'WFD persisted data query')} aria-busy={busy}>
    <PageHeading level="h3" title={words('数据查询', 'Data query')} />
    {!ready && <PageEmpty state="unavailable">{words('数据连接暂不可用；请先配置并核对 data_only（仅数据）连接。',
      'The data connection is unavailable; configure and verify a data_only connection first.')}</PageEmpty>}
    <div className="r1-read-toolbar">
      <PageButton variant="primary" disabled={busy || !ready} onClick={() => void loadCurrent()}>{words('查看当前数据', 'View current data')}</PageButton>
      {discovery && <p className="r1-read-source" role="status" data-source={source}>{source === 'explicit'
        ? words(`已载入指定快照 · ${discovery.selections.length} 个产品`, `Specified snapshot loaded · ${discovery.selections.length} products`)
        : words(`已载入当前数据 · ${discovery.selections.length} 个产品`, `Current data loaded · ${discovery.selections.length} products`)}</p>}
    </div>
    <details className="r1-read-more"><summary>{words('按快照编号查询', 'Query by snapshot ID')}</summary>
      <div className="r1-snapshot-tools">
        <PageField label={words('快照编号', 'Snapshot ID')}>
          <input aria-label={words('快照编号', 'Snapshot ID')} value={snapshotId} maxLength={128} disabled={busy || !ready} placeholder="s_…" onChange={event => setSnapshotId(event.target.value)} />
        </PageField>
        <PageButton disabled={busy || !ready || !snapshotId.trim()} onClick={() => void loadExplicit()}>{words('查询此快照', 'Query this snapshot')}</PageButton>
      </div>
    </details>
    {busy && <PageEmpty state="loading">{words('正在读取…', 'Reading…')}</PageEmpty>}
    {error && <ErrorNote detail={error.code === error.text ? null : error.code}>{error.text}</ErrorNote>}
    {source === 'empty' && <PageEmpty>{words('当前实例已初始化，但还没有保存任何数据。', 'This instance is initialized but has no saved data yet.')}</PageEmpty>}
    {discovery && !discovery.selections.length && <PageEmpty>{words('这个快照里没有可查看的产品。', 'This snapshot has no products to view.')}</PageEmpty>}
    {discovery && discovery.selections.length > 0 && <div className="r1-query-block">
      <PageField label={words('产品', 'Product')}>
        <select aria-label={words('产品', 'Product')} value={productId} disabled={busy} onChange={event => {
          const id = event.target.value;
          setProductId(id); setProjection(initialProjection(discovery.selections.find(item => item.productId === id)?.fields, maxFields)); changed();
        }}>
          <option value="">{words('请选择产品', 'Choose a product')}</option>
          {discovery.selections.map(item => <option key={item.productId} value={item.productId}>{labels.get(item.productId)}</option>)}
        </select>
      </PageField>
      {selected && !selected.readable && <p className="r1-help danger-text">{words('此产品暂时无法读取；原因见“读取详情”。', 'This product cannot be read; see Read details for the reason.')}</p>}
      {selected?.readable && selected.fields.length > 0 && <details className="r1-read-more">
        <summary><span>{words('选择显示字段', 'Choose fields')}</span><span className="r1-read-chip">{words(`已选 ${projection.length}/${selected.fields.length}`,
          `${projection.length}/${selected.fields.length} selected`)}</span></summary>
        <fieldset className="r1-read-fields" aria-label={words('选择显示字段', 'Choose fields')}>
          <p className="r1-help">{words(`可自行增减字段，每次最多 ${maxFields} 项。`, `Choose up to ${maxFields} fields per query.`)}</p>
          <div className="r1-read-field-options">{selected.fields.map(field => <label key={field}><input type="checkbox" disabled={busy}
            checked={projection.includes(field)} onChange={event => {
              setProjection(current => event.target.checked ? [...current, field].sort() : current.filter(value => value !== field)); changed();
            }} /><span>{fieldLabel(field)}</span></label>)}</div>
        </fieldset>
      </details>}
      <details className="r1-read-more">
        <summary><span>{words('历史视角', 'Historical view')}</span><span className="r1-read-chip">{perspective(historyMode, at, usableStage)}</span></summary>
        <div className="r1-grid">
          <PageField label={words('视角', 'View')}>
            <select aria-label={words('历史视角', 'Historical view')} value={historyMode} disabled={busy || !ready} onChange={event => {
              setHistoryMode(event.target.value as HistoryMode); setAt(''); setUsableStage(''); changed();
            }}>
              {Object.entries(modeLabels).map(([value, label]) => <option key={value} value={value}>{words(label[0], label[1])}</option>)}
            </select>
          </PageField>
          {historyMode !== 'snapshot_contents' && <PageField label={words('截止时间（UTC，精确到秒）', 'Cutoff (UTC, to the second)')}
            hint={words('格式 YYYY-MM-DDTHH:mm:ssZ；不自动补全日期、时区或当前时间。', 'Format YYYY-MM-DDTHH:mm:ssZ; no date, timezone or current time is inferred.')}>
            <input aria-label={words('截止时间（UTC，精确到秒）', 'Cutoff (UTC, to the second)')} value={at} maxLength={20} placeholder="YYYY-MM-DDTHH:mm:ssZ" disabled={busy || !ready} onChange={event => { setAt(event.target.value); changed(); }} />
          </PageField>}
          {historyMode === 'system_held_at' && <PageField label={words('持有阶段', 'Holding stage')} hint={trustedHolding
            ? words('已取得当前连接的实例绑定。', 'The instance binding for this connection is available.')
            : words('读取时核对当前连接的实例绑定；无法核对则拒绝读取。', 'The instance binding is checked when reading; the read is refused if it cannot be verified.')}>
            <select aria-label={words('持有阶段', 'Holding stage')} value={usableStage} disabled={busy || !ready} onChange={event => { setUsableStage(event.target.value); changed(); }}>
              <option value="">{words('请选择阶段', 'Choose a stage')}</option>
              {Object.entries(stageLabels).map(([value, label]) => <option key={value} value={value}>{words(label[0], label[1])}</option>)}
            </select>
          </PageField>}
        </div>
        {historyMode !== 'snapshot_contents' && <p className="r1-help">{words('按所选截止时间核对当时是否可知；缺少证据时给出诊断或拒绝，不会改用最新数据。',
          'Eligibility is checked at the selected cutoff; missing evidence yields a diagnostic or refusal, never current data.')}
          {historyMode === 'system_held_at' && ' ' + words('还须证明本实例当时已达到所选阶段。', 'This instance must also be shown to have reached the selected stage.')}</p>}
      </details>
      <div className="r1-read-actions">
        <PageButton variant="primary" disabled={busy || !fieldsReady} onClick={() => void read(null, 1)}>{words('查看数据', 'View data')}</PageButton>
        {fieldNote && <p className="r1-help r1-caution">{fieldNote}</p>}
      </div>
    </div>}
    {result && <div className="r1-read-result r1-query-block" aria-label={words('WFD 实际读取结果', 'Actual WFD read result')}>
      {result.historyMode !== 'snapshot_contents' && <p className="r1-help">{words('已应用：', 'Applied: ')}
        {perspective(result.historyMode, object(data?.knowledge_cutoff).earliest_utc, data?.usable_stage)}</p>}
      {!rows.length && <PageEmpty>{diagnostics.length
        ? words(`本页没有可显示的行；WFD 给出了 ${diagnostics.length} 条诊断，见“读取诊断”。`, `No rows to show on this page; WFD returned ${diagnostics.length} diagnostics, see Read diagnostics.`)
        : words('没有符合条件的数据行，也没有诊断。', 'No matching data rows and no diagnostics.')}</PageEmpty>}
      {rows.length > 0 && <div className="r1-table-scroll" role="region" tabIndex={0} aria-label={words('数据表', 'Data table')}>
        <table><caption>{labels.get(result.productId) ?? words('数据表', 'Data table')}</caption>
          <thead><tr><th scope="col">{words('业务时间', 'Business time')}</th>{fields.map(field => {
            const label = fieldLabel(field), unit = fieldUnits.get(field);
            const includesUnit = unit && (label.endsWith(`（${unit}）`) || label.endsWith(`(${unit})`));
            return <th scope="col" key={field}>{label}{unit && !includesUnit && <small>{unit}</small>}</th>;
          })}
            {canVerify && <th scope="col">{words('原件', 'Original')}</th>}</tr></thead>
          <tbody>{rows.map((row, index) => { const identity = identities[index], values = object(row.values); return <tr key={index}>
            <td>{timeCell(object(row.business_time))}</td>
            {fields.map(field => <td key={field}>{valueCell(values, field)}</td>)}
            {canVerify && <td>{identity ? <PageButton data-record-id={identity.recordId} onClick={() => { setEvidenceRun(value => value + 1); setEvidenceIdentity(identity); }}>
              {words('核对原件', 'Verify original')}</PageButton> : <span className="r1-cell-state">—</span>}</td>}
          </tr>; })}</tbody>
        </table>
      </div>}
      {pageIndex === 1 && lastPage && total === rows.length
        ? rows.length > 0 && <p className="r1-help">{words(`共 ${rows.length} 行`, `${rows.length} rows`)}</p>
        : <div className="r1-pager">
        <p className="r1-help">{words(`第 ${pageIndex} 页 · 本页 ${rows.length} 行${total === null ? '' : ` · 共 ${total} 行`}${lastPage ? ' · 已到末页' : ''}`,
          `Page ${pageIndex} · ${rows.length} rows${total === null ? '' : ` · ${total} total`}${lastPage ? ' · last page' : ''}`)}</p>
        <PageButton disabled={busy || page.has_more !== true || typeof page.next_cursor !== 'string' || !lastRequest}
          onClick={() => void read(page.next_cursor as string, pageIndex + 1)}>{words('下一页', 'Next page')}</PageButton>
      </div>}
      {fieldGaps.length > 0 && <p className="r1-help r1-caution">{words(`${fieldGaps.length} 条字段覆盖诊断。部分记录的定义缺少所选字段，可改选共有字段后重查。`,
        `${fieldGaps.length} field-coverage diagnostics. Some record definitions omit selected fields. Try querying the shared fields.`)}</p>}
      {result.historyMode === 'snapshot_contents' && evidenceIdentity && <RecordEvidencePanel key={JSON.stringify([result.snapshotId, result.productId, evidenceIdentity, evidenceRun])}
        identity={evidenceIdentity} snapshotId={result.snapshotId} connection={result.connection} />}
      {diagnostics.length > 0 && <details className="r1-read-more"><summary>{words('读取诊断', 'Read diagnostics')} · {diagnostics.length}</summary>
        <pre className="database-text-preview">{json(diagnostics)}</pre></details>}
    </div>}
    {discovery && limits && <details className="r1-read-more r1-read-details"><summary>{words('读取详情', 'Read details')}</summary>
      <DetailFacts items={facts} />
      {!discovery.selections.length && <p className="r1-help">{words('索引分钟分区须按原批次回执中的定位信息读取。', 'Indexed minute partitions require the locator from the original batch receipt.')}</p>}
      <details><summary>{words('查询预算', 'Query budget')}</summary>
        <p className="r1-help">{words(`每页 ${limits.pageSize} 行；单次最多预扫 ${limits.maxScanRows} 行、${limits.maxScanBytes / 1048576} MiB，完整结果上限 ${limits.maxResultBytes / 1048576} MiB，最长等待 ${limits.timeoutMs / 1000} 秒。超限会报错，不会截断为成功。`,
          `${limits.pageSize} rows per page; at most ${limits.maxScanRows} rows and ${limits.maxScanBytes / 1048576} MiB scanned per call, ${limits.maxResultBytes / 1048576} MiB per complete result and ${limits.timeoutMs / 1000} seconds waiting. Budget failures are errors, never truncated success.`)}</p>
      </details>
      <details><summary>{words('公开定义与合同', 'Definitions and contracts')}</summary><pre className="database-text-preview">{json(discovery.products)}</pre></details>
      {result && <details><summary>{words('本页原始结果', 'Raw page result')}</summary><pre className="database-text-preview">{json(data)}</pre></details>}
    </details>}
  </section>;
}
