import { useCallback, useEffect, useRef, useState } from 'react';
import { FileJson, ListChecks, Play, RefreshCw, RotateCw, Square } from 'lucide-react';
import { request, RequestError } from '../api';
import { dataBrowserApi, type ConversationProcessingItem, type ProcessingPlanView, type ProcessingStepView, type ProcessingTaskView } from '../data-browser-api';
import { ErrorNote, errorDetail, useWords } from './Controls';
import { taskStateText } from './TaskResults';
import { localDataGeneration } from '../local-data-context';

const planStateLabels: Record<string, [string, string]> = {
  prepared: ['计划已准备', 'Plan prepared'], partial: ['部分完成', 'Partly completed'], completed: ['步骤已完成', 'Steps completed'],
  blocked: ['计划被阻塞', 'Plan blocked'], failed: ['计划未完成', 'Plan failed'],
};
const outputStateLabels: Record<string, [string, string]> = {
  pending: ['待形成结构产物', 'Structure pending'], structured: ['结构产物已形成', 'Structure formed'],
  blocked: ['被缺口阻塞', 'Blocked by gaps'], failed: ['处理失败', 'Failed'], custody_only: ['仅保管原件', 'Custody only'],
};
const stepStateLabels: Record<string, [string, string]> = {
  pending: ['待执行', 'Pending'], succeeded: ['已完成', 'Completed'], failed: ['失败', 'Failed'], blocked: ['阻塞', 'Blocked'],
};
const stepKindLabels: Record<string, [string, string]> = {
  parse: ['解析原件', 'Parse'], clean: ['清洗', 'Clean'], structure: ['整理结构', 'Structure'], annotate: ['标注', 'Annotate'], check: ['结构检查', 'Check'],
};
const activeStatuses = ['ready', 'running', 'pausing', 'cancelling', 'waiting_approval'];

function label(map: Record<string, [string, string]>, value: string, words: (zh: string, en: string) => string): string {
  const found = map[value];
  return found ? words(found[0], found[1]) : words('状态待核', 'Status unconfirmed');
}
function gapsOf(output: ProcessingPlanView['outputs'][number]): string[] {
  return [...new Set([...output.gaps, ...output.semanticGaps].filter(Boolean))];
}
function outputLabel(plan: ProcessingPlanView, output: ProcessingPlanView['outputs'][number], index: number): string {
  const names = output.materialIds.map(id => plan.materials.find(material => material.materialId === id)?.filename).filter((name): name is string => !!name);
  return names.length ? names.join('、') : `输出 ${index + 1}`;
}
function stepLabel(step: ProcessingStepView, words: (zh: string, en: string) => string): string {
  const kind = stepKindLabels[step.kind];
  return kind ? words(kind[0], kind[1]) : step.kind;
}
function activeTask(item: ConversationProcessingItem): ProcessingTaskView | null {
  return [item.task, ...item.executions].filter((task): task is ProcessingTaskView => !!task)
    .filter(task => activeStatuses.includes(task.status)).sort((left, right) => right.updatedAt - left.updatedAt)[0] ?? null;
}
function nextAction(plan: ProcessingPlanView, task: ProcessingTaskView | null, words: (zh: string, en: string) => string): string {
  if (task) return words(`处理任务正在${taskStateText(task.status, words)}；可停止该任务，或稍后刷新原结果。`,
    `Processing is ${taskStateText(task.status, words)}; stop the task or refresh the original result later.`);
  const failed = plan.steps.filter(step => step.state === 'failed'), pending = plan.steps.filter(step => step.state === 'pending');
  const blocked = plan.steps.filter(step => step.state === 'blocked');
  if (failed.length) return words(`有 ${failed.length} 个步骤失败；先核对失败说明，再运行剩余步骤，或请代理修订计划。`, `${failed.length} step(s) failed; read the failure, then run remaining steps or ask the agent to revise the plan.`);
  if (pending.length) return words(`下一步：执行「${stepLabel(pending[0], words)}」，或一次运行剩余步骤。`, `Next: run “${stepLabel(pending[0], words)}”, or run the remaining steps.`);
  if (blocked.length) return words('步骤因缺口阻塞；向代理说明缺失信息后可修订计划。', 'Steps are blocked by gaps; tell the agent what is missing so it can revise the plan.');
  if (plan.outputs.some(output => gapsOf(output).length)) return words('结构步骤已完成；仍有缺口，发布前需补齐语义或目标。', 'Structural steps are done; gaps remain before publication.');
  if (plan.outputs.some(output => output.state === 'structured')) return words('结构产物已形成；交接仍须符合 R1 合同并明确确认。', 'Structural artifacts exist; handoff still requires the R1 contract and explicit confirmation.');
  return words('计划已准备，可运行剩余步骤。', 'The plan is prepared; remaining steps can run.');
}

export default function ProcessingPanel({ conversationId, branchId }: { conversationId: string; branchId: string }) {
  const words = useWords();
  const generation = localDataGeneration();
  const [items, setItems] = useState<ConversationProcessingItem[]>([]);
  const [availability, setAvailability] = useState<'loading' | 'available' | 'unavailable'>('loading');
  const [reason, setReason] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [stopping, setStopping] = useState<ReadonlySet<string>>(() => new Set());
  const epoch = useRef(0);
  const load = useCallback(async () => {
    const current = ++epoch.current;
    try {
      const value = await dataBrowserApi.conversationProcessing(conversationId, branchId);
      if (current !== epoch.current) return;
      setItems(value.items); setAvailability(value.availability); setReason(value.reason);
    } catch (failure) {
      if (current !== epoch.current) return;
      setAvailability('unavailable'); setReason(errorDetail(failure));
    }
  }, [conversationId, branchId]);
  useEffect(() => {
    setItems([]); setAvailability('loading'); setReason(null); setError(null);
    void load();
    const timer = window.setInterval(() => void load(), 6_000);
    return () => { epoch.current++; window.clearInterval(timer); };
  }, [load]);

  async function act(item: ConversationProcessingItem, action: 'run' | 'recover' | 'execute', stepId?: string) {
    const key = `${item.plan.planId}:${action}:${stepId ?? ''}`;
    if (busy) return;
    setBusy(key); setError(null);
    try {
      const requestId = `ui.processing.${action}.${item.plan.planId}.${Date.now()}`;
      const plan = encodeURIComponent(item.plan.planId);
      if (action === 'run') await request(`/api/bd/processing/plans/${plan}/run`, 'POST', { requestId });
      else if (action === 'recover') await request(`/api/bd/processing/plans/${plan}/recover`, 'POST', { requestId });
      else await request(`/api/bd/processing/plans/${plan}/steps/${encodeURIComponent(stepId ?? '')}/execute`, 'POST', { requestId });
      await load();
    } catch (failure) { setError(errorDetail(failure)); }
    finally { setBusy(null); }
  }
  async function stopTask(item: ConversationProcessingItem, task: ProcessingTaskView) {
    if (stopping.has(task.taskId)) return;
    const mark = (active: boolean) => setStopping(previous => {
      const next = new Set(previous);
      if (active) next.add(task.taskId); else next.delete(task.taskId);
      return next;
    });
    mark(true); setError(null);
    try {
      // 处理任务属于工作台角色，必须按原 taskId 查询工作台任务入口；不能再走只查个人库的 /api/tasks/:id。
      const latest = await dataBrowserApi.processingTask(task.taskId);
      if (!activeStatuses.includes(String(latest.status))) { await load(); return; }
      await dataBrowserApi.cancelProcessingTask(task.taskId);
      await load();
    } catch (failure) {
      if (failure instanceof RequestError && ['TASK_NOT_FOUND', 'STALE_RUN', 'TASK_VERSION_CONFLICT'].includes(failure.code ?? '')) {
        await load(); setError(words('任务状态已经变化，已按当前事实刷新；原任务没有被重发。', 'The task changed; the current facts were refreshed and the original task was not resent.'));
      } else setError(errorDetail(failure));
    } finally { mark(false); }
  }

  if (availability === 'loading') return null;
  if (availability === 'unavailable') return <p className="task-linked-note" role="status">{reason ?? words('处理计划暂时不可读。', 'Processing plans are unavailable.')}</p>;
  if (!items.length) return null;
  return <section className="task-results task-results--processing" aria-label={words('本会话处理计划', 'Processing plans in this conversation')}>
    <p className="processing-intro">{words('计划由会话代理按材料准备；结构检查不等于来源真实性、业务语义或发布资格。',
      'The agent prepares plans from the materials; structural checks do not prove source truth, meaning or publication eligibility.')}</p>
    {error && <ErrorNote detail={error}>{words('操作未确认，原计划事实已保留。', 'The action is unconfirmed; the original plan facts are preserved.')}</ErrorNote>}
    {items.map(item => {
      const plan = item.plan, task = activeTask(item);
      const running = busy?.startsWith(`${plan.planId}:`);
      const pending = plan.steps.filter(step => step.state === 'pending');
      const completed = plan.steps.filter(step => step.state === 'succeeded').length;
      const hasGaps = plan.outputs.some(output => gapsOf(output).length);
      const planState = plan.status === 'completed' && hasGaps ? words('结构完成，语义待补', 'Structure done; meaning pending') : label(planStateLabels, plan.status, words);
      return <article className="result-row processing-plan" key={plan.planId} data-state={plan.status}>
        <ListChecks size={19} aria-hidden="true" />
        <div className="result-copy">
          <div className="result-heading">
            <span>{words('处理计划', 'Processing plan')} · {plan.materials.map(material => material.filename).join('、') || plan.planId}</span>
            <span className="task-state" data-state={['blocked', 'failed'].includes(plan.status) ? 'failed' : plan.status === 'prepared' ? 'ready' : 'succeeded'}>
              {planState}
            </span>
          </div>
          <p className="processing-summary">{words(`${plan.outputs.length} 个输出 · ${completed}/${plan.steps.length} 个步骤已完成。`,
            `${plan.outputs.length} output(s) · ${completed}/${plan.steps.length} steps completed.`)}</p>
          <ul className="candidate-outputs processing-outputs">
            {plan.outputs.map((output, index) => {
              const gaps = gapsOf(output);
              return <li key={output.outputId} data-state={output.state} className="processing-output">
                <span className="candidate-output-name">{outputLabel(plan, output, index)}</span>
                <span className="candidate-output-state">{label(outputStateLabels, output.state, words)}</span>
                {output.intendedAction === 'publish' && <span className={output.publishEligible ? 'candidate-output-readback' : 'candidate-output-gap'}>
                  {output.publishEligible ? words('计划内可进入候选准备；发布授权未评估', 'Eligible for candidate preparation; authorization not evaluated')
                    : words('暂不能发布：目标、语义或结构尚未满足', 'Not publishable yet: target, meaning or structure is incomplete')}
                </span>}
                {gaps.length > 0 && <span className="candidate-output-gap">{words(`缺口：${gaps.slice(0, 3).join('；')}${gaps.length > 3 ? `；还有 ${gaps.length - 3} 项，见详情` : ''}`,
                  `Gaps: ${gaps.slice(0, 3).join('; ')}${gaps.length > 3 ? `; ${gaps.length - 3} more in details` : ''}`)}</span>}
                {output.routingState === 'rejected' && output.rejectReason && <span className="candidate-output-gap">{words('本地用途拒绝理由', 'Local rejection reason')}：{output.rejectReason}</span>}
                {output.state === 'structured' && generation !== null && <a className="processing-artifact" href={`/api/bd/processing/plans/${encodeURIComponent(plan.planId)}/outputs/${encodeURIComponent(output.outputId)}/artifact?localDataGeneration=${generation}`}
                  target="_blank" rel="noreferrer"><FileJson size={13} aria-hidden="true" />{words('查看结构产物', 'View structural artifact')}</a>}
                <div className="processing-steps">
                  {output.steps.map(step => <span className="processing-step" data-state={step.state} key={step.stepId} title={step.stepId}>
                    <span>{stepLabel(step, words)}</span>
                    <span className="processing-step-state">{label(stepStateLabels, step.state, words)}</span>
                    {step.state === 'succeeded' && step.output && generation !== null && <a className="processing-step-action" target="_blank" rel="noreferrer"
                      href={`/api/bd/processing/plans/${encodeURIComponent(plan.planId)}/steps/${encodeURIComponent(step.stepId)}/artifact?localDataGeneration=${generation}`}>{words('产物', 'Artifact')}</a>}
                    {step.state === 'pending' && <button type="button" className="text-button processing-step-action" disabled={!!busy}
                      onClick={() => void act(item, 'execute', step.stepId)}>{words('单步执行', 'Run step')}</button>}
                  </span>)}
                </div>
              </li>;
            })}
          </ul>
          <p className="processing-next">{nextAction(plan, task, words)}</p>
          <div className="processing-actions">
            {pending.length > 0 && !task && <button type="button" className="primary-button" disabled={!!busy} onClick={() => void act(item, 'run')}>
              <Play size={14} aria-hidden="true" />{busy === `${plan.planId}:run:` ? words('运行中…', 'Running…') : words('运行剩余步骤', 'Run remaining steps')}</button>}
            {task && <button type="button" className="text-button danger-text" disabled={stopping.has(task.taskId)} onClick={() => void stopTask(item, task)}>
              <Square size={13} aria-hidden="true" />{stopping.has(task.taskId) ? words('停止中…', 'Stopping…') : words('停止任务', 'Stop task')}</button>}
            <button type="button" className="text-button" disabled={!!busy} onClick={() => void act(item, 'recover')}>
              <RotateCw size={14} aria-hidden="true" />{words('核对产物', 'Verify artifacts')}</button>
            <button type="button" className="text-button" disabled={running} onClick={() => void load()}>
              <RefreshCw size={14} aria-hidden="true" />{words('刷新原结果', 'Refresh result')}</button>
          </div>
          <details className="result-details"><summary>{words('计划身份、目标与逐步骤详情', 'Plan identity, target and step details')}</summary>
            <dl><dt>{words('计划', 'Plan')}</dt><dd>{plan.planId}</dd><dt>{words('原请求', 'Request')}</dt><dd>{plan.requestId}</dd>
              {plan.parentPlanId && <><dt>{words('原计划', 'Previous plan')}</dt><dd>{plan.parentPlanId}</dd></>}
              <dt>{words('状态', 'Status')}</dt><dd>{plan.status}</dd>
              <dt>{words('更新时间', 'Updated')}</dt><dd>{new Date(plan.updatedAt).toISOString()}</dd></dl>
            {plan.outputs.map((output, index) => <div className="candidate-output-detail" key={output.outputId}>
              <strong>{outputLabel(plan, output, index)} · {output.outputId}</strong>
              <small>{words('路由', 'Routing')} {output.routingState} · {words('意图', 'Intent')} {output.intendedAction} · {words('证据范围', 'Evidence scope')} {output.evidenceScope ?? '—'}</small>
              {output.routingState === 'rejected' && output.rejectReason && <small>{words('本地用途拒绝理由', 'Local rejection reason')}：{output.rejectReason}</small>}
              {output.target && <small>{words('目标', 'Target')} {output.target.productId ?? output.target.kind}{output.target.expectedSnapshotId ? ` · ${output.target.expectedSnapshotId}` : ''}</small>}
              {output.steps.map(step => <small key={step.stepId}>{step.stepId} · {step.kind} · {step.state} · {step.outputDigest ? step.outputDigest.slice(0, 16) : '—'}</small>)}
              {gapsOf(output).map(gap => <small key={gap}>{words('缺口', 'Gap')}：{gap}</small>)}
            </div>)}
            {[item.task, ...item.executions].filter((entry): entry is ProcessingTaskView => !!entry).map(entry =>
              <div className="candidate-output-detail" key={entry.taskId}><strong>{words('处理任务', 'Processing task')} {entry.action}</strong>
                <small>{entry.taskId} · {entry.status} · {words('版本', 'Version')} {entry.version} · {words('运行', 'Run')} {entry.currentRunId ?? '—'}</small>
                {entry.error && <small>{entry.error.code}: {entry.error.message}</small>}</div>)}
          </details>
        </div>
      </article>;
    })}
  </section>;
}
