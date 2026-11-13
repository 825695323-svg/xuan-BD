import { useEffect, useState } from 'react';
import type { AlgorithmEntryFocus } from './algorithm-catalog';
import type { AlgorithmCatalogView, AlgorithmTaskView } from '../../../../modules/financial/algorithm-types';
import { loadAlgorithmCatalog, listAlgorithmCalls } from '../algorithm-api';
import { useAlgorithmResult } from './useAlgorithmResult';
import { ErrorNote, errorDetail, useWords } from './Controls';
import { PageActions, PageButton, PageEmpty, PageHeading } from './PageUI';

/** 前端只读展示；所有算法执行、派生保管、R1 写回均由 BD AGENTS 工具调用。 */
export function ComputationPanel({ focus = null }: {
  focus?: Extract<AlgorithmEntryFocus, { kind: 'fixed' }> | null;
}) {
  const words = useWords();
  const [catalog, setCatalog] = useState<AlgorithmCatalogView | null>(null);
  const [tasks, setTasks] = useState<AlgorithmTaskView[]>([]);
  // 跨页定位提示会自动清除，已选任务仍属于当前面板。
  const detail = useAlgorithmResult('database:computation');
  const selected = detail.task;
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => { let active = true;
    void Promise.all([loadAlgorithmCatalog(), listAlgorithmCalls()])
      .then(([methods, calls]) => { if (active) { setCatalog(methods); setTasks(calls); } })
      .catch(reason => { if (active) setError(errorDetail(reason)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  return <section id="fixed-calculation" className="r1-stage" aria-label={words('基础算法只读展示', 'Basic algorithms (read-only)')}>
    <PageHeading level="h3" title={words('基础算法', 'Basic algorithms')}
      description={words('这里只展示算法、运行状态及已有结果。BD AGENTS 从 WFD 固定快照读取，调用独立算法，派生结构化结果经独立核对、R1 正式交接与 WFD 固定读回，不再经过原报五步加工。前端不能发起计算或发布。',
        'Read-only algorithms, task status and saved results. BD AGENTS reads fixed WFD snapshots, runs independent methods and publishes verified derivatives through R1. The UI cannot run calculations or publish data.')} />
    {focus && <p className="r1-help">{words('当前定位', 'Selected method')}：{focus.methodId}。{words('执行请走 BD AGENTS 工具接口。', 'Run through BD AGENTS tools.')}</p>}
    {(error || detail.error) && <ErrorNote detail={error ?? detail.error}>{words('基础算法读取失败。', 'Could not load algorithms.')}</ErrorNote>}
    {loading && !catalog && !error && <PageEmpty state="loading">{words('正在读取算法目录…', 'Loading algorithm catalog…')}</PageEmpty>}
    {catalog && <div className="r1-table-scroll"><table><thead><tr><th>{words('独立算法', 'Algorithm')}</th><th>{words('执行状态', 'Status')}</th><th>{words('输入', 'Inputs')}</th><th>{words('输出', 'Outputs')}</th></tr></thead>
      <tbody>{catalog.methods.map(method => <tr key={method.id}>
        <td><strong>{method.title}</strong><p><code>{method.id}</code></p></td>
        <td>{method.status} {method.reason ?? ''}</td><td>{method.requiredFields.join(', ')}</td><td>{method.outputFields.join(', ')}</td>
      </tr>)}</tbody></table></div>}
    <PageActions><PageButton onClick={() => {
      void listAlgorithmCalls().then(setTasks).catch(reason => setError(errorDetail(reason)));
    }}>{words('刷新结果', 'Refresh results')}</PageButton></PageActions>
    <p className="r1-help">{words('本地算法原任务（只读）。任务结果中的 publication=not_requested 仅表示计算阶段，WFD 是否正式发布须以单独 R1 回执为准。',
      'Local algorithm tasks (read-only). publication=not_requested only describes computation; formal WFD publication requires a separate R1 receipt.')}</p>
    {!tasks.length && !loading && !error && <PageEmpty>{words('尚无已登记算法任务。', 'No recorded algorithm tasks.')}</PageEmpty>}
    {tasks.map(item => <button key={item.taskId} type="button" className="database-row database-row--button"
      aria-current={selected?.taskId === item.taskId ? 'true' : undefined}
      onClick={() => { void detail.loadTask(item.taskId, item.methodId); }}>
      <span>{item.methodId} · <code>{item.taskId}</code></span><span>{item.status}</span>
    </button>)}
    {selected && <details open><summary>{words('原算法结果和输入', 'Original result and input')}：{selected.taskId}</summary>
      <p>{words('状态', 'Status')}：{selected.status}；{words('方法', 'Method')}：{selected.methodId}；
        {words('计算结果行数', 'Result rows')}：{selected.result?.rows.length ?? 0}；
        {words('入库依据需另核 R1。', 'Ingestion requires a separate R1 verification.')}</p>
      <pre className="database-text-preview">{JSON.stringify({
        inputDigest: selected.result?.inputDigest ?? null,
        source: selected.result?.source ?? null,
        parameters: selected.result?.parameters ?? null,
        methodVersion: selected.result?.methodVersion ?? null,
        preview: selected.result?.rows.slice(0, 10) ?? [],
        error: selected.error
      }, null, 2)}</pre></details>}
  </section>;
}
