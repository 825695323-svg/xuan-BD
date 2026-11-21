import { CatalogCategory, CatalogChildren, CatalogRow, CatalogSidebar } from './CatalogSidebar';
import { WorkbenchCard } from './WorkbenchCard';
import { useEffect, useState } from 'react';
import type { ToolLibraryTool, ToolLibraryView } from '../../../../contracts/tool-library';
import { request } from '../api';
import { ErrorNote, errorDetail, useWords } from './Controls';
import { DetailDiagnostics, DetailFacts, DetailHeader, DetailSection, ObjectDetailPanel } from './ObjectDetailPanel';
import { PageButton, PageEmpty, PageSearch } from './PageUI';
import { useObjectSelection } from './useStoredSelection';
import { algorithmReferenceEvidence } from '../object-reference-evidence';
import { setWorkspaceObject } from './workspace-context';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');

function isTool(value: unknown): value is ToolLibraryTool {
  return isRecord(value) && typeof value.id === 'string' && value.id.length > 0
    && typeof value.title === 'string' && typeof value.description === 'string'
    && (value.status === 'ready' || value.status === 'blocked' || value.status === 'unavailable')
    && (value.reason === null || typeof value.reason === 'string')
    && Array.isArray(value.parameters) && value.parameters.every(parameter => isRecord(parameter)
      && typeof parameter.key === 'string' && typeof parameter.label === 'string'
      && [parameter.defaultValue, parameter.min, parameter.max].every(number => typeof number === 'number' && Number.isFinite(number)))
    && (value.sources === undefined || strings(value.sources))
    && strings(value.outputFields) && strings(value.limitations)
    && (value.requiredInputs === undefined || strings(value.requiredInputs))
    && (value.missing === undefined || strings(value.missing))
    && (value.definition === undefined || isRecord(value.definition) && Array.isArray(value.definition.formula)
      && (value.definition.products === undefined || Array.isArray(value.definition.products) && value.definition.products.every(product => isRecord(product) && ['id', 'label', 'configurationId', 'note'].every(key => typeof product[key] === 'string')))
      && value.definition.formula.every(line => isRecord(line) && typeof line.output === 'string'
        && typeof line.expression === 'string' && (line.note === undefined || typeof line.note === 'string')));
}

const MAX_CATALOG_ITEMS = 128;

function asView(value: unknown): ToolLibraryView {
  if (!isRecord(value) || (value.status !== 'ready' && value.status !== 'unavailable')
    || !(value.reason === null || typeof value.reason === 'string')
    || !Array.isArray(value.tools) || value.tools.length > MAX_CATALOG_ITEMS || !value.tools.every(isTool)
    || new Set(value.tools.map(tool => tool.id)).size !== value.tools.length) {
    throw new Error('Invalid tool-library response');
  }
  return value as unknown as ToolLibraryView;
}

type CatalogLoad = { state: 'loading' } | { state: 'loaded'; view: ToolLibraryView } | { state: 'failed'; error: string };
const tones = { ready: 'ready', blocked: 'blocked', unavailable: 'warning' } as const;

export function ToolsPage() {
  const words = useWords();
  const [catalog, setCatalog] = useState<CatalogLoad>({ state: 'loading' });
  const [reload, setReload] = useState(0);
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const toggle = (id: string) => setCollapsed(current => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  useEffect(() => {
    let active = true;
    void request('/api/ui/tool-library').then(asView).then(view => {
      if (active) setCatalog({ state: 'loaded', view });
    }).catch(failure => {
      if (active) setCatalog({ state: 'failed', error: errorDetail(failure) });
    });
    return () => { active = false; };
  }, [reload]);

  const view = catalog.state === 'loaded' ? catalog.view : null;
  const tools = view?.tools ?? [];
  const selection = useObjectSelection('xuan.tools.object', tools.map(tool => tool.id), catalog.state === 'loaded', 'first');
  const selected = tools.find(tool => tool.id === selection.id);
  const selectedId = selected?.id;
  const selectedTitle = selected?.title;
  useEffect(() => {
    setWorkspaceObject(selectedId && selectedTitle && selected && view ? { page: 'tools', kind: 'algorithm', id: selectedId, label: selectedTitle, evidence: algorithmReferenceEvidence(view, selected) } : null);
    return () => setWorkspaceObject(null);
  }, [selectedId, selectedTitle, selected, view]);

  const search = query.trim().toLowerCase();
  const visible = tools.filter(tool => [tool.title, tool.id, tool.description, ...(tool.requiredInputs ?? [])]
    .some(text => text.toLowerCase().includes(search)));
  const labels: Record<ToolLibraryTool['status'], string> = {
    ready: words('准入可用', 'Eligible'),
    blocked: words('受阻', 'Blocked'),
    unavailable: words('不可用', 'Unavailable'),
  };
  const facts = selected ? [
    ...(selected.requiredInputs?.length ? [{ label: words('输入', 'Inputs'), value: selected.requiredInputs.join(words('、', ', ')) }] : []),
    ...(selected.outputFields.length ? [{ label: words('输出', 'Outputs'), value: selected.outputFields.join(words('、', ', ')) }] : []),
  ] : [];
  const formula = selected?.definition?.formula;
  const requirements = selected?.missing ?? [];

  const categories = [
    ['market', words('行情指标', 'Market indicators')], ['financial', words('财务', 'Financial')],
    ['adjustment', words('复权', 'Adjustments')], ['statistics', words('统计', 'Statistics')],
    ['utility', words('工具', 'Utilities')], ['other', words('其他算法', 'Other algorithms')],
  ] as const;
  const knownCategories = new Set<string>(categories.map(([id]) => id));
  const groupOf = (tool: ToolLibraryTool) => tool.category && knownCategories.has(tool.category) ? tool.category : 'other';

  return <div className="catalog-page">
    <CatalogSidebar label={words('算法目录', 'Algorithm catalog')} search={
      <PageSearch compact label={words('搜索算法、编号或用途', 'Search algorithms, IDs or purposes')} value={query} onChange={setQuery} />}>
      {categories.map(([id, title]) => {
        const rows = visible.filter(tool => groupOf(tool) === id);
        const expanded = !collapsed.has(id) || !!search;
        return rows.length > 0 && <CatalogCategory key={id} label={title} className="is-group"
          expanded={expanded} onClick={() => toggle(id)}>
          {expanded && <CatalogChildren aria-label={title}>{rows.map(tool =>
            <CatalogRow key={tool.id} label={tool.title} meta={tool.id} badge={labels[tool.status]} state={tool.status}
              selected={selectedId === tool.id} onSelect={() => selection.select(tool.id)} />
          )}</CatalogChildren>}
        </CatalogCategory>;
      })}
      {tools.length > 0 && visible.length === 0 && <li><PageEmpty>{words('没有匹配的算法条目。', 'No matching algorithms.')}</PageEmpty></li>}
    </CatalogSidebar>
    <WorkbenchCard className="catalog-detail-card">
    <ObjectDetailPanel label={words('算法详情', 'Algorithm details')} header={<DetailHeader
      title={selectedTitle ?? words('算法', 'Algorithms')}
      status={selected && labels[selected.status]} tone={selected && tones[selected.status]}
      meta={selectedId}
      badge={<PageButton disabled={catalog.state === 'loading'} onClick={() => {
        setCatalog({ state: 'loading' });
        setReload(value => value + 1);
      }}>{words('重新读取', 'Refresh')}</PageButton>} />}
      summary={facts.length > 0 && <DetailFacts items={facts} />}
      diagnostics={selected && <DetailDiagnostics key={selectedId} label={words('公式、限制与实现来源', 'Formula, limitations and implementation sources')}>
        {!!formula?.length && <DetailSection title={words('公式', 'Formula')}>
          {formula.map(line => <p key={line.output} className="object-detail-value"><code>{line.expression}</code>{line.note && <> · {line.note}</>}</p>)}
        </DetailSection>}
        {selected.limitations.length > 0 && <DetailSection title={words('使用限制', 'Limitations')}>
          <ul className="object-detail-value">{selected.limitations.map(item => <li key={item}>{item}</li>)}</ul>
        </DetailSection>}
        {!!selected.sources?.length && <DetailSection title={words('实现来源', 'Implementation sources')}>
          <ul className="object-detail-value">{selected.sources.map(item => <li key={item}><code>{item}</code></li>)}</ul>
        </DetailSection>}
      </DetailDiagnostics>}>
      {catalog.state === 'loading' && <PageEmpty state="loading">{words('正在读取算法目录…', 'Loading the algorithm catalog…')}</PageEmpty>}
      {catalog.state === 'failed' && <ErrorNote detail={catalog.error}>{words('算法目录读取失败。', 'Could not load the algorithm catalog.')}</ErrorNote>}
      {view?.status === 'unavailable' && tools.length === 0 && <PageEmpty state="unavailable">
        {view.reason ?? words('算法目录当前不可用。', 'The algorithm catalog is unavailable.')}
      </PageEmpty>}
      {view?.status === 'ready' && tools.length === 0 && <PageEmpty>{words('暂无已登记算法。', 'No algorithms are registered.')}</PageEmpty>}
      {selected && <>
        {selected.reason && <p className="object-detail-value status-warning">{selected.reason}</p>}
        {requirements.length > 0 && <div className="object-detail-blockers" role="status">
          <strong>{words('待满足条件', 'Requirements')}</strong>
          <ul className="object-detail-value">{requirements.map(item => <li key={item}>{item}</li>)}</ul>
        </div>}
        <DetailSection title={words('算法定义', 'Algorithm definition')}>
          <p className="object-detail-value">{selected.description}</p>
        </DetailSection>
        <DetailSection title={words('计算配置', 'Calculation configuration')} note={words('登记参数，非已保存的运行配置', 'Registered parameters, not saved run configuration')}>
          {selected.parameters.length ? <DetailFacts items={selected.parameters.map(parameter => ({ label: parameter.key,
            value: parameter.min === parameter.max ? words(`固定 ${parameter.defaultValue}`, `Fixed ${parameter.defaultValue}`)
              : words(`默认 ${parameter.defaultValue}；范围 ${parameter.min}–${parameter.max}`, `Default ${parameter.defaultValue}; range ${parameter.min}–${parameter.max}`) }))} />
            : <p className="object-detail-value">{words('未登记参数。', 'No registered parameters.')}</p>}
        </DetailSection>
        <DetailSection title={words('关联产物', 'Related products')} note={words('定义关联，不是实际产物回执', 'Definition links, not actual product receipts')}>
          {selected.definition?.products?.length ? <ul className="object-detail-value">{selected.definition.products.map(product => <li key={product.id}>{product.label} · {product.configurationId} · {product.note}</li>)}</ul>
            : <p className="object-detail-value">{words('目录未登记产物关联；实际产物需按任务核对。', 'No product links are registered in this catalog; actual products require task evidence.')}</p>}
        </DetailSection>
        <DetailSection title={words('准入与执行状态', 'Eligibility and execution')}>
          <p className="object-detail-value">{words('顶部状态仅为当前准入；本页未读取执行回执，不能据此判定已运行或成功。', 'The header shows eligibility only. This page has not read execution receipts and cannot establish that a run occurred or succeeded.')}</p>
        </DetailSection>
      </>}
    </ObjectDetailPanel>
    </WorkbenchCard>
  </div>;
}

export default ToolsPage;
