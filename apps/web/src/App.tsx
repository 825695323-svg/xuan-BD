import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Tooltip } from 'radix-ui';
import type { ConversationAttachmentRef } from '../../../contracts/contracts';
import type { UiRuntimeView } from './ui-runtime-api';
import { uiApi } from './ui-runtime-api';
import { useConversation } from './useConversation';
import { useConversationTasks } from './useConversationTasks';
import { PreferencesProvider, usePreferences } from './ui/Preferences';
import { CanvasContext } from './ui/canvas';
import { Shell, type Page } from './ui/Shell';
import { WorkspaceLayout } from './ui/WorkspaceLayout';
import ConversationView from './ui/ConversationView';
import SettingsPage from './ui/SettingsPage';
import CaptureSourcesPage from './ui/CaptureSourcesPage';
import ApiSourcesPage from './ui/ApiSourcesPage';
import DatabasePage from './ui/DatabasePage';
import ToolsPage from './ui/ToolsPage';
import type { AlgorithmEntryFocus, AlgorithmFocusRequest } from './ui/algorithm-catalog';
import { Modal, errorDetail, useWords } from './ui/Controls';
import { currentLocalData, type LocalDataRecord } from './local-data-api';
import { forgetLocalDataSession, localDataRevision, setLocalDataSession, subscribeLocalDataRevoked } from './local-data-context';

type ReferenceIntent = { text: string; attachments: ConversationAttachmentRef[]; targetId: string | null; targetBranch: string | null; requireNew: boolean; ready: boolean; resolve(): void; reject(error: Error): void };

const PAGES: readonly Page[] = ['conversations', 'capture', 'api-sources', 'database', 'tools', 'settings'];
const PAGE_TITLE_KEYS: Record<Page, string> = { conversations: 'nav.conversations', capture: 'nav.capture',
  'api-sources': 'nav.apiSources', database: 'nav.database', tools: 'nav.tools', settings: 'nav.settings' };
/** 只从地址栏 hash 恢复页面标识；未知值回到会话页，不据此发起任何请求或写入。 */
function pageFromHash(): Page {
  const raw = window.location.hash.slice(1);
  return (PAGES as readonly string[]).includes(raw) ? raw as Page : 'conversations';
}

function Application() {
  const words = useWords(), chat = useConversation('pi'), { t } = usePreferences();
  // 真实任务流只在这里订阅一次，会话视图与任务中心共用。
  const tasks = useConversationTasks(chat.conversation?.conversationId);
  const [page, setPage] = useState<Page>(pageFromHash);
  const pageTitle = t(PAGE_TITLE_KEYS[page]);
  const [algorithmFocus, setAlgorithmFocus] = useState<AlgorithmEntryFocus | null>(null);
  const [runtime, setRuntime] = useState<UiRuntimeView | null>(null), [runtimeError, setRuntimeError] = useState<string | null>(null), [controlBusy, setControlBusy] = useState(false), [feedback, setFeedback] = useState<{ message: string; issues: string[] } | null>(null), [dropNotice, setDropNotice] = useState<string | null>(null);
  const [referenceIntent, setReferenceIntent] = useState<ReferenceIntent | null>(null);
  const chatRef = useRef(chat); chatRef.current = chat;
  const referenceLock = useRef(false), referenceWorking = useRef(false), runtimeEpoch = useRef(0), algorithmFocusNonce = useRef(0), alive = useRef(true), navigateLatest = useRef<(next: Page) => void>(() => {});
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  // 地址栏只记录当前页面标识，供刷新与重挂载恢复；用 replaceState 不新增历史条目，也不参与任何私有请求。
  useEffect(() => {
    const target = page === 'conversations' ? window.location.pathname + window.location.search : `#${page}`;
    try { window.history.replaceState(null, '', target); } catch { /* 仅地址栏同步。 */ }
  }, [page]);
  const refreshRuntime = useCallback(() => {
    const epoch = ++runtimeEpoch.current;
    void uiApi.runtime().then((value) => { if (alive.current && epoch === runtimeEpoch.current) { setRuntime(value); setRuntimeError(null); } }).catch((failure) => { if (alive.current && epoch === runtimeEpoch.current) setRuntimeError(errorDetail(failure)); });
  }, []);
  useEffect(() => { refreshRuntime(); const interval = window.setInterval(refreshRuntime, 15_000); return () => { window.clearInterval(interval); ++runtimeEpoch.current; }; }, [refreshRuntime]);
  useEffect(() => { refreshRuntime(); }, [chat.isRunning, refreshRuntime]);
  useEffect(() => {
    if (page !== 'database' || !algorithmFocus) return;
    // 目标面板完成首次滚动与聚焦后清除一次性提示；页面重新进入时不会再次自动滚动。
    const timer = window.setTimeout(() => setAlgorithmFocus(null), 2500);
    return () => window.clearTimeout(timer);
  }, [page, algorithmFocus]);
  function navigate(next: Page) {
    setDropNotice(null);
    if (next !== 'database') setAlgorithmFocus(null);
    setPage(next);
  }
  navigateLatest.current = navigate;
  // 统一算法页只把目标面板/方法带到数据库；不携带表单载荷，也不触发任何计算或写入。
  const openAlgorithmEntry = (request: AlgorithmFocusRequest) => {
    setAlgorithmFocus({ ...request, nonce: ++algorithmFocusNonce.current });
    navigate('database');
  };
  async function control(kind: 'stop' | 'resume') {
    if (controlBusy) return;
    setControlBusy(true); ++runtimeEpoch.current;
    try {
      if (kind === 'stop') {
        const result = await uiApi.stop('all'); setRuntime(result); setRuntimeError(null);
        setFeedback({ message: result.confirmed ? words('新增派发已停止，当前可取消工作已收束。', 'New dispatches are stopped and cancellable work has settled.') : words('已请求全部停止，仍有结果待核。', 'Stop all was requested. Some outcomes remain unconfirmed.'), issues: result.issues });
      } else if (runtime) {
        const result = await uiApi.resume(runtime.control.personal.generation, runtime.control.workspace?.generation); setRuntime(result); setRuntimeError(null);
        setFeedback({ message: words('新增派发已恢复；草稿与待核任务不会自动重发。', 'New dispatches resumed. Drafts and unconfirmed tasks are not resent automatically.'), issues: [] });
      }
    } catch (failure) { setFeedback({ message: words('控制结果尚未确认，请核对状态。', 'The control result is unconfirmed. Check status.'), issues: [errorDetail(failure)] }); }
    finally { setControlBusy(false); }
  }
  const bringToConversation = useCallback((text: string, attachments: ConversationAttachmentRef[] = []) => new Promise<void>((resolve, reject) => {
    if (referenceLock.current) { reject(new Error('A reference is already being added.')); return; }
    referenceLock.current = true; const current = chatRef.current;
    const intent: ReferenceIntent = { text, attachments, targetId: current.selectedId, targetBranch: current.conversation?.branchId ?? null, requireNew: !current.conversation || current.readOnly, ready: false, resolve, reject };
    setReferenceIntent(intent);
    if (intent.requireNew) void current.newConversation().then((created) => {
      if (!created) { intent.reject(new Error('A writable conversation could not be created. The reference was not added.')); referenceLock.current = false; setReferenceIntent(null); return; }
      setReferenceIntent((value) => value === intent ? { ...intent, targetId: created.conversationId, targetBranch: created.branchId, ready: true } : value);
    });
    else setReferenceIntent({ ...intent, ready: true });
  }), []);
  useEffect(() => {
    if (!referenceIntent?.ready || referenceWorking.current || chat.newPending) return;
    const intent = referenceIntent, target = chatRef.current;
    if (target.selectedId === intent.targetId && target.connection === 'connecting') return;
    if (!target.conversation || target.readOnly || !target.draft || target.selectedId !== intent.targetId || target.conversation.branchId !== intent.targetBranch || target.connection !== 'connected') {
      intent.reject(new Error(words('未能建立可写会话，引用尚未加入草稿。', 'A writable conversation could not be opened. The reference was not added to a draft.'))); referenceLock.current = false; setReferenceIntent(null); return;
    }
    referenceWorking.current = true;
    const id = target.conversation.conversationId;
    if (intent.text && !target.draft.text.includes(intent.text)) target.setDraftText([target.draft.text, intent.text].filter(Boolean).join('\n\n'));
    void target.addDraftAttachments(intent.attachments).then(() => {
      target.selectConversation(id); navigateLatest.current('conversations'); intent.resolve();
    }).catch((failure) => intent.reject(failure instanceof Error ? failure : new Error(errorDetail(failure))))
      .finally(() => { referenceWorking.current = false; referenceLock.current = false; setReferenceIntent(null); });
  }, [referenceIntent, chat.newPending, chat.selectedId, chat.draft, chat.connection, words]);
  return <Shell page={page} onNavigate={navigate}
    hasActiveTasks={chat.isRunning || !!runtime?.control.activeCount || !!runtime?.activeRuns.length} globallyStopped={runtime?.control.stopped ?? false} stoppingAll={controlBusy} onStopAll={() => void control('stop')} onResume={() => void control('resume')} onRefresh={refreshRuntime}
    onRejectedDrop={(kind) => setDropNotice(kind === 'url' ? words('网址不会自动下载，请在会话中说明访问范围。', 'URLs are not downloaded on drop. Describe the intended access in a conversation.') : words('请把文件拖入会话输入框。', 'Drop files into the conversation composer.'))}>
    {dropNotice && <div className="page-notice" role="status">{dropNotice}<button type="button" className="text-button" onClick={() => setDropNotice(null)}>{words('关闭', 'Dismiss')}</button></div>}
    <WorkspaceLayout title={pageTitle} pageKey={page} contextLabel={pageTitle} tasks={tasks}
      showDirectory={!['capture', 'api-sources', 'tools', 'conversations', 'database'].includes(page)}
      showAgent={page !== 'conversations' && page !== 'database'}
      agent={<ConversationView chat={chat} hidden={false} dispatchBlocked={runtime?.control.stopped ?? false} controlUnconfirmed={!runtime || !!runtimeError} compact tasks={tasks} />}>
    {page === 'conversations' && <ConversationView chat={chat} hidden={false} dispatchBlocked={runtime?.control.stopped ?? false} controlUnconfirmed={!runtime || !!runtimeError} tasks={tasks} />}
    {page === 'capture' && <CaptureSourcesPage />}
    {page === 'api-sources' && <ApiSourcesPage />}
    {page === 'database' && <DatabasePage onBringToConversation={bringToConversation} algorithmFocus={algorithmFocus} />}
    {page === 'tools' && <ToolsPage onOpenEntry={openAlgorithmEntry} />}
    {page === 'settings' && <SettingsPage />}
    </WorkspaceLayout>
    {feedback && <Modal title={words('运行控制', 'Run control')} onClose={() => setFeedback(null)}><p role="status">{feedback.message}</p><p className="subtle-text">{words('控制范围是本 xuan BD；外部已发生的结果仍按原记录核对。', 'This control applies to this xuan BD application. External effects are still checked against their original records.')}</p>{feedback.issues.length > 0 && <ul>{feedback.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul>}<div className="dialog-actions"><button type="button" className="text-button" onClick={refreshRuntime}>{words('核对状态', 'Check status')}</button><button type="button" className="primary-button" onClick={() => setFeedback(null)}>{words('关闭', 'Close')}</button></div></Modal>}
  </Shell>;
}

function DesignCanvas({ children }: { children: ReactNode }) {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  return <div ref={setNode} className="design-canvas">
    <CanvasContext.Provider value={node}>{children}</CanvasContext.Provider>
  </div>;
}

type LifecycleView = { state: 'checking' } | { state: 'active' | 'blocked'; dataId: string; record: LocalDataRecord } | { state: 'unavailable'; detail: string };

export default function App() { return <LifecycleGate />; }

function LifecycleGate() {
  const [view, setView] = useState<LifecycleView>({ state: 'checking' });
  const [checking, setChecking] = useState(false);
  const cleared = useRef(false);
  const epoch = useRef(0);
  const latestCheck = useRef<() => Promise<void>>(async () => {});
  const check = useCallback(async (quiet = false) => {
    const ticket = ++epoch.current;
    const revoked = localDataRevision();
    if (!quiet) setChecking(true);
    try {
      const current = await currentLocalData();
      // 慢的旧 active 响应不能覆盖更新的停用/解绑；请求期间发生资格撤销也按失败关闭。
      if (ticket !== epoch.current || localDataRevision() !== revoked) return;
      const record = current.record;
      const active = current.available && !!record && record.status === 'active' && record.adopted;
      if (active && record) {
        setLocalDataSession(current.dataId, record.generation);
        setView({ state: 'active', dataId: current.dataId, record });
      } else {
        forgetLocalDataSession();
        setView(record ? { state: 'blocked', dataId: current.dataId, record }
          : { state: 'unavailable', detail: current.detail ?? '当前身份没有控制记录，不能自动重建。' });
      }
    } catch (failure) {
      if (ticket !== epoch.current || localDataRevision() !== revoked) return;
      forgetLocalDataSession();
      setView({ state: 'unavailable', detail: errorDetail(failure) });
    } finally { if (ticket === epoch.current) setChecking(false); }
  }, []);
  latestCheck.current = () => check(true);
  useEffect(() => { void check(); }, [check]);
  useEffect(() => subscribeLocalDataRevoked(() => {
    ++epoch.current;
    forgetLocalDataSession();
    // 任何明确失效先卸下私有页面，再重新核对；不等待下一次轮询。
    setView((value) => value.state === 'active' ? { state: 'checking' } : value);
    void latestCheck.current();
  }), []);
  useEffect(() => {
    // 两窗口与焦点/恢复：只静默复核资格；明确失效由上方 revoked 订阅立即卸载。
    const wake = () => {
      if (document.visibilityState !== 'visible') return;
      ++epoch.current;
      // 焦点/可见性恢复只做静默复核：不预先卸载私有页面，否则每次切回窗口都会重挂载并丢失当前页面状态。
      // 复核返回非 active 时仍由下方条件渲染卸载；显式失效（revoked 广播、服务端拒绝）依旧立即卸载。
      void check(true);
    };
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void check(true);
    }, 3_000);
    let channel: BroadcastChannel | null = null;
    try {
      channel = new BroadcastChannel('mashiro.local-data-lifecycle');
      channel.onmessage = wake;
    } catch { /* 无广播能力时仍按轮询与焦点核对。 */ }
    window.addEventListener('focus', wake);
    window.addEventListener('online', wake);
    document.addEventListener('visibilitychange', wake);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', wake);
      window.removeEventListener('online', wake);
      document.removeEventListener('visibilitychange', wake);
      channel?.close();
    };
  }, [check]);
  useEffect(() => {
    if (view.state === 'blocked' && !cleared.current) { cleared.current = true; purgePrivateClientState(); }
    if (view.state === 'active') cleared.current = false;
  }, [view.state]);
  if (view.state === 'active') return <PreferencesProvider><Tooltip.Provider delayDuration={350}><DesignCanvas>
    <Application />
  </DesignCanvas></Tooltip.Provider></PreferencesProvider>;
  return <LocalDataUnavailable view={view} checking={checking} onCheck={() => check()} />;
}

/** 身份或资格异常时的最小提示；只重新核对，不提供停用/解绑/重新采用，也不绕过启动门禁。 */
function LocalDataUnavailable({ view, checking, onCheck }: { view: Exclude<LifecycleView, { state: 'active' }>; checking: boolean; onCheck: () => Promise<void> }) {
  const message = view.state === 'checking' ? '正在核对当前本地资料身份…'
    : view.state === 'unavailable' ? `资格尚未确认：${view.detail}`
    : '当前本地资料身份未通过核对，已停止加载私有内容。';
  return <main style={{ maxWidth: 680, margin: '12vh auto', padding: '0 24px', fontFamily: 'system-ui, sans-serif', lineHeight: 1.7 }}>
    <h1 style={{ fontSize: 22 }}>当前本地资料未加载</h1>
    <p role="status">{message}</p>
    <p style={{ color: '#666', fontSize: 13 }}>应用不会自动重建资料、绕过身份检查或重发旧任务。请核对运行根与状态库对象后再重新核对资格。</p>
    <div style={{ marginTop: 16 }}><button type="button" disabled={checking} onClick={() => void onCheck()}>{checking ? '核对中…' : '重新核对资格'}</button></div>
    <details style={{ color: '#666', fontSize: 12, marginTop: 16 }}><summary>技术详情</summary>
      {view.state === 'blocked' && <p>资料 {view.dataId}；状态 {view.record.status}；代次 {view.record.generation}；修订 {view.record.revision}。</p>}
      {view.state === 'unavailable' && <p>{view.detail}</p>}
    </details>
  </main>;
}

function purgePrivateClientState() {
  try {
    for (const key of Object.keys(localStorage)) if (key.startsWith('mashiro.')) localStorage.removeItem(key);
    for (const key of Object.keys(sessionStorage)) if (key.startsWith('mashiro.')) sessionStorage.removeItem(key);
  } catch { /* 浏览器拒绝清理时，已卸载的页面不再保留这些状态。 */ }
  void (typeof caches === 'undefined' ? Promise.resolve() : caches.keys().then((keys) => Promise.all(keys.map((key) => caches.delete(key)))).catch(() => {}));
}
