import { useEffect, useRef, useState } from 'react';
import type { TaskRecord } from '../../../../contracts/task-contracts';
import { commandTask, getTaskDetails, recoverTask } from '../platform-api';
import { localDataGeneration, localDataRevision } from '../local-data-context';
import { sameTaskRecoveryTarget, taskRecoveryChoices, type TaskRecoveryAction } from '../task-recovery';
import { ErrorNote, Modal, useWords } from './Controls';
import { PageButton } from './PageUI';

/** An explicit operator action, separate from reading or reconnecting the task feed. */
export function TaskRecovery({ task, ready, refresh }: { task: TaskRecord; ready: boolean; refresh(): void }) {
  const words = useWords();
  const scope = JSON.stringify([task.conversationId, localDataGeneration(), localDataRevision()]);
  const latest = useRef({ task, ready, scope }); latest.current = { task, ready, scope };
  const epoch = useRef(0), lock = useRef(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [preview, setPreview] = useState<{ task: TaskRecord; scope: string; choices: TaskRecoveryAction[] } | null>(null);
  useEffect(() => () => { ++epoch.current; }, []);
  const sameScope = (frozen: TaskRecord, frozenScope: string, ticket: number) => epoch.current === ticket && localDataGeneration() !== null
    && latest.current.scope === frozenScope && frozenScope === JSON.stringify([frozen.conversationId, localDataGeneration(), localDataRevision()]);
  const valid = (frozen: TaskRecord, frozenScope: string, ticket: number) => sameScope(frozen, frozenScope, ticket)
    && latest.current.ready && sameTaskRecoveryTarget(frozen, latest.current.task);
  const label = (action: TaskRecoveryAction) => action === 'resume' ? words('继续原任务', 'Resume original task')
    : action === 'retry' ? words('重试原任务', 'Retry original task') : words('核对原外部结果', 'Reconcile original external result');
  const inspect = async () => {
    if (lock.current || !ready || localDataGeneration() === null) return;
    const frozen = task, frozenScope = scope, ticket = ++epoch.current;
    lock.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const details = await getTaskDetails(frozen.id);
      if (!valid(frozen, frozenScope, ticket)) return;
      if (!sameTaskRecoveryTarget(frozen, details.task) || typeof details.recoverySupported !== 'boolean') throw new Error('TASK_VERSION_CONFLICT');
      setPreview({ task: frozen, scope: frozenScope, choices: taskRecoveryChoices(details.task, details.recoverySupported) });
    } catch (cause) { if (valid(frozen, frozenScope, ticket)) setError(cause instanceof Error ? cause.message : 'TASK_READ_FAILED'); }
    finally { if (epoch.current === ticket) { lock.current = false; setBusy(false); } }
  };
  const confirm = async (action: TaskRecoveryAction) => {
    if (!preview || lock.current || !preview.choices.includes(action) || !valid(preview.task, preview.scope, epoch.current)) return;
    const frozen = preview, ticket = epoch.current;
    lock.current = true; setBusy(true); setPreview(null); setError('');
    try {
      const result = await (action === 'recover' ? recoverTask(frozen.task) : commandTask(frozen.task, action));
      if (!sameScope(frozen.task, frozen.scope, ticket)) return;
      if (result.id !== frozen.task.id || result.conversationId !== frozen.task.conversationId) throw new Error('TASK_RESPONSE_MISMATCH');
      setNotice(words('请求已返回；以原任务最新记录及审批状态为准，不代表执行成功。', 'Request returned. Check the original task and approvals; this is not execution success.'));
    } catch (cause) {
      if (sameScope(frozen.task, frozen.scope, ticket)) setError(words('请求未确认成功；先刷新原任务，不自动重试。', 'Request success is unconfirmed. Refresh the original task; no automatic retry.') + ' ' + (cause instanceof Error ? cause.message : 'TASK_ACTION_FAILED'));
    } finally { if (epoch.current === ticket) { lock.current = false; setBusy(false); if (sameScope(frozen.task, frozen.scope, ticket)) refresh(); } }
  };
  return <>
    <PageButton disabled={!ready || busy} onClick={() => void inspect()}>{words('查看恢复操作', 'Review recovery actions')}</PageButton>
    {error && <ErrorNote>{error}</ErrorNote>}{notice && <p role="status">{notice}</p>}
    {preview && <Modal title={words('确认原任务操作', 'Confirm original task action')} onClose={() => { ++epoch.current; setPreview(null); }}>
      <p>{preview.task.title}</p><p>{preview.task.id} · {preview.task.version}</p>
      <p>{words('继续或重试可能实际执行并产生费用或外部影响；仍须通过原权限、预算和审批。核对不重发外部操作，但可能更新原任务核对记录。', 'Resume or retry may execute work, incur costs or external effects. Existing permissions, budgets and approvals still apply. Reconciliation does not resend external operations, but may update the original task’s reconciliation record.')}</p>
      {!valid(preview.task, preview.scope, epoch.current) && <ErrorNote>{words('任务或会话已变化，请关闭并重新读取。', 'Task or conversation changed. Close and read again.')}</ErrorNote>}
      {!preview.choices.length && <p>{words('当前记录没有可用的恢复入口；待审批或成果审核不等于可继续。', 'No recovery entry is available for this record. Approval or result review is not permission to resume.')}</p>}
      {preview.choices.map(action => <PageButton key={action} disabled={!valid(preview.task, preview.scope, epoch.current) || busy} onClick={() => void confirm(action)}>{label(action)}</PageButton>)}
      <PageButton onClick={() => { ++epoch.current; setPreview(null); }}>{words('取消', 'Cancel')}</PageButton>
    </Modal>}
  </>;
}
