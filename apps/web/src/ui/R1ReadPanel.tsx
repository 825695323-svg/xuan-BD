import { useState } from 'react';
import type { R1ProductDiscovery, R1ProductRead, R1SnapshotStatus } from '../../../../contracts/r1-contracts';
import { RequestError } from '../api';
import { r1Api } from '../r1-api';
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
  const [pageIndex, setPageIndex] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selected = discovery?.selections.find(item => item.productId === productId);
  const seriesById = new Map(discovery?.products.map(product => [product.product_id, reportSeries(product)]));
  const reportField = (code: string) => seriesById.get(productId) ? sourceLabel(code, 'src_') : code;
  const data = result?.result, page = object(data?.page);
  const rows = Array.isArray(data?.rows) ? data.rows.map(object) : [];
  const fields = Array.isArray(data?.fields) ? data.fields.filter((value): value is string => typeof value === 'string') : [];
  const diagnostics = Array.isArray(data?.diagnostics) ? data.diagnostics : [];
  const fieldGaps = diagnostics.filter(item => object(item).code === 'FIELD_NOT_DEFINED_IN_ROW_CONTRACT');
  const fieldsReady = !!selected?.readable && projection.length > 0 && projection.length <= (discovery?.limits.maxFields ?? 64);

  const clear = () => { setDiscovery(null); setProductId(''); setProjection([]); setResult(null); setPageIndex(1); setError(null); };
  const act = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError(null);
    try { await work(); }
    catch (caught) { setError((caught instanceof RequestError && caught.code ? `${caught.code}: ` : '') + errorDetail(caught)); }
    finally { setBusy(false); }
  };
  const read = (cursor: string | null, nextPage: number) => act(async () => {
    if (!discovery || !fieldsReady) return;
    const response = await r1Api.readProduct({ snapshotId: discovery.snapshotId, productId, fields: projection, cursor });
    setResult(response); setPageIndex(nextPage);
  });

  return <section className="r1-stage r1-read-panel" aria-label={words('WFD 持久数据查询', 'WFD persisted data query')} aria-busy={busy}>
    <h3>{words('WFD 持久数据查询', 'WFD persisted data query')}</h3>
    <p className="r1-help">{words('从绑定数据库读取所选固定快照的真实产品与数据。此区与本地材料预览、加工输出和交接回执独立，重开页面后仍可查询。',
      'Read actual products and data from a fixed snapshot in the bound database. This query is independent of local previews, processing outputs and handoff receipts, and remains usable after reopening.')}</p>
    <p className="r1-help">{words('时间视角固定为“快照内容”：显示该快照中的内容，不证明这些内容在过去某时点已公开或已由本实例持有。本入口不提供日期、证券或题材筛选；未登记的历史资格保持未知。',
      'The time perspective is fixed to snapshot contents. It does not establish past public availability or instance possession. This entry has no date, security or topic filters; unknown historical eligibility stays unknown.')}</p>
    {!ready && <p className="r1-help danger-text">{words('请先配置并核对可用的 data_only（仅数据）绑定连接。', 'Configure and verify an available data_only connection first.')}</p>}
    <div className="r1-actions">
      <button type="button" className="text-button" disabled={busy || !ready} onClick={() => void act(async () => {
        clear(); setStatus(null);
        const response = await r1Api.snapshotStatus(); setStatus(response); setSnapshotId(response.snapshotId ?? '');
      })}>{words('取得当前固定快照', 'Get current fixed snapshot')}</button>
      <label>{words('固定快照编号', 'Fixed snapshot ID')}<input value={snapshotId} maxLength={128} disabled={busy || !ready}
        placeholder="s_…" onChange={event => { setSnapshotId(event.target.value); setStatus(null); clear(); }} /></label>
      <button type="button" className="text-button" disabled={busy || !ready || !snapshotId.trim()} onClick={() => void act(async () => {
        setDiscovery(null); setProductId(''); setProjection([]); setResult(null); setPageIndex(1);
        const fixed = snapshotId.trim(), response = await r1Api.discoverProducts(fixed);
        setSnapshotId(fixed); setDiscovery(response);
      })}>{words('发现快照中的产品', 'Discover products in snapshot')}</button>
    </div>
    {status && <p className="r1-help" role="status">{status.empty
      ? words('已只读确认：绑定实例为合法初始化空库，尚无活动快照。', 'Read-only check confirms an initialized empty bound instance with no active snapshot.')
      : words('已从活动头权威取得固定快照；本次后续查询固定使用该编号。', 'A fixed snapshot was obtained from the active-head authority; subsequent queries use that fixed ID.')}
      {' '}{status.connection.connectionId}</p>}
    {busy && <p className="r1-help" role="status">{words('正在只读查询绑定 WFD…', 'Reading the bound WFD…')}</p>}
    {error && <ErrorNote>{error}</ErrorNote>}
    {discovery && <>
      <p className="r1-help">{words(`发现 ${discovery.selections.length} 个实际产品、${discovery.products.length} 份固定合同绑定。`,
        `Discovered ${discovery.selections.length} actual products and ${discovery.products.length} fixed contract bindings.`)} <code>{discovery.snapshotId}</code></p>
      <label>{words('快照中的产品', 'Product in snapshot')}<select value={productId} disabled={busy} onChange={event => {
        setProductId(event.target.value); setProjection(discovery.selections.find(item => item.productId === event.target.value)?.fields.slice() ?? []);
        setResult(null); setPageIndex(1); setError(null);
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
            setResult(null); setPageIndex(1); setError(null);
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
      <p className="r1-help">{words('本页来自 WFD 持久读取。', 'This page comes from a persisted WFD read.')} <code>{result.snapshotId}</code> · <code>{result.productId}</code></p>
      {!rows.length && <p className="data-empty">{words('本页没有可返回的业务行；请同时核对诊断与原始结果。', 'This page has no returnable business rows. Inspect diagnostics and the original result.')}</p>}
      {rows.length > 0 && <div className="r1-table-scroll"><table><caption>{words('持久字段值与状态', 'Persisted field values and states')}</caption>
        <thead><tr><th>{words('业务键与版本', 'Business key and version')}</th><th>{words('业务时间与状态', 'Business time and status')}</th>{fields.map(field => <th key={field} title={field}>{reportField(field)}</th>)}</tr></thead>
        <tbody>{rows.map((row, index) => { const ref = object(row.record_ref), time = object(row.business_time), values = object(row.values); return <tr key={index}>
          <td>{display(ref.logical_key ?? ref.record_id)}<small>{display(ref.revision_id ?? ref.record_version)}</small></td>
          <td>{time.status === 'known' ? <>{display(time.earliest_utc)}<br />{words('至（不含）', 'until (exclusive)')} {display(time.latest_exclusive_utc)}<small>{display(time.precision)} · {display(time.source_timezone)}</small></>
            : <>{display(time.status)}{typeof time.status === 'string' && states[time.status] ? `（${states[time.status]}）` : ''}</>}</td>
          {fields.map(field => { const cell = object(values[field]), state = display(cell.value_state); return <td key={field}><span>{display(cell.value)}</span>
            <small>{state}{states[state] ? `（${states[state]}）` : ''}</small><small>{words('单位', 'Unit')}：{seriesById.get(productId) ? sourceLabel(display(object(cell.unit).unit_code), 'srcunit_') : display(object(cell.unit).unit_code)}</small></td>; })}
        </tr>; })}</tbody></table></div>}
      <p className="r1-help">{page.has_more ? words('还有后续页；本页不代表全部数据已读完。', 'More pages remain; this page does not mean all data was read.')
        : words('当前固定查询已到末页。完整性与被排除的记录仍以 WFD 诊断为准。', 'This fixed query has reached its final page. Completeness and excluded records are still governed by WFD diagnostics.')}</p>
      {fieldGaps.length > 0 && <p className="r1-help danger-text">{words(`WFD 返回 ${fieldGaps.length} 条字段覆盖诊断：对应记录的固定合同未声明全部所选字段，未计入本次返回行。可改选共有字段读取已有值；准确记录与缺字段见下方诊断。`,
        `WFD returned ${fieldGaps.length} field-coverage diagnostics. The affected fixed contracts do not declare every selected field, so those records are excluded from this projection. Select shared fields to read their existing values; exact records and missing fields are listed below.`)}</p>}
      {diagnostics.length > 0 && <details open><summary>{words('WFD 读取诊断', 'WFD read diagnostics')} · {diagnostics.length}</summary><pre className="database-text-preview">{JSON.stringify(diagnostics, null, 2)}</pre></details>}
      <button type="button" className="text-button" disabled={busy || page.has_more !== true || typeof page.next_cursor !== 'string'} onClick={() => void read(page.next_cursor as string, pageIndex + 1)}>{words('下一页', 'Next page')}</button>
      <details><summary>{words('查看本页原始结果、时间、单位与预算', 'Inspect the original page, times, units and budget')}</summary><pre className="database-text-preview">{JSON.stringify(data, null, 2)}</pre></details>
    </div>}
  </section>;
}
