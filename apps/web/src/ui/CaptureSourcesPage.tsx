import { useCallback, useEffect, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { request } from '../api';
import { ErrorNote, Modal, errorDetail, useWords } from './Controls';
import { MorphIcon } from './MorphIcon';
import { RunReceipt, SourceCheckError, SourceCheckLine, useSourceCheck, type SourceRunTask } from './SourceActions';
import { DetailDiagnostics, DetailFacts, DetailHeader, DetailSection, ObjectDetailPanel } from './ObjectDetailPanel';
import { useObjectSelection } from './useStoredSelection';
import { setWorkspaceObject } from './workspace-context';
import type { CaptureSourceSetting, SourceSettingsView } from '../../../../contracts/source-settings';
import {
  baiduLabels, baiduOperations, metaOf, operationLabels,
  sourceSearchText, TOPICS, type CaptureSource, type CustomSource,
} from './captureCatalog';

/** 采集源页：页面、登录态与站点操作保持一份真实来源状态，筛选只作用于本地列表。 */
export function CaptureSourcesPage() {
  const words = useWords();
  const [open, setOpen] = useState<Set<string>>(() => new Set(['topics', 'views']));
  const [topic, setTopic] = useState<string>('全部');
  const [shortcut, setShortcut] = useState<'none' | 'opinion'>('none');
  const [sources, setSources] = useState<CaptureSource[] | null>(null);
  const [settings, setSettings] = useState<SourceSettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [baiduAvailable, setBaiduAvailable] = useState<boolean | null>(null);
  const [customSources, setCustomSources] = useState<CustomSource[]>([]);
  const [loginStates, setLoginStates] = useState<Record<string, string>>({});
  const [query, setQuery] = useState('');
  /** 自定义来源单独读取；两者都回来之前不判定"没有这个对象"。 */
  const [catalogReady, setCatalogReady] = useState(false);
  const [loginOpen, setLoginOpen] = useState<Set<string>>(new Set());
  const [loginBusy, setLoginBusy] = useState<string | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [runTarget, setRunTarget] = useState<{ source: CaptureSource; setting: CaptureSourceSetting | null } | null>(null);
  const [runReceipt, setRunReceipt] = useState<SourceRunTask | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [runBusy, setRunBusy] = useState(false);
  const runRequestId = useRef(`ui-capture-${crypto.randomUUID()}`);

  const loadSourceSettings = useCallback(async () => {
    try {
      const value = await request('/api/ui/source-settings') as SourceSettingsView;
      setSettings(value); setSources((value.capturePlugins ?? []).map(item => ({ ...item, reason: item.reason ?? undefined })) as CaptureSource[]); setError(null);
    } catch (failure) { setError(errorDetail(failure)); }
  }, []);
  const sourceCheck = useSourceCheck(loadSourceSettings);
  useEffect(() => {
    let alive = true;
    const loadStates = () => { void request('/api/capture-sources')
      .then((value) => { const list = (value as { sources?: { sourceId: string; state: string }[] }).sources ?? [];
        if (alive) setLoginStates(Object.fromEntries(list.map((item) => [item.sourceId, item.state]))); })
      .catch(() => { if (alive) setLoginStates({}); }); };
    const loadCustom = () => { void request('/api/ui/custom-sources')
      .then((value) => { if (alive) setCustomSources(((value as { sources?: CustomSource[] }).sources) ?? []); })
      .catch(() => { if (alive) setCustomSources([]); })
      .finally(() => { if (alive) setCatalogReady(true); }); };
    void loadSourceSettings(); void loadCustom(); loadStates();
    const timer = window.setInterval(() => { void loadSourceSettings(); loadCustom(); loadStates(); }, 10_000);
    void request('/api/skills')
      .then((value) => {
        const list = Array.isArray(value) ? value as { action?: string; availability?: { available?: boolean } }[] : [];
        const baidu = list.find((item) => item.action === 'baidu.drive');
        if (alive) setBaiduAvailable(!!baidu?.availability?.available);
      })
      .catch(() => { if (alive) setBaiduAvailable(false); });
    return () => { alive = false; window.clearInterval(timer); };
  }, [loadSourceSettings]);

  const loginAction = async (sourceId: string, action: 'open' | 'save' | 'cancel') => {
    setLoginError(null); setLoginBusy(sourceId);
    try {
      await request(`/api/capture-sources/${encodeURIComponent(sourceId)}/login`, 'POST', { action });
      if (action === 'open') { setLoginOpen((current) => new Set(current).add(sourceId)); return; }
      setLoginOpen((current) => { const next = new Set(current); next.delete(sourceId); return next; });
      const value = await request('/api/ui/source-settings');
      setSources((value as { capturePlugins?: CaptureSource[] }).capturePlugins ?? []);
    } catch (failure) {
      setLoginError(errorDetail(failure));
      // 失败时回到加号，避免勾号卡在本地状态。
      setLoginOpen((current) => { const next = new Set(current); next.delete(sourceId); return next; });
    } finally { setLoginBusy(null); }
  };
  const runCapture = async () => {
    if (!runTarget || runBusy) return;
    setRunBusy(true); setRunError(null); setRunReceipt(null);
    try {
      const value = await request('/api/ui/source-settings/runs', 'POST', { captureSourceId: runTarget.source.sourceId, requestId: runRequestId.current }) as { task?: SourceRunTask };
      if (!value.task || typeof value.task.id !== 'string') throw new Error(words('采集入口没有返回原任务。', 'The capture entry returned no original task.'));
      setRunReceipt(value.task);
      await loadSourceSettings();
    } catch (failure) { setRunError(errorDetail(failure)); }
    finally { setRunBusy(false); }
  };
  const fuzzy = (haystack: string) => {
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    const text = haystack.toLowerCase();
    let index = 0;
    for (const char of needle) {
      index = text.indexOf(char, index);
      if (index < 0) return false;
      index += 1;
    }
    return true;
  };
  const matchesFilters = (source: CaptureSource) => {
    const meta = metaOf(source);
    if (topic !== '全部' && !meta.topics.includes(topic)) return false;
    if (shortcut === 'opinion' && !metaOf(source).opinion) return false;
    return true;
  };
  const allSources: CaptureSource[] = [...(sources ?? []), {
    sourceId: 'baidu-drive', label: '百度网盘', available: baiduAvailable === true,
    operations: baiduOperations.map((operation) => ({ operation })),
  }, ...customSources.map((source) => ({ sourceId: source.id, label: source.label, available: false, loginRequired: true, custom: true,
    operations: source.operations.map((operation) => ({ operation })) }))];
  const visibleSources = allSources.filter((source) => matchesFilters(source) && fuzzy(sourceSearchText(source)));
  /** 三栏布局里当前选中的来源；只影响详情栏，不改变任何筛选或采集状态。 */
  const selection = useObjectSelection('xuan.capture.object',
    allSources.map((source) => source.sourceId), sources !== null && catalogReady);
  const selectedId = selection.id;
  const toggle = (id: string) => setOpen((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const navItem = (id: string, label: string, active: boolean, onClick: () => void) => <button type="button" key={id}
    className="data-nav-item is-child" aria-current={active ? 'true' : undefined} onClick={onClick}>
    <span>{label}</span><span className="data-nav-dot" aria-hidden="true" />
  </button>;

  const nav = <aside className="data-nav" aria-label={words('采集源分类', 'Capture source categories')}>
    <div className="sidebar-search-slot">
      <div className="data-search data-nav-search">
        <Search size={15} aria-hidden="true" />
        <input type="search" value={query} onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder={words('搜索采集源', 'Search sources')} aria-label={words('搜索采集源', 'Search sources')} />
      </div>
    </div>
    <button type="button" className="data-nav-item" aria-current={topic === '全部' ? 'true' : undefined} onClick={() => setTopic('全部')}>
      <span>{words('全部来源', 'All sources')}</span><span className="data-nav-dot" aria-hidden="true" />
    </button>
    <button type="button" className="data-nav-item is-group" aria-expanded={open.has('topics')} onClick={() => toggle('topics')}>
      <span>{words('主题分类', 'Topics')}</span><MorphIcon name={open.has('topics') ? 'chevron-up' : 'chevron-down'} size={16} />
    </button>
    {open.has('topics') && <div className="data-nav-children">
      {TOPICS.map((item) => navItem(item, item, topic === item, () => setTopic(item)))}
    </div>}
    <button type="button" className="data-nav-item is-group" aria-expanded={open.has('views')} onClick={() => toggle('views')}>
      <span>{words('快捷视图', 'Views')}</span><MorphIcon name={open.has('views') ? 'chevron-up' : 'chevron-down'} size={16} />
    </button>
    {open.has('views') && <div className="data-nav-children">
      {navItem('opinion', words('舆论观察', 'Public opinion'), shortcut === 'opinion', () => setShortcut((current) => current === 'opinion' ? 'none' : 'opinion'))}
    </div>}
  </aside>;

  const selectedSource = allSources.find((source) => source.sourceId === selectedId) ?? null;
  const selectedMeta = selectedSource ? metaOf(selectedSource) : null;
  const selectedSetting = selectedSource ? settings?.capture.find((item) => item.sourceId === selectedSource.sourceId) ?? null : null;
  const selectedCheck = selectedSource ? settings?.checks.find((item) => item.id === selectedSource.sourceId) : undefined;
  // 只发布"当前在看哪个来源"，不写会话、不触发采集。
  useEffect(() => {
    setWorkspaceObject(selectedId ? { page: 'capture', kind: 'source', id: selectedId, label: selectedSource?.label ?? selectedId } : null);
  }, [selectedId, selectedSource?.label]);
  useEffect(() => () => setWorkspaceObject(null), []);
  const loginText = (state?: string) => state === 'saved' ? words('已保存', 'Saved')
    : state === 'public' ? words('公开可读', 'Public') : state === 'expired' ? words('已过期', 'Expired')
      : state ? words('未登录', 'Not signed in') : words('未读取', 'Not read');

  return <div className="data-page page-panes">
    {nav}
    <section className="page-cards" aria-label={words('采集源', 'Capture sources')}>
      {loginError && <ErrorNote detail={loginError}>{words('登录操作未完成。', 'The login action did not complete.')}</ErrorNote>}
      <SourceCheckError error={sourceCheck.error} />
      {error && <ErrorNote detail={error}>{words('采集源状态暂时无法读取。', 'Capture source status could not be read.')}</ErrorNote>}
      {!error && !sources && <p className="data-empty">{words('读取中…', 'Loading…')}</p>}
      {!!sources?.length && <div className="object-list">{visibleSources.map((source) => {
        const meta = metaOf(source);
        return <button type="button" key={source.sourceId} className="object-card"
          aria-current={selectedId === source.sourceId ? 'true' : undefined} onClick={() => selection.select(source.sourceId)}>
          <span className="object-card-main">
            <span className="object-card-title">{source.label}</span>
            <span className="object-card-meta">{[meta.topics[0] ?? words('未分类', 'Unclassified'), meta.channel].filter(Boolean).join(' · ')}</span>
          </span>
          <span className="object-card-state" data-ok={source.available}>{source.available ? words('可用', 'Available') : words('不可用', 'Unavailable')}</span>
        </button>;
      })}</div>}
      {!!sources?.length && !visibleSources.length && <p className="data-empty">{words('没有匹配的采集源', 'No matching sources')}</p>}
    </section>
    <ObjectDetailPanel
      label={words('来源详情', 'Source detail')}
      header={<DetailHeader
        title={selection.pending ? words('正在读取…', 'Loading…') : selectedSource?.label ?? words('未选择来源', 'No source selected')}
        status={selectedSource ? (selectedSource.available ? words('可用', 'Available') : words('不可用', 'Unavailable')) : undefined}
        tone={selectedSource?.available ? 'ready' : 'warning'} />}
      summary={selectedSource ? <DetailFacts items={[
        { label: words('登录态', 'Login'), value: loginText(loginStates[selectedSource.sourceId]) },
        { label: words('渠道', 'Channel'), value: selectedMeta?.channel ?? '—' },
        { label: words('采集范围', 'Coverage'), value: selectedMeta?.regions.join(' / ') || '—' },
        { label: words('最近检查', 'Latest check'), value: <SourceCheckLine check={selectedCheck} /> },
      ]} /> : undefined}
      diagnostics={selectedSource ? <DetailDiagnostics label={words('分类与语言说明', 'Topics and languages')}
        count={words(`${(selectedMeta?.topics.length ?? 0) + (selectedMeta?.languages.length ?? 0)} 项`, `${(selectedMeta?.topics.length ?? 0) + (selectedMeta?.languages.length ?? 0)} items`)}>
        <dl className="object-detail-facts">
          <div><dt>{words('分类', 'Topics')}</dt><dd>{selectedMeta?.topics.join(' / ') || words('未分类', 'Unclassified')}</dd></div>
          <div><dt>{words('语言', 'Languages')}</dt><dd>{selectedMeta?.languages.join(' / ') || '—'}</dd></div>
        </dl>
      </DetailDiagnostics> : undefined}>
      {selection.pending ? <p className="object-detail-note">{words('来源列表尚未读回，暂不显示详情，也不回落到其他来源。',
        'The source list has not loaded yet; no detail is shown and no other source is substituted.')}</p>
        : !selectedSource ? <p className="object-detail-note">{words('从第二栏选择一个来源，这里显示它的登录态、覆盖范围与最近检查。',
          'Pick a source from the list; its login state, coverage and latest check appear here.')}</p> : <>
        <DetailSection title={words('可用操作', 'Operations')} note={words('按该来源已登记的固定操作', 'Fixed operations registered for this source')}>
          <p className="object-detail-value">{(selectedSource.operations ?? []).map((item) => operationLabels[item.operation] ?? baiduLabels[item.operation] ?? item.operation).join(' · ') || words('无固定操作', 'No fixed operations')}</p>
        </DetailSection>
        <DetailSection title={words('采集配置', 'Capture')}>
          <p className="object-detail-value">{selectedSetting?.enabled ? selectedSetting.operation : words('未启用', 'Not enabled')}</p>
        </DetailSection>
        <div className="supplier-detail-actions">
          {selectedSource.sourceId !== 'baidu-drive' && selectedSource.loginRequired !== false && <button type="button" className="text-button" disabled={loginBusy === selectedSource.sourceId}
            onClick={() => void loginAction(selectedSource.sourceId, loginOpen.has(selectedSource.sourceId) ? 'save' : 'open')}>
            {loginOpen.has(selectedSource.sourceId) ? words('保存登录态', 'Save login state') : words('打开登录页', 'Open login page')}</button>}
          <button type="button" className="text-button" disabled={sourceCheck.busy !== null} onClick={() => void sourceCheck.check(selectedSource.sourceId)}>
            {sourceCheck.busy === selectedSource.sourceId ? words('检查中…', 'Checking…') : words('检查', 'Check')}</button>
          {selectedSetting?.enabled && !selectedSource.custom && selectedSource.sourceId !== 'baidu-drive' && <button type="button" className="text-button"
            onClick={() => { setRunReceipt(null); setRunError(null); runRequestId.current = `ui-capture-${crypto.randomUUID()}`; setRunTarget({ source: selectedSource, setting: selectedSetting }); }}>
            {words('单次采集…', 'Collect once…')}</button>}
        </div>
      </>}
    </ObjectDetailPanel>
    {runTarget && <Modal title={words('单次采集', 'Collect once')} onClose={() => { if (runBusy) return; setRunTarget(null); setRunReceipt(null); setRunError(null); }} busy={runBusy}>
      <p><strong>{runTarget.source.label}</strong> · {words('按当前已保存的操作和参数发起一次真实采集；页面不会自动运行或自动登录。', 'Runs one real collection with the saved operation and parameters; nothing runs or logs in automatically.')}</p>
      <p className="database-scope">{words('操作', 'Operation')} {runTarget.setting?.operation ?? '—'} · {words('参数', 'Parameters')} {runTarget.setting && Object.keys(runTarget.setting.parameters).length ? JSON.stringify(runTarget.setting.parameters) : '{}'}</p>
      {!runTarget.source.available && <p className="status-warning">{words('当前采集会话或登录态显示不可用；任务仍按原配置受理并返回具体失败，不会替换为其他账号或站点。', 'The capture session or login state is unavailable; the task is still accepted with the original configuration and reports the concrete failure. No other account or site is substituted.')}</p>}
      {runReceipt && <RunReceipt task={runReceipt} />}
      {runError && <ErrorNote detail={runError}>{words('采集运行未确认；没有自动重试。', 'The collection run is unconfirmed; it was not retried automatically.')}</ErrorNote>}
      <div className="dialog-actions"><button type="button" className="text-button" disabled={runBusy} onClick={() => { setRunTarget(null); setRunReceipt(null); setRunError(null); }}>{words('关闭', 'Close')}</button>
        <button type="button" className="primary-button" disabled={runBusy} onClick={() => void runCapture()}>{runBusy ? words('受理中…', 'Starting…') : words('明确采集一次', 'Collect once explicitly')}</button></div>
    </Modal>}
  </div>;
}

export default CaptureSourcesPage;
