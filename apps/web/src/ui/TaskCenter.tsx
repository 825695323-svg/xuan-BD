import { useState } from 'react';
import { TaskRecovery } from './TaskRecovery';
import type { TaskRecord, TaskStatus } from '../../../../contracts/task-contracts';
import type { ConversationTaskFeed } from '../useConversationTasks';
import { ErrorNote, useWords } from './Controls';
import { PageButton, PageEmpty, PageSearch } from './PageUI';
import { TaskState, taskStateText } from './TaskResults';

export function taskCenterGroup(status: TaskStatus): 'active' | 'attention' | 'finished' {
  if (['ready', 'running', 'pausing', 'cancelling'].includes(status)) return 'active';
  if (['waiting_approval', 'paused', 'interrupted', 'needs_review', 'blocked', 'awaiting_review'].includes(status)) return 'attention';
  return 'finished';
}
function TaskRow({ task, feed }: { task: TaskRecord; feed?: ConversationTaskFeed }) {
  const words = useWords();
  const fraction = task.progress?.fraction;
  return <article className="agent-task-row" data-task-id={task.id} data-state={task.status}>
    <div className="agent-task-head"><span className="agent-task-title">{task.title}</span><TaskState task={task} /></div>
    {task.blockedReason && <p className="agent-task-note">{task.blockedReason}</p>}
    {task.error && <p className="agent-task-note" role="note">{task.error.code}: {task.error.message}</p>}
    {task.progress?.message && <p className="agent-task-note">{task.progress.message}</p>}
    {typeof fraction === 'number' && Number.isFinite(fraction) && fraction >= 0 && fraction <= 1 &&
      <progress max={1} value={fraction} aria-label={words('任务报告的进度', 'Task-reported progress')} />}
    {task.result?.summary && <p className="agent-task-note">{task.result.summary}</p>}
    <details className="agent-task-details"><summary>{words('查看任务记录', 'View task record')}</summary>
      <dl><dt>{words('任务编号', 'Task ID')}</dt><dd>{task.id}</dd>
        <dt>{words('原始任务状态', 'Recorded task state')}</dt><dd>{taskStateText(task.status, words)}</dd>
        <dt>{words('动作', 'Action')}</dt><dd>{task.action}</dd>
        <dt>{words('版本 / 事件序号', 'Version / event sequence')}</dt><dd>{task.version} / {task.sequence}</dd>
        <dt>{words('执行轮次', 'Run')}</dt><dd>{task.currentRunId ?? words('暂无记录', 'Not recorded')}</dd>
        <dt>{words('结果引用', 'Result reference')}</dt><dd>{task.resultRef ?? words('暂无记录', 'Not recorded')}</dd>
      </dl>
      {task.error?.nextAction && <p>{task.error.nextAction}</p>}
      {task.approvalId && <p>{words('授权须在现有会话审批条处理，本视图不批准。', 'Authorization belongs in the existing conversation approval strip, not this view.')}</p>}
      <p>{words('只读记录；查看不会重试、继续或派发任务。', 'Read-only record. Viewing does not retry, resume or dispatch a task.')}</p>
      {feed && <TaskRecovery task={task} ready={feed.status === 'ready' && !feed.refreshing} refresh={feed.refresh} />}
    </details>
  </article>;
}
/** The feed belongs to App. This view adds no subscription; execution requires a separate explicit confirmation. */
export function TaskCenter({ tasks, feed }: { tasks: readonly TaskRecord[]; feed?: ConversationTaskFeed }) {
  const words = useWords();
  const [query, setQuery] = useState('');
  const filtered = tasks.filter(task => [task.id, task.title, task.action, task.status, taskStateText(task.status, words)].some(value => value.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())));
  const status = feed?.status ?? 'idle';
  const groups = [
    ['active', words('受理与运行', 'Accepted and running')],
    ['attention', words('等待与待处理', 'Waiting and attention')],
    ['finished', words('已结束记录', 'Finished records')],
  ] as const;
  return <div className="agent-tasks-list" data-feed-status={status} aria-busy={status === 'loading' || feed?.refreshing}>
    <div className="agent-task-feed"><span>{words('当前会话任务；非对象或分支筛选。', 'Current conversation tasks; not filtered by object or branch.')}</span>
      {feed && <PageButton disabled={status === 'idle' || feed.refreshing} onClick={feed.refresh}>{words('刷新任务', 'Refresh tasks')}</PageButton>}</div>
    {status === 'idle' && <PageEmpty state="unavailable">{words('请先选择可读取的会话。', 'Select a readable conversation first.')}</PageEmpty>}
    {status === 'loading' && <PageEmpty state="loading">{words('正在读取任务记录…', 'Loading task records…')}</PageEmpty>}
    {status === 'error' && <ErrorNote>{words('任务读取失败，尚不能确认是否为空。请刷新重试。', 'Task read failed; an empty list is not confirmed. Refresh to retry.')}</ErrorNote>}
    {status === 'stale' && <ErrorNote>{words('任务更新已中断或刷新失败；以下为上次记录，可能过时。重连后重新核对。', 'Task updates stopped or refresh failed. Last-read records may be stale; reconnect to verify.')}</ErrorNote>}
    {status === 'ready' && !tasks.length && <p className="workspace-empty">{words('当前会话还没有任务记录。', 'No tasks for this conversation yet.')}</p>}
    <PageSearch compact label={words('查找当前会话任务：标题、编号、动作或状态', 'Find current conversation tasks: title, ID, action or status')} value={query} onChange={setQuery} />
    {status === 'ready' && !!tasks.length && !filtered.length && <PageEmpty>{words('当前会话没有匹配的任务记录。', 'No matching task records in this conversation.')}</PageEmpty>}
    {groups.map(([group, label]) => {
      const items = filtered.filter(task => taskCenterGroup(task.status) === group).slice().sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
      return items.length ? <section key={group} data-task-group={group}><p className="agent-tasks-group">{label} · {items.length}</p>
        {items.map(task => <TaskRow key={task.id} task={task} feed={feed} />)}</section> : null;
    })}
  </div>;
}
