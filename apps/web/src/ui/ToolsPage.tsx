import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, Play, RefreshCw, Search } from 'lucide-react';
import type { ToolLibraryParameter, ToolLibraryTool, ToolLibraryView } from '../../../../contracts/tool-library';
import type { AlgorithmCallRequest, AlgorithmCatalogView, AlgorithmFieldMapping, AlgorithmMethodId, AlgorithmTaskView, ManagedTableSummary } from '../../../../modules/financial/algorithm-types';
import { RequestError, request } from '../api';
import { loadAlgorithmCatalog, readAlgorithmCall, submitAlgorithmCall } from '../algorithm-api';
import { ErrorNote, errorDetail, useWords } from './Controls';
import { usePreferences } from './Preferences';
import { MorphIcon } from './MorphIcon';
import './ToolsPage.css';

type Words = (zh: string, en: string) => string;
type FormState = {
  tableId: string; timestamp: string; close: string; open: string; high: string; low: string; availableAt: string;
  availability: 'column' | 'bar_close'; closeTime: string; period: string;
  subject: string; currency: string; timezone: string; adjustment: 'unadjusted' | 'as_stored'; basis: string;
  calendar: 'not_verified' | 'dense'; synthetic: boolean;
};
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'needs_review', 'interrupted', 'blocked', 'awaiting_review']);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function isParameter(value: unknown): value is ToolLibraryParameter {
  return isRecord(value) && typeof value.key === 'string' && typeof value.label === 'string'
    && typeof value.defaultValue === 'number' && typeof value.min === 'number' && typeof value.max === 'number';
}
function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((line) => typeof line === 'string');
}
function isTool(value: unknown): value is ToolLibraryTool {
  return isRecord(value) && typeof value.id === 'string' && value.id.length > 0
    && typeof value.title === 'string' && typeof value.description === 'string'
    && ['ready', 'blocked', 'unavailable'].includes(String(value.status))
    && (value.reason === null || typeof value.reason === 'string')
    && Array.isArray(value.parameters) && value.parameters.every(isParameter)
    && Array.isArray(value.outputFields) && value.outputFields.every((field) => typeof field === 'string')
    && Array.isArray(value.limitations) && value.limitations.every((line) => typeof line === 'string')
    && (value.requiredInputs === undefined || isStringList(value.requiredInputs))
    && (value.missing === undefined || isStringList(value.missing))
    && (value.sources === undefined || isStringList(value.sources));
}
function asView(value: unknown): ToolLibraryView {
  if (!isRecord(value) || !Array.isArray(value.tools) || !['ready', 'unavailable'].includes(String(value.status))
    || !(value.reason === null || typeof value.reason === 'string') || !value.tools.every(isTool)) {
    throw new Error('数据算法返回的数据与当前接口契约不一致。');
  }
  return value as unknown as ToolLibraryView;
}
function toolStatusLabel(status: ToolLibraryTool['status'], words: Words): string {
  if (status === 'ready') return words('已启用', 'Enabled');
  if (status === 'blocked') return words('受阻', 'Blocked');
  return words('不可用', 'Unavailable');
}
function toolStateLabel(state: ToolLibraryTool['state'], words: Words): string | null {
  if (state === 'executable') return words('受控入口已放行', 'Released on controlled entry');
  if (state === 'assets_only') return words('实现已在本工程，入口未放行', 'Implemented locally, entry not released');
  if (state === 'not_implemented') return words('本工程无实现', 'Not implemented here');
  if (state === 'needs_data') return words('缺输入数据', 'Missing input data');
  return null;
}
function taskStatusLabel(status: string, words: Words): string {
  const labels: Record<string, [string, string]> = { ready: ['待开始', 'Ready'], running: ['计算中', 'Running'],
    waiting_approval: ['等待授权', 'Waiting for approval'], paused: ['已暂停', 'Paused'], interrupted: ['已中断', 'Interrupted'],
    succeeded: ['已完成', 'Succeeded'], failed: ['失败', 'Failed'], cancelled: ['已取消', 'Cancelled'],
    needs_review: ['结果待核对', 'Needs review'], blocked: ['受阻', 'Blocked'], awaiting_review: ['等待成果审核', 'Awaiting review'] };
  const label = labels[status];
  return label ? words(label[0], label[1]) : status;
}
function initialForm(): FormState {
  let timezone = '';
  try { timezone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? ''; } catch { /* 保留空值，由服务端核验。 */ }
  return { tableId: '', timestamp: '', close: '', open: '', high: '', low: '', availableAt: '',
    availability: 'bar_close', closeTime: '', period: '5', subject: '', currency: '', timezone, adjustment: 'unadjusted',
    basis: '', calendar: 'not_verified', synthetic: false };
}
function guessMapping(table: ManagedTableSummary) {
  const find = (names: string[]) => table.columns.find(column => names.some(name => column.toLowerCase() === name.toLowerCase())) ?? '';
  return { timestamp: find(['timestamp', 'date', 'time', 'datetime', 'trade_date', '日期', '时间']),
    close: find(['close', '收盘', '收盘价']), open: find(['open', '开盘', '开盘价']),
    high: find(['high', '最高', '最高价']), low: find(['low', '最低', '最低价']),
    availableAt: find(['available_at', 'availableat', 'available_time', '可得时间']) };
}
function shortDigest(value: string): string { return value.length > 20 ? `${value.slice(0, 12)}…${value.slice(-6)}` : value; }
function isTerminal(status: string): boolean { return TERMINAL.has(status); }
function displayCell(value: unknown, words: Words): string {
  if (value === null) return '—';
  if (typeof value === 'boolean') return value ? words('是', 'Yes') : words('否', 'No');
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(10).replace(/0+$/u, '').replace(/\.$/u, '');
  return String(value);
}
function sourceLabel(source: unknown): string {
  if (isRecord(source) && typeof source.displayName === 'string') return source.displayName;
  if (isRecord(source) && source.kind === 'fixed_snapshot') return '固定快照';
  return '受管表';
}

function FieldSelect({ label, value, options, onChange, empty }: {
  label: string; value: string; options: string[]; onChange(value: string): void; empty: string;
}) {
  return <label className="tools-field"><span>{label}</span><select value={value} onChange={(event) => onChange(event.currentTarget.value)}>
    <option value="">{empty}</option>{options.map((option) => <option key={option} value={option}>{option}</option>)}
  </select></label>;
}

export function ToolsPage() {
  const words = useWords(), { t } = usePreferences();
  const [view, setView] = useState<ToolLibraryView | null>(null);
  const [loading, setLoading] = useState(true), [loadError, setLoadError] = useState<string | null>(null);
  const [loadStatus, setLoadStatus] = useState<number | null>(null), [reloadNonce, setReloadNonce] = useState(0);
  const [catalogQuery, setCatalogQuery] = useState(''), [catalogOpen, setCatalogOpen] = useState(true);
  const [selectedToolId, setSelectedToolId] = useState<string | null>(null);
  const [algorithms, setAlgorithms] = useState<AlgorithmCatalogView | null>(null);
  const [algorithmError, setAlgorithmError] = useState<string | null>(null);
  const [algorithmStatus, setAlgorithmStatus] = useState<number | null>(null);
  const [form, setForm] = useState<FormState>(initialForm);
  const [busy, setBusy] = useState(false), [callError, setCallError] = useState<string | null>(null), [callView, setCallView] = useState<AlgorithmTaskView | null>(null);
  const alive = useRef(true);

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setLoadError(null); setLoadStatus(null);
    void request('/api/ui/tool-library').then(asView).then((next) => {
      if (!cancelled) setView(next);
    }).catch((failure) => {
      if (cancelled) return;
      setLoadError(errorDetail(failure));
      setLoadStatus(failure instanceof RequestError ? failure.status : null);
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [reloadNonce]);

  useEffect(() => {
    let cancelled = false;
    setAlgorithmError(null); setAlgorithmStatus(null);
    void loadAlgorithmCatalog().then((next) => {
      if (!cancelled) setAlgorithms(next);
    }).catch((failure) => {
      if (cancelled) return;
      setAlgorithms(null);
      setAlgorithmError(failure instanceof RequestError && failure.status === 404
        ? '算法计算入口尚未装配（/api/ui/algorithms 未挂载）；当前只保留只读目录。'
        : errorDetail(failure));
      setAlgorithmStatus(failure instanceof RequestError ? failure.status : null);
    });
    return () => { cancelled = true; };
  }, [reloadNonce]);

  useEffect(() => {
    if (!view) return;
    setSelectedToolId((current) => current && view.tools.some((tool) => tool.id === current) ? current : view.tools[0]?.id ?? null);
  }, [view]);
  useEffect(() => { setCallView(null); setCallError(null); }, [selectedToolId]);

  const tools = view?.tools ?? [];
  const selectedTool = tools.find((tool) => tool.id === selectedToolId) ?? null;
  const selectedMethod = algorithms?.methods.find((method) => method.id === selectedToolId) ?? null;
  const managedTables = algorithms?.inputs.managedTables.items ?? [];
  const selectedTable = managedTables.find((table) => table.materialId === form.tableId) ?? null;
  const filteredTools = tools.filter((tool) => `${tool.id} ${tool.title} ${tool.description}`.toLowerCase().includes(catalogQuery.trim().toLowerCase()));
  const refresh = () => setReloadNonce((value) => value + 1);
  const setField = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((current) => ({ ...current, [key]: value }));

  const selectTable = (materialId: string) => {
    const table = managedTables.find((item) => item.materialId === materialId);
    if (!table) { setForm((current) => ({ ...current, tableId: '' })); return; }
    const mapping = guessMapping(table);
    setForm((current) => ({ ...current, tableId: materialId, timestamp: mapping.timestamp, close: mapping.close, open: mapping.open,
      high: mapping.high, low: mapping.low, availableAt: mapping.availableAt, availability: mapping.availableAt ? 'column' : 'bar_close' }));
  };

  const buildCall = (): AlgorithmCallRequest | string => {
    if (!selectedMethod) return '当前目录项没有可调用的算法实现。';
    if (!selectedTable) return '请选择已受管表。';
    if (!form.timestamp || !form.close) return '请映射时间列和收盘价列。';
    if (selectedMethod.id === 'bullish_engulfing' && !form.open) return '严格看涨吞没需要映射开盘价列。';
    if (!form.subject.trim()) return '请填写标的或序列名称。';
    if (!/^[A-Z]{3}$/u.test(form.currency.trim()) || form.currency.trim() === 'XXX') return '请填写已识别的三位大写币种码，例如 CNY。';
    if (!form.timezone.trim()) return '请填写 IANA 时区，例如 Asia/Shanghai。';
    if (!form.basis.trim()) return '请填写明确的复权依据。';
    if (form.availability === 'column' && !form.availableAt) return '逐行可得时刻需要选择 available_at 列。';
    if (form.availability === 'bar_close' && !/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/u.test(form.closeTime)) return '收盘后可得时刻须为 HH:MM:SS。';
    let parameters: AlgorithmCallRequest['parameters'];
    if (selectedMethod.id === 'ma') {
      const period = Number(form.period);
      if (!Number.isSafeInteger(period) || period < 1 || period > 10000) return 'MA 周期须为 1 至 10000 的整数。';
      parameters = { period };
    } else if (selectedMethod.id === 'macd') parameters = { short_period: 12, long_period: 26, signal_period: 9, init: 'first_valid' };
    else parameters = {};
    const fieldMapping: AlgorithmFieldMapping = { timestamp: form.timestamp, close: form.close };
    if (form.open) fieldMapping.open = form.open;
    if (form.high) fieldMapping.high = form.high;
    if (form.low) fieldMapping.low = form.low;
    if (form.availableAt) fieldMapping.available_at = form.availableAt;
    return { methodId: selectedMethod.id as AlgorithmMethodId, parameters,
      source: { kind: 'managed_table', materialId: selectedTable.materialId, materialSha256: selectedTable.sha256, format: selectedTable.format,
        fieldMapping,
        semantics: { subject: form.subject.trim(), frequency: '1d', timezone: form.timezone.trim(), priceUnit: 'currency_per_share',
          currency: form.currency.trim(), adjustment: form.adjustment, adjustmentBasis: form.basis.trim(), barClosed: true, synthetic: form.synthetic,
          availability: form.availability === 'column' ? { kind: 'column' } : { kind: 'bar_close', closeTime: form.closeTime } },
        calendar: form.calendar === 'dense' ? { mode: 'dense' } : { mode: 'not_verified', note: '用户未提供交易日历；只按所供行计算。' } } };
  };

  const run = async () => {
    const call = buildCall();
    if (typeof call === 'string') { setCallError(call); return; }
    setBusy(true); setCallError(null); setCallView(null);
    try {
      let next = await submitAlgorithmCall(crypto.randomUUID(), call);
      if (!alive.current) return;
      setCallView(next);
      for (let attempt = 0; attempt < 120 && !isTerminal(next.status) && alive.current; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        next = await readAlgorithmCall(next.taskId);
        if (alive.current) setCallView(next);
      }
    } catch (failure) { if (alive.current) setCallError(errorDetail(failure)); }
    finally { if (alive.current) setBusy(false); }
  };

  return <div className="data-page tools-page">
    <aside className="data-nav tools-nav" aria-label={words('基础数据算法目录', 'Basic data algorithm catalog')}>
      <div className="sidebar-search-slot">
        <div className="data-search data-nav-search">
          <Search size={15} aria-hidden="true" />
          <input type="search" value={catalogQuery} onChange={(event) => setCatalogQuery(event.currentTarget.value)}
            placeholder={words('搜索算法', 'Search algorithms')} aria-label={words('搜索算法', 'Search algorithms')} />
        </div>
      </div>
      <button type="button" className="data-nav-item is-group" aria-expanded={catalogOpen}
        onClick={() => setCatalogOpen((current) => !current)}>
        <span className="tools-nav-label">{words('基础数据算法', 'Basic data algorithms')}</span><MorphIcon name={catalogOpen ? 'chevron-up' : 'chevron-down'} size={16} />
      </button>
      {catalogOpen && <div className="data-nav-children">
        {filteredTools.map((tool) => <button type="button" key={tool.id} className="data-nav-item is-child"
          aria-current={selectedTool?.id === tool.id ? 'true' : undefined} onClick={() => setSelectedToolId(tool.id)}>
          <span className="tools-nav-label">{tool.title}</span><span className="data-nav-dot" aria-hidden="true" />
        </button>)}
        {!filteredTools.length && <p className="data-nav-hint">{catalogQuery.trim()
          ? words('没有匹配的算法。', 'No matching algorithms.')
          : words('尚未读取到基础数据算法。', 'No basic data algorithms loaded.')}</p>}
      </div>}
    </aside>

    <section className="data-panel tools-panel" aria-label={t('nav.tools')} aria-busy={loading}>
      <div className="tools-content">
        <header className="tools-head">
          <div className="tools-head-copy">
            <p className="tools-eyebrow">{words('基础数据算法', 'Basic data algorithms')}</p>
            <h2 className="tools-page-title">{words('算法目录与受控计算', 'Algorithm catalog and controlled computation')}</h2>
            <p className="tools-page-sub">{words('查看既有算法的参数、输出字段与真实启用状态；已支持的方法可从明确选定的受管表计算，结果只作本地候选。',
              'Review existing algorithm parameters, output fields and actual enablement; supported methods may run on an explicitly selected managed table, with results kept as local candidates.')}</p>
          </div>
          <button type="button" className="text-button tools-refresh" onClick={refresh} disabled={loading || busy}>
            {loading ? <Loader2 className="tools-spin" size={15} aria-hidden="true" /> : <RefreshCw size={15} aria-hidden="true" />}
            {loading ? words('读取中…', 'Loading…') : words('重新读取', 'Refresh')}
          </button>
        </header>

        {loading && !view && <p className="tools-loading" role="status"><Loader2 className="tools-spin" size={16} aria-hidden="true" />{words('正在读取基础数据算法…', 'Loading basic data algorithms…')}</p>}
        {loadError && <div className="tools-state-block"><ErrorNote detail={loadError}>{view
          ? words('上次刷新未完成；下面仍是上次成功读取的内容。', 'The last refresh failed. The content below is from the last successful read.')
          : loadStatus === 404
            ? words('数据算法接口尚未装配。', 'The data algorithm endpoint is not connected.')
            : words('数据算法没有读取成功。', 'Data algorithms could not be loaded.')}</ErrorNote></div>}

        {view && <>
          {view.status !== 'ready' && <div className="tools-banner" role="status">
            <AlertTriangle size={18} aria-hidden="true" />
            <div><strong>{words('基础数据算法当前不可用', 'Basic data algorithms are currently unavailable')}</strong><p>{view.reason || t('tools.notAvailable')}</p></div>
          </div>}
          {algorithmError && <div className="tools-banner" role="status">
            <AlertTriangle size={18} aria-hidden="true" />
            <div><strong>{algorithmStatus === 404 ? words('计算入口尚未装配', 'Compute endpoint not connected') : words('计算能力没有读取成功', 'Compute capability could not be loaded')}</strong>
              <p>{algorithmError}</p></div>
          </div>}
          {algorithms && <dl className="tools-readiness">
            <div><dt>{words('实现', 'Implementation')}</dt><dd>{algorithms.implementation.version ? shortDigest(algorithms.implementation.version) : words('未读取', 'Not loaded')}
              <span className="tools-meta-sub">{algorithms.implementation.bindingRequired ? words('需要资源绑定', 'Binding required') : words('源码直读，无需旧 compute_assets 绑定', 'Direct source capture; no legacy compute_assets binding')}</span></dd></div>
            <div><dt>{words('执行绑定', 'Execution binding')}</dt><dd>{algorithms.execution.permission === 'granted' ? words('已授权', 'Granted')
              : algorithms.execution.permission === 'approval_required' ? words('提交后请求本机授权', 'Approval requested on submit') : words('不可用', 'Unavailable')}
              <span className="tools-meta-sub">{algorithms.execution.reason ?? words('固定 Python 入口已核验', 'Registered Python entry verified')}</span></dd></div>
            <div><dt>{words('输入就绪', 'Input readiness')}</dt><dd>{algorithms.inputs.managedTables.status === 'available'
              ? words(`${algorithms.inputs.managedTables.items.length} 张已受管表`, `${algorithms.inputs.managedTables.items.length} managed tables`)
              : words('受管表不可用', 'Managed tables unavailable')}
              <span className="tools-meta-sub">{algorithms.inputs.fixedSnapshots.status === 'available' ? words('固定快照已绑定', 'Fixed snapshot bound')
                : words('固定快照端口未装配', 'Fixed snapshot port not connected')}</span></dd></div>
          </dl>}
          {tools.length === 0 && <div className="tools-state-block"><p className="tools-empty-title">{t('tools.empty')}</p></div>}
          {selectedTool && <>
            <div className="tools-tool-head">
              <div className="tools-title-row">
                <h3 className="tools-title">{selectedTool.title}</h3><span className="tools-tool-id">{selectedTool.id}</span>
                <span className="tools-status" data-status={selectedTool.status}>{toolStatusLabel(selectedTool.status, words)}</span>
                {selectedMethod && <span className="tools-status" data-status={selectedMethod.status}>{toolStatusLabel(selectedMethod.status, words)}</span>}
              </div>
              <p className="tools-description">{selectedTool.description}</p>
            </div>
            {selectedTool.status !== 'ready' && <div className="tools-block" role="status">
              <AlertTriangle size={18} aria-hidden="true" />
              <div><strong>{selectedTool.status === 'blocked' ? words('该算法当前受阻', 'This algorithm is blocked') : words('该算法当前不可用', 'This algorithm is unavailable')}</strong>
                <p>{selectedTool.reason || words('服务没有提供进一步原因。', 'The service did not provide a further reason.')}</p></div>
            </div>}
            <section className="tools-section" aria-labelledby="tools-missing">
              <div className="tools-section-head"><h4 id="tools-missing">{words('登记状态与依赖', 'Registration state and dependencies')}</h4>
                {selectedTool.state && <span className="tools-status" data-status={selectedTool.status}>{toolStateLabel(selectedTool.state, words)}</span>}
              </div>
              {selectedTool.missing?.length
                ? <><p className="tools-field-hint">{words('缺失项逐条列出；补齐前不能把这项算作可用。', 'Missing items are listed one by one; the entry stays unusable until they are closed.')}</p>
                  <ul className="tools-limits">{selectedTool.missing.map((line) => <li key={line}>{line}</li>)}</ul></>
                : <p className="tools-muted">{words('没有登记缺失项。', 'No missing items are registered.')}</p>}
              {selectedTool.requiredInputs?.length ? <>
                <p className="tools-field-hint tools-meta-sub">{words('所需输入', 'Required inputs')}</p>
                <div className="tools-tags">{selectedTool.requiredInputs.map((field) => <span className="tools-tag" key={field}>{field}</span>)}</div>
              </> : null}
              {selectedTool.sources?.length ? <>
                <p className="tools-field-hint tools-meta-sub">{words('方法与口径来源', 'Method and semantics sources')}</p>
                <ul className="tools-limits">{selectedTool.sources.map((line) => <li key={line} className="tools-mono">{line}</li>)}</ul>
              </> : null}
            </section>
            <section className="tools-section" aria-labelledby="tools-parameters">
              <div className="tools-section-head"><h4 id="tools-parameters">{words('参数', 'Parameters')}</h4></div>
              {selectedTool.parameters.length
                ? <dl className="tools-meta">{selectedTool.parameters.map((parameter) => <div key={parameter.key}>
                  <dt>{parameter.label} · {parameter.key}</dt><dd>{words('默认值', 'Default')}: {parameter.defaultValue}
                    <span className="tools-meta-sub">{words('范围', 'Range')}: {parameter.min} – {parameter.max}</span></dd>
                </div>)}</dl>
                : <p className="tools-muted">{words('该算法没有可调参数。', 'This algorithm has no adjustable parameters.')}</p>}
            </section>
            <section className="tools-section" aria-labelledby="tools-output">
              <div className="tools-section-head"><h4 id="tools-output">{words('输出字段', 'Output fields')}</h4></div>
              {selectedTool.outputFields.length
                ? <div className="tools-tags">{selectedTool.outputFields.map((field) => <span className="tools-tag tools-field-tag" key={field}>{field}</span>)}</div>
                : <p className="tools-muted">{words('该算法未登记输出字段。', 'No output fields are registered.')}</p>}
            </section>
            <section className="tools-section" aria-labelledby="tools-limits">
              <div className="tools-section-head"><h4 id="tools-limits">{words('限制与口径', 'Limitations and semantics')}</h4></div>
              {selectedTool.limitations.length
                ? <ul className="tools-limits">{selectedTool.limitations.map((line) => <li key={line}>{line}</li>)}</ul>
                : <p className="tools-muted">{words('该算法未登记额外限制。', 'No additional limitations are registered.')}</p>}
            </section>

            <section className="tools-section tools-compute" aria-labelledby="tools-compute">
              <div className="tools-section-head"><h4 id="tools-compute">{words('本次受控计算', 'Controlled computation')}</h4>
                {algorithms && <span className="tools-status" data-status={algorithms.status === 'available' ? 'ready' : 'blocked'}>{algorithms.status === 'available' ? words('入口可用', 'Endpoint available') : words('入口不可用', 'Endpoint unavailable')}</span>}
              </div>
              {algorithmError
                ? <p className="tools-muted">{algorithmError}</p>
                : !algorithms ? <p className="tools-muted">{words('正在读取计算能力…', 'Loading compute capability…')}</p>
                : !selectedMethod ? <p className="tools-muted">{words('当前目录项没有受控计算方法；复权与分钟/日线加工尚未装配。', 'This catalog item has no controlled method; adjustment and minute/daily processing are not connected.')}</p>
                : selectedMethod.status !== 'ready' ? <div className="tools-block" role="status"><AlertTriangle size={18} aria-hidden="true" />
                  <div><strong>{words('该方法当前不能计算', 'This method cannot run now')}</strong><p>{selectedMethod.reason || algorithms.reason || words('输入或服务尚未就绪。', 'Input or service is not ready.')}</p></div></div>
                : <div className="tools-form">
                  <div className="tools-form-section">
                    <h5>{words('输入表', 'Input table')}</h5>
                    <label className="tools-field tools-field-wide"><span>{words('已受管表', 'Managed table')}</span>
                      <select value={form.tableId} onChange={(event) => selectTable(event.currentTarget.value)}>
                        <option value="">{words('选择已接收的数据表', 'Choose a received data table')}</option>
                        {managedTables.map((table) => <option key={table.materialId} value={table.materialId}>{table.displayName} · {table.rowCount} {words('行', 'rows')}</option>)}
                      </select></label>
                    {selectedTable ? <p className="tools-field-hint">{selectedTable.format.toUpperCase()} · {selectedTable.rowCount} {words('行', 'rows')} · {selectedTable.columns.length} {words('列', 'columns')} · SHA-256 {shortDigest(selectedTable.sha256)}</p>
                      : <p className="tools-field-hint">{words('表内容按材料身份固定；不读取任意路径，也不把显示名称当作证券身份。', 'Table content is pinned by material identity; no arbitrary paths and no display-name-as-security-identity.')}</p>}
                  </div>
                  {selectedTable && <>
                    <div className="tools-form-section"><h5>{words('字段映射', 'Field mapping')}</h5>
                      <div className="tools-form-grid">
                        <FieldSelect label={words('时间列', 'Time column')} value={form.timestamp} options={selectedTable.columns} empty={words('选择时间列', 'Choose time column')} onChange={(value) => setField('timestamp', value)} />
                        <FieldSelect label={words('收盘价列', 'Close column')} value={form.close} options={selectedTable.columns} empty={words('选择收盘价列', 'Choose close column')} onChange={(value) => setField('close', value)} />
                        <FieldSelect label={words('开盘价列', 'Open column')} value={form.open} options={selectedTable.columns} empty={words('未映射', 'Not mapped')} onChange={(value) => setField('open', value)} />
                        <FieldSelect label={words('最高价列', 'High column')} value={form.high} options={selectedTable.columns} empty={words('未映射', 'Not mapped')} onChange={(value) => setField('high', value)} />
                        <FieldSelect label={words('最低价列', 'Low column')} value={form.low} options={selectedTable.columns} empty={words('未映射', 'Not mapped')} onChange={(value) => setField('low', value)} />
                        <FieldSelect label={words('可得时间列', 'Available-at column')} value={form.availableAt} options={selectedTable.columns} empty={words('未映射', 'Not mapped')} onChange={(value) => setForm((current) => ({ ...current, availableAt: value, availability: value ? 'column' : current.availability }))} />
                      </div>
                    </div>
                    <div className="tools-form-section"><h5>{words('本次参数', 'Parameters')}</h5>
                      {selectedMethod.id === 'ma' ? <label className="tools-field"><span>{words('观测周期', 'Observation period')}</span>
                        <input type="number" min={1} max={10000} step={1} value={form.period} onChange={(event) => setField('period', event.currentTarget.value)} /></label>
                        : selectedMethod.id === 'macd' ? <p className="tools-field-hint">{words('固定 12/26/9；以所供窗口首条收盘价初始化，不接受续算状态。', 'Fixed 12/26/9; seeded by the first supplied close, no continuation state.')}</p>
                        : <p className="tools-field-hint">{words('无参数；严格使用前一条和当前一条日线的开盘价、收盘价。', 'No parameters; uses the previous and current daily open/close only.')}</p>}
                    </div>
                    <div className="tools-form-section"><h5>{words('语义声明', 'Semantics')}</h5>
                      <div className="tools-form-grid">
                        <label className="tools-field"><span>{words('标的 / 序列', 'Subject / series')}</span><input value={form.subject} onChange={(event) => setField('subject', event.currentTarget.value)} placeholder={words('例如 600000.SH 或合成序列', 'e.g. 600000.SH or a synthetic series')} /></label>
                        <label className="tools-field"><span>{words('币种', 'Currency')}</span><input value={form.currency} maxLength={3} onChange={(event) => setField('currency', event.currentTarget.value.toUpperCase())} placeholder="CNY" /></label>
                        <label className="tools-field"><span>{words('时区', 'Timezone')}</span><input value={form.timezone} onChange={(event) => setField('timezone', event.currentTarget.value)} placeholder="Asia/Shanghai" /></label>
                        <label className="tools-field"><span>{words('复权状态', 'Adjustment')}</span><select value={form.adjustment} onChange={(event) => setField('adjustment', event.currentTarget.value as FormState['adjustment'])}>
                          <option value="unadjusted">unadjusted · 未复权</option><option value="as_stored">as_stored · 按表内存储值</option>
                        </select></label>
                        <label className="tools-field tools-field-wide"><span>{words('复权依据', 'Adjustment basis')}</span><input value={form.basis} onChange={(event) => setField('basis', event.currentTarget.value)} placeholder={words('例如：原始未复权价；不执行复权', 'e.g. stored unadjusted values; no adjustment applied')} /></label>
                        <label className="tools-field"><span>{words('可得时刻', 'Availability')}</span><select value={form.availability} onChange={(event) => setField('availability', event.currentTarget.value as FormState['availability'])}>
                          <option value="column">{words('逐行可得时间列', 'Per-row available-at column')}</option><option value="bar_close">{words('收盘后固定时刻', 'Fixed time after close')}</option>
                        </select></label>
                        {form.availability === 'bar_close'
                          ? <label className="tools-field"><span>{words('收盘后时刻', 'Time after close')}</span><input value={form.closeTime} onChange={(event) => setField('closeTime', event.currentTarget.value)} placeholder="15:00:00" /></label>
                          : <p className="tools-field-hint">{words('使用已映射的 available_at 列；缺失即失败，不补造时刻。', 'Uses the mapped available_at column; missing values fail instead of being fabricated.')}</p>}
                        <label className="tools-field"><span>{words('日历完整性', 'Calendar completeness')}</span><select value={form.calendar} onChange={(event) => setField('calendar', event.currentTarget.value as FormState['calendar'])}>
                          <option value="not_verified">{words('未核对（只按所供行）', 'Not verified (supplied rows only)')}</option><option value="dense">{words('逐日连续（缺日失败）', 'Dense calendar (gap fails)')}</option>
                        </select></label>
                        <label className="tools-check"><input type="checkbox" checked={form.synthetic} onChange={(event) => setField('synthetic', event.currentTarget.checked)} />
                          <span>{words('这是隔离生成的合成测试数据', 'This is isolated synthetic test data')}</span></label>
                      </div>
                      <p className="tools-field-hint">{form.calendar === 'dense' ? words('逐日连续模式要求相邻行日期相差一天；周末或节假日缺口会明确失败。', 'Dense mode requires adjacent calendar days; weekend or holiday gaps fail explicitly.') : words('未核对模式仍会记录 CALENDAR_NOT_VERIFIED 缺口，不声称没有缺行。', 'Unverified mode records a CALENDAR_NOT_VERIFIED gap and never claims the calendar is complete.')}</p>
                    </div>
                  </>}
                  <div className="tools-form-actions">
                    <button type="button" className="primary-button tools-run" onClick={() => void run()} disabled={busy}>
                      {busy ? <Loader2 className="tools-spin" size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
                      {busy ? words('计算中…', 'Computing…') : words('开始计算', 'Run computation')}
                    </button>
                    <span className="tools-field-hint">{words('提交后由任务服务持有；重复请求按原任务查询，未知结果不重算。', 'Held by the task service; repeats query the original task and unknown results are not recomputed.')}</span>
                  </div>
                  {callError && <div className="tools-state-block"><ErrorNote detail={callError}>{words('本次计算没有提交成功或没有完成。', 'This computation was not submitted successfully or did not complete.')}</ErrorNote></div>}
                </div>}
            </section>

            {callView && <section className="tools-section tools-result" aria-labelledby="tools-result">
              <div className="tools-section-head"><h4 id="tools-result">{words('计算任务与结果', 'Computation task and result')}</h4>
                <span className="tools-status" data-status={callView.status === 'succeeded' ? 'ready' : callView.status === 'failed' || callView.status === 'cancelled' ? 'unavailable' : 'blocked'}>{taskStatusLabel(callView.status, words)}</span>
              </div>
              <dl className="tools-meta">
                <div><dt>{words('任务编号', 'Task ID')}</dt><dd className="tools-mono">{callView.taskId}</dd></div>
                <div><dt>{words('请求编号', 'Request ID')}</dt><dd className="tools-mono">{callView.requestId}</dd></div>
                <div><dt>{words('方法', 'Method')}</dt><dd>{callView.methodId} · {callView.result?.methodVersion ?? selectedMethod?.methodVersion ?? '—'}</dd></div>
                <div><dt>{words('状态说明', 'Guidance')}</dt><dd>{callView.guidance ?? (callView.status === 'succeeded' ? words('结果已保管，可按原任务读回。', 'Result is stored and can be read back by the original task.') : '—')}</dd></div>
              </dl>
              {callView.error && <div className="tools-block" role="alert"><AlertTriangle size={18} aria-hidden="true" />
                <div><strong>{callView.error.code}</strong><p>{callView.error.message}</p></div></div>}
              {callView.result && <AlgorithmResult view={callView} words={words} />}
            </section>}
          </>}
        </>}
      </div>
    </section>
  </div>;
}

function AlgorithmResult({ view, words }: { view: AlgorithmTaskView; words: Words }) {
  const result = view.result!;
  const fields = result.methodId === 'macd' ? ['DIFF', 'DEA', 'MACD', 'ZERO'] : result.methodId === 'ma' ? ['MA'] : ['bullish_engulfing'];
  const rows = result.rows.slice(0, 100);
  return <div className="tools-result-body">
    <div className="tools-result-summary">
      <div><span>{words('输入', 'Input')}</span><strong>{sourceLabel(result.source)}</strong><small>{result.coverage.windowStart} – {result.coverage.windowEnd} · {result.coverage.suppliedRows} {words('行', 'rows')}</small></div>
      <div><span>{words('输入摘要', 'Input digest')}</span><strong className="tools-mono">{shortDigest(result.inputDigest)}</strong><small>{words('封闭输入与结果分开保管', 'Sealed input and result are stored separately')}</small></div>
      <div><span>{words('有效区间', 'Valid interval')}</span><strong>{result.validInterval ? `${result.validInterval.start} – ${result.validInterval.end}` : words('无', 'None')}</strong><small>{words('预热空值', 'Leading warm-up')}: {result.coverage.leadingInvalidRows}</small></div>
      <div><span>{words('发布', 'Publication')}</span><strong>{words('未请求', 'Not requested')}</strong><small>{words('须另走既有通用候选服务', 'Must use the existing generic candidate service')}</small></div>
    </div>
    {result.gaps.length > 0 && <div className="tools-gaps"><strong>{words('范围与缺口', 'Scope and gaps')}</strong>
      <ul>{result.gaps.map((gap) => <li key={`${gap.code}-${gap.scope ?? ''}`}><code>{gap.code}</code><span>{gap.message}</span></li>)}</ul></div>}
    <div className="tools-table-wrap"><table className="tools-result-table">
      <thead><tr><th>{words('日期', 'Date')}</th>{fields.map((field) => <th key={field}>{field}</th>)}<th>{words('可得时刻', 'Available at')}</th></tr></thead>
      <tbody>{rows.map((row) => <tr key={row.timestamp}><td>{row.timestamp}</td>{fields.map((field) => <td key={field} data-null={row[field] === null ? 'true' : undefined}>{displayCell(row[field], words)}</td>)}<td className="tools-mono">{row.available_at}</td></tr>)}</tbody>
    </table></div>
    {result.rows.length > rows.length && <p className="tools-field-hint">{words(`仅显示前 ${rows.length} 行；完整 ${result.rows.length} 行已按任务结果保管。`, `Showing the first ${rows.length} of ${result.rows.length} stored rows.`)}</p>}
    <div className="tools-result-foot">
      <span>{words('实现版本', 'Implementation')}: <code>{shortDigest(result.implementationVersion)}</code></span>
      <span>{words('诊断', 'Diagnostics')}: {Array.isArray(result.diagnostics) ? result.diagnostics.length : 0}</span>
      <span>{words('结果状态', 'Result state')}: {result.status} · {result.persistence}</span>
    </div>
    <ul className="tools-limits">{result.limitations.map((line) => <li key={line}>{line}</li>)}</ul>
    <p className="tools-field-hint"><CheckCircle2 size={14} aria-hidden="true" /> {words('数值、规则命中、任务成功、结果保管与数据库发布分别认定；本面板不把计算成功当作入库成功。',
      'Numbers, rule hits, task success, custody and database publication are separate facts; this panel never treats computation as publication.')}</p>
  </div>;
}

export default ToolsPage;
