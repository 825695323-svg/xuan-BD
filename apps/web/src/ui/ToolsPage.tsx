import { useEffect, useState } from 'react';
import type { ToolLibraryTool, ToolLibraryView } from '../../../../contracts/tool-library';
import { request } from '../api';
import { ErrorNote, errorDetail, useWords } from './Controls';
import { DetailFacts, DetailHeader, DetailSection, ObjectDetailPanel } from './ObjectDetailPanel';
import { PageButton, PageEmpty, PageSearch } from './PageUI';
import { useObjectSelection } from './useStoredSelection';
import { setWorkspaceObject } from './workspace-context';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');

function isTool(value: unknown): value is ToolLibraryTool {
  return isRecord(value) && typeof value.id === 'string' && value.id.length > 0
    && typeof value.title === 'string' && typeof value.description === 'string'
    && (value.status === 'ready' || value.status === 'blocked' || value.status === 'unavailable')
    && (value.reason === null || typeof value.reason === 'string')
    && strings(value.outputFields) && strings(value.limitations)
    && (value.requiredInputs === undefined || strings(value.requiredInputs))
    && (value.missing === undefined || strings(value.missing))
    && (value.definition === undefined || isRecord(value.definition) && Array.isArray(value.definition.formula)
      && value.definition.formula.every(line => isRecord(line) && typeof line.output === 'string'
        && typeof line.expression === 'string' && (line.note === undefined || typeof line.note === 'string')));
}

function asView(value: unknown): ToolLibraryView {
  if (!isRecord(value) || (value.status !== 'ready' && value.status !== 'unavailable')
    || !(value.reason === null || typeof value.reason === 'string')
    || !Array.isArray(value.tools) || value.tools.length > 1 || !value.tools.every(isTool)) {
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
    setWorkspaceObject(selectedId && selectedTitle ? { page: 'tools', kind: 'algorithm', id: selectedId, label: selectedTitle } : null);
    return () => setWorkspaceObject(null);
  }, [selectedId, selectedTitle]);

  const search = query.trim().toLowerCase();
  const visible = tools.filter(tool => [tool.title, tool.id, tool.description, ...(tool.requiredInputs ?? [])]
    .some(text => text.toLowerCase().includes(search)));
  const labels: Record<ToolLibraryTool['status'], string> = {
    ready: words('可用', 'Available'),
    blocked: words('受阻', 'Blocked'),
    unavailable: words('不可用', 'Unavailable'),
  };
  const facts = selected ? [
    ...(selected.requiredInputs?.length ? [{ label: words('输入', 'Inputs'), value: selected.requiredInputs.join(words('、', ', ')) }] : []),
    ...(selected.outputFields.length ? [{ label: words('输出', 'Outputs'), value: selected.outputFields.join(words('、', ', ')) }] : []),
  ] : [];
  const formula = selected?.definition?.formula;
  const requirements = selected?.missing ?? [];

  return <div className="data-page page-panes">
    <aside className="data-nav" aria-label={words('算法目录', 'Algorithm catalog')}>
      <div className="sidebar-search-slot">
        <PageSearch compact label={words('搜索算法、编号或用途', 'Search algorithms, IDs or purposes')} value={query} onChange={setQuery} />
      </div>
    </aside>
    <div className="page-cards" aria-label={words('算法条目', 'Algorithm entries')}>
      <div className="object-list">
        {visible.map(tool => <button type="button" key={tool.id} className="object-card"
          aria-current={selectedId === tool.id ? 'true' : undefined} onClick={() => selection.select(tool.id)}>
          <span className="object-card-main">
            <span className="object-card-title">{tool.title}</span>
            <span className="object-card-meta">{tool.id}</span>
          </span>
          <span className="object-card-state" data-state={tool.status}>{labels[tool.status]}</span>
        </button>)}
        {tools.length > 0 && visible.length === 0 && <PageEmpty>{words('没有匹配的算法条目。', 'No matching algorithms.')}</PageEmpty>}
      </div>
    </div>
    <ObjectDetailPanel label={words('算法详情', 'Algorithm details')} header={<DetailHeader
      title={selectedTitle ?? words('算法', 'Algorithms')}
      status={selected && labels[selected.status]} tone={selected && tones[selected.status]}
      meta={selectedId}
      badge={<PageButton disabled={catalog.state === 'loading'} onClick={() => {
        setCatalog({ state: 'loading' });
        setReload(value => value + 1);
      }}>{words('重新读取', 'Refresh')}</PageButton>} />}
      summary={facts.length > 0 && <DetailFacts items={facts} />}>
      {catalog.state === 'loading' && <PageEmpty state="loading">{words('正在读取算法目录…', 'Loading the algorithm catalog…')}</PageEmpty>}
      {catalog.state === 'failed' && <ErrorNote detail={catalog.error}>{words('算法目录读取失败。', 'Could not load the algorithm catalog.')}</ErrorNote>}
      {view?.status === 'unavailable' && tools.length === 0 && <PageEmpty state="unavailable">
        {view.reason ?? words('算法目录当前不可用。', 'The algorithm catalog is unavailable.')}
      </PageEmpty>}
      {view?.status === 'ready' && tools.length === 0 && <PageEmpty>{words('暂无已登记算法。', 'No algorithms are registered.')}</PageEmpty>}
      {selected && <>
        <p className="object-detail-note">{selected.description}</p>
        {selected.status !== 'ready' && selected.reason && <PageEmpty state="unavailable">{selected.reason}</PageEmpty>}
        {!!formula?.length && <DetailSection title={words('公式', 'Formula')}>
          {formula.map(line => <p key={line.output} className="object-detail-value">
            <code>{line.expression}</code>{line.note && <> · {line.note}</>}
          </p>)}
        </DetailSection>}
        {requirements.length > 0 && <DetailSection title={words('待满足条件', 'Requirements')}>
          <ul className="object-detail-value">{requirements.map(item => <li key={item}>{item}</li>)}</ul>
        </DetailSection>}
        {selected.limitations.length > 0 && <DetailSection title={words('使用限制', 'Limitations')}>
          <ul className="object-detail-value">{selected.limitations.map(item => <li key={item}>{item}</li>)}</ul>
        </DetailSection>}
      </>}
    </ObjectDetailPanel>
  </div>;
}

export default ToolsPage;
