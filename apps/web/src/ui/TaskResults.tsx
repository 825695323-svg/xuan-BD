import { FileCheck2, ShieldAlert } from 'lucide-react';
import type { MaterialSemanticRecord } from '../../../../modules/collection/materials/semantic-contracts';
import type { TaskRecord } from '../../../../contracts/task-contracts';
import type { CandidateView } from '../data-browser-api';
import { useWords } from './Controls';

export const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export function semanticRecord(task: TaskRecord): MaterialSemanticRecord | null {
  const data = task.result?.data;
  if (!isObject(data) || data.kind !== 'conversation-material' || !isObject(data.semanticRecord)) return null;
  const record = data.semanticRecord;
  return isObject(record.result) && Array.isArray(record.result.changes) && Array.isArray(record.result.questions) && Array.isArray(record.result.adoptedKnown)
    && isObject(record.proposal) && Array.isArray(record.proposal.judgments) && isObject(record.origin) && isObject(record.envelope)
    ? record as unknown as MaterialSemanticRecord : null;
}
export function rejectionReason(task: TaskRecord): string | null {
  const data = task.result?.data;
  if (!isObject(data) || !isObject(data.modelPreview) || data.modelPreview.status !== 'proposal_rejected') return null;
  return typeof data.modelPreview.reason === 'string' ? data.modelPreview.reason.slice(0, 500) : '';
}
function compareRecency(a: TaskRecord, b: TaskRecord): number {
  const aTime = semanticRecord(a)?.envelope.createdAt ?? a.createdAt, bTime = semanticRecord(b)?.envelope.createdAt ?? b.createdAt;
  return aTime - bTime || a.sequence - b.sequence || a.id.localeCompare(b.id);
}
export function tasksForBranch(tasks: readonly TaskRecord[], conversationId: string, branchId: string): TaskRecord[] {
  const byMaterial = new Map<string, TaskRecord>();
  for (const task of tasks) {
    const data = task.result?.data;
    if (task.conversationId !== conversationId || !isObject(data) || data.kind !== 'conversation-material' || typeof data.materialId !== 'string') continue;
    const source = isObject(data.conversationSource) ? data.conversationSource : semanticRecord(task)?.origin;
    if (!source || source.conversationId !== conversationId || source.branchId !== branchId) continue;
    const previous = byMaterial.get(data.materialId);
    if (!previous || Number(!!semanticRecord(task)) > Number(!!semanticRecord(previous)) || (Number(!!semanticRecord(task)) === Number(!!semanticRecord(previous)) && compareRecency(task, previous) > 0)) byMaterial.set(data.materialId, task);
  }
  return [...byMaterial.values()].sort(compareRecency).slice(-6);
}

export const taskStateLabels: Record<string, [string, string]> = {
  ready: ['已受理', 'Accepted'], running: ['运行中', 'Running'], waiting_approval: ['等待授权', 'Awaiting authorization'],
  pausing: ['正在暂停', 'Pausing'], paused: ['已暂停', 'Paused'], cancelling: ['正在取消', 'Cancelling'], cancelled: ['已取消', 'Cancelled'],
  succeeded: ['已完成', 'Completed'], failed: ['未完成', 'Failed'], interrupted: ['已中断', 'Interrupted'],
  needs_review: ['结果待核', 'Outcome unconfirmed'], blocked: ['已阻塞', 'Blocked'], awaiting_review: ['等待核对', 'Awaiting review'],
};
const semanticLabels: Record<string, [string, string]> = {
  processed: ['程序加工已完成', 'Processing completed'], candidates_saved: ['模型判断已保留', 'Model judgments saved'],
  needs_confirmation: ['等待同会话澄清', 'Awaiting clarification'], needs_adapter: ['需要适配器', 'Adapter required'],
  unsupported: ['当前不支持加工', 'Processing unsupported'],
};
export function taskStateText(status: string, words: (zh: string, en: string) => string): string {
  const label = taskStateLabels[status];
  return label ? words(label[0], label[1]) : words('状态待核', 'Status unconfirmed');
}
export function taskState(
  task: TaskRecord, words: (zh: string, en: string) => string,
): { label: string; state: string; danger: boolean } {
  const record = semanticRecord(task), rejected = rejectionReason(task) !== null;
  const financial = isObject(task.result?.data) && task.result.data.kind === 'conversation-financial' ? task.result.data
    : isObject(task.checkpoint) && task.checkpoint.kind === 'conversation-financial' ? task.checkpoint : null;
  const needsReview = task.requiresReview || financial?.requiresReview === true || task.error?.code === 'MODEL_ACTION_REQUIRES_REVIEW';
  const state = typeof financial?.serviceStatus === 'string' ? financial.serviceStatus : task.status;
  const label = needsReview ? words('结果待核', 'Outcome unconfirmed')
    : rejected ? words('语义提案未通过核对', 'Proposal verification failed')
      : record ? (semanticLabels[record.result.status] ? words(...semanticLabels[record.result.status]) : words('状态待核', 'Status unconfirmed'))
        : taskStateText(state, words);
  return { label, state: needsReview ? 'needs_review' : rejected ? 'failed' : record?.result.status ?? state, danger: needsReview || rejected || ['failed', 'needs_review', 'blocked'].includes(state) };
}

export function TaskState({ task }: { task: TaskRecord }) {
  const words = useWords(), view = taskState(task, words);
  return <span className="task-state" data-state={view.danger ? 'failed' : view.state}>{view.label}</span>;
}

function taskProgress(task: TaskRecord): string | null {
  if (task.progress?.message) return task.progress.message;
  if (task.blockedReason) return task.blockedReason;
  return null;
}

/** These records are conversation-scoped; older local tasks have no branch identity. */
export function ConversationTaskResults({ tasks, conversationId }: { tasks: readonly TaskRecord[]; conversationId: string }) {
  const words = useWords();
  // 处理计划任务由 ProcessingPanel 展示计划、步骤与产物，普通任务区不重复同一事实。
  const results = tasks.filter(task => task.conversationId === conversationId && task.runtimeId !== 'pi'
    && !task.action.startsWith('data.processing.')
    && !(isObject(task.result?.data) && task.result.data.kind === 'conversation-material'));
  if (!results.length) return null;
  return <section className="task-results" aria-label={words('会话任务结果', 'Conversation task results')}>
    {results.slice(-6).map(task => {
      const state = taskState(task, words), progress = taskProgress(task);
      return <article className="result-row" key={task.id} data-state={state.state}><FileCheck2 size={19} aria-hidden="true" /><div className="result-copy">
        <div className="result-heading"><span>{task.title}</span><TaskState task={task} /></div>
        {task.approvalId && <p className="result-approval"><ShieldAlert size={14} aria-hidden="true" />{words('等待本机操作者在会话审批条处理；界面不另建批准权。', 'Waiting for the local operator in the existing approval strip; this view adds no approval authority.')}</p>}
        <p>{progress ?? task.result?.summary ?? (task.status === 'waiting_approval' ? words('任务已受理，等待授权后继续。', 'Accepted; waiting for authorization.') : words('任务已受理，结果尚未确认。', 'Task accepted; its outcome is not yet confirmed.'))}</p>
        <small>{task.result?.artifactIds?.length ? words(`${task.result.artifactIds.length} 项已登记产物`, `${task.result.artifactIds.length} registered artifacts`) : ''}
          {task.error?.message ? ` · ${task.error.message}` : ''}</small>
        <details className="result-details"><summary>{words('查看任务身份与回执', 'Task identity and receipt')}</summary>
          <dl><dt>{words('操作', 'Operation')}</dt><dd>{task.action}</dd><dt>{words('任务', 'Task')}</dt><dd>{task.id}</dd><dt>{words('原请求', 'Request')}</dt><dd>{task.requestId}</dd>
            <dt>{words('状态', 'Status')}</dt><dd>{task.status}{task.requiresReview ? words(' · 待核', ' · unconfirmed') : ''}</dd>
            {task.error?.code && <><dt>{words('错误码', 'Error code')}</dt><dd>{task.error.code}</dd></>}</dl>
        </details>
      </div></article>;
    })}
  </section>;
}

const outputStateLabels: Record<string, [string, string]> = {
  committed: ['正式提交成功', 'Committed'], stored_not_committed: ['已保管，未提交', 'Stored, not committed'],
  custody_only: ['仅保管原件', 'Custody only'], prepared: ['本地候选已构造', 'Prepared locally'],
  rejected: ['数据库拒绝', 'Rejected'], cancelled: ['已取消', 'Cancelled'], unknown: ['结果待核', 'Outcome unconfirmed'],
};
const candidateStateLabels: Record<string, [string, string]> = {
  not_sent: ['尚未向数据库发送', 'Not sent'], prepared: ['已准备请求', 'Request prepared'], uploading: ['正在保管原件', 'Uploading originals'],
  dispatched: ['已派发，等待回执', 'Dispatched'], accepted: ['数据库已受理', 'Accepted'], received: ['输入已保管', 'Input stored'],
  verified: ['回执已核对', 'Receipt verified'], stored_not_committed: ['已保管，未提交', 'Stored, not committed'],
  rejected: ['数据库拒绝', 'Rejected'], unknown: ['结果待核', 'Outcome unconfirmed'], cancelled: ['已取消', 'Cancelled'],
};

/** 工作台候选只按会话/分支的获准关联进入；空列表与不可用分别显示。 */
export function CandidateTaskResults({ items, availability, reason }: {
  items: CandidateView[]; availability: 'available' | 'unavailable' | 'loading'; reason?: string | null;
}) {
  const words = useWords();
  if (availability === 'loading') return <p className="task-linked-note">{words('正在读取本分支关联的工作台候选…', 'Reading workbench candidates linked to this branch…')}</p>;
  if (availability === 'unavailable') return <p className="task-linked-note" role="status">{reason ?? words('工作台候选关联暂时不可读，没有混入其他会话任务。', 'Linked workbench candidates are unavailable; tasks from other conversations are not mixed in.')}</p>;
  if (!items.length) return null;
  return <section className="task-results task-results--candidates" aria-label={words('本会话关联的工作台候选', 'Workbench candidates linked to this conversation')}>
    {items.map(item => {
      const database = candidateStateLabels[item.database.state] ?? null;
      const partial = item.database.committed > 0 && (item.database.storedNotCommitted > 0 || item.database.rejected > 0);
      return <article className="result-row" key={item.taskId}><FileCheck2 size={19} aria-hidden="true" /><div className="result-copy">
        <div className="result-heading"><span>{item.title}</span><span className="task-state" data-state={item.status === 'failed' ? 'failed' : partial || item.requiresReview ? 'needs_review' : 'succeeded'}>
          {taskStateText(item.status, words)}{partial ? words(' · 部分完成', ' · partial') : ''}</span></div>
        {item.approvalId && <p className="result-approval"><ShieldAlert size={14} aria-hidden="true" />{words('等待本机操作者在会话审批条处理；这里不新建批准权。', 'Waiting in the existing approval strip; no new approval authority here.')}</p>}
        <p>{item.progress?.message ?? item.blockedReason ?? item.error?.message
          ?? (database ? words(`数据库：${database[0]}`, `Database: ${database[1]}`) : words('候选状态待核。', 'Candidate status unconfirmed.'))}</p>
        {item.outputs.length > 0 && <ul className="candidate-outputs">{item.outputs.map(output => {
          const label = outputStateLabels[output.state] ?? [output.state, output.state];
          return <li key={output.outputId} data-state={output.state}>
            <span className="candidate-output-name">{output.outputId}</span>
            <span className="candidate-output-state">{words(label[0], label[1])}</span>
            {output.coverage && !output.coverage.complete && <span className="candidate-output-gap">{words(`缺项：${output.coverage.gaps.join('；') || '范围未完成'}`, `Gaps: ${output.coverage.gaps.join('; ') || 'scope incomplete'}`)}</span>}
            {output.issues.length > 0 && <span className="candidate-output-gap">{output.issues.map(issue => issue.message).join('；')}</span>}
            {output.readback?.state === 'verified' && <span className="candidate-output-readback">{words(`固定读回 ${output.readback.rows} 行`, `Fixed readback ${output.readback.rows} rows`)}</span>}
          </li>;
        })}</ul>}
        <small>{partial ? words('已提交与未提交输出分别列出，不把部分成功说成整批入库。', 'Committed and uncommitted outputs are listed separately; a partial result is not reported as a full commit.')
          : words('正式提交只认数据库 commit_id 与 snapshot_id，并核对固定读回；前端动画不算入库。', 'A commit requires the database commit_id and snapshot_id plus a fixed readback; frontend feedback is not a commit.')}</small>
        <details className="result-details"><summary>{words('查看身份与逐输出详情', 'Identity and per-output details')}</summary>
          <dl><dt>{words('任务', 'Task')}</dt><dd>{item.taskId}</dd><dt>{words('原请求', 'Request')}</dt><dd>{item.requestId}</dd>
            {item.database.requestId && <><dt>{words('数据库请求', 'Database request')}</dt><dd>{item.database.requestId}</dd></>}
            {item.database.instanceId && <><dt>{words('实例', 'Instance')}</dt><dd>{item.database.instanceId}</dd></>}
            <dt>{words('数据库状态', 'Database state')}</dt><dd>{item.database.state}</dd></dl>
          {item.outputs.map(output => <div className="candidate-output-detail" key={output.outputId}><strong>{output.outputId}</strong>
            <small>{output.productId ?? words('产品尚未确定', 'No product yet')} · {output.snapshotId ?? words('快照尚未形成', 'No snapshot yet')}</small>
            {output.commitId && <small>{words('提交', 'Commit')} {output.commitId}</small>}
            {output.readback && <small>{words('读回摘要', 'Readback digest')} {output.readback.rowsSha256}</small>}
          </div>)}
        </details>
      </div></article>;
    })}
  </section>;
}

export function TaskResults({ tasks }: { tasks: TaskRecord[] }) {
  const words = useWords();
  if (!tasks.length) return null;
  return <section className="task-results" aria-label={words('材料处理结果', 'Material processing results')}>{tasks.map((task) => {
    const record = semanticRecord(task);
    const rejected = rejectionReason(task);
    const unknown = record?.proposal.judgments.filter((item) => item.status === 'unknown').length ?? 0;
    const conflicts = record?.proposal.judgments.filter((item) => item.status === 'conflict').length ?? 0;
    return <article className="result-row" key={task.id}><FileCheck2 size={19} aria-hidden="true" /><div className="result-copy"><div className="result-heading"><span>{task.title}</span><TaskState task={task} /></div>
      <p>{rejected !== null ? words('提案未通过核对，尚未执行清洗。', 'The proposal failed verification. Cleaning has not been applied.') : record ? record.result.applied ? words(`实际清洗变化 ${record.result.changes.length} 处。`, `${record.result.changes.length} actual cleaning changes.`) : words('判断已保留，尚未执行清洗。', 'Judgments are preserved. Cleaning has not been applied.') : task.result?.summary ?? task.progress?.message ?? words('处理记录已保存，结果待核。', 'The processing record is saved. The result needs checking.')}
        {record && (unknown || conflicts) ? words(` 未知 ${unknown} 项，冲突 ${conflicts} 项。`, ` ${unknown} unknown, ${conflicts} conflicting items.`) : ''}</p>
      {record?.result.questions.length ? <ul className="result-questions">{record.result.questions.map((question) => <li key={question.id}>{question.prompt}</li>)}</ul> : null}
      {rejected && <p>{rejected}</p>}
      <small>{words('原件保留 · 尚未正式入库', 'Original preserved · Not formally committed')}</small></div>
    </article>;
  })}</section>;
}
