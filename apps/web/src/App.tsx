import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Tooltip } from 'radix-ui';
import type { ConversationAttachmentRef } from '../../../contracts/contracts';
import type { UiIndicator, UiRuntimeView } from './ui-runtime-api';
import { uiApi } from './ui-runtime-api';
import { useConversation } from './useConversation';
import { PreferencesProvider } from './ui/Preferences';
import { CanvasContext } from './ui/canvas';
import { Shell, type Page } from './ui/Shell';
import ConversationView from './ui/ConversationView';
import SettingsPage, { type SettingsSection } from './ui/SettingsPage';
import CaptureSourcesPage from './ui/CaptureSourcesPage';
import ApiSourcesPage from './ui/ApiSourcesPage';
import DatabasePage from './ui/DatabasePage';
import ToolsPage from './ui/ToolsPage';
import { ErrorNote, Modal, errorDetail, useWords } from './ui/Controls';
import { currentLocalData, deactivateLocalData, unbindLocalData, verifyLocalData, reloadLocalData, stopLocalData, type LocalDataRecord } from './local-data-api';
import { forgetLocalDataSession, localDataRevision, setLocalDataSession, subscribeLocalDataRevoked } from './local-data-context';

type ReferenceIntent = { text: string; attachments: ConversationAttachmentRef[]; targetId: string | null; targetBranch: string | null; requireNew: boolean; ready: boolean; resolve(): void; reject(error: Error): void };

function Application() {
  const words = useWords(), chat = useConversation('pi');
  const [page, setPage] = useState<Page>('conversations'), [settingsSection, setSettingsSection] = useState<SettingsSection>('general');
  const [settingsDirty, setSettingsDirty] = useState(false), [leaving, setLeaving] = useState<{ page: Page; section?: SettingsSection } | null>(null), [leaveBusy, setLeaveBusy] = useState(false), [leaveError, setLeaveError] = useState<string | null>(null);
  const [runtime, setRuntime] = useState<UiRuntimeView | null>(null), [runtimeError, setRuntimeError] = useState<string | null>(null), [controlBusy, setControlBusy] = useState(false), [feedback, setFeedback] = useState<{ message: string; issues: string[] } | null>(null), [dropNotice, setDropNotice] = useState<string | null>(null);
  const [referenceIntent, setReferenceIntent] = useState<ReferenceIntent | null>(null);
  const chatRef = useRef(chat); chatRef.current = chat;
  const settingsSave = useRef<(() => Promise<void>) | null>(null), referenceLock = useRef(false), referenceWorking = useRef(false), runtimeEpoch = useRef(0), alive = useRef(true), navigateLatest = useRef<(next: Page, section?: SettingsSection) => void>(() => {});
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const refreshRuntime = useCallback(() => {
    const epoch = ++runtimeEpoch.current;
    void uiApi.runtime().then((value) => { if (alive.current && epoch === runtimeEpoch.current) { setRuntime(value); setRuntimeError(null); } }).catch((failure) => { if (alive.current && epoch === runtimeEpoch.current) setRuntimeError(errorDetail(failure)); });
  }, []);
  useEffect(() => { refreshRuntime(); const interval = window.setInterval(refreshRuntime, 15_000); return () => { window.clearInterval(interval); ++runtimeEpoch.current; }; }, [refreshRuntime]);
  useEffect(() => { refreshRuntime(); }, [chat.isRunning, refreshRuntime]);
  function navigate(next: Page, section?: SettingsSection) {
    setDropNotice(null);
    if (page === 'settings' && settingsDirty && next !== 'settings') { setLeaving({ page: next, section }); setLeaveError(null); return; }
    if (section) setSettingsSection(section);
    setPage(next);
  }
  navigateLatest.current = navigate;
  function completeNavigation(destination: { page: Page; section?: SettingsSection }) {
    setSettingsDirty(false); if (destination.section) setSettingsSection(destination.section); setPage(destination.page); setLeaving(null);
  }
  async function saveAndLeave() {
    if (!leaving || leaveBusy || !settingsSave.current) return;
    setLeaveBusy(true); setLeaveError(null);
    try { await settingsSave.current(); completeNavigation(leaving); }
    catch (failure) { setLeaveError(errorDetail(failure)); }
    finally { setLeaveBusy(false); }
  }
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
    <ConversationView chat={chat} hidden={page !== 'conversations'} dispatchBlocked={runtime?.control.stopped ?? false} controlUnconfirmed={!runtime || !!runtimeError} />
    {page === 'capture' && <CaptureSourcesPage />}
    {page === 'api-sources' && <ApiSourcesPage />}
    {page === 'database' && <DatabasePage onBringToConversation={bringToConversation} />}
    {page === 'tools' && <ToolsPage />}
    {page === 'settings' && <SettingsPage initialSection={settingsSection} onSectionChange={setSettingsSection} onDirtyChange={setSettingsDirty} onSaveAction={(action) => { settingsSave.current = action; }} />}
    {leaving && <Modal title={words('保存设置改动？', 'Save settings changes?')} onClose={() => setLeaving(null)} busy={leaveBusy}><p>{words('此页有尚未保存的改动。', 'This page has unsaved changes.')}</p>
      {leaveError && <ErrorNote detail={leaveError}>{words('保存失败，编辑内容已保留。', 'Save failed. Your edits are preserved.')}</ErrorNote>}
      <div className="dialog-actions"><button type="button" className="text-button" disabled={leaveBusy} onClick={() => setLeaving(null)}>{words('继续编辑', 'Keep editing')}</button><button type="button" className="text-button" disabled={leaveBusy} onClick={() => completeNavigation(leaving)}>{words('放弃修改', 'Discard changes')}</button><button type="button" className="primary-button" disabled={leaveBusy || !settingsSave.current} onClick={() => void saveAndLeave()}>{words('保存并离开', 'Save and leave')}</button></div>
    </Modal>}
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
    // 两窗口与焦点/恢复：先核资格，再允许私有渲染。
    const wake = () => {
      if (document.visibilityState !== 'visible') return;
      ++epoch.current;
      // 先卸下私有渲染；保留旧代次上下文直到本轮核对返回，避免在核对期间制造额外拒绝与重试。
      setView((value) => value.state === 'active' ? { state: 'checking' } : value);
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
  const deactivated = useCallback((record: LocalDataRecord) => {
    ++epoch.current;
    forgetLocalDataSession();
    setView({ state: 'blocked', dataId: record.dataId, record });
    try { new BroadcastChannel('mashiro.local-data-lifecycle').postMessage('changed'); } catch { /* 无广播能力时由其他窗口轮询。 */ }
    purgePrivateClientState();
  }, []);
  if (view.state === 'active') return <PreferencesProvider><Tooltip.Provider delayDuration={350}><DesignCanvas>
    <Application />
    <LocalDataControl dataId={view.dataId} record={view.record} onDeactivated={deactivated} onCheck={() => check(true)} />
  </DesignCanvas></Tooltip.Provider></PreferencesProvider>;
  return <LocalDataBlocked view={view} checking={checking} onCheck={() => check()} />;
}

function LocalDataBlocked({ view, checking, onCheck }: { view: Exclude<LifecycleView, { state: 'active' }>; checking: boolean; onCheck: () => Promise<void> }) {
  return <main style={{ maxWidth: 680, margin: '12vh auto', padding: '0 24px', fontFamily: 'system-ui, sans-serif', lineHeight: 1.7 }}>
    <h1 style={{ fontSize: 22 }}>当前本地资料未启用</h1>
    {view.state === 'checking' || view.state === 'unavailable'
      ? <p role="status">{view.state === 'checking' ? '正在核对当前本地资料资格…' : `资格尚未确认：${view.detail}`}</p>
      : <BlockedDetail record={view.record} dataId={view.dataId} onCheck={onCheck} />}
    <div style={{ display: 'flex', gap: 12, marginTop: 16 }}>
      <button type="button" disabled={checking} onClick={() => void onCheck()}>{checking ? '核对中…' : '重新核对资格'}</button>
    </div>
    <p style={{ color: '#666', fontSize: 13, marginTop: 24 }}>停用或解绑后不会自动重建资料、恢复会话或重发旧任务；外部结果与待核任务仍按原记录保留。</p>
    <details style={{ color: '#666', fontSize: 12, marginTop: 16 }}>
      <summary>技术详情</summary>
      {view.state === 'blocked' && <p>资料 {view.dataId}；记录 {view.record.status}；代次 {view.record.generation}；修订 {view.record.revision}。</p>}
      {view.state === 'unavailable' && <p>{view.detail}</p>}
    </details>
  </main>;
}

function BlockedDetail({ record, dataId, onCheck }: { record: LocalDataRecord; dataId: string; onCheck: () => Promise<void> }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);
  const operation = record.lastOperation;
  const unresolved = record.status === 'deactivating' || operation?.state === 'unresolved' || operation?.state === 'stopped';
  const canUnbind = record.status === 'inactive' && !record.reloadPending && (operation?.state === 'settled' || operation?.state === 'completed') && record.adopted;
  const canReload = !record.reloadPending && (
    ((record.status === 'inactive' || record.status === 'unbound') && (operation?.state === 'settled' || operation?.state === 'completed'))
    || (record.status === 'deactivating' && !!record.quiescence));
  async function run(action: 'verify' | 'unbind' | 'reload' | 'stop') {
    if (busy) return;
    setBusy(true); setDetail(null);
    try {
      if (action === 'verify' && operation) await verifyLocalData({ dataId, operationId: operation.operationId });
      else if (action === 'stop' && operation) await stopLocalData({ dataId, operationId: operation.operationId });
      else if (action === 'unbind') await unbindLocalData({ dataId, expectedGeneration: record.generation, reason });
      else if (action === 'reload') await reloadLocalData({ dataId, expectedGeneration: record.generation, reason });
      await onCheck();
    } catch (failure) {
      setDetail(errorDetail(failure));
      // 回执丢失时按 current/原 operation 核对，不自动生成新编号重复动作。
      await onCheck();
    }
    finally { setBusy(false); }
  }
  return <div>
    {record.reloadPending
      ? <p role="status">重新加载已保存，等待重启。重启后会先核对同一原资料身份，再以新代次加载；旧代次与原任务不会自动恢复。</p>
      : <p>当前资料{record.status === 'unbound' ? '已解除采用关系' : unresolved ? '停用尚未收束' : '已停用'}。{record.status === 'inactive' && !record.reloadPending ? '可保存待重启的重新加载请求。' : ''}</p>}
    {operation && <p>原操作：{operation.kind === 'deactivate' ? '停用' : '解绑'}；{operation.evidence ?? '尚无收束证据。'}</p>}
    {operation && operation.pendingTaskIds.length > 0 && <details><summary>待核任务 {operation.pendingTaskIds.length} 项</summary>
      <ul>{operation.pendingTaskIds.slice(0, 50).map((id) => <li key={id}>{id}</li>)}</ul></details>}
    {record.status === 'unbound' && <p role="status">已解除采用关系。可由受信入口保存重新加载请求；重启后先核对同一原资料身份，再以新代次重新采用。本页不会自动复活旧任务或内容。</p>}
    {unresolved && <div style={{ marginTop: 12 }}>
      <p>停用尚未确认收束。可由宿主重新查询真实任务与组件证据；客户端不能提交结论。</p>
      <button type="button" disabled={busy || !operation} onClick={() => void run('verify')}>{busy ? '核对中…' : '请求宿主重新核对'}</button>
      {operation?.state === 'settling' || operation?.state === 'pending'
        ? <button type="button" disabled={busy} onClick={() => void run('stop')}>{busy ? '处理中…' : '停止等待并保留未决'}</button> : null}
      {record.quiescence && <p role="status">宿主已确认执行器退出；仍有 {record.quiescence.pendingTaskIds.length} 项外部结果待核，可保留它们保存重新加载。</p>}
    </div>}
    {(canReload || canUnbind) && <div style={{ marginTop: 12, display: 'grid', gap: 8 }}>
      <p>{canReload ? (record.quiescence ? '保留上述待核项与证据，只保存待重启重新加载；不标结案、不重放旧任务。' : '重新加载只保存待重启请求；重启后核对同一原资料身份并以新代次加载或重新采用。') : '确认无未决任务与外部结果后，可解除采用关系；不会删除文件、凭据或数据库。'}</p>
      <input value={reason} onChange={(event) => setReason(event.target.value)} placeholder={canReload ? '重新加载原因' : '解绑原因'} style={{ padding: 8 }} />
      {canReload && <button type="button" disabled={busy || !reason.trim()} onClick={() => void run('reload')}>{busy ? '保存中…' : '保存待重启重新加载'}</button>}
      {canUnbind && <button type="button" disabled={busy || !reason.trim()} onClick={() => void run('unbind')}>{busy ? '处理中…' : '解除绑定'}</button>}
    </div>}
    {detail && <p role="alert" style={{ color: '#a33' }}>{detail}</p>}
    <details style={{ color: '#666', fontSize: 12, marginTop: 12 }}>
      <summary>技术详情</summary>
      <p>资料 {dataId}；状态 {record.status}；代次 {record.generation}；采用 {record.adopted ? '是' : '否'}；修订 {record.revision}。</p>
      {operation && <p>原操作 {operation.operationId}；{operation.state}；期望代次 {operation.expectedGeneration}；操作代次 {operation.generation}。</p>}
      {record.reloadPending && <p>重新加载 {record.reloadPending.operationId}；{record.reloadPending.state}；目标代次 {record.reloadPending.generation}。</p>}
    </details>
  </div>;
}

function LocalDataControl({ dataId, record, onDeactivated, onCheck }: { dataId: string; record: LocalDataRecord; onDeactivated: (record: LocalDataRecord) => void; onCheck: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);
  async function deactivate() {
    if (busy || !reason.trim()) return;
    setBusy(true); setDetail(null);
    try {
      const next = await deactivateLocalData({ dataId, expectedGeneration: record.generation, reason });
      // 停用回执一到即卸载私有页面，不再等待下一次资格轮询。
      onDeactivated(next);
    }
    catch (failure) {
      setDetail(errorDetail(failure));
      await onCheck();
    }
    finally { setBusy(false); }
  }
  return <div style={{ position: 'fixed', right: 18, bottom: 18, zIndex: 50, fontSize: 13 }}>
    {open && <section style={{ width: 320, background: '#fff', border: '1px solid #d8d8d8', borderRadius: 10, padding: 14, boxShadow: '0 8px 28px rgba(0,0,0,.14)', marginBottom: 8 }}>
      <strong>当前本地资料</strong>
      <p style={{ color: '#666', margin: '6px 0' }}>已启用</p>
      <p style={{ margin: '6px 0' }}>停用会先持久失效当前代次，再停止任务、模型运行与队列并关闭本应用浏览器/采集会话。文件、凭据与外部数据库不删除。</p>
      <input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="停用原因" style={{ width: '100%', boxSizing: 'border-box', padding: 8, marginBottom: 8 }} />
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button type="button" onClick={() => setOpen(false)} disabled={busy}>关闭</button>
        <button type="button" onClick={() => void deactivate()} disabled={busy || !reason.trim()}>{busy ? '停用中…' : '停用当前资料'}</button>
      </div>
      {detail && <p role="alert" style={{ color: '#a33' }}>{detail}</p>}
      <details style={{ color: '#666', fontSize: 12 }}><summary>技术详情</summary><p>资料 {dataId}；代次 {record.generation}；修订 {record.revision}。</p></details>
    </section>}
    <button type="button" onClick={() => setOpen(!open)} style={{ padding: '8px 12px', borderRadius: 999, border: '1px solid #d8d8d8', background: '#fff' }}>当前资料</button>
  </div>;
}

function purgePrivateClientState() {
  try {
    for (const key of Object.keys(localStorage)) if (key.startsWith('mashiro.')) localStorage.removeItem(key);
    for (const key of Object.keys(sessionStorage)) if (key.startsWith('mashiro.')) sessionStorage.removeItem(key);
  } catch { /* 浏览器拒绝清理时，已卸载的页面不再保留这些状态。 */ }
  void (typeof caches === 'undefined' ? Promise.resolve() : caches.keys().then((keys) => Promise.all(keys.map((key) => caches.delete(key)))).catch(() => {}));
}
