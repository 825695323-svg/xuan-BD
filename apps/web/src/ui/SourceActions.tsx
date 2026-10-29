import { useCallback, useState } from 'react';
import type { SourceCheck } from '../../../../contracts/source-settings';
import { request } from '../api';
import { ErrorNote, errorDetail, useWords } from './Controls';

export function SourceCheckLine({ check }: { check?: SourceCheck }) {
  const words = useWords();
  if (!check) return <span className="source-check-state" data-state="never">{words('本次运行尚未检查；登记不代表可用。', 'Not checked in this run; registration is not availability.')}</span>;
  const state = check.status === 'passed' ? 'passed' : check.status === 'blocked' ? 'blocked' : 'partial';
  return <span className="source-check-state" data-state={state}>
    <strong>{state === 'passed' ? words('检查通过', 'Check passed') : state === 'blocked' ? words('检查未通过', 'Check blocked') : words('需要重新检查', 'Recheck required')}</strong>
    <span>{new Date(check.checkedAt).toLocaleString()}</span>
    <span className="source-check-reason">{check.reason}</span>
  </span>;
}

export function useSourceCheck(onChanged: () => void | Promise<void>) {
  const [busy, setBusy] = useState<string | null>(null), [error, setError] = useState<string | null>(null);
  const check = useCallback(async (id: string) => {
    if (busy) return;
    setBusy(id); setError(null);
    try {
      await request('/api/ui/source-settings/checks', 'POST', { id });
      await onChanged();
    } catch (failure) { setError(errorDetail(failure)); }
    finally { setBusy(null); }
  }, [busy, onChanged]);
  return { busy, error, check, clearError: () => setError(null) };
}

export interface SourceRunTask { id: string; status: string; title?: string; error?: { code?: string; message?: string } | null }
export function RunReceipt({ task }: { task: SourceRunTask }) {
  const words = useWords();
  return <div className="database-receipt" role="status"><strong>{words('原任务回执', 'Original task receipt')}</strong>
    <p>{task.status === 'waiting_approval' ? words('已受理并等待本机操作者审批；到会话审批条处理。', 'Accepted and waiting for the local operator in the conversation approval strip.')
      : task.status === 'failed' ? words('任务未完成；按原任务查看原因，不自动重试。', 'The task did not complete; inspect the original task, no automatic retry.')
        : words(`任务状态 ${task.status}；这不代表采集或入库已经完成。`, `Task status ${task.status}; this is not proof that collection or ingestion completed.`)}</p>
    {task.error?.message && <small>{task.error.code ? `${task.error.code} · ` : ''}{task.error.message}</small>}
    <small>{task.id}</small></div>;
}
export function SourceCheckError({ error }: { error: string | null }) {
  const words = useWords();
  return error ? <ErrorNote detail={error}>{words('来源检查未完成；未改写成可用。', 'The source check did not complete; it was not rewritten as available.')}</ErrorNote> : null;
}
