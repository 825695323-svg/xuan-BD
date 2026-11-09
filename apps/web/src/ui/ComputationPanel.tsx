import { useEffect, useRef, useState } from 'react';
import type { FixedCalculationCandidateSelection, FixedCalculationCapabilities, FixedCalculationInput,
  FixedCalculationInputs, FixedCalculationMethodId, FixedCalculationRecordPage, FixedCalculationTaskView } from '../../../../contracts/fixed-calculation-contracts';
import { fixedCalculationApi } from '../fixed-calculation-api';
import type { AlgorithmEntryFocus } from './algorithm-catalog';
import { ErrorNote, errorDetail } from './Controls';
import { taskStateText } from './TaskResults';

type RecordChoice = { snapshotId: string; productId: string; businessKey: string; recordVersion: string; label: string };
const object = (value: unknown): Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const display = (value: unknown) => value === undefined || value === null ? '未知' : typeof value === 'string' ? value : JSON.stringify(value);
const cell = (values: Record<string, unknown>, field: string) => {
  const value = object(values[field]);
  return ['valid_value', 'reported_zero'].includes(String(value.value_state)) ? display(value.value) : '未知';
};
const active = ['ready', 'running', 'pausing', 'cancelling', 'waiting_approval'];

/** 方法选项来自服务注册表；输入选择只携带真实固定引用，不让操作者手编计算载荷。 */
export function ComputationPanel({ ready, onUseCandidate, focus = null }: { ready: boolean;
  onUseCandidate(selection: FixedCalculationCandidateSelection): void | Promise<void>;
  focus?: Extract<AlgorithmEntryFocus, { kind: 'fixed' }> | null }) {
  const [caps, setCaps] = useState<FixedCalculationCapabilities | null>(null), [inputs, setInputs] = useState<FixedCalculationInputs | null>(null);
  const [method, setMethod] = useState<FixedCalculationMethodId>('observation_ma20');
  const [sources, setSources] = useState<string[]>([]), [column, setColumn] = useState('');
  const [operation, setOperation] = useState<'quarter_difference' | 'ttm'>('quarter_difference'), [cutoff, setCutoff] = useState('');
  const [productId, setProductId] = useState(''), [recordPage, setRecordPage] = useState<FixedCalculationRecordPage | null>(null);
  const [records, setRecords] = useState<RecordChoice[]>([]), [selectedRecord, setSelectedRecord] = useState('');
  const [operands, setOperands] = useState<Array<RecordChoice | null>>([null, null, null]);
  const [tasks, setTasks] = useState<FixedCalculationTaskView[]>([]), [view, setView] = useState<FixedCalculationTaskView | null>(null);
  const [frozen, setFrozen] = useState<FixedCalculationInput | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState(''), [restoreId, setRestoreId] = useState('');
  const requestId = useRef(crypto.randomUUID());
  const sectionRef = useRef<HTMLElement>(null);
  const selection = caps?.methods.find(item => item.id === method);
  const selectedSources = inputs?.sources.filter(source => sources.includes(source.autoRequestId)) ?? [];
  const columns = selectedSources[0]?.valueColumns.filter(value => selectedSources.every(source => source.valueColumns.includes(value))) ?? [];
  const productChoices = inputs?.products.filter(product => product.methods.includes(method as 'financial_linear' | 'macro_yoy')) ?? [];
  const operandLabels = method === 'macro_yoy' ? ['本期版本', '去年同期间版本'] : operation === 'ttm'
    ? ['前一完整年度', '本期累计', '上年同期累计'] : ['本期累计', '上一季度累计'];
  const act = async (work: () => Promise<void>) => { if (busy) return; setBusy(true); setError(null);
    try { await work(); } catch (caught) { setError(errorDetail(caught)); } finally { setBusy(false); } };
  const remember = (value: FixedCalculationTaskView) => {
    setView(value); setTasks(current => [value, ...current.filter(item => item.task.id !== value.task.id)].slice(0, 20));
  };
  useEffect(() => { let live = true;
    void Promise.all([fixedCalculationApi.capabilities(), fixedCalculationApi.list()]).then(([capabilities, saved]) => {
      if (live) { setCaps(capabilities); setTasks(saved); }
    }).catch(caught => { if (live) setError(errorDetail(caught)); });
    return () => { live = false; };
  }, []);
  useEffect(() => {
    if (!view || !active.includes(view.task.status) && !(view.candidate?.custodyTaskId && !view.candidate.materialId)) return;
    let live = true;
    const timer = window.setInterval(() => {
      void fixedCalculationApi.get(view.task.id).then(value => { if (live) remember(value); })
        .catch(caught => { if (live) { setError(errorDetail(caught)); window.clearInterval(timer); } });
    }, 2000);
    return () => { live = false; window.clearInterval(timer); };
  }, [view?.task.id, view?.task.status, view?.candidate?.custodyTaskId, view?.candidate?.materialId]);
  const reset = () => { setFrozen(null); setView(null); setNotice(''); requestId.current = crypto.randomUUID(); };
  const changeMethod = (value: FixedCalculationMethodId) => {
    setMethod(value); setProductId(''); setRecordPage(null); setRecords([]); setSelectedRecord(''); setOperands([null, null, null]);
  };
  useEffect(() => {
    if (!focus) return;
    // 只定位和选择方法；不载入输入、不读取候选，也不触发计算。
    changeMethod(focus.methodId as FixedCalculationMethodId);
    const timer = window.setTimeout(() => sectionRef.current?.scrollIntoView({ block: 'start' }), 80);
    return () => window.clearTimeout(timer);
  }, [focus?.nonce]);
  const loadRecords = async (next = false) => {
    if (!inputs?.snapshotId || !productId) throw new Error('先载入并选择真实固定产品。');
    const cursor = next ? recordPage?.page.nextCursor : null;
    if (next && !cursor) return;
    const page = await fixedCalculationApi.records({ snapshotId: inputs.snapshotId, productId, ...(cursor ? { cursor } : {}) });
    const found = page.rows.map(row => ({ snapshotId: page.snapshotId, productId: page.productId,
      businessKey: row.businessKey, recordVersion: row.recordVersion,
      label: [cell(row.values, method === 'macro_yoy' ? 'series_code' : 'concept'),
        cell(row.values, method === 'macro_yoy' ? 'period_start' : 'start_date'), cell(row.values, method === 'macro_yoy' ? 'period_end' : 'end_date'),
        cell(row.values, 'value'), cell(row.values, method === 'macro_yoy' ? 'release_id' : 'report_version')].join(' · ') }));
    setRecordPage(page); setRecords(found); setSelectedRecord('');
  };
  const build = (): FixedCalculationInput => {
    const id = requestId.current;
    if (method === 'observation_ma20') {
      if (!selectedSources.length || !columns.includes(column)) throw new Error('选择同一完整系列的已关联原报和共同数值列。');
      return { requestId: id, method, autoRequestIds: selectedSources.map(source => source.autoRequestId), valueColumn: column };
    }
    const selected = operands.slice(0, operandLabels.length);
    if (selected.some(item => !item)) throw new Error('为每个期间选择一条实际固定记录。');
    const refs = selected as RecordChoice[];
    if (method === 'financial_linear') return { requestId: id, method, calculation: { version: 'bd-financial-fixed/1', operation,
      inputs: refs.map(item => ({ snapshotId: item.snapshotId, productId: item.productId, businessKeys: [item.businessKey] })) } };
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/u.test(cutoff) || !Number.isFinite(Date.parse(cutoff))) {
      throw new Error('填写明确的来源公布校验截止，例如2026-11-05T00:00:00Z。');
    }
    return { requestId: id, method, calculation: { version: 'bd.macro-yoy/1', historyMode: 'snapshot_contents', knowledgeCutoff: cutoff,
      inputs: refs.map(({ snapshotId, productId, businessKey, recordVersion }) => ({ snapshotId, productId, businessKey, recordVersion })) } };
  };
  const calculate = async () => {
    const input = frozen ?? build(); setFrozen(input);
    remember(await fixedCalculationApi.create(input)); setNotice('计算请求已受理；结果仅为候选。');
  };
  const statusText = (status: string) => taskStateText(status, (zh: string) => zh);

  return <section ref={sectionRef} id="fixed-calculation" className="r1-stage" aria-label="统一固定计算" aria-busy={busy}
    data-focus-method={focus?.methodId}>
    <h3>固定计算</h3>
    {focus && <p className="r1-help" role="status">已从算法目录定位到此固定计算方法；仍需在本面板手动载入实际输入并确认，页面未执行计算。</p>}
    <p className="r1-help">选择方法与已存入的实际数据，得到可核对的计算候选。数据库查询在下方办理；已有批次自动均线继续使用原批次保存的周期。</p>
    <div className="r1-actions"><button type="button" className="text-button" disabled={!ready || busy || !!frozen} onClick={() => void act(async () => {
      setInputs(await fixedCalculationApi.inputs()); setSources([]); setColumn(''); setOperands([null, null, null]);
      setProductId(''); setRecords([]); setRecordPage(null); setSelectedRecord('');
    })}>载入实际计算输入</button><span className="r1-help">{inputs?.snapshotId ? <>本次固定快照：<code>{inputs.snapshotId}</code></> : '先载入原报与固定产品。'}</span></div>
    {caps && !caps.configured && <p className="r1-help" role="status">{caps.reason}</p>}
    <label>计算方法<select value={method} disabled={busy || !!frozen} onChange={event => changeMethod(event.target.value as FixedCalculationMethodId)}>
      {(caps?.methods ?? []).map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
    {selection && <><p className="r1-help">{selection.description}</p><p className="r1-help">{selection.scope}</p></>}
    {inputs && method === 'observation_ma20' && <>
      <fieldset className="r1-read-fields" disabled={busy || !!frozen}><legend>同一系列的来源原报（最近20份）</legend>
        <div className="r1-read-field-options">{inputs.sources.map(source => <label key={source.autoRequestId}>
          <input type="checkbox" checked={sources.includes(source.autoRequestId)} onChange={event => {
            setSources(current => event.target.checked ? [...current, source.autoRequestId] : current.filter(id => id !== source.autoRequestId)); setColumn('');
          }} /><span>{source.filename} · {source.rowCount}行</span></label>)}</div>
        {!inputs.sources.length && <p className="r1-help">尚无可用的已关联日线原报。先在文件自动交接完成来源发布和固定读回。</p>}
      </fieldset>
      <label>原报数值列<select value={column} disabled={busy || !!frozen || !columns.length} onChange={event => setColumn(event.target.value)}>
        <option value="">选择共同原列</option>{columns.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
      <p className="r1-help">须选齐同一系列在固定快照中的完整原报；服务会核对全部原记录。20期以前和窗口缺值保留未知。</p>
    </>}
    {inputs && method !== 'observation_ma20' && <>
      {method === 'financial_linear' && <label>期间计算<select value={operation} disabled={busy || !!frozen} onChange={event => {
        setOperation(event.target.value as typeof operation); setOperands([null, null, null]);
      }}><option value="quarter_difference">相邻累计差为单季</option><option value="ttm">近十二个月</option></select></label>}
      <div className="r1-grid"><label>实际产品<select value={productId} disabled={busy || !!frozen} onChange={event => {
        setProductId(event.target.value); setRecords([]); setRecordPage(null); setSelectedRecord('');
      }}><option value="">选择已登记产品</option>{productChoices.map(product => <option key={product.productId} value={product.productId}>
        {display(product.subject.id)} · {product.semanticCode}</option>)}</select></label>
        <button type="button" className="text-button" disabled={busy || !!frozen || !productId} onClick={() => void act(() => loadRecords())}>载入固定记录</button></div>
      {!productChoices.length && <p className="r1-help">当前快照没有含本方法全部必需字段的可读产品；先按对应格式化流程办理原数据。</p>}
      {recordPage && <><label>本页实际记录<select value={selectedRecord} disabled={busy || !!frozen} onChange={event => setSelectedRecord(event.target.value)}>
        <option value="">选择具体期间和来源版本</option>{records.map((item, index) => <option key={item.businessKey + item.recordVersion} value={String(index)}>{item.label}</option>)}</select></label>
        <div className="r1-actions"><button type="button" className="text-button" disabled={busy || !!frozen || !recordPage.page.hasMore} onClick={() => void act(() => loadRecords(true))}>读取下一页记录</button>
          <span className="r1-help">{recordPage.page.hasMore ? '还有后续记录；选择期间后继续翻页。' : '当前固定产品已到末页。'}</span></div></>}
      <fieldset className="r1-read-fields" disabled={busy || !!frozen}><legend>固定期间与版本</legend>{operandLabels.map((label, index) => <div className="r1-proof" key={label}>
        <strong>{label}</strong><p>{operands[index]?.label ?? '尚未选择实际记录'}</p>
        {operands[index] && <small>固定快照：{operands[index]!.snapshotId}；业务键：{operands[index]!.businessKey}</small>}
        <button type="button" className="text-button" disabled={selectedRecord === '' || !records[Number(selectedRecord)]} onClick={() => setOperands(current => current.map((item, i) => i === index ? records[Number(selectedRecord)] : item))}>将所选记录用于{label}</button>
      </div>)}</fieldset>
      {method === 'macro_yoy' && <label>来源公布校验截止（UTC，协调世界时）<input value={cutoff} disabled={busy || !!frozen} placeholder="2026-11-05T00:00:00Z" onChange={event => setCutoff(event.target.value)} /></label>}
      {method === 'financial_linear' && <p className="r1-help">本面板按相同披露修订选择。跨修订需要受信原文相容性核对，本面板暂不提供；条件不足时保留缺口。</p>}
    </>}
    {inputs?.gaps.map(gap => <p className="r1-help" key={gap}>{gap}</p>)}
    <div className="r1-actions"><button type="button" className="primary-button" disabled={busy || !caps?.configured || !inputs || !!view} onClick={() => void act(calculate)}>{frozen ? '核对并继续原计算请求' : '开始固定计算'}</button>
      {(frozen || view) && <button type="button" className="text-button" disabled={busy} onClick={reset}>新建其他计算</button>}</div>
    {frozen && <p className="r1-help">本次请求：<code>{frozen.requestId}</code>。重试沿用本次方法和输入；结果未知时先核对原请求。</p>}
    {notice && <p className="r1-notice" role="status">{notice}</p>}{error && <ErrorNote>{error}</ErrorNote>}
    {view && <div className="r1-proof" aria-label="固定计算任务结果"><strong>{caps?.methods.find(item => item.id === view.methodId)?.title ?? view.methodId} · {statusText(view.task.status)}</strong>
      <p className="r1-help">原任务：<code>{view.task.id}</code></p>{view.task.error && <p role="alert">{view.task.error.message}</p>}
      {view.result && <><p>{view.result.rowCount}行候选；尚未发布。</p><div className="r1-table-scroll"><table><thead><tr><th>期间</th><th>实际计算值</th><th>值状态</th></tr></thead>
        <tbody>{view.result.rows.slice(0, 25).map((row, index) => <tr key={index}><td>{display(row.start_utc ?? row.period_start)}</td><td>{display(row.value)}</td><td>{row.value_state === 'unknown' ? '未知' : row.value_state === 'reported_zero' ? '报告为零' : row.value_state === 'valid_value' ? '有效值' : display(row.value_state)}</td></tr>)}</tbody></table></div>
        {view.result.rowCount > 25 && <p className="r1-help">仅预览前25行；候选保管使用完整结果。</p>}
        <div className="r1-actions"><button type="button" className="text-button" disabled={busy || !!view.candidate?.materialId} onClick={() => void act(async () => {
          remember(await fixedCalculationApi.stage(view.task.id)); setNotice('已受理候选保管，完成后可沿原加工计划继续。');
        })}>{view.candidate?.materialId ? '候选已保管' : view.candidate?.custodyTaskId ? '核对原候选保管' : '保管计算候选'}</button>
          {view.candidate?.materialId && <button type="button" className="primary-button" disabled={busy} onClick={() => void act(async () => {
            await onUseCandidate({ taskId: view.task.id, materialId: view.candidate!.materialId!, methodId: view.methodId,
              algorithmDefinition: view.result!.algorithmDefinition }); setNotice('已选择此候选，请在原交接表中核对语义、加工计划和目标。');
          })}>使用此候选继续交接</button>}</div>
        <details><summary>固定计算依据与候选摘要</summary><p className="r1-help">候选摘要：<code>{view.result.sha256}</code></p><pre className="database-text-preview">{JSON.stringify(view.result.algorithmDefinition, null, 2)}</pre></details></>}
      <button type="button" className="text-button" disabled={busy} onClick={() => void act(async () => remember(await fixedCalculationApi.get(view.task.id)))}>刷新原任务</button>
    </div>}
    <details><summary>读取已有计算任务</summary><div className="r1-actions"><label>原任务编号<input value={restoreId} disabled={busy} onChange={event => setRestoreId(event.target.value)} /></label>
      <button type="button" className="text-button" disabled={busy || !restoreId.trim()} onClick={() => void act(async () => remember(await fixedCalculationApi.get(restoreId.trim())))}>读取原任务</button>
      <button type="button" className="text-button" disabled={busy} onClick={() => void act(async () => setTasks(await fixedCalculationApi.list()))}>刷新任务列表</button></div>
      <p className="r1-help">最近20项计算；读取原任务会保留原输入、原版本和候选保管事实。</p>{tasks.map(item => <button type="button" className="text-button" disabled={busy} key={item.task.id}
        onClick={() => void act(async () => remember(await fixedCalculationApi.get(item.task.id)))}>{caps?.methods.find(found => found.id === item.methodId)?.title ?? item.methodId} · {statusText(item.task.status)} · {item.task.requestId}</button>)}</details>
  </section>;
}
