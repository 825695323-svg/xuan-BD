import { R1_CONTEXT_OPERATIONS, type R1ContextOperation, type R1ContextReadInput, type R1ContextRead } from '../../../../contracts/r1-contracts';
import { useState } from 'react';
import type { R1ProductDiscovery } from '../../../../contracts/r1-contracts';
import { r1Api } from '../r1-api';
import { queryObject as object, structuredQueryApi, type QueryRecord } from '../structured-query-api';
import { ErrorNote, errorDetail } from './Controls';

interface Clause { field: string; operator: string; value: string; second: string; otherField: string;
  negate: boolean; includeLow: boolean; includeHigh: boolean }
interface Field { key: string; code: string; label: string; semantic: string; unit: string; productId: string }
const blank = (): Clause => ({ field: '', operator: '>=', value: '', second: '', otherField: '', negate: false, includeLow: true, includeHigh: true });
const display = (value: unknown) => value === null || value === undefined ? '—' : typeof value === 'string' ? value : JSON.stringify(value);
const outcomes: Record<string, string> = { matched: '已找到符合条件的对象', empty: '完整扫描后无符合对象',
  ambiguous: '记录选择存在歧义', coverage_insufficient: '查询存在数据或证据缺口', budget_exceeded: '本次扫描预算不足' };
const valueStates: Record<string, string> = { valid_value: '有效值', reported_zero: '报告为零', unknown: '未知' };
function label(code: string, prefix: string): string {
  if (!code.startsWith(prefix)) return code;
  try { const decoded = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(code.slice(prefix.length).replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)));
    return decoded && !/[\u0000-\u001f\u007f]/u.test(decoded) ? decoded : code;
  } catch { return code; }
}

const contextLabels: Record<R1ContextOperation, string> = { read_company_context: '公司上下文', read_relation_graph: '关系图',
  read_applicable_rules: '适用规则', read_event_timeline: '事件时间线' };

export function StructuredQueryPanel({ ready }: { ready: boolean }) {
  const [kind, setKind] = useState<'filter' | R1ContextOperation>('filter');
  return <>
    <section className="r1-stage"><label>查询种类<select value={kind} onChange={event => setKind(event.target.value as typeof kind)}>
      <option value="filter">结构化筛选与联合检索</option>
      {R1_CONTEXT_OPERATIONS.map(operation => <option value={operation} key={operation}>{contextLabels[operation]}（固定快照）</option>)}
    </select></label></section>
    {kind === 'filter' ? <FilterQueryPanel ready={ready} /> : <ContextQueryPanel key={kind} ready={ready} operation={kind} />}
  </>;
}

function ContextQueryPanel({ ready, operation }: { ready: boolean; operation: R1ContextOperation }) {
  const [discovery, setDiscovery] = useState<R1ProductDiscovery | null>(null), [focus, setFocus] = useState('');
  const [depth, setDepth] = useState(1), [pageSize, setPageSize] = useState(20), [filter, setFilter] = useState('');
  const [fields, setFields] = useState<string[]>([]), [lastRequest, setLastRequest] = useState<R1ContextReadInput | null>(null);
  const [view, setView] = useState<R1ContextRead | null>(null), [pageNumber, setPageNumber] = useState(1);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const choices = [...new Map((discovery?.selections ?? []).map(item => {
    const key = JSON.stringify([item.datasetId, item.subject]); return [key, { key, datasetId: item.datasetId, subject: item.subject }];
  })).values()];
  const selected = choices.find(item => item.key === focus);
  const availableFields = [...new Set((discovery?.selections ?? []).filter(item => item.datasetId === selected?.datasetId).flatMap(item => item.fields))].sort();
  const changed = () => { setView(null); setLastRequest(null); setPageNumber(1); setError(null); };
  const act = async (work: () => Promise<void>) => { if (busy) return; setBusy(true); setError(null);
    try { await work(); } catch (caught) { setError(errorDetail(caught)); } finally { setBusy(false); } };
  const read = async (input: R1ContextReadInput, page: number) => {
    const result = await structuredQueryApi.context(input); setView(result); setLastRequest(input); setPageNumber(page);
  };
  const build = (): R1ContextReadInput => {
    if (!discovery || !selected) throw new Error('先载入固定快照，并选择真实数据集及完整主体。');
    const names = filter.split(/[,，]/u).map(value => value.trim()).filter(Boolean);
    return { operation, snapshotId: discovery.snapshotId, datasetId: selected.datasetId, subject: selected.subject, pageSize,
      ...(fields.length ? { fields } : {}),
      ...(['read_company_context', 'read_relation_graph'].includes(operation) ? { maxDepth: depth } : {}),
      ...(names.length && operation === 'read_relation_graph' ? { relationTypes: names } : {}),
      ...(names.length && operation === 'read_applicable_rules' ? { ruleCodes: names } : {}),
      ...(names.length && operation === 'read_event_timeline' ? { eventTypes: names } : {}) };
  };
  const result = object(view?.result), page = object(result.page);
  const rows = Array.isArray(operation === 'read_relation_graph' ? result.edges : result.rows)
    ? (operation === 'read_relation_graph' ? result.edges : result.rows) as QueryRecord[] : [];
  const gaps = Array.isArray(result.gaps) ? result.gaps : [], conflicts = Array.isArray(result.rule_conflicts) ? result.rule_conflicts : [];
  return <section className="r1-stage structured-query-panel" aria-label={`${contextLabels[operation]}固定快照查询`} aria-busy={busy}>
    <h3>{contextLabels[operation]} · 固定快照内容</h3>
    <p className="r1-help">本入口只读所选固定快照，不证明市场当时已知或系统当时持有。主体种类、命名空间和编号共同决定身份；记录、合同、覆盖与缺口分别显示。</p>
    <div className="r1-actions"><button type="button" className="text-button" disabled={!ready || busy} onClick={() => void act(async () => {
      changed(); setFocus(''); setFields([]); setDiscovery(null);
      const snapshot = await r1Api.snapshotStatus();
      if (!snapshot.snapshotId) throw new Error('绑定实例尚无已发布快照。');
      setDiscovery(await r1Api.discoverProducts(snapshot.snapshotId));
    })}>载入当前快照主体</button><span className="r1-help">{discovery ? <>本次固定：<code>{discovery.snapshotId}</code></> : '先载入真实产品和主体。'}</span></div>
    {discovery && <>
      <div className="r1-grid"><label>数据集与完整主体<select disabled={busy} value={focus} onChange={event => { setFocus(event.target.value); setFields([]); changed(); }}>
        <option value="">选择真实主体</option>{choices.map(item => <option value={item.key} key={item.key}>{item.datasetId} · {String(item.subject.kind)} · {String(item.subject.namespace)} · {String(item.subject.id)}</option>)}
      </select></label>
      {['read_company_context', 'read_relation_graph'].includes(operation) && <label>关系深度<select disabled={busy} value={depth} onChange={event => { setDepth(Number(event.target.value)); changed(); }}>
        {[0, 1, 2, 3].map(value => <option key={value} value={value}>{value}层{value === 0 ? '（仅焦点身份）' : ''}</option>)}
      </select></label>}
      <label>每页条数<input type="number" min={1} max={100} disabled={busy} value={pageSize} onChange={event => { setPageSize(Number(event.target.value)); changed(); }} /></label>
      {operation !== 'read_company_context' && <label>{operation === 'read_relation_graph' ? '关系类型' : operation === 'read_event_timeline' ? '事件类型' : '规则码'}（可选，逗号分隔）<input disabled={busy} value={filter} onChange={event => { setFilter(event.target.value); changed(); }} /></label>}
      </div>
      {selected && availableFields.length > 0 && <fieldset className="r1-read-fields"><legend>字段投影（可选；未选择则读取各产品的声明字段）</legend><div className="r1-read-field-options">
        {availableFields.map(field => <label key={field}><input type="checkbox" disabled={busy} checked={fields.includes(field)} onChange={event => { setFields(previous => event.target.checked ? [...previous, field] : previous.filter(value => value !== field)); changed(); }} />{field}</label>)}
      </div></fieldset>}
      <p className="r1-help">{operation === 'read_relation_graph' ? '未知有效期关系保留不确定原因，不扩展为确认身份。图预算截断与分页末尾分别核对。'
        : operation === 'read_applicable_rules' ? '同码多依据并列返回冲突；本入口不解释优先级或例外。没有规则产品时显示明确缺口。'
          : operation === 'read_event_timeline' ? '计划与实际事件按原性质和状态分列，不合并为已发生事实。' : '只返回当前数据集内可达的公司、证券、关系和事件；不代表公司全量信息。'}</p>
      <button type="button" className="primary-button" disabled={!ready || busy || !selected} onClick={() => void act(async () => { changed(); await read(build(), 1); })}>读取固定快照上下文</button>
    </>}
    {busy && <p className="r1-help" role="status">正在读取固定快照上下文…</p>}{error && <ErrorNote>{error}</ErrorNote>}
    {view && <div className="r1-read-result" aria-label="上下文读取结果">
      <p role="status">{contextLabels[operation]}；第{pageNumber}页，本页{rows.length}条。{page.has_more ? '还有后续页。' : '已到当前结果末页；覆盖与缺口仍须核对。'}</p>
      <p className="r1-help">固定快照：<code>{view.snapshotId}</code>；主体：{String(view.subject.kind)} / {String(view.subject.namespace)} / {String(view.subject.id)}。</p>
      {result.truncated === true && <p className="danger-text">图读取达到预算，当前结果已截断，不能作为完整关系图。</p>}
      {conflicts.length > 0 && <p className="danger-text">规则存在多份冲突依据，已并列返回；没有选择其中一份作为最终裁决。</p>}
      {rows.map((row, index) => <div className="r1-proof" key={index}>
        <strong>{String(object(row.subject).id ?? '未声明主体')} · {display(row.row_type ?? row.relation_type ?? '记录')}</strong>
        {row.object ? <p>{display(row.relation_type)} → {display(object(row.object).id)}；连通资格：{display(row.connectivity)}</p> : null}
        {row.event ? <p>事件性质：{display(object(row.event).content_nature)}；状态：{display(object(row.event).status)}；编号：{display(object(row.event).event_id)}</p> : null}
        {row.rule ? <p>规则：{display(object(row.rule).rule_code)}；{object(row.rule).conflict === true ? '冲突依据并列' : '依据按原记录显示'}</p> : null}
        {Object.keys(object(row.values)).length > 0 && <pre className="database-text-preview">{JSON.stringify(row.values, null, 2)}</pre>}
        <details><summary>记录版本、时间及固定合同</summary><pre className="database-text-preview">{JSON.stringify(row, null, 2)}</pre></details>
      </div>)}
      {gaps.length > 0 && <div className="r1-proof"><strong>读取缺口与限制</strong><pre className="database-text-preview">{JSON.stringify(gaps, null, 2)}</pre></div>}
      <button type="button" className="text-button" disabled={busy || page.has_more !== true || typeof page.next_cursor !== 'string' || !lastRequest} onClick={() => {
        if (lastRequest && typeof page.next_cursor === 'string') void act(() => read({ ...lastRequest, cursor: page.next_cursor as string }, pageNumber + 1));
      }}>继续下一页上下文</button>
      <details><summary>关联身份、覆盖、预算与完整固定结果</summary><pre className="database-text-preview">{JSON.stringify(view, null, 2)}</pre></details>
    </div>}
  </section>;
}

/** Controls are populated from fixed public contracts; no hand-written product or field IDs. */
function FilterQueryPanel({ ready }: { ready: boolean }) {
  const [discovery, setDiscovery] = useState<R1ProductDiscovery | null>(null);
  const [selected, setSelected] = useState<string[]>([]), [clauses, setClauses] = useState<Clause[]>([blank()]);
  const [combine, setCombine] = useState('and'), [start, setStart] = useState(''), [end, setEnd] = useState('');
  const [timezone, setTimezone] = useState('Asia/Shanghai'), [history, setHistory] = useState('snapshot_contents');
  const [cutoff, setCutoff] = useState(''), [orderField, setOrderField] = useState(''), [direction, setDirection] = useState('desc');
  const [pageSize, setPageSize] = useState(20), [documentQuery, setDocumentQuery] = useState('');
  const [indexes, setIndexes] = useState<Array<{ index_version: string; built_at: number }>>([]), [indexVersion, setIndexVersion] = useState('');
  const [lastRequest, setLastRequest] = useState<{ structured: QueryRecord; documents?: QueryRecord } | null>(null);
  const [result, setResult] = useState<QueryRecord | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const products = discovery?.products.map(object).filter(p => selected.includes(String(p.product_id))) ?? [];
  const choices = (discovery?.products ?? []).map(object).filter(p => ['entity', 'instrument', 'listing', 'region'].includes(String(object(p.subject).kind)));
  const fields: Field[] = [], seen = new Set<string>();
  for (const product of products) {
    const declaration = object(product.declaration), semantic = String(declaration.semantic_code);
    const definitions = product.payload_kind === 'scalar_rows'
      ? [{ field_code: 'value_decimal', data_type: 'decimal', unit_code: declaration.unit_code }]
      : Array.isArray(declaration.field_definitions) ? declaration.field_definitions.map(object) : [];
    for (const field of definitions) {
      if (field.data_type !== 'decimal') continue;
      const key = JSON.stringify([semantic, field.field_code, field.unit_code]);
      if (seen.has(key)) continue;
      seen.add(key);
      fields.push({ key, code: String(field.field_code), label: label(String(field.field_code), 'src_'), semantic,
        unit: String(field.unit_code), productId: String(product.product_id) });
    }
  }
  const changed = () => { setResult(null); setLastRequest(null); setPageNumber(1); setError(null); };
  const act = async (work: () => Promise<void>) => { if (busy) return; setBusy(true); setError(null);
    try { await work(); } catch (caught) { setError(errorDetail(caught)); } finally { setBusy(false); } };
  const update = (index: number, patch: Partial<Clause>) => { setClauses(current => current.map((clause, i) => i === index ? { ...clause, ...patch } : clause)); changed(); };
  const optionFields = () => <><option value="">选择已登记的数值字段</option>{fields.map(field => <option key={field.key} value={field.key}>{field.label}（{label(field.unit, 'srcunit_')}） · {label(field.semantic, 'source_report.')}</option>)}</>;

  const build = (): { structured: QueryRecord; documents?: QueryRecord } => {
    if (!discovery || !products.length || !start || !end || !clauses.length) throw new Error('先载入并选择实际产品，再选择业务日期与筛选条件。');
    if (new Set(products.map(p => p.dataset_id)).size !== 1) throw new Error('本次筛选须使用同一数据集中的产品。');
    const subjects = [...new Map(products.map(p => [JSON.stringify(p.subject), p.subject])).values()];
    const metrics: QueryRecord[] = [], aliases = new Map<string, string>();
    const metric = (key: string): { name: string; field: Field } => {
      const field = fields.find(f => f.key === key);
      if (!field) throw new Error('请选择当前固定合同中的数值字段。');
      let name = aliases.get(key);
      if (!name) {
        name = 'field_' + aliases.size; aliases.set(key, name);
        const bound = products.filter(p => object(p.declaration).semantic_code === field.semantic);
        if (new Set(bound.map(p => JSON.stringify(p.subject))).size !== bound.length) throw new Error('同一对象同一指标有多个产品候选；请先缩小产品选择。');
        metrics.push({ metric: name, field: field.code, bindings: bound.map(p => ({ subject: p.subject, product_id: p.product_id })) });
      }
      return { name, field };
    };
    const constant = (text: string, unit: string) => {
      if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(text)) throw new Error('阈值须为不含千分位的十进制原值，例如12.30。');
      return { data_type: 'decimal', value: text, unit_code: unit };
    };
    const nodes = clauses.map(clause => {
      const { name, field } = metric(clause.field); let node: QueryRecord;
      if (clause.operator === 'between') node = { between: { metric: name, low: constant(clause.value, field.unit), high: constant(clause.second, field.unit), include_low: clause.includeLow, include_high: clause.includeHigh } };
      else if (clause.operator === 'in') node = { in: { metric: name, values: clause.value.split(/[,，]/u).map(text => constant(text.trim(), field.unit)) } };
      else if (clause.operator.startsWith('metric')) node = { compare_metrics: { left: name, right: metric(clause.otherField).name, op: clause.operator === 'metric_gt' ? '>' : '<' } };
      else node = { compare: { metric: name, op: clause.operator, value: constant(clause.value, field.unit) } };
      return clause.negate ? { not: node } : node;
    });
    const order = orderField ? [{ kind: 'metric', metric: metric(orderField).name, direction, nulls: 'last' }] : [{ kind: 'subject', direction: 'asc' }];
    let knowledge: QueryRecord | null = null;
    if (history !== 'snapshot_contents') {
      const time = Date.parse(cutoff);
      if (!cutoff.endsWith('Z') || !Number.isFinite(time)) throw new Error('历史知识截止须为明确UTC（协调世界时）时点，例如2026-11-05T00:00:00Z。');
      knowledge = { status: 'known', precision: 'second', earliest_utc: new Date(time).toISOString().replace('.000Z', 'Z'),
        latest_exclusive_utc: new Date(time + 1000).toISOString().replace('.000Z', 'Z'), source_timezone: 'UTC' };
    }
    const role = String(object(products[0]!.declaration).time_role ?? 'observation');
    const structured = { dataset_id: products[0]!.dataset_id, snapshot_id: discovery.snapshotId,
      history_mode: history, knowledge_cutoff: knowledge, held_scope: null, usable_stage: null,
      universe: { kind: 'explicit_subjects', subjects }, metrics,
      business_time_range: { role, start, end, timezone }, predicate: nodes.length === 1 ? nodes[0] : { [combine]: nodes },
      order_by: order, page_size: pageSize, cursor: null };
    if (documentQuery.trim() && !indexVersion) throw new Error('联合检索须选择一个已登记文档索引。');
    return { structured, ...(documentQuery.trim() ? { documents: { method: 'keyword', query: documentQuery.trim(), limit: 20,
      indexVersion, mode: history === 'snapshot_contents' ? null : history, asOf: knowledge?.earliest_utc ?? null } } : {}) };
  };
  const execute = (input: { structured: QueryRecord; documents?: QueryRecord }, page: number) => act(async () => {
    const response = input.documents ? await structuredQueryApi.joint(input) : await structuredQueryApi.filter(input.structured);
    setLastRequest(input); setResult(response); setPageNumber(page);
  });
  const structured = result?.schema === 'bd.structured-document-retrieval/1' ? object(result.structured) : result ?? {}, page = object(structured.page);
  const objects = Array.isArray(result?.objects) ? result.objects.map(object) : [];

  return <section className="r1-stage structured-query-panel" aria-label="结构化筛选与联合检索" aria-busy={busy}>
    <h3>结构化筛选与联合检索</h3>
    <p className="r1-help">选择固定快照中的实际产品与字段，用原值条件筛选对象。业务日期内每个对象、指标须有唯一合格记录；多条记录会提示缩小期间。缺值保留未知。</p>
    <div className="r1-actions"><button type="button" className="text-button" disabled={!ready || busy} onClick={() => void act(async () => {
      changed(); setSelected([]); setClauses([blank()]);
      const snapshot = await r1Api.snapshotStatus();
      if (!snapshot.snapshotId) { setDiscovery(null); throw new Error('绑定实例尚无已发布快照。'); }
      const [found, versions] = await Promise.all([r1Api.discoverProducts(snapshot.snapshotId), structuredQueryApi.indexes()]);
      setDiscovery(found); setIndexes(versions); setIndexVersion(versions[0]?.index_version ?? '');
    })}>载入当前快照产品</button><span className="r1-help">{discovery ? <>本次固定：<code>{discovery.snapshotId}</code></> : '先载入真实产品与固定合同。'}</span></div>
    {discovery && <>
      <fieldset className="r1-read-fields"><legend>选择对象产品</legend><div className="r1-read-field-options">{choices.map(product => {
        const id = String(product.product_id), declaration = object(product.declaration), subject = object(product.subject);
        return <label key={id}><input type="checkbox" disabled={busy} checked={selected.includes(id)} onChange={event => {
          setSelected(current => event.target.checked ? [...current, id] : current.filter(value => value !== id)); changed();
        }} /><span>{display(subject.id)} · {display(object(object(declaration.semantic_context).identity).alias_scope ?? declaration.semantic_code)}</span></label>;
      })}</div>{!choices.length && <p className="r1-help">当前快照没有本入口支持的主体、证券、挂牌或地区产品。</p>}</fieldset>
      <div className="r1-grid"><label>业务日期起点<input type="date" value={start} disabled={busy} onChange={e => { setStart(e.target.value); changed(); }} /></label>
        <label>业务日期终点（含当天）<input type="date" value={end} disabled={busy} onChange={e => { setEnd(e.target.value); changed(); }} /></label>
        <label>业务时区<input value={timezone} disabled={busy} onChange={e => { setTimezone(e.target.value); changed(); }} /></label>
        <label>时间资格<select value={history} disabled={busy} onChange={e => { setHistory(e.target.value); changed(); }}><option value="snapshot_contents">固定快照内容</option><option value="market_known_at">市场当时已知（需公开资格）</option><option disabled value="system_held_at">系统当时持有（尚无可发现的持有范围）</option></select></label></div>
      {history !== 'snapshot_contents' && <label>知识截止（UTC，协调世界时）<input value={cutoff} placeholder="2026-11-05T00:00:00Z" disabled={busy} onChange={e => { setCutoff(e.target.value); changed(); }} /></label>}
      <p className="r1-help">快照内容不证明过去已公开或已持有。仅当前业务值产品只接受当前有效头；历史资格不足会返回具体缺口。</p>
      <fieldset className="r1-read-fields"><legend>筛选条件</legend><label>多条件关系<select value={combine} disabled={busy} onChange={e => { setCombine(e.target.value); changed(); }}><option value="and">全部满足</option><option value="or">任一满足</option></select></label>
        {clauses.map((clause, index) => <div className="r1-proof" key={index}><div className="r1-grid">
          <label>条件{index + 1}字段<select value={clause.field} disabled={busy} onChange={e => update(index, { field: e.target.value })}>{optionFields()}</select></label>
          <label>条件{index + 1}比较<select value={clause.operator} disabled={busy} onChange={e => update(index, { operator: e.target.value })}>{[['>=', '大于或等于'], ['>', '大于'], ['=', '等于'], ['<=', '小于或等于'], ['<', '小于'], ['between', '在区间内'], ['in', '属于原值集合'], ['metric_gt', '大于同产品另一字段'], ['metric_lt', '小于同产品另一字段']].map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label>
          {clause.operator.startsWith('metric') ? <label>条件{index + 1}另一字段<select value={clause.otherField} disabled={busy} onChange={e => update(index, { otherField: e.target.value })}>{optionFields()}</select></label>
            : <label>条件{index + 1}{clause.operator === 'between' ? '下界' : '原值'}<input value={clause.value} disabled={busy} placeholder={clause.operator === 'in' ? '10,12.30' : '12.30'} onChange={e => update(index, { value: e.target.value })} /></label>}
          {clause.operator === 'between' && <label>条件{index + 1}上界<input value={clause.second} disabled={busy} onChange={e => update(index, { second: e.target.value })} /></label>}
        </div><div className="r1-read-field-options"><label><input type="checkbox" disabled={busy} checked={clause.negate} onChange={e => update(index, { negate: e.target.checked })} />取此条件的否定（缺值仍未知）</label>
          {clause.operator === 'between' && <><label><input type="checkbox" checked={clause.includeLow} disabled={busy} onChange={e => update(index, { includeLow: e.target.checked })} />包含下界</label><label><input type="checkbox" checked={clause.includeHigh} disabled={busy} onChange={e => update(index, { includeHigh: e.target.checked })} />包含上界</label></>}
          {clauses.length > 1 && <button type="button" className="text-button" disabled={busy} onClick={() => { setClauses(current => current.filter((_, i) => i !== index)); changed(); }}>删除条件{index + 1}</button>}</div></div>)}
        <button type="button" className="text-button" disabled={busy || clauses.length >= 8} onClick={() => { setClauses(current => [...current, blank()]); changed(); }}>添加条件</button>
      </fieldset>
      <div className="r1-grid"><label>排序字段<select value={orderField} disabled={busy} onChange={e => { setOrderField(e.target.value); changed(); }}><option value="">完整对象身份</option>{fields.map(field => <option key={field.key} value={field.key}>{field.label}</option>)}</select></label>
        <label>数值排序<select value={direction} disabled={busy || !orderField} onChange={e => { setDirection(e.target.value); changed(); }}><option value="desc">从大到小</option><option value="asc">从小到大</option></select></label>
        <label>每页对象数<input type="number" min={1} max={100} value={pageSize} disabled={busy} onChange={e => { setPageSize(Number(e.target.value)); changed(); }} /></label>
        <label>关联资料检索词（可选）<input value={documentQuery} disabled={busy} onChange={e => { setDocumentQuery(e.target.value); changed(); }} /></label></div>
      {documentQuery.trim() && <label>固定文档索引<select value={indexVersion} disabled={busy} onChange={e => { setIndexVersion(e.target.value); changed(); }}><option value="">选择已登记索引</option>{indexes.map(index => <option key={index.index_version} value={index.index_version}>{new Date(index.built_at).toLocaleString('zh-CN')} · {index.index_version}</option>)}</select></label>}
      <p className="r1-help">资料只检索已核对回链的原材料；没有行版本关联、文档索引或历史公开证明时保留缺口。本地文档尚无逐文档权限模型。</p>
      <button type="button" className="primary-button" disabled={busy || !selected.length || !fields.length || !start || !end} onClick={() => {
        try { const input = build(); void execute(input, 1); } catch (caught) { setError(errorDetail(caught)); }
      }}>执行固定筛选</button>
    </>}
    {busy && <p className="r1-help" role="status">正在查询固定产品与资格…</p>}{error && <ErrorNote>{error}</ErrorNote>}
    {result && <div className="r1-read-result" aria-label="结构化筛选结果"><p role="status">{outcomes[String(result.status)] ?? display(result.status)}；第{pageNumber}页，本页{objects.length}个对象。</p>
      <p className="r1-help">扫描完成：{object(structured.scan_receipt).scan_complete ? '是' : '否'}；已确认匹配{display(object(structured.scan_receipt).matched_objects)}个；未知或有覆盖缺口{Array.isArray(structured.indeterminate) ? structured.indeterminate.length : 0}个。</p>
      {result.qualification ? <p className="r1-help">{display(object(result.qualification).note)} 文档索引：{display(object(result.qualification).document_index_version)}</p> : null}
      {objects.map((item, i) => <div className="r1-proof" key={i}><strong>{display(object(item.subject).id)}</strong>
        <div className="r1-table-scroll"><table><thead><tr><th>字段</th><th>实际比较值</th><th>状态</th><th>单位</th></tr></thead><tbody>{Object.entries(object(item.values)).map(([name, raw]) => {
          const cell = object(raw), ref = object(object(item.record_refs)[name]);
          return <tr key={name}><td>{label(String(ref.field ?? name), 'src_')}</td><td>{display(cell.value)}</td><td>{valueStates[String(cell.value_state)] ?? display(cell.value_state)}</td><td>{label(String(object(cell.unit).unit_code ?? ''), 'srcunit_')}</td></tr>;
        })}</tbody></table></div>
        {Array.isArray(object(item.documents).citations) && (object(item.documents).citations as unknown[]).map((raw, n) => { const cite = object(raw); return <details key={n}><summary>关联资料 · 第{display(cite.page_number)}页 · {display(cite.document_id)}</summary><p className="r1-help">{display(cite.excerpt)}</p><small>文档版本：{display(cite.document_version)}；解析版本：{display(cite.parser_version)}</small></details>; })}
        <details><summary>记录版本与资料资格</summary><pre className="database-text-preview">{JSON.stringify({ records: item.record_refs, qualification: object(item.documents).qualification, gaps: item.gaps }, null, 2)}</pre></details>
      </div>)}
      <p className="r1-help">{page.has_more ? '还有后续页；当前页不代表结果已穷尽。' : page.result_exhausted ? '已到固定查询末页；数据覆盖与证据缺口仍单独保留。' : '扫描或选择尚未完成，不能声明完整结果。'}</p>
      <button type="button" className="text-button" disabled={busy || page.has_more !== true || typeof page.next_cursor !== 'string' || !lastRequest} onClick={() => {
        if (lastRequest && typeof page.next_cursor === 'string') void execute({ ...lastRequest, structured: { ...lastRequest.structured, cursor: page.next_cursor } }, pageNumber + 1);
      }}>继续下一页</button>
      <details><summary>固定合同、未知值与执行缺口</summary><pre className="database-text-preview">{JSON.stringify(result, null, 2)}</pre></details>
    </div>}
  </section>;
}
