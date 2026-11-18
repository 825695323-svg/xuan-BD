import { useEffect, useRef, useState } from 'react';
import type { R1ProductDiscovery, R1ProductRead, R1ProductReadInput, R1SnapshotStatus } from '../../../../contracts/r1-contracts';
import { RequestError } from '../api';
import { r1Api } from '../r1-api';
import { buildR1ReadHistory, R1HistoryError, sameR1ReadConnection } from '../r1-read-history';
import { PageField } from './PageUI';
import { recordIdentity, type RecordIdentity } from '../record-evidence-api';
import { RecordEvidencePanel } from './RecordEvidencePanel';
import { ErrorNote, errorDetail, useWords } from './Controls';

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const display = (value: unknown): string => value === null ? 'null' : value === undefined ? '—' : typeof value === 'string' ? value : JSON.stringify(value);
const states: Record<string, string> = { valid_value: '有效值', reported_zero: '报告为零', unknown: '未知',
  not_applicable: '不适用', missing_unknown: '缺失原因未知', not_disclosed: '未披露' };

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

function reportSeries(product: Record<string, unknown>) {
  const declaration = object(product.declaration);
  const identity = object(object(declaration.semantic_context).identity);
  if (!String(declaration.semantic_code).startsWith('source_report.')
    || !String(identity.identity_resolution_rule).startsWith('source_reported_date_and_identity_columns:')) return '';
  return typeof identity.alias_scope === 'string' ? identity.alias_scope : '';
}

/** Independent of the local preparation/receipt editor; all data comes from fresh fixed WFD reads. */
export function R1ReadPanel({ ready }: { ready: boolean }) {
  const words = useWords();
  const [snapshotId, setSnapshotId] = useState('');
  const [status, setStatus] = useState<R1SnapshotStatus | null>(null);
  const [discovery, setDiscovery] = useState<R1ProductDiscovery | null>(null);
  const [productId, setProductId] = useState('');
  const [projection, setProjection] = useState<string[]>([]);
  const [result, setResult] = useState<R1ProductRead | null>(null);
  const [evidenceRun, setEvidenceRun] = useState(0);
  const [evidenceIdentity, setEvidenceIdentity] = useState<RecordIdentity | null>(null);
  const [pageIndex, setPageIndex] = useState(1);
  const [historyMode, setHistoryMode] = useState<NonNullable<R1ProductReadInput['historyMode']>>('snapshot_contents');
  const [at, setAt] = useState(''), [usableStage, setUsableStage] = useState('');
  const [lastRequest, setLastRequest] = useState<R1ProductReadInput | null>(null);
  const epoch = useRef(0), active = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { epoch.current++; active.current = false; setBusy(false); setStatus(null);
    setDiscovery(null); setProductId(''); setProjection([]); setResult(null); setLastRequest(null); setPageIndex(1); setError(null);
    return () => { epoch.current++; active.current = false; };
  }, [ready]);
  const selected = discovery?.selections.find(item => item.productId === productId);
  const seriesById = new Map(discovery?.products.map(product => [product.product_id, reportSeries(product)]));
  const reportField = (code: string) => seriesById.get(productId) ? sourceLabel(code, 'src_') : code;
  const data = result?.result, page = object(data?.page);
  const rows = Array.isArray(data?.rows) ? data.rows.map(object) : [];
  const fields = Array.isArray(data?.fields) ? data.fields.filter((value): value is string => typeof value === 'string') : [];
  const diagnostics = Array.isArray(data?.diagnostics) ? data.diagnostics : [];
  const fieldGaps = diagnostics.filter(item => object(item).code === 'FIELD_NOT_DEFINED_IN_ROW_CONTRACT');
  const fieldsReady = !!selected?.readable && projection.length > 0 && projection.length <= (discovery?.limits.maxFields ?? 64);

  const changed = () => { setEvidenceIdentity(null); setResult(null); setLastRequest(null); setPageIndex(1); setError(null); };
  const clear = () => { setDiscovery(null); setProductId(''); setProjection([]); changed(); };
  const act = async (work: (current: () => boolean) => Promise<void>) => {
    if (active.current || !ready) return;
    active.current = true; const requestEpoch = ++epoch.current;
    const current = () => epoch.current === requestEpoch;
    setBusy(true); setError(null);
    try { await work(current); }
    catch (caught) { if (current()) setError(caught instanceof R1HistoryError ? `${caught.code}: ${words(caught.message, caught.english)}` : (caught instanceof RequestError && caught.code ? `${caught.code}: ` : '') + errorDetail(caught)); }
    finally { if (current()) { active.current = false; setBusy(false); } }
  };
  const read = (cursor: string | null, nextPage: number) => act(async current => {
    if (!discovery || !fieldsReady) return;
    setEvidenceIdentity(null); setResult(null);
    if (historyMode === 'system_held_at' && (!status || !sameR1ReadConnection(status.connection, discovery.connection)))
      throw new RequestError(words('持有实例与产品发现的绑定不一致；请重新取得当前固定快照并发现产品。',
        'The holding instance and discovery bindings differ; reload the current snapshot and rediscover products.'));
    const input: R1ProductReadInput = cursor && lastRequest ? { ...lastRequest, cursor } : {
      snapshotId: discovery.snapshotId, productId, fields: projection.slice(), cursor: null,
      ...buildR1ReadHistory({ historyMode, ...(historyMode !== 'snapshot_contents' ? { at } : {}),
        ...(historyMode === 'system_held_at' ? { usableStage } : {}) }, status),
    };
    const response = await r1Api.readProduct(input);
    if (!current()) return;
    if (!sameR1ReadConnection(response.connection, discovery.connection))
      throw new RequestError(words('R1_READ_CONNECTION_CHANGED：固定发现与读取的连接不同；请重新发现产品。',
        'R1_READ_CONNECTION_CHANGED: fixed discovery and read connections differ; rediscover before continuing.'));
    setResult(response); setLastRequest(input); setPageIndex(nextPage);
  });

  return <section className="r1-stage r1-read-panel" aria-label={words('WFD 持久数据查询', 'WFD persisted data query')} aria-busy={busy}>
    <h3>{words('WFD 持久数据查询', 'WFD persisted data query')}</h3>
    <p className="r1-help">{words('从绑定数据库读取所选固定快照的真实产品与数据。此区与本地材料预览、加工输出和交接回执独立，重开页面后仍可查询。',
      'Read actual products and data from a fixed snapshot in the bound database. This query is independent of local previews, processing outputs and handoff receipts, and remains usable after reopening.')}</p>
    <p className="r1-help">{words('产品发现仍是固定快照合同列表，不是历史可知清单。历史读取须显式选择时间视角、秒级 UTC 截止；业务时间与知识截止不同。未知资格保持诊断或拒绝，不回退最新数据。结构化筛选和关系上下文的历史控件不在本入口范围内。',
      'Discovery lists fixed snapshot contracts, not products known in the past. Historical reads require an explicit perspective and second-precision UTC cutoff. Business time is separate. Unknown eligibility remains a diagnostic or refusal, never a fallback to latest data. Structured filters and relation-context history controls are outside this entry.')}</p>
    {!ready && <p className="r1-help danger-text">{words('请先配置并核对可用的 data_only（仅数据）绑定连接。', 'Configure and verify an available data_only connection first.')}</p>}
    <div className="r1-actions">
      <button type="button" className="text-button" disabled={busy || !ready} onClick={() => void act(async current => {
        clear(); setStatus(null); setUsableStage('');
        const response = await r1Api.snapshotStatus(); if (!current()) return; setStatus(response); setSnapshotId(response.snapshotId ?? '');
      })}>{words('取得当前固定快照', 'Get current fixed snapshot')}</button>
      <label>{words('固定快照编号', 'Fixed snapshot ID')}<input value={snapshotId} maxLength={128} disabled={busy || !ready}
        placeholder="s_…" onChange={event => { setSnapshotId(event.target.value); clear(); }} /></label>
      <button type="button" className="text-button" disabled={busy || !ready || !snapshotId.trim()} onClick={() => void act(async current => {
        setLastRequest(null); setDiscovery(null); setProductId(''); setProjection([]); setResult(null); setPageIndex(1);
        const fixed = snapshotId.trim(), response = await r1Api.discoverProducts(fixed);
        if (!current()) return; setSnapshotId(fixed); setDiscovery(response);
      })}>{words('发现快照中的产品', 'Discover products in snapshot')}</button>
    </div>
    {status && <p className="r1-help" role="status">{status.empty
      ? words('已只读确认：绑定实例为合法初始化空库，尚无活动快照。', 'Read-only check confirms an initialized empty bound instance with no active snapshot.')
      : words('已核对当前绑定与活动头；查询使用上方显式固定编号。', 'The current binding and active head were checked; queries use the explicit fixed ID above.')}
      {' '}{status.connection.connectionId}</p>}
    <div className="r1-grid" aria-label={words('持久数据时间视角', 'Persisted data time perspective')}>
      <PageField label={words('历史视角', 'History perspective')}><select aria-label={words('历史视角', 'History perspective')} value={historyMode} disabled={busy || !ready} onChange={event => {
        setHistoryMode(event.target.value as NonNullable<R1ProductReadInput['historyMode']>); setAt(''); setUsableStage(''); changed();
      }}>
        <option value="snapshot_contents">{words('固定快照内容', 'Snapshot contents')}</option>
        <option value="market_known_at">{words('市场当时已知', 'Market known at')}</option>
        <option value="system_held_at">{words('本实例当时持有', 'This instance held at')}</option>
      </select></PageField>
      {historyMode !== 'snapshot_contents' && <PageField label={words('截止时间（秒级 UTC）', 'Cutoff (UTC seconds)')}
        hint={words('完整输入 YYYY-MM-DDTHH:mm:ssZ；不自动补日期、时区或当前时间。', 'Enter YYYY-MM-DDTHH:mm:ssZ; no inferred date, timezone or current time.')}>
        <input aria-label={words('截止时间（秒级 UTC）', 'Cutoff (UTC seconds)')} value={at} maxLength={20} placeholder="YYYY-MM-DDTHH:mm:ssZ" disabled={busy || !ready}
          onChange={event => { setAt(event.target.value); changed(); }} />
      </PageField>}
      {historyMode === 'system_held_at' && <>
        <PageField label={words('实际持有实例', 'Actual holding instance')} hint={status?.holdingInstance?.bindingSource ?? words('未知；先取得当前固定快照以核对绑定。', 'Unknown; check the current snapshot binding first.')}>
          <input aria-label={words('实际持有实例', 'Actual holding instance')} readOnly value={status?.holdingInstance?.instanceId ?? ''} placeholder={words('未知', 'Unknown')} />
        </PageField>
        <PageField label={words('所需可用阶段', 'Required usable stage')}><select aria-label={words('所需可用阶段', 'Required usable stage')} value={usableStage} disabled={busy || !ready}
          onChange={event => { setUsableStage(event.target.value); changed(); }}>
          <option value="">{words('明确选择阶段', 'Select a stage explicitly')}</option>
          <option value="acquired">{words('已取得', 'Acquired')}</option><option value="custodied">{words('已保管', 'Custodied')}</option>
          <option value="published_readable">{words('正式可读', 'Published readable')}</option>
        </select></PageField>
      </>}
    </div>
    {historyMode === 'system_held_at' && <p className="r1-help">{words('实例身份存在不证明任一记录已达到该阶段；缺持有证据时返回未知或拒绝，不以公开日期替代。',
      'An instance identity does not prove a record reached the selected stage. Missing holding evidence stays unknown or refused, never replaced by a public date.')}</p>}
    {busy && <p className="r1-help" role="status">{words('正在只读查询绑定 WFD…', 'Reading the bound WFD…')}</p>}
    {error && <ErrorNote>{error}</ErrorNote>}
    {discovery && <>
      <p className="r1-help">{words(`发现 ${discovery.selections.length} 个实际产品、${discovery.products.length} 份固定合同绑定。`,
        `Discovered ${discovery.selections.length} actual products and ${discovery.products.length} fixed contract bindings.`)} <code>{discovery.snapshotId}</code></p>
      <label>{words('快照中的产品', 'Product in snapshot')}<select value={productId} disabled={busy} onChange={event => {
        setProductId(event.target.value); setProjection(discovery.selections.find(item => item.productId === event.target.value)?.fields.slice() ?? []);
        changed();
      }}>
        <option value="">{words('选择一个实际产品', 'Select an actual product')}</option>
        {discovery.selections.map(item => <option key={item.productId} value={item.productId}>{seriesById.get(item.productId) || item.datasetId} · {item.productId} · {display(item.subject.id)}</option>)}
      </select></label>
      {!discovery.selections.length && <p className="data-empty">{words('该固定快照没有实际产品。', 'This fixed snapshot contains no actual products.')}</p>}
      {selected && <div className="r1-proof">
        <p>{words('数据集', 'Dataset')}：{selected.datasetId} · {words('产品', 'Product')}：<code>{selected.productId}</code></p>
        <p>{words('主体', 'Subject')}：{display(selected.subject)} · {words('载荷类型', 'Payload kind')}：{selected.payloadKind}</p>
        <p>{words('按固定合同投影字段', 'Fields projected from fixed contracts')}：{selected.fields.map(reportField).join('、') || '—'}</p>
        {!selected.readable && <p className="danger-text">{selected.reason}</p>}
      </div>}
      {selected?.readable && <fieldset className="r1-read-fields" aria-label={words('选择读取字段', 'Select fields to read')}>
        <legend>{words('选择读取字段', 'Select fields to read')}</legend>
        <p className="r1-help">{words(`已选 ${projection.length} 项；每次选择 1–${discovery.limits.maxFields} 项。默认全部声明字段，切换字段后从第一页重新读取。`,
          `${projection.length} selected; choose 1–${discovery.limits.maxFields} fields per query. All declared fields are selected by default. Changing fields starts a new query from the first page.`)}</p>
        <div className="r1-read-field-options">{selected.fields.map(field => <label key={field}><input type="checkbox" aria-label={reportField(field)}
          disabled={busy} checked={projection.includes(field)} onChange={event => {
            setProjection(current => event.target.checked ? [...current, field].sort() : current.filter(value => value !== field));
            changed();
          }} /><span title={field}>{reportField(field)}</span></label>)}</div>
        <p className="r1-help">{words('不同固定合同可能覆盖不同字段。共有字段可用于读取旧记录；选中新增字段时，缺少该字段的旧记录由 WFD 列出准确诊断，已有值不补成新字段值。',
          'Fixed contracts can cover different fields. Select shared fields to read older records. When a new field is selected, WFD reports exact diagnostics for records whose contracts do not declare it; existing values are not substituted for new fields.')}</p>
      </fieldset>}
      <p className="r1-help">{words(`每页 ${discovery.limits.pageSize} 行；单次至多预扫 ${discovery.limits.maxScanRows} 个候选行与 ${discovery.limits.maxScanBytes / 1048576} MiB，完整结果上限 ${discovery.limits.maxResultBytes / 1048576} MiB，等待上限 ${discovery.limits.timeoutMs / 1000} 秒。超限返回错误，不截断为成功。`,
        `${discovery.limits.pageSize} rows per page; at most ${discovery.limits.maxScanRows} candidate rows and ${discovery.limits.maxScanBytes / 1048576} MiB scanned per call, ${discovery.limits.maxResultBytes / 1048576} MiB for the complete result and ${discovery.limits.timeoutMs / 1000} seconds waiting. Budget failures are not truncated into success.`)}</p>
      <button type="button" className="primary-button" disabled={busy || !fieldsReady} onClick={() => void read(null, 1)}>{words('读取持久数据', 'Read persisted data')}</button>
      <details><summary>{words('查看该快照的公开定义与合同', 'Inspect public definitions and contracts in this snapshot')}</summary><pre className="database-text-preview">{JSON.stringify(discovery.products, null, 2)}</pre></details>
    </>}
    {result && <div className="r1-read-result" aria-label={words('WFD 实际读取结果', 'Actual WFD read result')}>
      <p className="r1-help">{words(`第 ${pageIndex} 页，本页 ${rows.length} 行；本次字段投影可返回 ${display(page.total_rows)} 行，本页后还有 ${Math.max(0, Number(page.remaining_rows) - rows.length)} 行。`,
        `Page ${pageIndex}: ${rows.length} rows on this page, ${display(page.total_rows)} returnable rows for this field projection, ${Math.max(0, Number(page.remaining_rows) - rows.length)} rows after this page.`)}</p>
      <p className="r1-help" aria-label={words('已核对的历史资格', 'Verified history selection')}>{words('视角', 'Perspective')}：{result.historyMode} · {words('截止', 'Cutoff')}：{display(object(data?.knowledge_cutoff).earliest_utc)} · {words('持有实例', 'Holding instance')}：{display(data?.held_scope)} · {words('阶段', 'Stage')}：{display(data?.usable_stage)}</p>
      <p className="r1-help">{words('本页来自 WFD 持久读取。', 'This page comes from a persisted WFD read.')} <code>{result.snapshotId}</code> · <code>{result.productId}</code></p>
      {!rows.length && <p className="data-empty">{words('本页没有可返回的业务行；请同时核对诊断与原始结果。', 'This page has no returnable business rows. Inspect diagnostics and the original result.')}</p>}
      {rows.length > 0 && <div className="r1-table-scroll"><table><caption>{words('持久字段值与状态', 'Persisted field values and states')}</caption>
        <thead><tr><th>{words('业务键与版本', 'Business key and version')}</th><th>{words('业务时间与状态', 'Business time and status')}</th>{fields.map(field => <th key={field} title={field}>{reportField(field)}</th>)}</tr></thead>
        <tbody>{rows.map((row, index) => { const ref = object(row.record_ref), time = object(row.business_time), values = object(row.values); return <tr key={index}>
          <td>{display(ref.logical_key ?? ref.record_id)}<small>{display(ref.revision_id ?? ref.record_version)}</small>{historyMode === 'snapshot_contents' && selected && (() => {
            const identity = recordIdentity(selected.datasetId, result.productId, result.snapshotId, ref);
            return identity && <button type="button" className="text-button" data-record-id={identity.recordId} onClick={() => { setEvidenceRun(value => value + 1); setEvidenceIdentity(identity); }}>{words('核对原件', 'Verify original')}</button>;
          })()}</td>
          <td>{time.status === 'known' ? <>{display(time.earliest_utc)}<br />{words('至（不含）', 'until (exclusive)')} {display(time.latest_exclusive_utc)}<small>{display(time.precision)} · {display(time.source_timezone)}</small></>
            : <>{display(time.status)}{typeof time.status === 'string' && states[time.status] ? `（${states[time.status]}）` : ''}</>}</td>
          {fields.map(field => { const cell = object(values[field]), state = display(cell.value_state); return <td key={field}><span>{display(cell.value)}</span>
            <small>{state}{states[state] ? `（${states[state]}）` : ''}</small><small>{words('单位', 'Unit')}：{seriesById.get(productId) ? sourceLabel(display(object(cell.unit).unit_code), 'srcunit_') : display(object(cell.unit).unit_code)}</small></td>; })}
        </tr>; })}</tbody></table></div>}
      {historyMode === 'snapshot_contents' && evidenceIdentity && <RecordEvidencePanel key={JSON.stringify([result.snapshotId, result.productId, evidenceIdentity, evidenceRun])} identity={evidenceIdentity} snapshotId={result.snapshotId} connection={result.connection} />}
      <p className="r1-help">{page.has_more ? words('还有后续页；本页不代表全部数据已读完。', 'More pages remain; this page does not mean all data was read.')
        : words('当前固定查询已到末页。完整性与被排除的记录仍以 WFD 诊断为准。', 'This fixed query has reached its final page. Completeness and excluded records are still governed by WFD diagnostics.')}</p>
      {fieldGaps.length > 0 && <p className="r1-help danger-text">{words(`WFD 返回 ${fieldGaps.length} 条字段覆盖诊断：对应记录的固定合同未声明全部所选字段，未计入本次返回行。可改选共有字段读取已有值；准确记录与缺字段见下方诊断。`,
        `WFD returned ${fieldGaps.length} field-coverage diagnostics. The affected fixed contracts do not declare every selected field, so those records are excluded from this projection. Select shared fields to read their existing values; exact records and missing fields are listed below.`)}</p>}
      {diagnostics.length > 0 && <details open><summary>{words('WFD 读取诊断', 'WFD read diagnostics')} · {diagnostics.length}</summary><pre className="database-text-preview">{JSON.stringify(diagnostics, null, 2)}</pre></details>}
      <button type="button" className="text-button" disabled={busy || page.has_more !== true || typeof page.next_cursor !== 'string' || !lastRequest} onClick={() => void read(page.next_cursor as string, pageIndex + 1)}>{words('下一页', 'Next page')}</button>
      <details><summary>{words('查看本页原始结果、时间、单位与预算', 'Inspect the original page, times, units and budget')}</summary><pre className="database-text-preview">{JSON.stringify(data, null, 2)}</pre></details>
    </div>}
  </section>;
}
