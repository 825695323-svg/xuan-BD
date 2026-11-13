import { useEffect, useRef, useState } from 'react';
import type { AlgorithmEntryFocus } from './algorithm-catalog';
import type { AlgorithmCatalogView, AlgorithmTaskView } from '../../../../modules/financial/algorithm-types';
import { loadAlgorithmCatalog, listAlgorithmCalls, readAlgorithmCall } from '../algorithm-api';
import { ErrorNote, errorDetail } from './Controls';

/** 前端只读展示；所有算法执行、派生保管、R1 写回均由 BD AGENTS 工具调用。 */
export function ComputationPanel({ focus = null }: {
  focus?: Extract<AlgorithmEntryFocus, { kind: 'fixed' }> | null;
}) {
  const [catalog, setCatalog] = useState<AlgorithmCatalogView | null>(null);
  const [tasks, setTasks] = useState<AlgorithmTaskView[]>([]);
  const [selected, setSelected] = useState<AlgorithmTaskView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selectedRequest = useRef(0);
  useEffect(() => { let active = true;
    void Promise.all([loadAlgorithmCatalog(), listAlgorithmCalls()])
      .then(([methods, calls]) => { if (active) { setCatalog(methods); setTasks(calls); } })
      .catch(reason => { if (active) setError(errorDetail(reason)); });
    return () => { active = false; selectedRequest.current += 1; };
  }, []);
  return <section id="fixed-calculation" className="r1-stage" aria-label="基础算法只读展示">
    <h3>基础算法 / Basic Algorithms</h3>
    <p className="r1-help">这里只展示算法、运行状态及已有结果。BD AGENTS 从 WFD 固定快照读取，调用独立算法，再把派生新数据经五步加工、R1 受控发布和 WFD 固定读回。前端不能发起计算或发布。</p>
    {focus && <p className="r1-help">当前定位：{focus.methodId}。执行请走 BD AGENTS 工具接口。</p>}
    {error && <ErrorNote>{error}</ErrorNote>}
    {catalog && <div className="r1-table-scroll"><table><thead><tr><th>独立算法</th><th>执行状态</th><th>输入</th><th>输出</th></tr></thead>
      <tbody>{catalog.methods.map(method => <tr key={method.id}>
        <td><strong>{method.title}</strong><p><code>{method.id}</code></p></td>
        <td>{method.status} {method.reason ?? ''}</td><td>{method.requiredFields.join(', ')}</td><td>{method.outputFields.join(', ')}</td>
      </tr>)}</tbody></table></div>}
    <div className="r1-actions"><button type="button" className="text-button" onClick={() => {
      void listAlgorithmCalls().then(setTasks).catch(reason => setError(errorDetail(reason)));
    }}>刷新结果</button></div>
    <p className="r1-help">本地算法原任务（只读）。任务结果中的 publication=not_requested 仅表示计算阶段，WFD 是否正式发布须以单独 R1 回执为准。</p>
    {tasks.map(item => <button key={item.taskId} type="button" className="database-row database-row--button"
      onClick={() => {
        const token = ++selectedRequest.current;
        setSelected(null); setError(null);
        void readAlgorithmCall(item.taskId)
          .then(detail => { if (token === selectedRequest.current) setSelected(detail); })
          .catch(reason => { if (token === selectedRequest.current) setError(errorDetail(reason)); });
      }}>
      <span>{item.methodId} · <code>{item.taskId}</code></span><span>{item.status}</span>
    </button>)}
    {selected && <details open><summary>原算法结果和输入：{selected.taskId}</summary>
      <p>状态：{selected.status}；方法：{selected.methodId}；计算结果行数：{selected.result?.rows.length ?? 0}；入库依据需另核 R1。</p>
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
