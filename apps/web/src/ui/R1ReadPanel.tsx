import { useEffect, useRef, useState, type Ref } from 'react';
import type { R1ProductDiscovery, R1ProductRead, R1ProductReadInput, R1SnapshotStatus } from '../../../../contracts/r1-contracts';
import { RequestError } from '../api';
import { r1Api } from '../r1-api';
import { buildR1ReadHistory, R1HistoryError, sameR1ReadConnection } from '../r1-read-history';
import { PageButton, PageEmpty, PageField, PageHeading } from './PageUI';
import { recordIdentity, type RecordIdentity } from '../record-evidence-api';
import { RecordEvidencePanel } from './RecordEvidencePanel';
import { ErrorNote, errorDetail, useWords } from './Controls';

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const display = (value: unknown): string => value === null ? 'null' : value === undefined ? '—' : typeof value === 'string' ? value : JSON.stringify(value);
const stateLabels: Record<string, readonly [string, string]> = {
  valid_value: ['有效值', 'Valid value'], reported_zero: ['报告为零', 'Reported zero'],
  unknown: ['未知', 'Unknown'], not_applicable: ['不适用', 'Not applicable'],
  missing_unknown: ['缺失原因未知', 'Reason for absence unknown'], not_disclosed: ['未披露', 'Not disclosed'],
};

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
export function R1ReadPanel({ ready, ref }: { ready: boolean; ref?: Ref<HTMLElement> }) {
  const words = useWords();
  const describeState = (code: string) => {
    const label = Object.hasOwn(stateLabels, code) ? stateLabels[code] : undefined;
    return label ? words(...label) + ' · ' + code : code;
  };
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

  return <section className="r1-stage r1-read-panel" ref={ref} tabIndex={-1}
    aria-label={words('WFD 持久数据查询', 'WFD persisted data query')} aria-busy={busy}>
    <PageHeading level="h3" title={words('WFD 持久数据查询', 'WFD persisted data query')}
      description={words('输入已有快照编号，或从当前连接取得编号，再查找要读取的产品。',
        'Enter a saved snapshot ID or get one from the current connection, then find a product to read.')} />
    {!ready && <PageEmpty state="unavailable">{words('请先配置并核对可用的 data_only（仅数据）绑定连接。', 'Configure and verify an available data_only connection first.')}</PageEmpty>}
    <div className="r1-snapshot-tools r1-query-block">
      <h4 className="r1-step">{words('查询条件', 'Query conditions')}</h4>
      <PageField label={words('固定快照编号', 'Fixed snapshot ID')}>
        <input aria-label={words('固定快照编号', 'Fixed snapshot ID')} value={snapshotId} maxLength={128} disabled={busy || !ready}
          placeholder="s_…" onChange={event => { setSnapshotId(event.target.value); clear(); }} />
      </PageField>
      <div className="r1-actions">
        <PageButton disabled={busy || !ready} onClick={() => void act(async current => {
          clear(); setStatus(null); setUsableStage('');
          const response = await r1Api.snapshotStatus(); if (!current()) return; setStatus(response); setSnapshotId(response.snapshotId ?? '');
        })}>{words('取得当前固定快照', 'Get current fixed snapshot')}</PageButton>
        <PageButton variant="primary" disabled={busy || !ready || !snapshotId.trim()} onClick={() => void act(async current => {
          clear();
          const fixed = snapshotId.trim(), response = await r1Api.discoverProducts(fixed);
          if (!current()) return; setSnapshotId(fixed); setDiscovery(response);
        })}>{words('发现快照中的产品', 'Discover products in snapshot')}</PageButton>
      </div>
      {status && <p className="r1-help" role="status">{status.empty
        ? words('上次核对时，绑定实例为合法初始化空库，尚无活动快照。', 'The last check confirmed an initialized empty instance with no active snapshot.')
        : <>{words('上次核对的活动快照', 'Active snapshot at last check')} <code>{status.snapshotId}</code></>}
        {' · '}{status.connection.connectionId}</p>}
      {status && snapshotId.trim() && snapshotId.trim() !== (status.snapshotId ?? '') && <p className="r1-help r1-caution">{words('查询将按输入编号执行，而非上次核对的活动快照。', 'Queries will use the entered ID, not the active snapshot from the last check.')}</p>}
    </div>
    <div className="r1-grid r1-query-block r1-perspective" aria-label={words('持久数据时间视角', 'Persisted data time perspective')}>
      <h4 className="r1-step">{words('时间与持有视角', 'Time and holding perspective')}</h4>
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
      {historyMode !== 'snapshot_contents' && <p className="r1-help r1-caution">
        {words('目录按固定快照列出合同。读取按所选的知识截止时间核验资格，业务发生时间单独核对。缺少证据时返回诊断或拒绝，不回退到最新值。',
          'The directory lists contracts from the fixed snapshot. Reads check eligibility at the selected knowledge cutoff, separately from business time. Missing evidence produces a diagnostic or refusal without falling back to current data.')}
        {historyMode === 'system_held_at' && ' ' + words('持有资格还须核对该实例的实际阶段。', 'Holding also requires evidence of the stage reached by this instance.')}
      </p>}
    </div>
    {busy && <p className="r1-help" role="status">{words('正在只读查询绑定 WFD…', 'Reading the bound WFD…')}</p>}
    {error && <ErrorNote>{error}</ErrorNote>}
    {discovery && <div className="r1-query-block r1-discovery">
      <h4 className="r1-step">{words('产品与字段', 'Product and fields')}</h4>
      <p className="r1-help r1-meta">{words(`快照产品目录 · ${discovery.selections.length} 个产品 · ${discovery.products.length} 份合同绑定`,
        `Snapshot directory · ${discovery.selections.length} products · ${discovery.products.length} contract bindings`)} <code>{discovery.snapshotId}</code></p>
      <label>{words('快照中的产品', 'Product in snapshot')}<select value={productId} disabled={busy || !discovery.selections.length} onChange={event => {
        setProductId(event.target.value); setProjection(discovery.selections.find(item => item.productId === event.target.value)?.fields.slice() ?? []);
        changed();
      }}>
        <option value="">{words('选择一个实际产品', 'Select an actual product')}</option>
        {discovery.selections.map(item => <option key={item.productId} value={item.productId}>{seriesById.get(item.productId) || item.datasetId} · {item.productId} · {display(item.subject.id)}</option>)}
      </select></label>
      {!discovery.selections.length && <PageEmpty>{words('此快照的产品目录没有返回条目。索引分钟分区须按原批次回执中的定位信息读取。',
        'The directory returned no entries for this snapshot. Indexed minute partitions require the locator from the original batch receipt.')}</PageEmpty>}
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
        <details className="r1-note"><summary>{words('字段覆盖说明', 'Field coverage notes')}</summary>
          <p className="r1-help">{words('不同固定合同可能覆盖不同字段。共有字段可用于读取旧记录；选中新增字段时，缺少该字段的旧记录由 WFD 列出准确诊断，已有值不补成新字段值。',
            'Fixed contracts can cover different fields. Select shared fields to read older records. When a new field is selected, WFD reports exact diagnostics for records whose contracts do not declare it; existing values are not substituted for new fields.')}</p>
        </details>
      </fieldset>}
      <div className="r1-read-bar">
        <button type="button" className="primary-button" disabled={busy || !fieldsReady} onClick={() => void read(null, 1)}>{words('读取持久数据', 'Read persisted data')}</button>
        <details className="r1-note"><summary>{words('查询预算与超限规则', 'Query budget and limit rules')}</summary>
          <p className="r1-help">{words(`每页 ${discovery.limits.pageSize} 行；单次至多预扫 ${discovery.limits.maxScanRows} 个候选行与 ${discovery.limits.maxScanBytes / 1048576} MiB，完整结果上限 ${discovery.limits.maxResultBytes / 1048576} MiB，等待上限 ${discovery.limits.timeoutMs / 1000} 秒。超限返回错误，不截断为成功。`,
            `${discovery.limits.pageSize} rows per page; at most ${discovery.limits.maxScanRows} candidate rows and ${discovery.limits.maxScanBytes / 1048576} MiB scanned per call, ${discovery.limits.maxResultBytes / 1048576} MiB for the complete result and ${discovery.limits.timeoutMs / 1000} seconds waiting. Budget failures are not truncated into success.`)}</p>
        </details>
      </div>
      <details><summary>{words('查看该快照的公开定义与合同', 'Inspect public definitions and contracts in this snapshot')}</summary>{discovery.selections.length > 0 && <p className="r1-help">{words('索引分钟分区的读取依赖原批次回执中的定位信息。', 'Reading indexed minute partitions depends on the locator in the original batch receipt.')}</p>}<pre className="database-text-preview">{JSON.stringify(discovery.products, null, 2)}</pre></details>
    </div>}
    {result && <div className="r1-read-result r1-query-block" aria-label={words('WFD 实际读取结果', 'Actual WFD read result')}>
      <h4 className="r1-step">{words('读取结果', 'Read result')}</h4>
      <p className="r1-help r1-result-identity">{words('本页来自 WFD 持久读取。', 'This page comes from a persisted WFD read.')} <code>{result.snapshotId}</code> · <code>{result.productId}</code></p>
      <dl className="r1-readout">
        <div><dt>{words('页码', 'Page')}</dt><dd>{words(`第 ${pageIndex} 页`, `${pageIndex}`)}</dd></div>
        <div><dt>{words('本页行', 'Page rows')}</dt><dd>{rows.length}</dd></div>
        <div><dt>{words('可返回总行', 'Total returnable')}</dt><dd>{display(page.total_rows)}</dd></div>
        <div><dt>{words('本页后剩余', 'Remaining after page')}</dt><dd>{Math.max(0, Number(page.remaining_rows) - rows.length)}</dd></div>
      </dl>
      <p className="r1-help" aria-label={words('已核对的历史资格', 'Verified history selection')}>{words('视角', 'Perspective')}：{result.historyMode} · {words('截止', 'Cutoff')}：{display(object(data?.knowledge_cutoff).earliest_utc)} · {words('持有实例', 'Holding instance')}：{display(data?.held_scope)} · {words('阶段', 'Stage')}：{display(data?.usable_stage)}</p>
      {!rows.length && <p className="data-empty">{words('本页没有可返回的业务行；请同时核对诊断与原始结果。', 'This page has no returnable business rows. Inspect diagnostics and the original result.')}</p>}
      {rows.length > 0 && <div className="r1-table-scroll" role="region" tabIndex={0}
        aria-label={words('持久字段值与状态', 'Persisted field values and states')}><table><caption>{words('持久字段值与状态', 'Persisted field values and states')}</caption>
        <thead><tr><th>{words('业务键与版本', 'Business key and version')}</th><th>{words('业务时间与状态', 'Business time and status')}</th>{fields.map(field => <th key={field} title={field}>{reportField(field)}</th>)}</tr></thead>
        <tbody>{rows.map((row, index) => { const ref = object(row.record_ref), time = object(row.business_time), values = object(row.values); return <tr key={index}>
          <td>{display(ref.logical_key ?? ref.record_id)}<small>{display(ref.revision_id ?? ref.record_version)}</small>{historyMode === 'snapshot_contents' && selected && (() => {
            const identity = recordIdentity(selected.datasetId, result.productId, result.snapshotId, ref);
            return identity && <button type="button" className="text-button" data-record-id={identity.recordId} onClick={() => { setEvidenceRun(value => value + 1); setEvidenceIdentity(identity); }}>{words('核对原件', 'Verify original')}</button>;
          })()}</td>
          <td>{time.status === 'known' ? <>{display(time.earliest_utc)}<br />{words('至（不含）', 'until (exclusive)')} {display(time.latest_exclusive_utc)}<small>{display(time.precision)} · {display(time.source_timezone)}</small></>
            : describeState(display(time.status))}</td>
          {fields.map(field => { const cell = object(values[field]), state = display(cell.value_state); return <td key={field}><span>{display(cell.value)}</span>
            <small>{describeState(state)}</small><small>{words('单位', 'Unit')}：{seriesById.get(productId) ? sourceLabel(display(object(cell.unit).unit_code), 'srcunit_') : display(object(cell.unit).unit_code)}</small></td>; })}
        </tr>; })}</tbody></table></div>}
      {historyMode === 'snapshot_contents' && evidenceIdentity && <RecordEvidencePanel key={JSON.stringify([result.snapshotId, result.productId, evidenceIdentity, evidenceRun])} identity={evidenceIdentity} snapshotId={result.snapshotId} connection={result.connection} />}
      <div className="r1-pager">
        <p className="r1-help">{page.has_more ? words('还有后续页；本页不代表全部数据已读完。', 'More pages remain; this page does not mean all data was read.')
        : words('当前固定查询已到末页。完整性与被排除的记录仍以 WFD 诊断为准。', 'This fixed query has reached its final page. Completeness and excluded records are still governed by WFD diagnostics.')}</p>
        <button type="button" className="text-button" disabled={busy || page.has_more !== true || typeof page.next_cursor !== 'string' || !lastRequest} onClick={() => void read(page.next_cursor as string, pageIndex + 1)}>{words('下一页', 'Next page')}</button>
      </div>
      {fieldGaps.length > 0 && <p className="r1-help danger-text">{words(`WFD 返回 ${fieldGaps.length} 条字段覆盖诊断：对应记录的固定合同未声明全部所选字段，未计入本次返回行。可改选共有字段读取已有值；准确记录与缺字段见下方诊断。`,
        `WFD returned ${fieldGaps.length} field-coverage diagnostics. The affected fixed contracts do not declare every selected field, so those records are excluded from this projection. Select shared fields to read their existing values; exact records and missing fields are listed below.`)}</p>}
      {diagnostics.length > 0 && <details open><summary>{words('WFD 读取诊断', 'WFD read diagnostics')} · {diagnostics.length}</summary><pre className="database-text-preview">{JSON.stringify(diagnostics, null, 2)}</pre></details>}
      <details><summary>{words('查看本页原始结果、时间、单位与预算', 'Inspect the original page, times, units and budget')}</summary><pre className="database-text-preview">{JSON.stringify(data, null, 2)}</pre></details>
    </div>}
  </section>;
}
