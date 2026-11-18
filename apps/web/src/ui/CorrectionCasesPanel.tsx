import { useEffect, useRef, useState } from 'react';
import { correctionCasesApi, type CorrectionCaseDetail, type CorrectionCaseSummary, type CorrectionState } from '../correction-cases-api';
import { localDataGeneration, localDataRevision, subscribeLocalDataRevoked } from '../local-data-context';
import { ErrorNote, useWords } from './Controls';
import { PageActions, PageButton, PageEmpty, PageHeading, PageSearch } from './PageUI';
import { DetailFacts, DetailSection } from './ObjectDetailPanel';
import { taskStateText } from './TaskResults';
import './CorrectionCasesPanel.css';

const labels: Record<CorrectionState, [string, string]> = {
  registered: ['已登记', 'Registered'], impact_incomplete: ['影响范围不完整', 'Impact incomplete'], impact_frozen: ['影响已冻结', 'Impact frozen'],
  suspend_failed: ['暂停结果未确认', 'Suspension unconfirmed'], suspended: ['已登记用途暂停', 'Usage suspension registered'],
  prepared: ['修复已准备，未获授权', 'Repair prepared, not authorized'], authorization_pending: ['审批办理中', 'Authorization pending'],
  authorization_rejected: ['审批未通过', 'Authorization rejected'], repairing: ['修复结果待收束', 'Repair unsettled'],
  verified: ['已读回，收束待核', 'Readback verified, settlement pending'], resolved: ['已登记解决', 'Resolution registered'], blocked: ['受阻，结果待核', 'Blocked, outcome unconfirmed'],
};
type TaskView = Awaited<ReturnType<typeof correctionCasesApi.task>>['value'];
/** Local-maintenance projection only. Never calls registration, authorization, suspension or recovery. */
export function CorrectionCasesPanel() {
  const words = useWords();
  const [items, setItems] = useState<CorrectionCaseSummary[] | null>(null);
  const [connection, setConnection] = useState<string | null>(null), [query, setQuery] = useState('');
  const [detail, setDetail] = useState<CorrectionCaseDetail | null>(null), [selected, setSelected] = useState('');
  const [task, setTask] = useState<TaskView | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(false);
  const epoch = useRef(0), mounted = useRef(true);
  const state = (value: CorrectionState) => words(...labels[value]);
  function clear() { setItems(null); setConnection(null); setDetail(null); setSelected(''); setTask(null); }
  useEffect(() => {
    mounted.current = true;
    const stop = subscribeLocalDataRevoked(() => { epoch.current++; clear(); setBusy(false); setError(true); });
    return () => { mounted.current = false; epoch.current++; stop(); };
  }, []);
  async function read(kind: 'list' | 'detail' | 'task', id?: string) {
    const current = ++epoch.current, generation = localDataGeneration(), revision = localDataRevision();
    setBusy(true); setError(false); setTask(null);
    if (kind === 'list') clear();
    if (kind === 'detail') { setDetail(null); setSelected(id!); }
    const active = () => mounted.current && current === epoch.current && generation === localDataGeneration() && revision === localDataRevision();
    try {
      if (kind === 'list') { const result = await correctionCasesApi.list(); if (active()) { setItems(result.value); setConnection(result.connection); } }
      else if (kind === 'detail' && connection) { const result = await correctionCasesApi.detail(id!, connection); if (active()) setDetail(result.value); }
      else if (kind === 'task' && connection && detail?.taskIds.includes(id!)) { const result = await correctionCasesApi.task(id!, connection); if (active()) setTask(result.value); }
    } catch { if (active()) { clear(); setError(true); } }
    finally { if (active()) setBusy(false); }
  }
  const filtered = items?.filter(item => item.caseId.toLowerCase().includes(query.trim().toLowerCase()));
  return <div className="database-list-page correction-cases-panel" aria-busy={busy} data-testid="correction-cases">
    <PageHeading title={words('更正事项', 'Correction cases')} description={words(
      '只读维护视图。仅展示已证明子集，不代表全库影响；审批或准备不等于正式发布。此处不登记、授权、暂停或恢复。',
      'Read-only maintenance. Proven subset only, not full downstream impact. Preparation or approval is not publication. No registration, authorization, suspension or recovery here.')} />
    <PageActions><PageButton disabled={busy} onClick={() => void read('list')}>{words('读取更正事项', 'Read correction cases')}</PageButton></PageActions>
    {error && <ErrorNote>{words('读取失败或范围已变化，旧结果已清除。请重新读取；未执行任何更正动作。', 'Read failed or scope changed; old results cleared. Read again. No corrective action was performed.')}</ErrorNote>}
    {busy && <PageEmpty state="loading">{words('读取中…', 'Reading…')}</PageEmpty>}
    {items && <>
      <PageSearch label={words('按更正编号查找', 'Find correction ID')} value={query} onChange={setQuery} />
      {!filtered?.length && <PageEmpty>{words('当前已读列表中没有匹配事项。', 'No matching cases in the loaded list.')}</PageEmpty>}
      <div className="database-list">{filtered?.map(item => <article className="database-row" key={item.caseId}>
        <div className="database-row-main"><strong>{item.caseId}</strong><small>{state(item.state)} · {words('已登记条目', 'Registered items')} {item.itemCount} · {words('缺口', 'Gaps')} {item.gapCount}</small>
          <PageButton data-case-id={item.caseId} aria-pressed={selected === item.caseId} disabled={busy} onClick={() => void read('detail', item.caseId)}>{words('查看事项', 'View case')} {item.caseId}</PageButton>
        </div></article>)}</div>
    </>}
    {detail && <section aria-label={words('更正事项详情', 'Correction case detail')} data-testid="correction-detail">
      <PageHeading level="h3" title={detail.caseId} description={state(detail.state)} />
      <DetailFacts items={[
        { label: words('影响覆盖', 'Impact coverage'), value: 'proven_subset_only' },
        { label: words('类别', 'Kind'), value: detail.kind === 'processing_repair' ? words('同原件加工修复', 'Same-original processing repair') : words('来源更正', 'Source correction') },
        { label: words('已存暂停回执', 'Stored suspension receipt'), value: detail.suspension === 'active' ? words('当次登记为有效，不是实时查询', 'Recorded active, not a live query') : detail.suspension === 'resolved' ? words('已登记解决', 'Recorded resolved') : words('未知或未登记', 'Unknown or not recorded') },
      ]} />
      <DetailSection title={words('缺口与范围', 'Gaps and scope')}>
        <p className="database-scope">{words('本机已登记历史事项，未核它与当前 WFD 的归属。仅已证明子集；零缺口不证明全库完整。自由文本及原件路径不在此展开。', 'Local registered cases; ownership in the current WFD is not verified. Proven subset only; zero gaps is not complete coverage. Free text and original paths are not displayed.')}</p>
        <p>{words('已登记缺口数', 'Recorded gap count')}：{detail.gapCount}</p>
        {detail.gaps.map((gap, index) => <p className="database-scope" key={index}>{gap === 'additional_gap_details_withheld' ? words('另有缺口，未在此展示原始明细。', 'Additional gap; raw details not displayed here.') : gap}</p>)}
      </DetailSection>
      <DetailSection title={words('原审批／修复任务', 'Original authorization / repair task')}>
        {!detail.taskIds.length && <p>{words('尚无已登记任务引用；不据此推定成功。', 'No recorded task reference; success is not implied.')}</p>}
        {detail.taskIds.map(id => <PageButton key={id} disabled={busy} onClick={() => void read('task', id)}>{words('查看原任务', 'Read original task')} {id}</PageButton>)}
        {task && <div data-testid="correction-task"><DetailFacts items={[
          { label: words('任务编号', 'Task ID'), value: task.jobId },
          { label: words('任务请求编号（不是 WFD 发布号）', 'Task request ID (not WFD publication ID)'), value: task.requestId },
          { label: words('当前任务状态', 'Current task state'), value: taskStateText(task.status, words) },
        ]} />{task.requiresReview && <p>{words('原任务仍需核对。', 'The original task still requires review.')}</p>}</div>}
      </DetailSection>
      <DetailSection title={words('固定记录与摘要', 'Fixed records and digests')}>
        <p className="database-scope">{words('条目状态是本地登记值，不证明当前限制已生效。现接口无独立 WFD 请求字段，不拼造。', 'Item states are local records, not proof of currently effective restrictions. No separate WFD request field is available; none is synthesized.')}</p>
        <details className="result-details"><summary>{words('展开固定引用', 'Show fixed references')}</summary>
          <DetailFacts items={[{ label: 'impactSha256', value: detail.impactSha256 ?? 'unknown' }, { label: 'frozenSha256', value: detail.frozenSha256 ?? 'unknown' }]} />
          {detail.records.map((record, index) => <div key={index}><DetailFacts items={[
            { label: words('产品 / 快照', 'Product / snapshot'), value: `${record.productId} / ${record.snapshotId}` },
            { label: words('记录 / 版本', 'Record / revision'), value: `${record.businessKey} / ${record.recordVersion}` },
            { label: words('已登记状态', 'Recorded state'), value: record.state },
          ]} /></div>)}
        </details>
      </DetailSection>
    </section>}
  </div>;
}
