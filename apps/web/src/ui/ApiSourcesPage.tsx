import { useCallback, useEffect, useRef, useState } from 'react';
import { setWorkspaceObject } from './workspace-context';
import { useObjectSelection } from './useStoredSelection';
import type { DragEvent } from 'react';
import { PageSearch, PageButton, PageActions, PageField } from './PageUI';
import type { SourceConnection, SourceOperationId, SourceOperationPolicy, SourceSettingsView } from '../../../../contracts/source-settings';
import { request } from '../api';
import { usePreferences } from './Preferences';
import {
  SourceSettingsRequestError, loadSourceSettings, newSourceSettingsRequestId, saveSourceSettings,
  sourceSettingsOperation, type SourceSettingsOperation,
} from './sourceSettingsClient';
import { ErrorNote, Modal, SelectMenu, errorDetail, useWords } from './Controls';
import { DetailDiagnostics, DetailFacts, DetailHeader, ObjectDetailPanel } from './ObjectDetailPanel';
import { MorphIcon } from './MorphIcon';
import { RunReceipt, SourceCheckError, SourceCheckLine, useSourceCheck, type SourceRunTask } from './SourceActions';
import {
  ASSET_SCOPE_IDS, ASSET_SCOPE_LABELS, ASSET_SCOPES, DATA_CAPABILITY_IDS, DATA_CAPABILITY_LABELS, DATA_CAPS,
  DEFAULT_MARKET, defaultLayout, GLOBAL_MARKET_LEAVES, layoutOf, MARKET_SCOPES, marketLabelOf, marketOf,
  shortSource, TYPE_CAPABILITY_ORDER, type Layout, type MarketLeaf, type TypeCard,
} from './sourceMarkets';

/** 偏好只在布局或筛选实际变化时保存，比较同一份快照避免重复写入。 */
const preferenceSnapshot = (layout: Layout, selected: string, country: string, assetScope: string, dataCap: string): string =>
  JSON.stringify({ marketLayout: layout, marketSelection: { selected, country, assetScope, dataCap } });

type SaveStatus = 'saving' | 'adopted' | 'saved' | 'conflict' | 'unknown';
interface SaveNotice {
  requestId: string;
  operationId: SourceOperationId;
  scopeId: string;
  status: SaveStatus;
  /** 仍代表本操作最新未确认意图时才覆盖本地显示；迟到回执不覆盖新编辑。 */
  active: boolean;
  seq: number;
  candidate: SourceOperationPolicy;
  baseRevision: number;
  operation: SourceSettingsOperation | null;
  currentRevision: number | null;
  actual: { primary: string | null; backups: string[] } | null;
  error: string | null;
}
const pendingStatus = (status: SaveStatus) => status === 'saving' || status === 'unknown' || status === 'conflict';

/** 合并权威视图与本地未确认意图：新 revision 可以推进，但用户拖拽的候选不被轮询抹掉。 */
function overlayPending(view: SourceSettingsView, notices: SaveNotice[]): SourceSettingsView {
  const pending = new Map<string, SourceOperationPolicy>();
  for (const notice of notices) if (notice.active && pendingStatus(notice.status)) pending.set(`${notice.scopeId}:${notice.operationId}`, notice.candidate);
  if (!pending.size) return view;
  return { ...view, operationPolicies: [...view.operationPolicies.filter((item) => !pending.has(`${item.scopeId}:${item.operationId}`)), ...pending.values()] };
}

function effectivePolicy(view: SourceSettingsView, scopeId: string, operationId: SourceOperationId): { primary: string | null; backups: string[] } {
  const explicit = view.operationPolicies.find((item) => item.scopeId === scopeId && item.operationId === operationId);
  if (explicit) return { primary: explicit.primary, backups: explicit.backups };
  const scope = view.policies.find((item) => item.scopeId === scopeId);
  const policy = scope?.mode === 'inherit' ? view.policies.find((item) => item.scopeId === 'global') : scope;
  return { primary: policy?.primary ?? null, backups: policy?.backups ?? [] };
}

/** 接口源页：地区分类只决定范围；右侧按接口类型编排主源、备用源与可选池。 */
export function ApiSourcesPage() {
  const words = useWords();
  const { preferences, ready: preferencesReady, updatePreferences } = usePreferences();
  const [layout, setLayout] = useState<Layout>(defaultLayout);
  const [selected, setSelected] = useState<string>(DEFAULT_MARKET);
  const [open, setOpen] = useState<Set<string>>(() => new Set(['region', 'other']));
  const [marketQuery, setMarketQuery] = useState('');
  const [country, setCountry] = useState<string>('全部');
  const [assetScope, setAssetScope] = useState<string>('全部');
  const [dataCap, setDataCap] = useState<string>('全部');
  const [dragging, setDragging] = useState<{ id: string; from: 'root' | 'other' } | null>(null);
  const [sourceSettings, setSourceSettings] = useState<SourceSettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sourceDrag, setSourceDrag] = useState<{ operationId: SourceOperationId; connectionId: string } | null>(null);
  const [sourceDragOver, setSourceDragOver] = useState<string | null>(null);
  const [saveNotices, setSaveNotices] = useState<SaveNotice[]>([]);
  const settingsRef = useRef<SourceSettingsView | null>(null);
  const noticesRef = useRef<SaveNotice[]>([]);
  const editSeqRef = useRef(0);
  const savedSnapshot = useRef('');
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  useEffect(() => {
    if (!preferencesReady || prefsLoaded) return;
    const nextLayout = preferences.marketLayout && Array.isArray(preferences.marketLayout.root) && Array.isArray(preferences.marketLayout.other)
      ? preferences.marketLayout : defaultLayout;
    const selection = preferences.marketSelection;
    // 旧偏好可能停在采集源或数据库入口，那些已不是本页范围，回到默认市场。
    const nextSelected = selection?.selected && marketOf(selection.selected) ? selection.selected : DEFAULT_MARKET;
    const nextCountry = selection?.country ?? '全部', nextAssetScope = selection?.assetScope ?? '全部', nextDataCap = selection?.dataCap ?? '全部';
    setLayout(nextLayout); setSelected(nextSelected);
    setCountry(nextCountry); setAssetScope(nextAssetScope); setDataCap(nextDataCap);
    savedSnapshot.current = preferenceSnapshot(nextLayout, nextSelected, nextCountry, nextAssetScope, nextDataCap);
    setPrefsLoaded(true);
  }, [preferencesReady, preferences, prefsLoaded]);

  useEffect(() => {
    if (!prefsLoaded) return;
    const snapshot = preferenceSnapshot(layout, selected, country, assetScope, dataCap);
    if (snapshot === savedSnapshot.current) return;
    const timer = window.setTimeout(() => {
      // 页面只负责去抖与选择；偏好修订号和串行写入始终由全局 Provider 管理。
      saveQueue.current = saveQueue.current.catch(() => undefined).then(async () => {
        if (snapshot === savedSnapshot.current) return;
        await updatePreferences({ marketLayout: layout, marketSelection: { selected, country, assetScope, dataCap } });
        savedSnapshot.current = snapshot;
      }).catch(() => undefined);
    }, 500);
    return () => window.clearTimeout(timer);
  }, [prefsLoaded, layout, selected, country, assetScope, dataCap, updatePreferences]);

  const authoritativeRef = useRef<SourceSettingsView | null>(null);
  const applyView = useCallback((next: SourceSettingsView) => {
    const authoritative = authoritativeRef.current;
    // 权威新 revision 已读到后，晚到的旧回执不能把它覆盖回去；仍重新合并以撤下已失效的旧意图。
    if (authoritative && next.revision < authoritative.revision) {
      const merged = overlayPending(authoritative, noticesRef.current);
      settingsRef.current = merged; setSourceSettings(merged);
      return false;
    }
    authoritativeRef.current = next;
    const merged = overlayPending(next, noticesRef.current);
    settingsRef.current = merged; setSourceSettings(merged);
    return true;
  }, []);
  const publishNotice = useCallback((notice: SaveNotice) => {
    const next = [...noticesRef.current.filter((item) => item.requestId !== notice.requestId), notice];
    noticesRef.current = next; setSaveNotices(next);
  }, []);
  const latestNotice = (operationId: SourceOperationId) => [...saveNotices].reverse().find((item) => item.operationId === operationId) ?? null;
  const noticesFor = (operationId: SourceOperationId) => saveNotices.filter((item) => item.operationId === operationId);
  const receiptStatus = (operation: SourceSettingsOperation | null): SaveStatus => operation?.status === 'adopted' ? 'adopted'
    : operation?.status === 'conflict' ? 'conflict' : operation?.status === 'saving' ? 'unknown' : 'saved';
  const loadSettings = useCallback(async () => {
    try { void applyView(await loadSourceSettings()); setError(null); }
    catch (failure) { setError(errorDetail(failure)); }
  }, [applyView]);
  useEffect(() => {
    void loadSettings();
    const timer = window.setInterval(() => void loadSettings(), 10_000);
    return () => window.clearInterval(timer);
  }, [loadSettings]);
  const sourceCheck = useSourceCheck(loadSettings);
  const [runSource, setRunSource] = useState<SourceConnection | null>(null);
  const [runReceipt, setRunReceipt] = useState<SourceRunTask | null>(null), [runError, setRunError] = useState<string | null>(null);

  const pick = (id: string) => { setSelected(id); setCountry('全部'); setAssetScope('全部'); setDataCap('全部'); };
  const toggle = (id: string) => setOpen((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const moveTo = (target: 'root' | 'other') => {
    if (!dragging) return;
    const { id, from } = dragging;
    setDragging(null);
    if (from === target) return;
    setLayout((current) => ({
      root: target === 'root' ? [...current.root, id] : current.root.filter((item) => item !== id),
      other: target === 'other' ? [...current.other, id] : current.other.filter((item) => item !== id),
    }));
  };
  const dragProps = (id: string, from: 'root' | 'other') => ({
    draggable: true,
    onDragStart: () => setDragging({ id, from }),
    onDragEnd: () => setDragging(null),
  });
  const leaf = (item: MarketLeaf, from: 'root' | 'other' | 'fixed', depth = 1) => <button type="button" key={item.id}
    className={`data-nav-item${depth > 1 ? ' is-child' : ''}`} aria-current={selected === item.id ? 'true' : undefined}
    onClick={() => pick(item.id)} {...(from === 'fixed' ? {} : dragProps(item.id, from))}>
    <span>{item.label}</span><span className="data-nav-dot" aria-hidden="true" />
  </button>;

  const searching = marketQuery.trim().length > 0;
  const matchesMarket = (label: string) => !searching || label.toLocaleLowerCase().includes(marketQuery.trim().toLocaleLowerCase());
  const nav = <aside className="data-nav" aria-label={words('接口源分类', 'API source categories')}>
    <div className="sidebar-search-slot">
      <PageSearch compact label={words('搜索接口源分类', 'Search API source categories')}
        placeholder={words('搜索接口源…', 'Search API sources…')} value={marketQuery} onChange={setMarketQuery} />
    </div>
    <div onDragOver={(event) => { event.preventDefault(); event.stopPropagation(); }} onDrop={(event) => { event.preventDefault(); event.stopPropagation(); moveTo('root'); }}>
      <button type="button" className="data-nav-item is-group" aria-expanded={open.has('region')} onClick={() => toggle('region')}>
        <span>{words('地区市场', 'Markets')}</span><MorphIcon name={open.has('region') ? 'chevron-up' : 'chevron-down'} size={16} />
      </button>
      {(open.has('region') || searching) && <div className="data-nav-children">
        {layoutOf(layout.root).filter((item) => matchesMarket(item.label)).map((item) => leaf(item, 'root'))}
        <button type="button" className={`data-nav-item is-group is-child${open.has('other') ? ' is-open' : ''}`} aria-expanded={open.has('other')}
          onClick={() => toggle('other')} onDragOver={(event) => { event.preventDefault(); event.stopPropagation(); }} onDrop={(event) => { event.preventDefault(); event.stopPropagation(); moveTo('other'); }}>
          <span>{words('其他地区', 'Other regions')}</span><MorphIcon name={open.has('other') ? 'chevron-up' : 'chevron-down'} size={14} />
        </button>
        {(open.has('other') || searching) && <div className="data-nav-children is-nested" onDragOver={(event) => { event.preventDefault(); event.stopPropagation(); }} onDrop={(event) => { event.preventDefault(); event.stopPropagation(); moveTo('other'); }}>
          {layoutOf(layout.other).filter((item) => matchesMarket(item.label)).map((item) => leaf(item, 'other', 2))}
          {!layout.other.length && !searching && <p className="data-nav-hint">{words('把市场拖到这里收进其他地区', 'Drag a market here')}</p>}
        </div>}
      </div>}
    </div>

    <button type="button" className="data-nav-item is-group" aria-expanded={open.has('global')} onClick={() => toggle('global')}>
      <span>{words('全球类型', 'Global types')}</span><MorphIcon name={open.has('global') ? 'chevron-up' : 'chevron-down'} size={16} />
    </button>
    {(open.has('global') || searching) && <div className="data-nav-children">{GLOBAL_MARKET_LEAVES.filter((item) => matchesMarket(item.label)).map((item) => leaf(item, 'fixed'))}</div>}
  </aside>;

  const market = marketOf(selected);
  const scopeId = MARKET_SCOPES[selected];
  const scopePolicy = scopeId ? sourceSettings?.policies.find((item) => item.scopeId === scopeId) : undefined;
  const inheritsGlobal = scopePolicy?.mode === 'inherit';
  const policy = scopePolicy?.enabled
    ? inheritsGlobal ? sourceSettings?.policies.find((item) => item.scopeId === 'global') : scopePolicy
    : undefined;
  const scopeConnections = sourceSettings && scopeId
    ? sourceSettings.connections.filter((connection) => connection.scopes.includes(scopeId) || connection.scopes.includes('global'))
    : [];
  /**
   * 当前选中的对象：`__market__` 为市场总览，其余为来源连接 id；只影响详情，不改编排或检查状态。
   * 记忆按市场分区（键里带市场 id），切换市场不会把上一市场的来源带过来；
   * 来源列表未读回前保持 pending，不先回落到总览。
   */
  const selection = useObjectSelection(`xuan.api-sources.object:${selected}`,
    ['__market__', ...scopeConnections.map((connection) => connection.id)], sourceSettings !== null);
  const selectedConnectionId = selection.id && selection.id !== '__market__' ? selection.id : null;
  const pluginOf = (connection: SourceConnection) => sourceSettings?.apiPlugins.find((item) => item.id === connection.pluginId);
  const policyIds = policy ? [policy.primary, ...policy.backups].filter((id): id is string => id !== null) : [];
  const configuredSources = scopeConnections.filter((connection) => policyIds.includes(connection.id));
  const typeCards: TypeCard[] = [];
  const typeIndex = new Map<string, TypeCard>();
  for (const connection of scopeConnections) {
    for (const operation of pluginOf(connection)?.operations ?? []) {
      if (typeIndex.has(operation.id)) continue;
      const card: TypeCard = { id: operation.id, label: operation.label, capability: operation.dataCapability, assetScope: operation.assetScope, primary: null, backups: [], optional: [] };
      typeIndex.set(operation.id, card); typeCards.push(card);
    }
  }
  for (const card of typeCards) {
    const explicit = sourceSettings?.operationPolicies.find((item) => item.scopeId === scopeId && item.operationId === card.id);
    if (explicit) {
      card.primary = scopeConnections.find((connection) => connection.id === explicit.primary) ?? null;
      card.backups = explicit.backups.map((id) => scopeConnections.find((connection) => connection.id === id))
        .filter((connection): connection is SourceConnection => !!connection).slice(0, 1);
    } else {
      // 没有按类型编排时沿用原范围主备顺序，并把不支持该类型的来源放进可选池。
      const eligible = scopeConnections.filter((connection) => pluginOf(connection)?.operations.some((operation) => operation.id === card.id));
      const ordered = eligible.filter((connection) => policyIds.includes(connection.id)).sort((a, b) => policyIds.indexOf(a.id) - policyIds.indexOf(b.id));
      card.primary = ordered[0] ?? null; card.backups = ordered.slice(1, 2);
    }
    const assigned = new Set([card.primary?.id, ...card.backups.map((connection) => connection.id)].filter((id): id is string => !!id));
    card.optional = scopeConnections.filter((connection) => !assigned.has(connection.id));
  }
  typeCards.sort((a, b) => TYPE_CAPABILITY_ORDER.indexOf(a.capability) - TYPE_CAPABILITY_ORDER.indexOf(b.capability));
  const visibleCards = typeCards.filter((card) => (assetScope === '全部' || card.assetScope === ASSET_SCOPE_IDS[assetScope])
    && (dataCap === '全部' || card.capability === DATA_CAPABILITY_IDS[dataCap]));
  const typeCountZh = visibleCards.length === typeCards.length ? `${typeCards.length} 个` : `${visibleCards.length}/${typeCards.length} 个`;
  const typeCountEn = visibleCards.length === typeCards.length ? `${typeCards.length}` : `${visibleCards.length}/${typeCards.length}`;
  const selectedConnection = scopeConnections.find((connection) => connection.id === selectedConnectionId) ?? null;
  const selectedCheck = selectedConnection ? sourceSettings?.checks.find((item) => item.id === selectedConnection.id) : undefined;
  const selectedOperations = selectedConnection ? pluginOf(selectedConnection)?.operations ?? [] : [];
  // 该来源在当前市场各接口类型里担任的角色（主源/备用/可选池），直接来自现有编排结果。
  const selectedRoutes = selectedConnection
    ? typeCards.filter((card) => [card.primary, ...card.backups, ...card.optional].some((item) => item?.id === selectedConnection.id))
      .map((card) => ({ label: card.label, role: card.primary?.id === selectedConnection.id ? words('主源', 'Primary')
        : card.backups.some((item) => item?.id === selectedConnection.id) ? words('备用', 'Backup') : words('可选池', 'Pool') }))
    : [];
  // 只发布"当前在看什么"，不写会话、不触发任何 Agent 动作；读取中不冒充已选中总览。
  useEffect(() => {
    if (selection.pending) return;
    setWorkspaceObject(selectedConnection
      ? { page: 'api-sources', kind: 'supplier', id: selectedConnection.id, label: sourceLabel(selectedConnection), detail: marketLabelOf(selected) }
      : { page: 'api-sources', kind: 'market', id: selected, label: marketLabelOf(selected) });
  }, [selectedConnection, selected, selection.pending]);
  useEffect(() => () => setWorkspaceObject(null), []);
  const supportsType = (connection: SourceConnection, operationId: SourceOperationId) =>
    pluginOf(connection)?.operations.some((operation) => operation.id === operationId) ?? false;
  const queryOriginal = async (requestId: string): Promise<SourceSettingsOperation | null> => {
    for (const delay of [0, 250, 750]) {
      if (delay) await new Promise((resolve) => window.setTimeout(resolve, delay));
      try { const operation = await sourceSettingsOperation(requestId); if (operation) return operation; }
      catch (failure) {
        if (failure instanceof SourceSettingsRequestError && failure.status !== null && failure.status < 500 && failure.status !== 404) throw failure;
      }
    }
    return null;
  };
  const reconcileFailure = async (notice: SaveNotice, failure: unknown) => {
    const status = failure instanceof SourceSettingsRequestError ? failure.status : null;
    let operation: SourceSettingsOperation | null = null;
    // 只有“可能已写入但没拿到回执”或 revision 冲突才查原号；明确 4xx 不伪造成功。
    if (status === null || status === 409) { try { operation = await queryOriginal(notice.requestId); } catch { /* 原号仍无法核对，保持未知。 */ } }
    const nextStatus: SaveStatus = operation ? receiptStatus(operation) : status === 409 ? 'conflict' : 'unknown';
    let actualView: SourceSettingsView | null = null;
    if (nextStatus === 'conflict' || nextStatus === 'adopted' || nextStatus === 'saved') {
      try { actualView = await loadSourceSettings(); } catch { /* 回执已确认，视图读取失败不改变保存事实。 */ }
    }
    publishNotice({ ...notice, status: nextStatus, active: pendingStatus(nextStatus) && notice.seq === editSeqRef.current, operation,
      currentRevision: actualView?.revision ?? operation?.currentRevision ?? null,
      actual: actualView && nextStatus === 'conflict' ? effectivePolicy(actualView, notice.scopeId, notice.operationId) : null,
      error: failure instanceof Error ? failure.message : String(failure) });
    if (actualView) applyView(actualView);
  };
  const saveOperationPolicy = async (operationId: SourceOperationId, primary: string | null, backups: string[]) => {
    const authoritative = authoritativeRef.current, current = settingsRef.current;
    if (!authoritative || !current || !scopeId) return;
    const candidate: SourceOperationPolicy = { scopeId, operationId, primary, backups };
    const seq = ++editSeqRef.current;
    const requestId = newSourceSettingsRequestId(scopeId, operationId);
    // 同一操作的新意图取代旧未确认意图；旧回执仍保留在详情里。
    for (const old of noticesRef.current) if (old.operationId === operationId && old.active) publishNotice({ ...old, active: false });
    const notice: SaveNotice = { requestId, operationId, scopeId, status: 'saving', active: true, seq, candidate,
      baseRevision: authoritative.revision, operation: null, currentRevision: null, actual: null, error: null };
    publishNotice(notice);
    const optimistic = { ...current, operationPolicies: [...current.operationPolicies.filter((item) => !(item.scopeId === scopeId && item.operationId === operationId)), candidate] };
    settingsRef.current = optimistic; setSourceSettings(optimistic);
    try {
      // 只提交权威视图与本操作候选，不把其他操作的未确认意图顺带写入。
      const payload: SourceSettingsView = { ...authoritative,
        operationPolicies: [...authoritative.operationPolicies.filter((item) => !(item.scopeId === scopeId && item.operationId === operationId)), candidate] };
      const result = await saveSourceSettings(payload, requestId);
      const nextStatus = receiptStatus(result.operation);
      // 回执本身可能晚于页面已读到的权威新修订；技术详情报告当前最高修订，不把旧值写成现状。
      const currentRevision = Math.max(result.view.revision, authoritativeRef.current?.revision ?? 0);
      publishNotice({ ...notice, status: nextStatus, active: pendingStatus(nextStatus) && notice.seq === editSeqRef.current, operation: result.operation,
        currentRevision, error: result.operation?.error ?? null });
      // 迟到回执只更新回执；revision 更低不覆盖已读到的权威新版本，新编辑由 overlay 保留。
      applyView(result.view);
    } catch (failure) { await reconcileFailure(notice, failure); }
  };
  const resaveNotice = (notice: SaveNotice) => {
    if (!notice.active || !pendingStatus(notice.status)) return;
    void saveOperationPolicy(notice.operationId, notice.candidate.primary, notice.candidate.backups);
  };
  const verifyNotice = async (notice: SaveNotice) => {
    try {
      const operation = await sourceSettingsOperation(notice.requestId);
      if (!operation) { publishNotice({ ...notice, status: 'unknown', error: '仍未找到原请求回执；未换请求编号重发。' }); return; }
      const nextStatus = receiptStatus(operation);
      let actualView: SourceSettingsView | null = null;
      if (nextStatus === 'adopted' || nextStatus === 'saved' || nextStatus === 'conflict') {
        try { actualView = await loadSourceSettings(); } catch { /* 回执已确认。 */ }
      }
      publishNotice({ ...notice, status: nextStatus, active: pendingStatus(nextStatus) && notice.seq === editSeqRef.current, operation,
        currentRevision: actualView?.revision ?? operation.currentRevision,
        actual: actualView && nextStatus === 'conflict' ? effectivePolicy(actualView, notice.scopeId, notice.operationId) : null,
        error: operation.error });
      if (actualView) applyView(actualView);
    } catch (failure) { publishNotice({ ...notice, status: 'unknown', error: errorDetail(failure) }); }
  };
  const moveSource = (card: TypeCard, connectionId: string, zone: 'primary' | 'backup' | 'pool') => {
    const primary = card.primary?.id ?? null, backup = card.backups[0]?.id ?? null;
    if (zone === 'primary') {
      if (primary === connectionId) return;
      // 主源只有一个：原主源落到备用源，原备用源回到可选池。
      void saveOperationPolicy(card.id, connectionId, primary ? [primary] : []);
    } else if (zone === 'backup') {
      if (backup === connectionId) return;
      if (primary === connectionId) {
        // 主备对调；没有备用源时只留备用源，等待重新指定主源。
        void saveOperationPolicy(card.id, backup, backup ? [connectionId] : [connectionId]);
      } else {
        // 备用源只有一个：新来源占用备用位，原备用源回到可选池。
        void saveOperationPolicy(card.id, primary, [connectionId]);
      }
    } else {
      if (card.optional.some((connection) => connection.id === connectionId)) return;
      if (primary === connectionId) void saveOperationPolicy(card.id, backup, []);
      else if (backup === connectionId) void saveOperationPolicy(card.id, primary, []);
    }
  };
  const dropHandlers = (card: TypeCard, zone: 'primary' | 'backup' | 'pool') => ({
    onDragOver: (event: DragEvent<HTMLDivElement>) => {
      if (!sourceDrag || sourceDrag.operationId !== card.id) return;
      event.preventDefault(); event.dataTransfer.dropEffect = 'move';
      setSourceDragOver(`${card.id}:${zone}`);
    },
    onDragLeave: () => setSourceDragOver((current) => current === `${card.id}:${zone}` ? null : current),
    onDrop: (event: DragEvent<HTMLDivElement>) => {
      if (!sourceDrag || sourceDrag.operationId !== card.id) return;
      event.preventDefault();
      const connectionId = event.dataTransfer.getData('text/plain') || sourceDrag.connectionId;
      setSourceDragOver(null); setSourceDrag(null);
      moveSource(card, connectionId, zone);
    },
  });
  const sourceLabel = (connection: SourceConnection) => pluginOf(connection)?.shortLabel ?? shortSource(connection);
  const sourceChip = (card: TypeCard, connection: SourceConnection) => {
    const supported = supportsType(connection, card.id), label = sourceLabel(connection);
    return <span className={`market-type-chip${supported ? '' : ' is-unsupported'}`} data-enabled={connection.enabled} data-connection-id={connection.id} key={connection.id} draggable
      title={`${connection.alias}${supported ? '' : words(' · 不支持此接口类型', ' · does not support this type')}${connection.enabled ? '' : words(' · 连接已停用', ' · connection disabled')}`}
      onDragStart={(event) => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', connection.id); setSourceDrag({ operationId: card.id, connectionId: connection.id }); }}
      onDragEnd={() => setSourceDrag(null)}>
      <span className="source-lamp" data-ok={supported} role="img" aria-label={supported ? words('支持此接口类型', 'Supports this type') : words('不支持此接口类型', 'Does not support this type')} />
      <span className="market-type-chip-name">{label}</span>
    </span>;
  };
  const sourceBox = (card: TypeCard, zone: 'primary' | 'backup' | 'pool', items: SourceConnection[]) => <div
    className={`market-type-box${sourceDragOver === `${card.id}:${zone}` ? ' is-over' : ''}`} data-operation-id={card.id} data-zone={zone} {...dropHandlers(card, zone)}>
    <div className="market-type-box-body">
      {items.length ? items.map((connection) => sourceChip(card, connection)) : <span className="market-type-box-empty">{words('拖到这里', 'Drop here')}</span>}
    </div>
  </div>;
  const labelForId = (connectionId: string) => {
    const connection = sourceSettings?.connections.find((item) => item.id === connectionId);
    return connection ? sourceLabel(connection) : connectionId;
  };
  const saveLabel = (status: SaveStatus) => status === 'saving' ? words('保存中…', 'Saving…')
    : status === 'adopted' ? words('已保存并生效', 'Saved and adopted')
      : status === 'saved' ? words('已保存未生效', 'Saved, not adopted')
        : status === 'conflict' ? words('冲突未保存', 'Conflict, not saved') : words('结果未确认', 'Unconfirmed');
  const savePanel = (card: TypeCard) => {
    const latest = latestNotice(card.id);
    if (!latest) return null;
    const history = noticesFor(card.id);
    return <div className="market-type-save" data-save-status={latest.status} data-request-id={latest.requestId}>
      <p role="status"><strong>{saveLabel(latest.status)}</strong>
        {latest.status === 'conflict' && latest.currentRevision !== null && <> · {words(`当前已到第 ${latest.currentRevision} 版`, `Current revision ${latest.currentRevision}`)}</>}
        {latest.status === 'conflict' && <> · {words('当前真实主备', 'Current primary/backup')}：{latest.actual?.primary ? labelForId(latest.actual.primary) : words('未编排', 'None')}{latest.actual?.backups.length ? ` / ${latest.actual.backups.map(labelForId).join(' / ')}` : ''}</>}
        {latest.status === 'conflict' && <button type="button" className="text-button" onClick={() => resaveNotice(latest)}>{words('以当前版本为基线再次保存', 'Save again on the current revision')}</button>}
        {latest.status === 'unknown' && <button type="button" className="text-button" onClick={() => void verifyNotice(latest)}>{words('核对原请求', 'Check original request')}</button>}
      </p>
      <details><summary>{words('技术详情', 'Technical details')}</summary>
        {history.map((item) => <div key={item.requestId}>
          <code>{item.requestId}</code>
          <small>expected {item.operation?.expectedRevision ?? item.baseRevision} · saved {item.operation?.savedRevision ?? '—'} · adopted {item.operation?.adoptedRevision ?? '—'} · current {item.currentRevision ?? item.operation?.currentRevision ?? '—'} · actualMatches {item.operation ? String(item.operation.actualMatches) : 'unknown'}</small>
          {(item.error || item.operation?.error) && <small>{item.error ?? item.operation?.error}</small>}
        </div>)}
      </details>
    </div>;
  };
  const chips = (label: string, values: string[], active: string, onPick: (value: string) => void) => <div className="market-filter">
    <span className="market-filter-label">{label}</span>
    <div className="market-chips">{values.map((value) => <button type="button" key={value} className="market-chip" aria-pressed={active === value} onClick={() => onPick(value)}>{value}</button>)}</div>
  </div>;
  /** 摘要只留"当前范围 + 类型数量"；筛选项属于操作，放在主体上方。 */
  const marketSummary = market ? <div className="market-scope">
    <span>{[country !== '全部' ? country : '', assetScope !== '全部' ? assetScope : '', dataCap !== '全部' ? dataCap : ''].filter(Boolean).join(' · ') || words('全部范围', 'All scopes')}</span>
    <span className="market-state">{words(`接口类型：${typeCountZh}`, `API types: ${typeCountEn}`)}</span>
  </div> : null;
  const marketFilters = market ? <>
    {!!market.countries?.length && chips(words('国家或地区', 'Country'), ['全部', ...market.countries], country, setCountry)}
    {chips(words('资产范围', 'Asset scope'), ASSET_SCOPES, assetScope, setAssetScope)}
    {chips(words('数据能力', 'Data capability'), DATA_CAPS, dataCap, setDataCap)}
  </> : null;
  const marketTypes = market ? (typeCards.length ? <>
    <div className="market-type-legend">
      <span><span className="source-lamp" data-ok="true" aria-hidden="true" />{words('支持此类型', 'Supports this type')}</span>
      <span><span className="source-lamp" data-ok="false" aria-hidden="true" />{words('不支持 = 没有这类接口，不能用，执行时跳过', 'Unsupported = no such API; cannot be used, skipped at execution')}</span>
    </div>
    <p className="market-types-note">{saveNotices.some((item) => item.status === 'saving') ? words('保存中…', 'Saving…') : words('主源、备用源各一个，其余来源在可选池；主备不可用时内置代理会从可选池继续查找，未编排时沿用范围主备。', 'One primary and one backup; other sources sit in the pool, which built-in agents fall back to when neither selected source is usable. The scope policy applies until an arrangement is saved.')}</p>
    {visibleCards.length ? <div className="market-types" aria-label={words('接口类型', 'API types')}>
      {visibleCards.map((card) => {
        const assigned = [card.primary, ...card.backups].filter((connection): connection is SourceConnection => !!connection);
        const supported = assigned.some((connection) => supportsType(connection, card.id));
        return <article className="market-type-card" data-operation-id={card.id} key={card.id}>
          <div className="market-type-head">
            <span className="market-type-name">{card.label}</span>
            <span className="market-type-cap">{words(...DATA_CAPABILITY_LABELS[card.capability])}</span>
            <span className="market-type-asset">{words(...ASSET_SCOPE_LABELS[card.assetScope])}</span>
          </div>
          <div className="market-type-pair">
            <div className="market-type-column">
              <span className="market-type-box-label">{words('主源', 'Primary')}</span>
              {sourceBox(card, 'primary', card.primary ? [card.primary] : [])}
            </div>
            <div className="market-type-column">
              <span className="market-type-box-label">{words('备用源', 'Backup')}</span>
              {sourceBox(card, 'backup', card.backups)}
            </div>
          </div>
          <div className="market-type-column market-type-pool-column">
            <span className="market-type-box-label">{words('可选池', 'Pool')}</span>
            {sourceBox(card, 'pool', card.optional)}
          </div>
          {savePanel(card)}
          {!supported && <p className="market-type-warning">{words('当前没有支持此类型的已选来源。', 'No selected source supports this type.')}</p>}
        </article>;
      })}
    </div> : <p className="data-empty">{words('当前资产范围或数据能力下没有匹配的接口类型。', 'No API type matches the current asset scope or data capability.')}</p>}
  </> : <p className="data-empty">{inheritsGlobal
    ? words('继承全局，但全局来源未覆盖该范围。', 'Inherits the global default, but it does not cover this scope.')
    : words('该范围尚未配置接口源。', 'No API source is configured for this scope.')}</p>) : null;

  const detailPanel = !market
    ? <section className="data-panel"><p className="data-empty">{words('该分类尚未接入数据。', 'No data is connected for this category yet.')}</p></section>
    : <ObjectDetailPanel
      label={words('接口源详情', 'API source detail')}
      header={selection.pending
        ? <DetailHeader title={words('正在读取…', 'Loading…')} />
        : selectedConnection
          ? <DetailHeader title={sourceLabel(selectedConnection)}
            status={selectedConnection.enabled ? words('已启用', 'Enabled') : words('已停用', 'Disabled')}
            tone={selectedConnection.enabled ? 'ready' : 'warning'}
            meta={`${selectedConnection.alias} · ${selectedConnection.scopes.join(' / ')}`} />
          : <DetailHeader title={market.label}
            status={configuredSources.length ? words('已配置', 'Configured') : words('未配置', 'Not configured')}
            tone={configuredSources.length ? 'ready' : 'neutral'}
            meta={inheritsGlobal && configuredSources.length > 0 ? words('继承全局默认编排', 'Inherits the global default arrangement') : undefined} />}
      summary={selection.pending ? undefined : selectedConnection
        ? <DetailFacts items={[
          { label: words('数据能力', 'Capabilities'), value: selectedOperations.length ? selectedOperations.map((operation) => operation.label).join(' · ') : words('没有公开运行动作', 'No public operations') },
          { label: words('来源路由', 'Routing'), value: selectedRoutes.length ? selectedRoutes.map((route) => `${route.label}（${route.role}）`).join(' · ') : words('未编入当前市场的接口类型', 'Not arranged for any API type in this market') },
          { label: words('最近检查', 'Latest check'), value: <SourceCheckLine check={selectedCheck} /> },
        ]} />
        : marketSummary}
      diagnostics={selectedConnection ? <DetailDiagnostics label={words('来源标识与范围', 'Source identity and scope')}>
        <dl className="object-detail-facts">
          <div><dt>{words('连接编号', 'Connection ID')}</dt><dd className="tools-mono">{selectedConnection.id}</dd></div>
          <div><dt>{words('别名', 'Alias')}</dt><dd>{selectedConnection.alias}</dd></div>
          <div><dt>{words('范围编号', 'Scope IDs')}</dt><dd className="tools-mono">{selectedConnection.scopes.join(' / ')}</dd></div>
          <div><dt>{words('适配插件', 'Plugin')}</dt><dd>{pluginOf(selectedConnection)?.shortLabel ?? '—'}</dd></div>
          <div><dt>{words('检查时间', 'Checked at')}</dt><dd>{selectedCheck ? new Date(selectedCheck.checkedAt).toLocaleString() : '—'}</dd></div>
        </dl>
      </DetailDiagnostics> : undefined}>
      {selection.pending
        ? <p className="object-detail-note">{words('来源列表尚未读回，暂不显示详情，也不回落到市场总览。',
          'The source list has not loaded yet; no detail is shown and the market overview is not substituted.')}</p>
        : selectedConnection ? <div className="supplier-detail-actions">
          <button type="button" className="text-button" disabled={sourceCheck.busy !== null} onClick={() => void sourceCheck.check(selectedConnection.id)}>
            {sourceCheck.busy === selectedConnection.id ? words('检查中…', 'Checking…') : words('检查', 'Check')}</button>
          {selectedConnection.enabled && selectedOperations.length > 0 && <button type="button" className="text-button"
            onClick={() => { setRunReceipt(null); setRunError(null); setRunSource(selectedConnection); }}>{words('运行…', 'Run…')}</button>}
        </div> : <>
          {error && <ErrorNote detail={error}>{words('接口源状态暂时无法读取。', 'API source status could not be read.')}</ErrorNote>}
          {marketFilters}
          {marketTypes}
        </>}
    </ObjectDetailPanel>;

  return <div className="data-page page-panes page-panes--api" data-settings-revision={sourceSettings?.revision ?? 'unknown'}>
    {nav}
    <div className="page-cards" aria-label={words('来源', 'Sources')}>
      <SourceCheckError error={sourceCheck.error} />
      <div className="object-list">
        <button type="button" className="object-card" aria-current={!selectedConnection && !selection.pending ? 'true' : undefined} onClick={() => selection.select('__market__')}>
          <span className="object-card-main">
            <span className="object-card-title">{words('当前市场总览', 'Market overview')}</span>
            <span className="object-card-meta">{marketLabelOf(selected)}</span>
          </span>
          <span className="object-card-state">{words(`${typeCards.length} 个接口类型`, `${typeCards.length} types`)}</span>
        </button>
        {scopeConnections.map((connection) => {
          return <button type="button" key={connection.id} className="object-card"
            aria-current={selectedConnectionId === connection.id ? 'true' : undefined} onClick={() => selection.select(connection.id)}>
            <span className="object-card-main">
              <span className="object-card-title">{sourceLabel(connection)}</span>
              <span className="object-card-meta">{connection.alias} · {connection.scopes.join(' / ')}</span>
            </span>
            <span className="object-card-state" data-ok={connection.enabled}>{connection.enabled ? words('已启用', 'Enabled') : words('已停用', 'Disabled')}</span>
          </button>;
        })}
        {!scopeConnections.length && <p className="data-empty">{words('当前范围没有已配置来源连接。', 'No source connection is configured for this scope.')}</p>}
      </div>
    </div>
    {detailPanel}
    {dragging && <p className="data-drag-hint" role="status">{words('拖到“其他地区”收进去，拖到地区列表放出来', 'Drop on 其他地区 to group it, or on the region list to pull it out')}</p>}
    {runSource && sourceSettings && <ApiRunDialog connection={runSource} plugin={sourceSettings.apiPlugins.find(item => item.id === runSource.pluginId) ?? null}
      scopes={sourceSettings.scopes} onClose={() => { setRunSource(null); setRunReceipt(null); setRunError(null); }}
      receipt={runReceipt} onReceipt={setRunReceipt} error={runError} onError={setRunError} />}
  </div>;
}

function ApiRunDialog({ connection, plugin, scopes, onClose, receipt, onReceipt, error, onError }: {
  connection: SourceConnection; plugin: SourceSettingsView['apiPlugins'][number] | null;
  scopes: SourceSettingsView['scopes']; onClose(): void; receipt: SourceRunTask | null;
  onReceipt(task: SourceRunTask | null): void; error: string | null; onError(error: string | null): void;
}) {
  const words = useWords();
  const operations = plugin?.operations ?? [];
  const [scope, setScope] = useState(connection.scopes[0] ?? 'global');
  const [operation, setOperation] = useState<SourceOperationId>(operations[0]?.id ?? 'daily_bars');
  const [parameters, setParameters] = useState('{}');
  const [busy, setBusy] = useState(false);
  const requestId = useRef(`ui-source-run-${crypto.randomUUID()}`);
  const run = async () => {
    if (busy) return;
    onError(null); onReceipt(null);
    let parsed: unknown;
    try { parsed = JSON.parse(parameters || '{}'); }
    catch { onError(words('参数需要有效 JSON 对象。', 'Parameters must be a valid JSON object.')); return; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { onError(words('参数需要 JSON 对象。', 'Parameters must be a JSON object.')); return; }
    const body = { requestId: requestId.current, connectionId: connection.id,
      operationId: operation, scopeId: scope, parameters: parsed };
    setBusy(true);
    try {
      const value = await request('/api/ui/source-settings/runs', 'POST', body) as { task?: SourceRunTask };
      if (!value.task || typeof value.task.id !== 'string') throw new Error(words('运行入口没有返回原任务。', 'The run entry returned no original task.'));
      onReceipt(value.task);
    } catch (failure) { onError(errorDetail(failure)); }
    finally { setBusy(false); }
  };
  return <Modal title={words('运行来源动作', 'Run source action')} onClose={onClose} busy={busy}>
    <p>{words('将按当前范围已保存的主备组合运行所选接口操作；实际调用来源以任务回执为准。页面不会自动采集或重试，任务回执不代表已入库。', 'Runs the selected operation through the saved primary/backup route for this scope; the receipt identifies the actual source. No automatic collection or retries, and a task receipt is not ingestion.')}</p>
    <div className="run-form">
      <SelectMenu label={words('范围', 'Scope')} value={scope} disabled={busy} options={(connection.scopes.length ? connection.scopes : scopes.map(item => item.id)).map(id => ({ value: id, label: scopes.find(item => item.id === id)?.label ?? id }))} onChange={setScope} />
      <SelectMenu label={words('操作', 'Operation')} value={operation} disabled={busy}
        options={(operations.length ? operations : [{ id: 'daily_bars' as const, label: words('日线', 'Daily') }]).map(item => ({ value: item.id, label: item.label }))}
        onChange={value => setOperation(value as SourceOperationId)} />
    </div>
    <PageField label={words('参数（JSON，按公开接口填写）', 'Parameters (JSON, per public API)')}>
      <textarea value={parameters} disabled={busy} rows={4} onChange={event => setParameters(event.currentTarget.value)} spellCheck={false} />
    </PageField>
    {receipt && <RunReceipt task={receipt} />}
    {error && <ErrorNote detail={error}>{words('来源运行未确认；没有换请求编号重发。', 'The source run is unconfirmed; it was not resent with a new request ID.')}</ErrorNote>}
    <PageActions className="dialog-actions" align="end">
      <PageButton disabled={busy} onClick={onClose}>{words('关闭', 'Close')}</PageButton>
      <PageButton variant="primary" disabled={busy || !plugin} onClick={() => void run()}>
        {busy ? words('发起中…', 'Starting…') : words('明确运行一次', 'Run once explicitly')}
      </PageButton>
    </PageActions>
  </Modal>;
}

export default ApiSourcesPage;
