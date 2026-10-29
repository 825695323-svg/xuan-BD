import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Boxes, CheckCircle2, ChevronRight, Database, FileText, GitBranch, ListChecks, RefreshCw, Search, ShieldAlert } from 'lucide-react';
import type { ConversationAttachmentRef } from '../../../../contracts/contracts';
import type { MaterialEnvelope, MaterialRecord } from '../../../../modules/collection/materials/contracts';
import type { HarnessJob } from '../harness-api';
import { dataBrowserApi, type CandidateView, type OfficialDataView, type OfficialSnapshotView } from '../data-browser-api';
import { ErrorNote, Modal, SelectMenu, errorDetail, useWords } from './Controls';

export interface DatabasePageProps {
  onBringToConversation(text: string, attachments?: ConversationAttachmentRef[]): void | Promise<void>;
}
type Section = 'overview' | 'files' | 'materials' | 'jobs' | 'candidates';
type JobView = HarnessJob & { title?: string; progress?: { message: string; fraction: number | null; timestamp: string } | null; blockedReason?: string | null; createdAt?: number; approvalId?: string | null };

const bytes = (value: number) => value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MiB` : value >= 1024 ? `${(value / 1024).toFixed(1)} KiB` : `${value} B`;
const time = (value: string | number | null | undefined) => {
  if (value === null || value === undefined) return '—';
  const date = new Date(value); return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
};
const newRequestId = (kind: string) => `ui-${kind}-${crypto.randomUUID()}`;
const STATE_LABELS: Record<string, [string, string]> = {
  succeeded: ['已完成', 'Completed'], prepared: ['待提交', 'Ready to submit'], running: ['处理中', 'In progress'],
  waiting_approval: ['待授权', 'Awaiting authorization'], needs_review: ['待核对', 'Needs review'], failed: ['失败', 'Failed'],
  cancelled: ['已取消', 'Cancelled'], committed: ['已提交', 'Committed'], custody_only: ['原件已保管，待补信息', 'Stored; details needed'],
  stored_not_committed: ['已保管，未提交', 'Stored, not committed'], not_sent: ['尚未提交', 'Not submitted'],
  accepted: ['已受理', 'Accepted'], received: ['已保管输入', 'Input stored'], verified: ['已核对', 'Verified'],
  queued: ['排队中', 'Queued'], blocked: ['已阻塞', 'Blocked'], uploading: ['提交中', 'Submitting'], partial: ['部分完成', 'Partially completed'],
  'user-attached': ['用户添加', 'User attached'], 'user-selected': ['用户选择', 'User selected'], generated: ['任务生成', 'Generated'],
  ready: ['可用', 'Ready'], stale: ['已过期', 'Stale'], missing: ['已丢失', 'Missing'],
};
const PURPOSE_LABELS: Record<string, [string, string]> = { user_test: ['用户测试', 'User test'], production: ['正式生产', 'Production'] };
const stateLabel = (state: string, words: (zh: string, en: string) => string) => {
  const item = STATE_LABELS[state];
  return item ? words(item[0], item[1]) : state;
};
const purposeLabel = (purpose: string | null | undefined, words: (zh: string, en: string) => string) => {
  const item = purpose ? PURPOSE_LABELS[purpose] : undefined;
  return item ? words(item[0], item[1]) : purpose ?? '—';
};

/** 数据库页只显示既有服务事实；连接核对、候选动作和固定读回都由用户明确触发。 */
export function DatabasePage({ onBringToConversation }: DatabasePageProps) {
  const words = useWords();
  const [section, setSection] = useState<Section>('overview');
  const [official, setOfficial] = useState<OfficialDataView | null>(null);
  const [officialError, setOfficialError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [candidateRefresh, setCandidateRefresh] = useState(0);

  const loadOfficial = useCallback(async () => {
    try { setOfficial(await dataBrowserApi.official()); setOfficialError(null); }
    catch (failure) { setOfficialError(errorDetail(failure)); }
  }, []);
  useEffect(() => { void loadOfficial(); }, [loadOfficial]);

  const check = async () => {
    if (!official?.line || checking) return;
    setChecking(true); setOfficialError(null);
    try { setOfficial(await dataBrowserApi.checkOfficial(official.line.revision)); }
    catch (failure) { setOfficialError(errorDetail(failure)); await loadOfficial(); }
    finally { setChecking(false); }
  };
  const bring = async () => {
    try {
      await onBringToConversation(words(
        '请帮我按已装配的数据库线路核对连接、实例、用途与权限；只在真实回执和固定读回后说明结果。',
        'Check the bound database line, instance, purpose and permissions. Only report results after real receipts and a fixed readback.',
      ));
    } catch (failure) { setOfficialError(errorDetail(failure)); }
  };

  const nav: Array<{ id: Section; label: string; icon: ReactNode }> = [
    { id: 'overview', label: words('数据库线路', 'Database line'), icon: <Database size={16} /> },
    { id: 'files', label: words('原件与产物', 'Files and outputs'), icon: <FileText size={16} /> },
    { id: 'materials', label: words('材料预览', 'Material previews'), icon: <Boxes size={16} /> },
    { id: 'jobs', label: words('工作台任务', 'Workbench tasks'), icon: <ListChecks size={16} /> },
    { id: 'candidates', label: words('候选与提交', 'Candidates and commits'), icon: <GitBranch size={16} /> },
  ];
  return <div className="data-page database-page">
    <aside className="data-nav" aria-label={words('数据库分类', 'Database sections')}>
      {nav.map(item => <button type="button" key={item.id} className="data-nav-item" aria-current={section === item.id ? 'true' : undefined}
        onClick={() => setSection(item.id)}><span className="database-nav-label">{item.icon}{item.label}</span><span className="data-nav-dot" aria-hidden="true" /></button>)}
    </aside>
    <section className="data-panel database-panel" aria-label={words('数据库', 'Database')}>
      {officialError && <ErrorNote detail={officialError}>{words('数据库状态暂时无法读取。', 'Database status could not be read.')}</ErrorNote>}
      {section === 'overview' && <OfficialPanel official={official} checking={checking} onCheck={() => void check()} onRefresh={() => void loadOfficial()} onBring={() => void bring()}
        onOpenCandidates={() => setSection('candidates')} />}
      {section === 'files' && <FileList />}
      {section === 'materials' && <MaterialList />}
      {section === 'jobs' && <JobList onOpenCandidates={() => setSection('candidates')} />}
      {section === 'candidates' && <CandidateList refreshKey={candidateRefresh} onChanged={() => { setCandidateRefresh(value => value + 1); void loadOfficial(); }} />}
    </section>
  </div>;
}

function OfficialPanel({ official, checking, onCheck, onRefresh, onBring, onOpenCandidates }: {
  official: OfficialDataView | null; checking: boolean; onCheck(): void; onRefresh(): void; onBring(): void; onOpenCandidates(): void;
}) {
  const words = useWords();
  if (!official) return <p className="data-empty">{words('读取数据库线路中…', 'Reading database line…')}</p>;
  const line = official.line, check = official.check, connection = official.connection, generic = official.generic;
  const purpose = line?.selected ? purposeLabel(line.selected.purpose, words) : '—';
  return <div className="database-overview">
    <div className="database-overview-head">
      <div><h2 className="data-panel-title">{words('数据库线路', 'Database line')}</h2>
        <p className="data-panel-sub">{words('用途、权限与产品以本次数据库查询为准；历史回执和旧协议只作兼容参考。', 'Purpose, permissions and products come from the current database query; history and the legacy protocol are compatibility references only.')}</p></div>
      <div className="database-overview-actions"><button type="button" className="text-button" onClick={onRefresh} disabled={checking}><RefreshCw size={15} />{words('刷新状态', 'Refresh')}</button>
        <button type="button" className="primary-button" onClick={onCheck} disabled={!line || checking}>{checking ? words('核对中…', 'Checking…') : words('核对连接与能力', 'Check connection and capabilities')}</button></div>
    </div>
    {!line && <div className="database-gap" role="status"><ShieldAlert size={18} /><div><strong>{words('当前没有已装配的数据库线路。', 'No database line is bound.')}</strong><p>{official.reason ?? words('没有连接、实例或用途可显示；不借用测试目录充当正式生产。', 'No connection, instance or purpose can be shown; a test target is not used as production.')}</p></div></div>}
    {line && <div className="database-line-grid">
      <div className="database-line-card"><span>{words('用途', 'Purpose')}</span><strong>{purpose}</strong><small>{line.selected?.purpose === 'user_test' ? words('用户测试；不是正式生产', 'User test; not production') : words('按线路登记用途显示', 'Shown as registered')}</small></div>
      <div className="database-line-card"><span>{words('模式', 'Mode')}</span><strong>{purposeLabel(line.selected?.mode, words)}</strong><small>{words('本次查询不得改变线路模式', 'The query cannot change the line mode')}</small></div>
      <div className="database-line-card"><span>{words('当前授权', 'Current grant')}</span><strong data-state={generic.grant?.enabled ? 'passed' : generic.status === 'passed' ? 'failed' : undefined}>{generic.grant?.enabled ? words('已授权', 'Granted') : generic.status === 'passed' ? words('未授权', 'Not granted') : words('尚未核对', 'Not checked')}</strong><small>{generic.checkedAt ? words(`上次核对 ${time(generic.checkedAt)}`, `Last checked ${time(generic.checkedAt)}`) : words('登记不等于授权', 'Registration is not a grant')}</small></div>
    </div>}
    <div className="database-section">
      <div className="database-section-head"><h3>{words('当前通用能力（v3）', 'Current generic capabilities (v3)')}</h3>
        <small>{generic.checkedAt ? words(`上次核对 ${time(generic.checkedAt)}`, `Last checked ${time(generic.checkedAt)}`) : words('尚未核对', 'Not checked')}</small></div>
      {generic.status === 'never' && <p className="data-empty">{words('尚未向数据库查询通用能力；线路登记不证明当前可读或已授权。', 'Generic capabilities have not been queried; registration does not prove readability or a current grant.')}</p>}
      {generic.status === 'failed' && <ErrorNote detail={generic.error?.message}>{words('通用能力查询未完成；未用历史回执代替当前能力。', 'The generic capability query did not complete; history was not used as current capability.')}</ErrorNote>}
      {generic.status === 'passed' && <>
        <p className="database-gap-note">{words('本次核对已完成；本线路可读取、保管、提交和查询。具体操作名、实例与协议见详情，每次提交仍按原权限逐次核验。',
          'This check completed; the line can read, store, submit and query. Exact operation names, instance and protocol are in details; each submit is still checked against the original permissions.')}</p>
        <div className="database-meta-row">
          <span>{words('用途', 'Purpose')} {purposeLabel(generic.purpose ?? line?.selected?.purpose, words)} · {words('模式', 'Mode')} {purposeLabel(generic.mode ?? line?.selected?.mode, words)}</span>
          <span>{words('授权', 'Grant')} {generic.grant?.enabled ? words('已授权', 'Granted') : words('未授权', 'Not granted')}</span>
        </div>
        <details className="result-details"><summary>{words('实例、协议与精确权限', 'Instance, protocol and exact permissions')}</summary><dl>
          <dt>{words('实例', 'Instance')}</dt><dd>{generic.instanceId ?? line?.selected?.instanceId ?? '—'}</dd>
          <dt>{words('协议', 'Contract')}</dt><dd>{generic.contract ?? 'wfd.data-service/v1'}</dd>
          <dt>{words('授权', 'Grant')}</dt><dd>{generic.grant?.enabled ? words('已授权', 'Granted') : words('未授权', 'Not granted')}</dd>
          <dt>{words('授权编号', 'Grant ID')}</dt><dd>{generic.grant?.grantId ?? '—'}</dd></dl>
          {generic.grant?.enabled && <div className="database-permissions"><h3>{words('精确权限', 'Exact permissions')}</h3>
            <p>{generic.operations.join(' · ') || words('数据库未返回操作清单。', 'No operations were returned.')}</p>
            <small>{words('授权只覆盖上面列出的操作；提交时仍按原权限逐次核验。', 'The grant covers only the listed operations; each submit is still authorized separately.')}</small></div>}
        </details>
        <div className="database-products">
          {generic.products.length === 0 && <p className="data-empty">{words('本次能力查询没有返回产品。', 'The capability query returned no products.')}</p>}
          {generic.products.map(item => <div className="database-dataset" key={item.productId}>
            <div><strong>{item.productId}</strong><small>{item.namespace ?? words('命名空间未记录', 'namespace not recorded')} · {item.registered ? words('已登记', 'registered') : words('未登记', 'not registered')}</small></div>
            <span className="market-state" data-ok={item.registered}>{item.state ? stateLabel(item.state, words) : item.snapshotIds.length ? words('有快照', 'Snapshot present') : words('无快照', 'No snapshot')}</span>
          </div>)}
          {generic.productsTruncated && <p className="database-gap-note">{words('产品较多，只显示前 50 项。', 'Only the first 50 products are shown.')}</p>}
        </div>
        <p className="database-gap-note">{words('以上是上次核对时的服务端事实；过去成功不等于当前授权或可用。', 'These are server facts at the last check; an earlier success does not prove current authorization or availability.')}</p>
      </>}
    </div>

    <div className="database-section">
      <h3>{words('历史提交回执（本地事实）', 'Historical submit receipts (local facts)')}</h3>
      {official.catalog.items.length === 0 && <p className="data-empty">{words('本机没有已提交回执。它不是数据库当前目录，不另造产品。', 'No submit receipt is stored locally. This is not the current database catalog.')}</p>}
      {official.catalog.items.length > 0 && <p className="data-panel-sub">{words('以下只是本机保存的过去提交记录，不能当成本次服务目录。', 'These are past submit records saved locally, not the current service catalog.')}</p>}
      {official.catalog.items.map(item => <div className="database-product" key={item.productId}>
        <div className="database-product-head"><strong className="path-text">{item.productId}</strong><span className="market-state">{item.namespace ?? words('命名空间未记录', 'namespace not recorded')}</span></div>
        {item.snapshots.map(snapshot => <SnapshotRow snapshot={snapshot} key={`${snapshot.snapshotId}:${snapshot.commitId}`} />)}
      </div>)}
      <p className="database-gap-note"><ShieldAlert size={14} />{official.catalog.reason}</p>
    </div>

    <details className="result-details database-compat">
      <summary>{words('兼容详情（旧 v2 线路协议）', 'Compatibility details (legacy v2 line protocol)')}<span className="market-state" data-state={check.state}>{check.state === 'passed' ? words('兼容核对通过', 'Compatibility passed') : check.state === 'failed' ? words('兼容核对未通过', 'Compatibility failed') : words('本次尚未核对', 'Not checked in this run')}</span></summary>
      <p className="data-panel-sub">{words('旧协议只用于兼容核对，不代表当前通用 v3 能力；以下操作与数据集不授权提交。', 'The legacy protocol is checked for compatibility only and does not represent current v3 capability; its operations and datasets authorize no submit.')}</p>
      {check.state === 'failed' && <ErrorNote detail={check.error?.code}>{check.error?.message ?? words('连接核对未完成。', 'The connection check did not complete.')}</ErrorNote>}
      <div className="database-meta-row"><span>{words('协议', 'Protocol')} {line?.selected?.protocol ?? '—'} · {line?.selected?.protocolRevision ?? '—'}</span>
        <span>{words('连接', 'Connection')} {line?.connectionId ?? '—'}</span>
        <span>{words('实例', 'Instance')} {line?.selected?.instanceId ?? '—'}</span>
        <span>{words('派发', 'Dispatch')} {line?.dispatchBlocked ? words('封闭', 'Blocked') : words('可派发', 'Open')}</span>
        <span>{words('业务账', 'Business ledger')} {line?.businessLedgerReady ? words('齐备', 'Ready') : words('缺项', 'Incomplete')}</span>
        <span>{words('正式生产', 'Production')} {official.productionBinding === 'unbound' ? words('未绑定', 'Unbound') : official.productionBinding}</span></div>
      {check.permissions && <div className="database-permissions">
        <h3>{words('旧协议核到的权限（兼容）', 'Permissions observed by the legacy protocol')}</h3>
        <p>{check.permissions.operations.join(' · ') || words('没有可用操作。', 'No operations reported.')}</p>
        <small>{words('读取上限', 'Read limit')} {check.permissions.maxReadRows ?? '—'} · {words('时间能力', 'Time capability')} {check.permissions.timeCapability ?? '—'} · {words('正式写入', 'Production write')} {check.permissions.productionEnabled ? words('已启用', 'Enabled') : words('未启用', 'Disabled')}</small>
      </div>}
      <h3>{words('旧协议数据集（兼容）', 'Legacy datasets (compatibility)')}</h3>
      {official.datasets.length === 0 && <p className="data-empty">{check.state === 'never' ? words('尚未核对旧协议；连接登记不证明当前可读。', 'The legacy protocol has not been checked; registration does not prove readability.') : words('旧协议没有返回数据集；不补造目录。', 'The legacy protocol returned no dataset; no catalog is invented.')}</p>}
      {official.datasets.map(dataset => <div className="database-dataset" key={dataset.datasetId}>
        <div><strong>{dataset.datasetId}</strong><small>{dataset.contractVersion ?? '—'} · {dataset.mappingVersion ?? '—'} · {dataset.allowedPurposes.join(' / ') || '—'}</small></div>
        <span className="market-state" data-ok={dataset.readable && dataset.headSnapshotId !== null}>{dataset.headSnapshotId ? words('有固定快照', 'Fixed snapshot present') : words('无已提交快照', 'No committed snapshot')}</span>
        <small className="path-text">{dataset.snapshotIds.length ? words(`快照：${dataset.snapshotIds.join('、')}`, `Snapshots: ${dataset.snapshotIds.join(', ')}`) : words('能力中没有该数据集的快照身份；固定读回不会用 latest 拼造。', 'No snapshot identity in capabilities; a fixed readback will not be assembled from latest.')}</small>
      </div>)}
      {check.fixedRead && <p className="database-fixed-read">{check.fixedRead.state === 'verified'
        ? words(`固定读回已核：${check.fixedRead.datasetId} · ${check.fixedRead.snapshotId}`, `Fixed readback verified: ${check.fixedRead.datasetId} · ${check.fixedRead.snapshotId}`)
        : words(`线路核对为空态：${check.fixedRead.datasetIds.join('、') || '无数据集'}。${check.fixedRead.reason}`, `Line check is empty: ${check.fixedRead.datasetIds.join(', ') || 'no datasets'}. ${check.fixedRead.reason}`)}</p>}
      <dl><dt>{words('主体', 'Principal')}</dt><dd>{line?.selected?.principalId ?? '—'}</dd><dt>{words('连接身份', 'Connection')}</dt><dd>{connection}</dd></dl>
    </details>
    <div className="database-actions"><button type="button" className="text-button" onClick={onBring}>{words('在会话中继续数据库处理', 'Continue database work in a conversation')}</button>
      <span className="database-hint">{words('只把说明加入会话草稿；发送后仍按原权限核验。', 'Adds a note to the draft; permissions are still checked after sending.')}</span></div>
  </div>;
}

function SnapshotRow({ snapshot }: { snapshot: OfficialSnapshotView }) {
  const words = useWords();
  const partial = snapshot.readback && snapshot.readback.state === 'verified' ? false : snapshot.state !== 'committed';
  return <div className="database-snapshot">
    <div className="database-snapshot-head"><strong>{snapshot.outputId}</strong><span className="market-state" data-state={snapshot.state}>{stateLabel(snapshot.state, words)}</span>
      {partial && <span className="market-state">{words('未形成固定入库', 'No fixed commit')}</span>}</div>
    {snapshot.coverage && <small>{snapshot.coverage.complete ? words('覆盖完整', 'Coverage complete') : words(`覆盖缺口：${snapshot.coverage.gaps.join('；') || '范围未完成'}`, `Coverage gaps: ${snapshot.coverage.gaps.join('; ') || 'scope incomplete'}`)}</small>}
    {snapshot.readback ? <small className="database-readback"><CheckCircle2 size={13} />{words(`已核对读回 ${snapshot.readback.rows} 行`, `Readback verified: ${snapshot.readback.rows} rows`)}</small>
      : <small>{words('没有固定读回；不能只凭提交回执声称可读。', 'No fixed readback; the commit receipt alone does not prove readability.')}</small>}
    {snapshot.issues.length > 0 && <ul className="database-issues">{snapshot.issues.map((issue, index) => <li key={`${issue.code}:${index}`}>{issue.message}</li>)}</ul>}
    <details className="result-details"><summary>{words('提交、快照与请求身份', 'Commit, snapshot and request identity')}</summary><dl>
      <dt>{words('提交', 'Commit')}</dt><dd>{snapshot.commitId}</dd><dt>{words('快照', 'Snapshot')}</dt><dd>{snapshot.snapshotId}</dd>
      {snapshot.readback && <><dt>{words('读回摘要', 'Readback digest')}</dt><dd>{snapshot.readback.rowsSha256}</dd></>}
      {snapshot.issues.length > 0 && <><dt>{words('问题码', 'Issue codes')}</dt><dd>{snapshot.issues.map(issue => issue.code).join(' · ')}</dd></>}
      <dt>{words('任务', 'Task')}</dt><dd>{snapshot.taskId}</dd><dt>{words('请求', 'Request')}</dt><dd>{snapshot.requestId}</dd></dl></details>
  </div>;
}

function SearchBar({ value, onChange, placeholder }: { value: string; onChange(value: string): void; placeholder: string }) {
  return <div className="data-search"><Search size={15} aria-hidden="true" /><input type="search" value={value} onChange={event => onChange(event.currentTarget.value)} placeholder={placeholder} aria-label={placeholder} /></div>;
}

function usePaged<T>(load: (query: string, cursor: string | null) => Promise<{ items: T[]; nextCursor: string | null; availability: 'available' | 'unavailable'; scope: string }>) {
  const [items, setItems] = useState<T[]>([]), [nextCursor, setNextCursor] = useState<string | null>(null);
  const [query, setQuery] = useState(''), [applied, setApplied] = useState(''), [loading, setLoading] = useState(false);
  const [availability, setAvailability] = useState<'available' | 'unavailable'>('available'), [scope, setScope] = useState('');
  const [error, setError] = useState<string | null>(null), epoch = useRef(0);
  useEffect(() => { const timer = window.setTimeout(() => setApplied(query.trim()), 300); return () => window.clearTimeout(timer); }, [query]);
  const read = useCallback(async (cursor: string | null, append: boolean) => {
    const current = ++epoch.current; setLoading(true); setError(null);
    try {
      const page = await load(applied, cursor);
      if (epoch.current !== current) return;
      setItems(existing => append ? [...existing, ...page.items] : page.items);
      setNextCursor(page.nextCursor); setAvailability(page.availability); setScope(page.scope);
    } catch (failure) { if (epoch.current === current) { setError(errorDetail(failure)); if (!append) setItems([]); } }
    finally { if (epoch.current === current) setLoading(false); }
  }, [applied, load]);
  useEffect(() => { void read(null, false); }, [read]);
  return { items, nextCursor, query, setQuery, loading, availability, scope, error, reload: () => void read(null, false), more: () => nextCursor && void read(nextCursor, true) };
}

function ListState({ loading, error, availability, empty, children }: {
  loading: boolean; error: string | null; availability: 'available' | 'unavailable'; scope: string; empty: boolean; children: React.ReactNode;
}) {
  const words = useWords();
  return <>{error && <ErrorNote detail={error}>{words('列表暂时无法读取，未用本地旧数据代替。', 'The list could not be read; stale local data is not used.')}</ErrorNote>}
    {availability === 'unavailable' && <p className="data-empty" role="status">{words('此工作台能力尚未装配或当前不可达；不是空列表。', 'This workbench capability is not bound or reachable; this is not an empty list.')}</p>}
    {loading && empty && !error ? <p className="data-empty">{words('读取中…', 'Loading…')}</p> : null}
    {availability === 'available' && !loading && empty && !error ? <p className="data-empty">{words('没有匹配记录。', 'No matching records.')}</p> : null}
    {children}</>;
}

function FileList() {
  const words = useWords(), [group, setGroup] = useState<'materials' | 'outputs'>('materials');
  const load = useCallback((query: string, cursor: string | null) => dataBrowserApi.files(group, query, cursor), [group]);
  const page = usePaged(load);
  return <div className="database-list-page">
    <div className="database-overview-head"><div><h2 className="data-panel-title">{words('原件与产物', 'Files and outputs')}</h2><p className="data-panel-sub">{words('个人文件引用；材料保管另见材料预览。', 'Personal file references; material custody is listed separately.')}</p></div>
      <div className="market-chips"><button type="button" className="market-chip" aria-pressed={group === 'materials'} onClick={() => setGroup('materials')}>{words('材料引用', 'Material refs')}</button><button type="button" className="market-chip" aria-pressed={group === 'outputs'} onClick={() => setGroup('outputs')}>{words('任务产物', 'Task outputs')}</button></div></div>
    <SearchBar value={page.query} onChange={page.setQuery} placeholder={words('搜索文件名或编号', 'Search name or ID')} />
    <ListState loading={page.loading} error={page.error} availability={page.availability} scope={page.scope} empty={!page.items.length}>
      <div className="database-list">{page.items.map(file => <article className="database-row" key={file.id}><FileText size={17} aria-hidden="true" />
        <div className="database-row-main"><strong>{file.displayName}</strong><small>{stateLabel(file.source, words)} · {bytes(file.size)} · v{file.version} · {stateLabel(file.status, words)}</small>
          <details className="result-details"><summary>{words('文件身份与关联', 'File identity and relations')}</summary><dl><dt>{words('编号', 'ID')}</dt><dd>{file.id}</dd><dt>{words('关联', 'Relations')}</dt><dd>{file.relations.map(relation => `${relation.kind}:${relation.id}`).join(' · ') || '—'}</dd></dl></details></div>
        <span className="market-state">{file.kind}</span></article>)}</div>
      {page.nextCursor && <button type="button" className="text-button database-more" disabled={page.loading} onClick={page.more}>{words('加载更多', 'Load more')}</button>}
    </ListState>
  </div>;
}

function MaterialList() {
  const words = useWords(), [preview, setPreview] = useState<MaterialRecord | null>(null), [previewError, setPreviewError] = useState<string | null>(null);
  const load = useCallback((query: string, cursor: string | null) => dataBrowserApi.materials(query, cursor), []);
  const page = usePaged<MaterialEnvelope>(load);
  const open = async (item: MaterialEnvelope) => {
    setPreviewError(null);
    try { setPreview(await dataBrowserApi.material(item.materialId)); }
    catch (failure) { setPreviewError(errorDetail(failure)); }
  };
  return <div className="database-list-page">
    <div className="database-overview-head"><div><h2 className="data-panel-title">{words('材料预览', 'Material previews')}</h2><p className="data-panel-sub">{words('只列已完成保管的原件；点击查看只读预览，不自动解析或入库。', 'Only completed custody is listed; previews are read-only and never trigger parsing or ingestion.')}</p></div></div>
    <SearchBar value={page.query} onChange={page.setQuery} placeholder={words('搜索材料名称、编号或类别', 'Search material, ID or category')} />
    {previewError && <ErrorNote detail={previewError}>{words('材料预览未能读取。', 'The material preview could not be read.')}</ErrorNote>}
    <ListState loading={page.loading} error={page.error} availability={page.availability} scope={page.scope} empty={!page.items.length}>
      <div className="database-list">{page.items.map(item => <button type="button" className="database-row database-row--button" key={item.materialId} onClick={() => void open(item)}>
        <Boxes size={17} aria-hidden="true" /><div className="database-row-main"><strong>{item.filename}</strong><small>{item.category} · {bytes(item.byteLength)} · {item.adapter ? `${item.adapter.id}/${item.adapter.version}` : words('无适配器', 'no adapter')} · {time(item.createdAt)}</small></div><ChevronRight size={16} /></button>)}</div>
      {page.nextCursor && <button type="button" className="text-button database-more" disabled={page.loading} onClick={page.more}>{words('加载更多', 'Load more')}</button>}
    </ListState>
    {preview && <Modal title={words('材料只读预览', 'Read-only material preview')} onClose={() => setPreview(null)}>
      <MaterialPreview record={preview} />
    </Modal>}
  </div>;
}

function MaterialPreview({ record }: { record: MaterialRecord }) {
  const words = useWords(), preview = record.preview, table = preview.table;
  return <div className="material-preview">
    <p><strong>{record.envelope.filename}</strong> · {preview.format} · {preview.support} · {bytes(record.envelope.byteLength)}</p>
    <p className="subtle-text">{preview.reason}</p>
    <p className="database-scope">{words('检查', 'Checks')} {preview.checks.status} · {words('清洗变化', 'Cleaning changes')} {preview.cleaning.totalChanges} · {words('限制', 'Limits')} {preview.limitations.join('；') || '—'}</p>
    {preview.checks.issues.length > 0 && <ul className="database-issues">{preview.checks.issues.map((issue, index) => <li key={`${issue.code}:${index}`}>{issue.code} · {issue.message}</li>)}</ul>}
    {table && <div className="table-scroll"><table><caption>{words(`预览 ${table.rows.length} / ${table.totalRows} 行`, `Preview ${table.rows.length} / ${table.totalRows} rows`)}</caption>
      <thead><tr>{table.columns.map(column => <th key={column.name}>{column.name}</th>)}</tr></thead><tbody>{table.rows.slice(0, 50).map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell.proposed === null ? '—' : String(cell.proposed)}</td>)}</tr>)}</tbody></table></div>}
    {!table && preview.text && <pre className="database-text-preview">{preview.text.proposed.slice(0, 6000)}</pre>}
    <details className="result-details"><summary>{words('材料身份', 'Material identity')}</summary><dl><dt>{words('材料', 'Material')}</dt><dd>{record.envelope.materialId}</dd><dt>{words('原件摘要', 'Original digest')}</dt><dd>{record.envelope.sha256}</dd><dt>{words('任务', 'Task')}</dt><dd>{record.envelope.taskId}</dd></dl></details>
  </div>;
}

function JobList({ onOpenCandidates }: { onOpenCandidates(): void }) {
  const words = useWords();
  const load = useCallback((query: string, cursor: string | null) => dataBrowserApi.jobs(query, cursor), []);
  const page = usePaged<JobView>(load);
  return <div className="database-list-page">
    <div className="database-overview-head"><div><h2 className="data-panel-title">{words('工作台任务', 'Workbench tasks')}</h2><p className="data-panel-sub">{words('含运行中、待审批、结果待核、失败和已保存结果，不只列有结果的记录。', 'Includes running, waiting approval, unconfirmed, failed and saved results, not only completed ones.')}</p></div></div>
    <SearchBar value={page.query} onChange={page.setQuery} placeholder={words('搜索操作、状态、摘要或编号', 'Search operation, status, summary or ID')} />
    <ListState loading={page.loading} error={page.error} availability={page.availability} scope={page.scope} empty={!page.items.length}>
      <div className="database-list">{page.items.map(job => <article className="database-row" key={job.jobId}><ListChecks size={17} aria-hidden="true" /><div className="database-row-main">
        <strong>{job.title ?? job.operation}</strong><small>{stateLabel(job.status, words)} · {time(job.createdAt)} {job.progress?.message ? ` · ${job.progress.message}` : ''}</small>
        {job.approvalId && <p className="result-approval"><ShieldAlert size={14} />{words('等待本机操作者在会话审批条处理。', 'Waiting for the local operator in the existing approval strip.')}</p>}
        <p>{job.result?.summary ?? job.error?.message ?? job.blockedReason ?? (job.status === 'waiting_approval' ? words('等待授权。', 'Awaiting authorization.') : words('任务已受理，结果尚未确认。', 'Accepted; outcome not yet confirmed.'))}</p>
        <details className="result-details"><summary>{words('任务身份与回执', 'Task identity and receipt')}</summary><dl><dt>{words('任务', 'Task')}</dt><dd>{job.jobId}</dd><dt>{words('操作', 'Operation')}</dt><dd>{job.operation}</dd><dt>{words('请求', 'Request')}</dt><dd>{job.requestId}</dd><dt>{words('状态', 'Status')}</dt><dd>{stateLabel(job.status, words)}{job.requiresReview ? words(' · 待核', ' · unconfirmed') : ''}</dd><dt>{words('错误码', 'Error code')}</dt><dd>{job.error?.code ?? '—'}</dd></dl></details>
      </div>{job.operation.startsWith('data.candidates.') && <button type="button" className="text-button" onClick={onOpenCandidates}>{words('查看候选', 'Candidates')}</button>}</article>)}</div>
      {page.nextCursor && <button type="button" className="text-button database-more" disabled={page.loading} onClick={page.more}>{words('加载更多', 'Load more')}</button>}
    </ListState>
  </div>;
}

function CandidateList({ refreshKey, onChanged }: { refreshKey: number; onChanged(): void }) {
  const words = useWords(), [refresh, setRefresh] = useState(0), [action, setAction] = useState<{ kind: 'submit' | 'resume' | 'cancel'; item: CandidateView } | null>(null), [actionError, setActionError] = useState<string | null>(null);
  const load = useCallback((query: string, cursor: string | null) => dataBrowserApi.candidates(query, cursor), []);
  const page = usePaged<CandidateView>(load);
  useEffect(() => { if (refreshKey) page.reload(); }, [refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (refresh) page.reload(); }, [refresh]); // eslint-disable-line react-hooks/exhaustive-deps
  return <div className="database-list-page">
    <div className="database-overview-head"><div><h2 className="data-panel-title">{words('候选与提交', 'Candidates and commits')}</h2><p className="data-panel-sub">{words('逐项显示材料保管、待补信息、提交与核对结果；只有你明确发起才会提交。', 'Per-item custody, missing information, submit and check results; nothing is submitted until you explicitly ask.')}</p></div><button type="button" className="text-button" onClick={() => setRefresh(value => value + 1)}><RefreshCw size={15} />{words('刷新候选', 'Refresh')}</button></div>
    <SearchBar value={page.query} onChange={page.setQuery} placeholder={words('搜索材料、候选、产品、快照或状态', 'Search material, candidate, product, snapshot or state')} />
    <ListState loading={page.loading} error={page.error} availability={page.availability} scope={page.scope} empty={!page.items.length}>
      {actionError && <ErrorNote detail={actionError}>{words('候选核对未完成；未改写原事实。', 'The candidate check did not complete; the original facts were not rewritten.')}</ErrorNote>}
      <div className="database-list">{page.items.map(item => <CandidateCard key={item.taskId} item={item} onAction={kind => setAction({ kind, item })} onReconcile={() => void reconcileCandidate(item)} />)}</div>
      {page.nextCursor && <button type="button" className="text-button database-more" disabled={page.loading} onClick={page.more}>{words('加载更多', 'Load more')}</button>}
    </ListState>
    {action && <CandidateActionModal action={action} onClose={() => setAction(null)}
      onChanged={() => { setRefresh(value => value + 1); onChanged(); }}
      onDone={() => { setAction(null); setRefresh(value => value + 1); onChanged(); }} />}
  </div>;

  async function reconcileCandidate(item: CandidateView) {
    setActionError(null);
    try { await dataBrowserApi.reconcileCandidate(item.taskId); setRefresh(value => value + 1); onChanged(); }
    catch (failure) { setActionError(errorDetail(failure)); }
  }
}

function CandidateCard({ item, onAction, onReconcile }: { item: CandidateView; onAction(kind: 'submit' | 'resume' | 'cancel'): void; onReconcile(): void }) {
  const words = useWords(), partial = item.database.committed > 0 && (item.database.storedNotCommitted > 0 || item.database.rejected > 0);
  const state = item.status === 'failed' ? 'failed' : item.requiresReview || item.status === 'needs_review' || partial ? 'needs_review' : item.status === 'succeeded' ? 'succeeded' : 'running';
  const fact = state === 'succeeded' ? (item.database.committed > 0 ? 'committed' : item.database.storedNotCommitted > 0 ? 'stored_not_committed' : 'prepared') : state;
  const actions = item.actionability;
  return <article className="database-row database-row--candidate"><GitBranch size={17} aria-hidden="true" /><div className="database-row-main">
    <div className="result-heading"><strong>{item.title}</strong><span className="task-state" data-state={state}>{stateLabel(fact, words)}{partial ? words(' · 部分完成', ' · partially completed') : ''}</span></div>
    <small>{words('候选准备', 'Candidate preparation')} · {time(item.createdAt)} · {words('数据库', 'Database')}：{stateLabel(item.database.receiptState ?? item.database.state, words)}</small>
    {item.progress?.message && <p>{item.progress.message}</p>}
    {item.blockedReason && <p className="status-warning">{item.blockedReason}</p>}
    {item.error && <p className="danger-text">{item.error.message}</p>}
    {item.approvalId && <p className="result-approval"><ShieldAlert size={14} />{words('等待你在会话审批条处理；这里不新增批准权。', 'Waiting for you in the conversation approval strip; no new approval authority here.')}</p>}
    <div className="candidate-summary"><span>{words(`已提交 ${item.database.committed}`, `${item.database.committed} committed`)}</span><span>{words(`已保管未提交 ${item.database.storedNotCommitted}`, `${item.database.storedNotCommitted} stored only`)}</span><span>{words(`拒绝/取消 ${item.database.rejected}`, `${item.database.rejected} rejected/cancelled`)}</span></div>
    <ul className="candidate-outputs">{item.outputs.map(output => <li key={output.outputId} data-state={output.state}>
      <span className="candidate-output-name">{output.outputId}</span>
      <span className="candidate-output-state">{stateLabel(output.state, words)}</span>
      {output.coverage && !output.coverage.complete && <span className="candidate-output-gap">{words(`待补信息：${output.coverage.gaps.join('；') || '范围未完成'}`, `Information needed: ${output.coverage.gaps.join('; ') || 'scope incomplete'}`)}</span>}
      {output.readback?.state === 'verified' && <span className="candidate-output-readback">{words(`已核对读回 ${output.readback.rows} 行`, `Readback verified: ${output.readback.rows} rows`)}</span>}
      {output.issues.map((issue, index) => <span className="candidate-output-gap" key={index}>{issue.message}</span>)}
    </li>)}</ul>
    <details className="result-details"><summary>{words('身份、协议与原始回执', 'Identity, protocol and raw receipts')}</summary>
      <dl><dt>{words('任务', 'Task')}</dt><dd>{item.taskId}</dd><dt>{words('原请求', 'Request')}</dt><dd>{item.requestId}</dd>
        <dt>{words('操作', 'Operation')}</dt><dd>{item.action}</dd>
        {item.error && <><dt>{words('错误码', 'Error code')}</dt><dd>{item.error.code}</dd></>}
        {item.database.requestId && <><dt>{words('数据库请求', 'Database request')}</dt><dd>{item.database.requestId}</dd></>}
        {item.database.instanceId && <><dt>{words('实例', 'Instance')}</dt><dd>{item.database.instanceId}</dd></>}</dl>
      {item.outputs.map(output => <div className="candidate-output-detail" key={output.outputId}><strong>{output.outputId}</strong>
        <small>{output.namespace} · {output.productId ?? words('产品尚未确定', 'No product yet')} · {output.snapshotId ?? words('快照尚未形成', 'No snapshot yet')}</small>
        {output.commitId && <small>{words('提交', 'Commit')} {output.commitId}</small>}
        {output.readback && <small>{words('读回摘要', 'Readback digest')} {output.readback.rowsSha256}</small>}
        {output.issues.map((issue, index) => <small key={index}>{issue.code} · {issue.message}</small>)}
      </div>)}</details>
    <div className="database-actions">
      {actions.canSubmit && <button type="button" className="primary-button" onClick={() => onAction('submit')}>{words('明确提交…', 'Commit explicitly…')}</button>}
      {actions.canResume && <button type="button" className="text-button" onClick={() => onAction('resume')}>{words('续接…', 'Resume…')}</button>}
      {actions.canCancel && <button type="button" className="text-button" onClick={() => onAction('cancel')}>{words('取消…', 'Cancel…')}</button>}
      {actions.canReconcile && <button type="button" className="text-button" onClick={onReconcile}>{words('核对原请求', 'Check original request')}</button>}
      {!actions.canSubmit && !actions.canResume && !actions.canCancel && !actions.canReconcile && <span className="database-hint">{words('当前没有可执行的候选动作；保持原事实。', 'No candidate action is available; the original facts are preserved.')}</span>}
    </div>
  </div></article>;
}

function CandidateActionModal({ action, onClose, onChanged, onDone }: {
  action: { kind: 'submit' | 'resume' | 'cancel'; item: CandidateView }; onClose(): void; onChanged(): void; onDone(): void;
}) {
  const words = useWords(), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [receipt, setReceipt] = useState<HarnessJob | null>(null);
  const [completion, setCompletion] = useState<'accepted' | 'received' | 'committed'>('committed');
  const [reason, setReason] = useState('');
  const requestId = useRef(newRequestId(action.kind));
  const run = async () => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const result = action.kind === 'submit'
        ? await dataBrowserApi.submitCandidate(action.item.taskId, completion, requestId.current)
        : await dataBrowserApi.controlCandidate(action.item.taskId, action.kind === 'cancel' ? 'cancel' : 'resume',
          action.kind === 'cancel' ? reason.trim() : completion, requestId.current);
      setReceipt(result); onChanged();
      if (result.status !== 'waiting_approval') onDone();
    } catch (failure) { setError(errorDetail(failure)); }
    finally { setBusy(false); }
  };
  const title = action.kind === 'submit' ? words('明确提交候选', 'Commit candidate explicitly')
    : action.kind === 'resume' ? words('续接原数据库交接', 'Resume original database handoff') : words('取消原数据库交接', 'Cancel original database handoff');
  return <Modal title={title} onClose={onClose} busy={busy}>
    <p>{action.kind === 'submit' ? words('这会直接调用原受控服务向数据库提交；只有真实 committed 身份和固定读回才算入库。', 'This calls the original controlled service to commit to the database; only a real committed identity and fixed readback count as a commit.')
      : action.kind === 'resume' ? words('沿原任务、实例、协议和原请求续接，不重新创建产品或换号重发。', 'Resume along the original task, instance, protocol and request; no new product or request ID.')
        : words('取消的是原数据库交接，不是本机窗口；已提交的结果不会被伪称撤销。', 'This cancels the original database handoff, not the local window; an existing commit is not falsely revoked.')}</p>
    {action.kind !== 'cancel' && <SelectMenu label={words('完成条件', 'Completion condition')} value={completion} disabled={busy}
      options={action.kind === 'submit' ? [{ value: 'accepted', label: words('受理', 'Accepted') }, { value: 'received', label: words('保管输入', 'Input stored') }, { value: 'committed', label: words('正式提交', 'Committed') }]
        : [{ value: 'received', label: words('保管输入', 'Input stored') }, { value: 'committed', label: words('正式提交', 'Committed') }]}
      onChange={value => setCompletion(value as typeof completion)} />}
    {action.kind === 'cancel' && <label className="field-label">{words('取消原因', 'Cancellation reason')}<textarea value={reason} disabled={busy} maxLength={2000} onChange={event => setReason(event.currentTarget.value)} /></label>}
    {receipt && <div className="database-receipt" role="status"><strong>{words('原受控服务回执', 'Original service receipt')}</strong><p>{receipt.status === 'waiting_approval' ? words('任务已受理并等待操作者审批；请到会话审批条处理。', 'Accepted and waiting for operator approval; use the conversation approval strip.')
      : words(`任务 ${receipt.status}；最终入库仍以数据库 committed 身份与固定读回为准。`, `Task ${receipt.status}; final commit still depends on the database committed identity and fixed readback.`)}</p>
      <small>{receipt.jobId}</small></div>}
    {error && <ErrorNote detail={error}>{words('动作结果未确认。请先刷新候选或核对原请求，不要换请求编号重复提交。', 'The action result is unconfirmed. Refresh the candidate or check the original request; do not resubmit with a new request ID.')}</ErrorNote>}
    <div className="dialog-actions"><button type="button" className="text-button" disabled={busy} onClick={onClose}>{words('关闭', 'Close')}</button>
      {action.kind === 'cancel' && <button type="button" className="danger-button" disabled={busy || !reason.trim()} onClick={() => void run()}>{busy ? words('取消中…', 'Cancelling…') : words('确认取消', 'Confirm cancel')}</button>}
      {action.kind !== 'cancel' && <button type="button" className="primary-button" disabled={busy} onClick={() => void run()}>{busy ? words('提交中…', 'Submitting…') : words('确认执行', 'Confirm')}</button>}</div>
  </Modal>;
}

export default DatabasePage;
