import { useEffect, useRef, useState } from 'react';
import type { CorrectionCaseDetail } from '../correction-cases-api';
import { caseInputRefs, outputIdentifier, readCorrectionDownstream, type DownstreamView } from '../correction-downstream-api';
import { localDataGeneration, localDataRevision, subscribeLocalDataRevoked } from '../local-data-context';
import { useWords, ErrorNote } from './Controls';
import { PageButton, PageField, PageEmpty } from './PageUI';
import { DetailFacts, DetailSection } from './ObjectDetailPanel';
export function CorrectionDownstreamPanel({ detail, connection }: { detail: CorrectionCaseDetail; connection: string }) {
  const words = useWords(), [planId,setPlanId] = useState(''), [outputId,setOutputId] = useState(''), [requestId,setRequestId] = useState('');
  const [result,setResult] = useState<DownstreamView | null>(null), [busy,setBusy] = useState(false), [error,setError] = useState(false);
  const epoch = useRef(0), mounted = useRef(true);
  useEffect(() => { mounted.current = true; const stop = subscribeLocalDataRevoked(() => { epoch.current++; setResult(null); setError(true); setBusy(false); });
    return () => { mounted.current = false; epoch.current++; stop(); }; }, []);
  let validRefs = false; try { caseInputRefs(detail); validRefs = true; } catch { /* Explicit unknown; no truncation to fit the query budget. */ }
  function changed(set: (x:string)=>void, value:string) { epoch.current++; set(value); setResult(null); setError(false); setBusy(false); }
  async function read() {
    const current = ++epoch.current, generation = localDataGeneration(), revision = localDataRevision();
    const active = () => mounted.current && current === epoch.current && generation === localDataGeneration() && revision === localDataRevision();
    setBusy(true); setError(false); setResult(null);
    try { const response = await readCorrectionDownstream(detail,{ planId,outputId,requestId },connection); if (active()) setResult(response.value); }
    catch { if (active()) setError(true); } finally { if (active()) setBusy(false); }
  }
  return <section data-testid="correction-downstream" aria-busy={busy}>
    <DetailSection title={words('用事项引用核对指定输出', 'Compare case references with one output')}>
      <p>{words('明确填写一个加工计划、输出与 WFD 发布请求。只读比较该输出解析证据与事项中的完整旧记录引用，不自动扫描或执行修复。', 'Specify one processing plan, output and WFD publication request. Read only: inspect the case’s complete old references for this output. No scan or repair is started.')}</p>
      {[['加工计划编号','Processing plan ID',planId,setPlanId],['输出编号','Output ID',outputId,setOutputId],['WFD 发布请求编号','WFD publication request ID',requestId,setRequestId]].map(([zh,en,value,set]) => <PageField key={String(en)} label={words(String(zh),String(en))}><input aria-label={words(String(zh),String(en))} value={String(value)} maxLength={128} onChange={e=>changed(set as (x:string)=>void,e.target.value)} /></PageField>)}
      {!validRefs && <PageEmpty state="unavailable">{words('事项须有 1–128 条完整且不重复的固定引用；不截断、不猜测。', 'Requires 1–128 complete, unique fixed case references. No truncation or inference.')}</PageEmpty>}
      <PageButton disabled={busy || !validRefs || ![planId,outputId,requestId].every(outputIdentifier)} onClick={()=>void read()}>{words('查询指定正式输出', 'Inspect specified published output')}</PageButton>
      {busy && <PageEmpty state="loading">{words('核对中…','Verifying…')}</PageEmpty>}
      {error && <ErrorNote>{words('无法核对或绑定已变化，旧结果已清除。影响未知，不等于没有发布或没有依赖。', 'Verification failed or binding changed; old result cleared. Impact is unknown, not proof of no publication or dependency.')}</ErrorNote>}
      {result && <div data-testid="correction-downstream-result">
        <p>{words('该固定输出的完整正式发布已核对。以下输入观察不是逐行因果归属。', 'The complete fixed output publication was verified. Input observations below are not published-row causation.')}</p>
        <DetailFacts items={[{label:words('正式产品 / 快照','Published product / snapshot'),value:result.productId+' / '+result.snapshotId},{label:words('输出摘要','Output digest'),value:result.outputSha256},{label:words('缺口数','Gap count'),value:result.gapCount}]} />
        {result.inputs.map((item,index)=><div key={index}><p className="database-scope">{item.ref.snapshot_id} / {item.ref.product_id} / {item.ref.logical_key} / {item.ref.revision_id}</p><p>{item.status==='observed'?words('observed：该固定输出的已核解析证据观察到相同四元组引用。','observed: the same four-part reference appears in verified parse evidence for this fixed output.'):item.status==='not_observed'?words('not_observed：仅此固定输出未观察到；不证明全局独立或无影响。','not_observed: not observed only in this fixed output; not global independence or absence of impact.'):words('unknown：解析证据不完整，不能判断。','unknown: incomplete parse evidence; no conclusion.')}</p></div>)}
        <p>{words('逐行归属 unknown；完整下游影响 unknown。固定发布不证明当前可用、历史资格或事项属于当前 WFD。没有新增逐文档权限。','Row attribution unknown; full downstream impact unknown. Fixed publication does not prove current usability, historical qualification or case ownership in this WFD. No new per-document permissions.')}</p>
        <details><summary>{words('查看正式输出的固定引用','Show fixed published output references')}</summary>{result.records.map((r,i)=><p className="database-scope" key={i}>{r.snapshot_id} / {r.product_id} / {r.logical_key} / {r.revision_id}</p>)}</details>
      </div>}
    </DetailSection>
  </section>;
}
