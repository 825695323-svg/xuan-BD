import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Plus, Search } from 'lucide-react';
import { request } from '../api';
import { ErrorNote, Modal, errorDetail, useWords } from './Controls';
import { FilterSelect } from './FilterSelect';
import { MorphIcon } from './MorphIcon';
import { RunReceipt, SourceCheckError, SourceCheckLine, useSourceCheck, type SourceRunTask } from './SourceActions';
import type { CaptureSourceSetting, SourceSettingsView } from '../../../../contracts/source-settings';
import {
  baiduLabels, baiduOperations, CHANNELS, FOLLOW_KEY, logos, metaOf, monogram, operationLabels, readFollowed,
  sourceSearchText, TOPICS, type CaptureSource, type CustomSource,
} from './captureCatalog';

/** 采集源页：页面、登录态与站点操作保持一份真实来源状态，筛选只作用于本地列表。 */
export function CaptureSourcesPage() {
  const words = useWords();
  const [open, setOpen] = useState<Set<string>>(() => new Set(['topics', 'views']));
  const [topic, setTopic] = useState<string>('全部');
  const [regionFilter, setRegionFilter] = useState<string>('全部');
  const [channelFilter, setChannelFilter] = useState<string>('全部');
  const [languageFilter, setLanguageFilter] = useState<string>('全部');
  const [statusFilter, setStatusFilter] = useState<string>('全部');
  const [shortcut, setShortcut] = useState<'none' | 'followed' | 'opinion'>('none');
  const [followed, setFollowed] = useState<string[]>(() => readFollowed());
  const [sources, setSources] = useState<CaptureSource[] | null>(null);
  const [settings, setSettings] = useState<SourceSettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [baiduAvailable, setBaiduAvailable] = useState<boolean | null>(null);
  const [customSources, setCustomSources] = useState<CustomSource[]>([]);
  const [loginStates, setLoginStates] = useState<Record<string, string>>({});
  const [query, setQuery] = useState('');
  const [loginOpen, setLoginOpen] = useState<Set<string>>(new Set());
  const [loginBusy, setLoginBusy] = useState<string | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [runTarget, setRunTarget] = useState<{ source: CaptureSource; setting: CaptureSourceSetting | null } | null>(null);
  const [runReceipt, setRunReceipt] = useState<SourceRunTask | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [runBusy, setRunBusy] = useState(false);
  const runRequestId = useRef(`ui-capture-${crypto.randomUUID()}`);

  useEffect(() => { try { window.localStorage.setItem(FOLLOW_KEY, JSON.stringify(followed)); } catch { /* 关注仅作本地快捷视图。 */ } }, [followed]);

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
      .catch(() => { if (alive) setCustomSources([]); }); };
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
    if (regionFilter !== '全部' && !meta.regions.includes(regionFilter)) return false;
    if (channelFilter !== '全部' && meta.channel !== channelFilter) return false;
    if (languageFilter !== '全部' && !meta.languages.includes(languageFilter)) return false;
    if (statusFilter === '可用' && !source.available) return false;
    if (statusFilter === '受限' && source.available) return false;
    if (shortcut === 'followed' && !followed.includes(source.sourceId)) return false;
    if (shortcut === 'opinion' && !metaOf(source).opinion) return false;
    return true;
  };
  const allSources: CaptureSource[] = [...(sources ?? []), {
    sourceId: 'baidu-drive', label: '百度网盘', available: baiduAvailable === true,
    operations: baiduOperations.map((operation) => ({ operation })),
  }, ...customSources.map((source) => ({ sourceId: source.id, label: source.label, available: false, loginRequired: true, custom: true,
    operations: source.operations.map((operation) => ({ operation })) }))];
  const visibleSources = allSources.filter((source) => matchesFilters(source) && fuzzy(sourceSearchText(source)));
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
      {navItem('followed', words('已关注', 'Followed'), shortcut === 'followed', () => setShortcut((current) => current === 'followed' ? 'none' : 'followed'))}
      {navItem('opinion', words('舆论观察', 'Public opinion'), shortcut === 'opinion', () => setShortcut((current) => current === 'opinion' ? 'none' : 'opinion'))}
    </div>}
  </aside>;

  return <div className="data-page">
    {nav}
    <section className="data-panel" aria-label={words('采集源', 'Capture sources')}>
      <div className="source-head">
        <h2 className="data-panel-title">{words('采集源', 'Sources')}</h2>
        <span className="source-count">{words(`${allSources.length} 个来源`, `${allSources.length} sources`)}</span>
      </div>

      <div className="source-filter-block">
        <span className="source-filter-label">{words('筛选', 'Filters')}</span>
        <div className="source-selects">
          <FilterSelect label={words('覆盖地区', 'Region')} value={regionFilter} options={['全部', '全球', '中国大陆', '中国香港', '中国台湾', '美国', '欧洲']} onChange={setRegionFilter} />
          <FilterSelect label={words('来源渠道', 'Channel')} value={channelFilter} options={['全部', ...CHANNELS, '工具']} onChange={setChannelFilter} />
          <FilterSelect label={words('语言', 'Language')} value={languageFilter} options={['全部', '中文', '英文']} onChange={setLanguageFilter} />
          <FilterSelect label={words('运行状态', 'Status')} value={statusFilter} options={['全部', '可用', '受限']} onChange={setStatusFilter} />
        </div>
      </div>

      {loginError && <ErrorNote detail={loginError}>{words('登录操作未完成。', 'The login action did not complete.')}</ErrorNote>}
      <SourceCheckError error={sourceCheck.error} />
      {error && <ErrorNote detail={error}>{words('采集源状态暂时无法读取。', 'Capture source status could not be read.')}</ErrorNote>}
      {!error && !sources && <p className="data-empty">{words('读取中…', 'Loading…')}</p>}
      {!!sources?.length && <div className="source-grid">{visibleSources.map((source) => {
        const meta = metaOf(source);
        const check = settings?.checks.find(item => item.id === source.sourceId);
        const captureSetting = settings?.capture.find(item => item.sourceId === source.sourceId) ?? null;
        return <article className="source-card" key={source.sourceId}>
          <div className="source-card-head">
            <span className="source-logo-wrap">
              <span className="source-logo" aria-hidden="true">
                {logos[source.sourceId]
                  ? <img src={`/logos/${logos[source.sourceId]}`} alt="" loading="lazy" onError={(event) => { event.currentTarget.style.display = 'none'; }} />
                  : <span className="source-logo-fallback">{monogram(source)}</span>}
              </span>
              {source.sourceId !== 'baidu-drive' && source.loginRequired !== false && !['saved', 'public'].includes(loginStates[source.sourceId] ?? '')
                ? <button type="button" className="source-logo-add" data-open={loginOpen.has(source.sourceId)}
                  disabled={loginBusy === source.sourceId}
                  aria-label={loginOpen.has(source.sourceId) ? words('保存登录态', 'Save login state') : words('打开登录页', 'Open login page')}
                  title={loginOpen.has(source.sourceId) ? words('保存登录态', 'Save login state') : words('打开登录页', 'Open login page')}
                  onClick={() => void loginAction(source.sourceId, loginOpen.has(source.sourceId) ? 'save' : 'open')}>
                  {loginOpen.has(source.sourceId) ? <Check size={11} aria-hidden="true" /> : <Plus size={11} aria-hidden="true" />}
                </button>
                : null}
            </span>
            <span className="source-card-title">{source.label}</span>
            <span className="source-head-right">
              {(source.custom || (source.sourceId === 'baidu-drive' && !source.available))
                ? <span className="source-unavailable" title={source.custom ? words('自定义来源：采集脚本与登录接入仍需开发', 'Custom source: capture script and login are not connected yet') : words('bdpan 未装配，暂不能保存登录态', 'bdpan is not connected; login state cannot be saved yet')}>{source.custom ? words('待接入', 'Not wired') : words('未装配', 'Not connected')}</span>
                : null}
              <button type="button" className="source-follow" aria-pressed={followed.includes(source.sourceId)}
                title={followed.includes(source.sourceId) ? words('取消关注', 'Unfollow') : words('关注与计划', 'Follow & plan')}
                onClick={() => setFollowed((current) => current.includes(source.sourceId) ? current.filter((id) => id !== source.sourceId) : [...current, source.sourceId])}>
                {followed.includes(source.sourceId) ? words('已关注', 'Followed') : words('关注', 'Follow')}
              </button>
              <span className="source-lamp" data-ok={source.available} role="img" aria-label={source.available ? words('可用', 'Available') : words('不可用', 'Unavailable')} />
            </span>
          </div>
          <p className="source-ops">{(source.operations ?? []).map((item) => operationLabels[item.operation] ?? baiduLabels[item.operation] ?? item.operation).join(' · ') || words('无固定操作', 'No fixed operations')}</p>
          <p className="source-meta">
            {[meta.topics.length ? meta.topics.join(' / ') : words('未分类', 'Unclassified'), meta.regions.join(' / ') || '—', meta.channel, meta.languages.join('/') || '—'].join(' · ')}
          </p>
          <div className="source-checks">
            <SourceCheckLine check={check} />
            <div className="source-check-actions">
              <button type="button" className="text-button" disabled={sourceCheck.busy !== null} onClick={() => void sourceCheck.check(source.sourceId)}>
                {sourceCheck.busy === source.sourceId ? words('检查中…', 'Checking…') : words('检查', 'Check')}</button>
              {captureSetting?.enabled && !source.custom && source.sourceId !== 'baidu-drive' && <button type="button" className="text-button"
                onClick={() => { setRunReceipt(null); setRunError(null); runRequestId.current = `ui-capture-${crypto.randomUUID()}`; setRunTarget({ source, setting: captureSetting }); }}>
                {words('单次采集…', 'Collect once…')}</button>}
            </div>
          </div>
        </article>;
      })}</div>}
      {!!sources?.length && !visibleSources.length && <p className="data-empty">{words('没有匹配的采集源', 'No matching sources')}</p>}
    </section>
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
