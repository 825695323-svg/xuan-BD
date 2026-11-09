import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Boxes, CheckCircle2, ChevronRight, ShieldAlert, FileText, GitBranch, ListChecks, RefreshCw, Search } from 'lucide-react';
import type { ConversationAttachmentRef } from '../../../../contracts/contracts';
import type { MaterialEnvelope, MaterialRecord } from '../../../../modules/collection/materials/contracts';
import type { BdJob } from '../bd-api';
import { dataBrowserApi, type MaterialProcessingOutput } from '../data-browser-api';
import { ErrorNote, Modal, SelectMenu, errorDetail, useWords } from './Controls';
import { R1Panel } from './R1Panel';
import type { AlgorithmEntryFocus } from './algorithm-catalog';

export interface DatabasePageProps {
  onBringToConversation(text: string, attachments?: ConversationAttachmentRef[]): void | Promise<void>;
  algorithmFocus?: AlgorithmEntryFocus | null;
}
type Section = 'r1' | 'files' | 'materials' | 'jobs';
type JobView = BdJob & { title?: string; progress?: { message: string; fraction: number | null; timestamp: string } | null; blockedReason?: string | null; createdAt?: number; approvalId?: string | null };

const bytes = (value: number) => value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MiB` : value >= 1024 ? `${(value / 1024).toFixed(1)} KiB` : `${value} B`;
const time = (value: string | number | null | undefined) => {
  if (value === null || value === undefined) return '—';
  const date = new Date(value); return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
};
const STATE_LABELS: Record<string, [string, string]> = {
  succeeded: ['已完成', 'Completed'], prepared: ['已准备', 'Prepared'], running: ['处理中', 'In progress'],
  waiting_approval: ['待授权', 'Awaiting authorization'], needs_review: ['待核对', 'Needs review'], failed: ['失败', 'Failed'],
  cancelled: ['已取消', 'Cancelled'], committed: ['已提交', 'Committed'], custody_only: ['原件已保管，待补信息', 'Stored; details needed'],
  stored_not_committed: ['已保管，未提交', 'Stored, not committed'], not_sent: ['尚未提交', 'Not submitted'],
  accepted: ['已受理', 'Accepted'], received: ['已保管输入', 'Input stored'], verified: ['已核对', 'Verified'],
  queued: ['排队中', 'Queued'], blocked: ['已阻塞', 'Blocked'], uploading: ['提交中', 'Submitting'], partial: ['部分完成', 'Partially completed'],
  'user-attached': ['用户添加', 'User attached'], 'user-selected': ['用户选择', 'User selected'], generated: ['任务生成', 'Generated'],
  ready: ['可用', 'Ready'], stale: ['已过期', 'Stale'], missing: ['已丢失', 'Missing'],
};
const stateLabel = (state: string, words: (zh: string, en: string) => string) => {
  const item = STATE_LABELS[state];
  return item ? words(item[0], item[1]) : state;
};
const materialProcessingLabels: Record<string, [string, string]> = {
  needs_classification: ['待分类', 'Needs classification'], needs_adapter: ['待适配', 'Adapter needed'],
  needs_target: ['待确定目标', 'Target needed'], needs_review: ['待核对', 'Needs review'],
  ready_candidate: ['可进入候选准备', 'Ready for candidate preparation'], rejected: ['已本地拒绝', 'Rejected locally'],
  pending: ['待形成结构产物', 'Structure pending'], structured: ['结构产物已形成', 'Structure formed'],
  blocked: ['被缺口阻塞', 'Blocked by gaps'], failed: ['处理失败', 'Failed'], custody_only: ['仅保管原件', 'Custody only'],
};
const materialProcessingLabel = (state: string, words: (zh: string, en: string) => string) => {
  const item = materialProcessingLabels[state];
  return item ? words(item[0], item[1]) : words('状态待核', 'Status unconfirmed');
};
/** 数据库页只显示既有服务事实；连接核对、候选动作和固定读回都由用户明确触发。 */
export function DatabasePage({ onBringToConversation, algorithmFocus = null }: DatabasePageProps) {
  const words = useWords();
  const [section, setSection] = useState<Section>('r1');
  useEffect(() => { if (algorithmFocus) setSection('r1'); }, [algorithmFocus]);
  const nav: Array<{ id: Section; label: string; icon: ReactNode }> = [
    { id: 'r1', label: words('R1 结构化交接', 'R1 structured handoff'), icon: <GitBranch size={16} /> },
    { id: 'files', label: words('原件与产物', 'Files and outputs'), icon: <FileText size={16} /> },
    { id: 'materials', label: words('材料预览', 'Material previews'), icon: <Boxes size={16} /> },
    { id: 'jobs', label: words('工作台任务', 'Workbench tasks'), icon: <ListChecks size={16} /> },
  ];
  return <div className="data-page database-page">
    <aside className="data-nav" aria-label={words('数据库分类', 'Database sections')}>
      {nav.map(item => <button type="button" key={item.id} className="data-nav-item" aria-current={section === item.id ? 'true' : undefined}
        onClick={() => setSection(item.id)}><span className="database-nav-label">{item.icon}{item.label}</span><span className="data-nav-dot" aria-hidden="true" /></button>)}
    </aside>
    <section className="data-panel database-panel" aria-label={words('数据库', 'Database')}>
      {section === 'r1' && <R1Panel algorithmFocus={algorithmFocus} />}
      {section === 'files' && <FileList />}
      {section === 'materials' && <MaterialList />}
      {section === 'jobs' && <JobList />}
    </section>
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
  const [processing, setProcessing] = useState<{ state: 'loading' | 'unclassified' | 'ready' | 'error'; outputs: MaterialProcessingOutput[]; error: string | null }>(
    { state: 'loading', outputs: [], error: null });
  const requestEpoch = useRef(0);
  useEffect(() => () => { requestEpoch.current++; }, []);
  const load = useCallback((query: string, cursor: string | null) => dataBrowserApi.materials(query, cursor), []);
  const page = usePaged<MaterialEnvelope>(load);
  const open = async (item: MaterialEnvelope) => {
    const epoch = ++requestEpoch.current;
    setPreview(null); setPreviewError(null); setProcessing({ state: 'loading', outputs: [], error: null });
    try {
      const record = await dataBrowserApi.material(item.materialId);
      if (epoch !== requestEpoch.current) return;
      setPreview(record);
      try {
        const outputs = await dataBrowserApi.materialProcessing(item.materialId);
        if (epoch !== requestEpoch.current) return;
        setProcessing({ state: outputs === null ? 'unclassified' : 'ready', outputs: outputs ?? [], error: null });
      } catch (failure) {
        if (epoch !== requestEpoch.current) return;
        setProcessing({ state: 'error', outputs: [], error: errorDetail(failure) });
      }
    } catch (failure) { if (epoch === requestEpoch.current) setPreviewError(errorDetail(failure)); }
  };
  const close = () => { requestEpoch.current++; setPreview(null); };
  return <div className="database-list-page">
    <div className="database-overview-head"><div><h2 className="data-panel-title">{words('材料预览', 'Material previews')}</h2><p className="data-panel-sub">{words('只列已完成保管的原件；点击查看只读预览，不自动解析或入库。', 'Only completed custody is listed; previews are read-only and never trigger parsing or ingestion.')}</p></div></div>
    <SearchBar value={page.query} onChange={page.setQuery} placeholder={words('搜索材料名称、编号或类别', 'Search material, ID or category')} />
    {previewError && <ErrorNote detail={previewError}>{words('材料预览未能读取。', 'The material preview could not be read.')}</ErrorNote>}
    <ListState loading={page.loading} error={page.error} availability={page.availability} scope={page.scope} empty={!page.items.length}>
      <div className="database-list">{page.items.map(item => <button type="button" className="database-row database-row--button" key={item.materialId} onClick={() => void open(item)}>
        <Boxes size={17} aria-hidden="true" /><div className="database-row-main"><strong>{item.filename}</strong><small>{item.category} · {bytes(item.byteLength)} · {item.adapter ? `${item.adapter.id}/${item.adapter.version}` : words('无适配器', 'no adapter')} · {time(item.createdAt)}</small></div><ChevronRight size={16} /></button>)}</div>
      {page.nextCursor && <button type="button" className="text-button database-more" disabled={page.loading} onClick={page.more}>{words('加载更多', 'Load more')}</button>}
    </ListState>
    {preview && <Modal title={words('材料只读预览', 'Read-only material preview')} onClose={close}>
      <MaterialPreview record={preview} />
      <div className="candidate-output-detail">
        <strong>{words('该材料的当前处理输出', 'Current processing outputs for this material')}</strong>
        {processing.state === 'loading' && <small>{words('正在读取持久路由与冻结计划…', 'Reading saved routing and frozen plans…')}</small>}
        {processing.state === 'unclassified' && <small>{words('尚无分类决定；原件预览仍可查看。', 'No classification decision is recorded; the original preview remains available.')}</small>}
        {processing.state === 'error' && <ErrorNote detail={processing.error}>{words('处理路由或冻结计划读取失败。', 'Could not read saved routing or frozen plans.')}</ErrorNote>}
        {processing.state === 'ready' && !processing.outputs.length && <small>{words('已有材料路由，尚无处理输出计划。', 'Material routing exists, but no output plan is recorded.')}</small>}
        {processing.state === 'ready' && processing.outputs.map(output => <div className="candidate-output-detail" key={`${output.planId}:${output.outputId}`}>
          <strong>{words('输出', 'Output')} {output.outputId}</strong>
          <small>{words('本地路由', 'Local routing')}：{materialProcessingLabel(output.routingState, words)} · {words('状态', 'State')}：{materialProcessingLabel(output.state, words)}</small>
          <small>{words('冻结计划', 'Frozen plan')}：{output.planId}</small>
          {output.routingState === 'rejected' && <small>{words('本地用途拒绝理由', 'Local rejection reason')}：{output.rejectReason ?? words('未记录', 'Not recorded')}</small>}
        </div>)}
      </div>
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

function JobList() {
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
      </div></article>)}</div>
      {page.nextCursor && <button type="button" className="text-button database-more" disabled={page.loading} onClick={page.more}>{words('加载更多', 'Load more')}</button>}
    </ListState>
  </div>;
}

export default DatabasePage;
