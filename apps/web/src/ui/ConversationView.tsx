import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, Check, ChevronLeft, ChevronRight, Copy, Pencil, RotateCcw, X } from 'lucide-react';
import { ActionBarPrimitive, AssistantRuntimeProvider, BranchPickerPrimitive, ExportedMessageRepository, MessagePrimitive, ThreadPrimitive,
  useAui, useAuiState, useExternalStoreRuntime, type TextMessagePartProps, type ThreadMessage, type ThreadMessageLike } from '@assistant-ui/react';
import type { ChatMessage } from '../../../../contracts/contracts';
import type { TaskRecord } from '../../../../contracts/task-contracts';
import { getTasks, mergeTasks, readTaskUpdate } from '../platform-api';
import { request } from '../api';
import { isConversationAttachmentRefs } from '../api';
import ConversationList, { type Chat } from './ConversationList';
import { MorphIcon } from './MorphIcon';
import Composer, { AttachmentList } from './Composer';
import BrandAsset from './BrandAsset';
import MarkdownText from './MarkdownText';
import QuestionCards from './QuestionCards';
import { ControlTooltip, ErrorNote, IconButton, errorDetail, useWords } from './Controls';
import { CandidateTaskResults, ConversationTaskResults, TaskResults, TaskState, isObject, tasksForBranch } from './TaskResults';
import ProcessingPanel from './ProcessingPanel';
import { dataBrowserApi, type CandidateView } from '../data-browser-api';
import { localDataGeneration, notifyLocalDataRevoked } from '../local-data-context';

function toMessage(message: ChatMessage): ThreadMessageLike {
  return { id: message.id, role: message.role, createdAt: new Date(message.createdAt), content: [{ type: 'text', text: message.text }],
    ...(message.role === 'assistant' ? { status: message.status === 'running' ? { type: 'running' as const } : message.status === 'complete' ? { type: 'complete' as const, reason: 'stop' as const }
      : { type: 'incomplete' as const, reason: message.status === 'interrupted' ? 'cancelled' as const : 'error' as const } } : {}),
    metadata: { custom: { coreStatus: message.status, attachmentRefs: message.attachmentRefs ?? [], failureCode: message.failureCode ?? null, rawStopReason: message.rawStopReason ?? null,
      agentDisplayName: message.agentDisplayName ?? null } } };
}
function MessageText({ text }: TextMessagePartProps) { return <MarkdownText text={text} />; }

function MessageEditor({ chat }: { chat: Chat }) {
  const words = useWords(), aui = useAui();
  const id = useAuiState((state) => state.message.id), source = useAuiState((state) => state.message.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n'));
  const draft = chat.getEditDraft(id), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  useEffect(() => { void chat.loadEditDraft(id, source).catch((failure) => setError(errorDetail(failure))); }, [id, source, chat.loadEditDraft]);
  async function submit() {
    if (busy || !draft || !draft.text.trim() || draft.conflict || !chat.canChangeHistory) return;
    setBusy(true); setError(null);
    try { await chat.edit(id, draft.text); aui.composer.cancel(); }
    catch (failure) { setError(errorDetail(failure)); }
    finally { setBusy(false); }
  }
  return <MessagePrimitive.Root className="message-editor"><form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
    <textarea autoFocus aria-label={words('编辑消息', 'Edit message')} rows={3} value={draft?.text ?? source} disabled={!draft || busy || chat.readOnly} onChange={(event) => chat.setEditDraftText(id, event.currentTarget.value)} onBlur={() => chat.saveEditDraft(id)} />
    <AttachmentList refs={draft?.attachmentRefs ?? []} onRemove={(ref) => chat.removeEditDraftAttachment(id, ref)} disabled={busy || !chat.canChangeHistory} draft />
    <div className="edit-toolbar"><span>{words('保留原历史，发送到新分支', 'Keep history and send on a new branch')}</span><button type="button" className="text-button" disabled={busy} onClick={() => aui.composer.cancel()}>{words('取消', 'Cancel')}</button>
      <button type="submit" className="primary-button" disabled={busy || !draft || !draft.text.trim() || !!draft.conflict || !chat.canChangeHistory}>{words('保存并发送', 'Save and send')}</button></div>
    {draft?.conflict && <div className="draft-conflict" role="alert"><p>{words('编辑草稿存在新版本，当前内容已保留。', 'The edit draft has a newer version. Your current content is preserved.')}</p><div><button type="button" className="text-button" onClick={() => chat.resolveEditDraftConflict(id, 'local')}>{words('保留当前输入', 'Keep current input')}</button><button type="button" className="text-button" onClick={() => chat.resolveEditDraftConflict(id, 'saved')}>{words('载入已保存版本', 'Load saved version')}</button></div></div>}
    {(error || draft?.error) && <ErrorNote detail={error || draft?.error}>{words('编辑尚未确认，内容已保留。', 'The edit is unconfirmed. Your content is preserved.')}</ErrorNote>}
  </form></MessagePrimitive.Root>;
}

function Message({ chat }: { chat: Chat }) {
  const words = useWords();
  const message = useAuiState((state) => state.message);
  if (message.composer.isEditing) return <MessageEditor chat={chat} />;
  const user = message.role === 'user', status = message.metadata.custom.coreStatus;
  const source = chat.conversation?.messages.find((item) => item.id === message.id), usage = source?.usage;
  const run = source?.runId === chat.conversation?.lastRun?.id ? chat.conversation?.lastRun : null;
  const elapsed = run?.settledAt ? Math.max(0, (Date.parse(run.settledAt) - Date.parse(run.startedAt)) / 1000) : null;
  const metrics = [elapsed !== null && Number.isFinite(elapsed) ? words(`${elapsed.toFixed(1)} 秒`, `${elapsed.toFixed(1)} s`) : '',
    usage ? words(`输入 ${usage.inputTokens.toLocaleString()} · 输出 ${usage.outputTokens.toLocaleString()} 词元`, `${usage.inputTokens.toLocaleString()} input · ${usage.outputTokens.toLocaleString()} output tokens`) : ''].filter(Boolean).join(' · ');
  const empty = !message.content.some((part) => part.type === 'text' && part.text.trim());
  const lastAssistant = [...(chat.conversation?.messages ?? [])].reverse().find((item) => item.role === 'assistant')?.id === message.id;
  const history = chat.conversation?.messages ?? [];
  const index = history.findIndex((item) => item.id === message.id);
  const continued = index >= 0 && history.slice(index + 1).some((item) => item.role === 'assistant');
  // 空片段后面还有续写时，不单独成卡，避免同一轮被拆成多张输出卡片。
  if (!user && empty && continued) return null;
  return <MessagePrimitive.Root className={`message message--${user ? 'user' : 'assistant'}`} data-running={status === 'running'}>

    {!user && status === 'running' && <span className="message-thinking">{words('生成中…', 'Generating…')}</span>}
    {!user && source?.thinking && <details className="message-reasoning"><summary>{words('思考过程', 'Thinking')}</summary><p>{source.thinking}</p></details>}
    <div className="message-body">{isConversationAttachmentRefs(message.metadata.custom.attachmentRefs) && <AttachmentList refs={message.metadata.custom.attachmentRefs} />}
      {empty ? <p className="waiting-response">{status === 'running' ? words('正在等待模型回应…', 'Waiting for the model…') : words('本轮没有输出正文。', 'This run produced no message text.')}</p> : <MessagePrimitive.Parts components={{ Text: MessageText }} />}
    </div>
    {status === 'interrupted' && <p className="message-outcome">{words('本轮已停止', 'Run stopped')}</p>}{status === 'error' && <p className="message-outcome danger-text">{words('本轮未完成', 'Run incomplete')}</p>}
    {!user && lastAssistant && metrics && <p className="message-metrics">{metrics}</p>}
    <div className="message-controls">
      {!chat.conversation?.history && <BranchPickerPrimitive.Root className="branch-picker" hideWhenSingleBranch><ControlTooltip label={words('上一个分支', 'Previous branch')}><BranchPickerPrimitive.Previous aria-label={words('上一个分支', 'Previous branch')} disabled={!chat.canBranch}><ChevronLeft size={14} /></BranchPickerPrimitive.Previous></ControlTooltip><span><BranchPickerPrimitive.Number /> / <BranchPickerPrimitive.Count /></span><ControlTooltip label={words('下一个分支', 'Next branch')}><BranchPickerPrimitive.Next aria-label={words('下一个分支', 'Next branch')} disabled={!chat.canBranch}><ChevronRight size={14} /></BranchPickerPrimitive.Next></ControlTooltip></BranchPickerPrimitive.Root>}
      <ActionBarPrimitive.Root className="message-actions"><ControlTooltip label={words('复制消息', 'Copy message')}><ActionBarPrimitive.Copy className="icon-button" aria-label={words('复制消息', 'Copy message')}><Copy size={15} /></ActionBarPrimitive.Copy></ControlTooltip>
        {user ? <ControlTooltip label={words('编辑并重新发送', 'Edit and resend')}><ActionBarPrimitive.Edit className="icon-button" aria-label={words('编辑并重新发送', 'Edit and resend')} disabled={!chat.canChangeHistory}><Pencil size={15} /></ActionBarPrimitive.Edit></ControlTooltip>
          : <ControlTooltip label={words('按原配置重试本轮', 'Retry with original configuration')}><button type="button" className="icon-button" aria-label={words('按原配置重试本轮', 'Retry with original configuration')} disabled={!chat.canChangeHistory} onClick={() => void chat.retry(message.id).catch(() => {})}><RotateCcw size={15} /></button></ControlTooltip>}
      </ActionBarPrimitive.Root>
    </div>
  </MessagePrimitive.Root>;
}

function Thread({ chat, tasks, scrollPositions, hidden, linkedCandidates, candidateAvailability, candidateReason }: { chat: Chat; tasks: TaskRecord[]; scrollPositions: Map<string, number>; hidden: boolean;
  linkedCandidates: CandidateView[]; candidateAvailability: 'available' | 'unavailable' | 'loading'; candidateReason: string | null }) {
  const words = useWords(), state = chat.conversation!;
  const viewport = useRef<HTMLDivElement>(null), branch = useRef(state.branchId), [atBottom, setAtBottom] = useState(true);
  branch.current = state.branchId;
  const scrollKey = `${state.conversationId}:${state.branchId}`;
  const repository = useMemo(() => {
    const ids = new Set(state.messageTree.map((message) => message.id));
    return ExportedMessageRepository.fromBranchableArray(state.messageTree.map((message) => ({ message: toMessage(message), parentId: state.history && message.parentId && !ids.has(message.parentId) ? null : message.parentId })), { headId: state.headId });
  }, [state.messageTree, state.headId, !!state.history, chat.treeReset]);
  const runtime = useExternalStoreRuntime<ThreadMessage>({ messageRepository: repository, isRunning: chat.isRunning, isSendDisabled: !chat.canSend || chat.isRunning, unstable_persistsHistory: true,
    onNew: async (message) => { if (chat.isRunning) throw new Error(words('本轮结束后才能发送。', 'Wait for the current run to finish before sending.')); await chat.send(undefined, message.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n')); },
    onEdit: async (message) => { if (!message.sourceId) throw new Error(words('无法识别原消息。', 'The source message could not be identified.')); await chat.edit(message.sourceId, message.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n')); },
    onReload: async (_parentId, config) => { if (config.sourceId) await chat.retry(config.sourceId); }, onCancel: chat.stop, setMessages: () => {}, unstable_onBranchChange: ({ headId }) => { if (headId) void chat.branch(headId).catch(() => {}); },
  });
  useEffect(() => { const node = viewport.current; if (!node) return; const saved = scrollPositions.get(scrollKey); if (saved !== undefined) requestAnimationFrame(() => { if (node.isConnected) node.scrollTop = saved; }); return () => { scrollPositions.set(scrollKey, node.scrollTop); }; }, [scrollKey, scrollPositions]);
  useEffect(() => { if (hidden) return; const node = viewport.current, saved = scrollPositions.get(scrollKey); if (node && saved !== undefined) requestAnimationFrame(() => { if (node.isConnected) node.scrollTop = saved; }); }, [hidden, scrollKey, scrollPositions]);
  async function older() {
    const node = viewport.current; if (!node || chat.historyLoading) return;
    const height = node.scrollHeight, top = node.scrollTop, expected = state.branchId;
    await chat.loadMoreHistory(); requestAnimationFrame(() => { if (node.isConnected && viewport.current === node && branch.current === expected) node.scrollTop = top + node.scrollHeight - height; });
  }
  const results = tasksForBranch(tasks, state.conversationId, state.branchId);
  const activeTasks = tasks.filter((task) => task.conversationId === state.conversationId && task.runtimeId !== 'pi' && ['ready', 'running', 'waiting_approval', 'pausing', 'cancelling', 'blocked', 'needs_review'].includes(task.status));
  const hasTaskActivity = !!activeTasks.length || !!results.length || tasks.some((task) => task.conversationId === state.conversationId && task.runtimeId !== 'pi' && !(isObject(task.result?.data) && task.result.data.kind === 'conversation-material'));
  return <AssistantRuntimeProvider runtime={runtime}><ThreadPrimitive.Root className="chat-thread" aria-label={words('当前会话', 'Current conversation')}>
    <ThreadPrimitive.Viewport ref={viewport} className="thread-viewport" autoScroll scrollToBottomOnInitialize={!scrollPositions.has(scrollKey)} scrollToBottomOnThreadSwitch={false} scrollToBottomOnRunStart={false}
      onScroll={(event) => { if (hidden) return; const node = event.currentTarget; const bottom = node.scrollHeight - node.scrollTop - node.clientHeight < 70; setAtBottom(bottom); scrollPositions.set(scrollKey, node.scrollTop); }}>
      <div className="message-list">
        {state.history?.hasMore && <div className="history-load"><button type="button" className="text-button" disabled={chat.historyLoading} onClick={() => void older()}>{chat.historyLoading ? words('读取中…', 'Loading…') : words('读取较早消息', 'Load earlier messages')}</button></div>}
        {chat.historyError && <ErrorNote detail={chat.historyError}>{words('较早消息暂时无法读取。', 'Earlier messages could not be loaded.')}</ErrorNote>}
        {!state.messages.length && <div className="conversation-empty"><BrandAsset kind="xuan" size={32} /><p>{words('说点什么，或拖入文件…', 'Send a message or drop files…')}</p></div>}
        <ThreadPrimitive.Messages>{({ message }) => message.metadata.isOptimistic ? null : <Message chat={chat} />}</ThreadPrimitive.Messages>
        <QuestionCards key={`questions:${scrollKey}`} chat={chat} />
        <TaskResults tasks={results} />
        <ConversationTaskResults tasks={tasks} conversationId={state.conversationId} />
        <ProcessingPanel conversationId={state.conversationId} branchId={state.branchId} />
        <CandidateTaskResults items={linkedCandidates} availability={candidateAvailability} reason={candidateReason} />
      </div>
    </ThreadPrimitive.Viewport>
    {!atBottom && <IconButton label={words('跳至最新消息', 'Jump to latest message')} className="jump-to-latest" onClick={() => { viewport.current?.scrollTo({ top: viewport.current.scrollHeight, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); }}><ArrowDown size={17} /></IconButton>}
  </ThreadPrimitive.Root></AssistantRuntimeProvider>;
}

function PendingApprovals() {
  const words = useWords();
  const [items, setItems] = useState<{ id: string; title: string }[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const list = await request('/api/approvals') as { id: string }[];
      const detailed = await Promise.all(list.slice(0, 4).map(async (item) => {
        try {
          const detail = await request(`/api/approvals/${encodeURIComponent(item.id)}`) as { task?: { title?: string }; operation?: { operationId?: string } };
          return { id: item.id, title: detail.task?.title ?? detail.operation?.operationId ?? item.id };
        } catch { return { id: item.id, title: item.id }; }
      }));
      setItems(detailed); setError(null);
    } catch (failure) { setError(errorDetail(failure)); }
  }, []);
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 10_000); return () => window.clearInterval(timer); }, [load]);
  if (!items.length) return error ? <ErrorNote detail={error}>{words('授权状态暂时无法读取。', 'Authorization status could not be read.')}</ErrorNote> : null;
  const decide = async (id: string, decision: 'approve' | 'deny') => {
    setBusy(id);
    try { await request(`/api/approvals/${encodeURIComponent(id)}`, 'POST', { decision }); await load(); }
    catch (failure) { setError(errorDetail(failure)); }
    finally { setBusy(null); }
  };
  return <div className="approval-strip" role="status">
    {items.map((item) => <div className="approval-row" key={item.id}>
      <span className="approval-title">{item.title}</span>
      <span className="approval-state">{words('等待授权', 'Awaiting authorization')}</span>
      <span className="approval-actions">
        <button type="button" className="text-button" disabled={busy === item.id} onClick={() => void decide(item.id, 'deny')}>{words('拒绝', 'Deny')}</button>
        <button type="button" className="primary-button" disabled={busy === item.id} onClick={() => void decide(item.id, 'approve')}>{words('批准', 'Approve')}</button>
      </span>
    </div>)}
    {error && <p className="approval-error">{error}</p>}
  </div>;
}

export default function ConversationView({ chat, hidden, dispatchBlocked, controlUnconfirmed }: { chat: Chat; hidden: boolean; dispatchBlocked: boolean; controlUnconfirmed: boolean }) {
  const words = useWords();
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [linkedCandidates, setLinkedCandidates] = useState<CandidateView[]>([]);
  const [candidateAvailability, setCandidateAvailability] = useState<'available' | 'unavailable' | 'loading'>('loading');
  const [candidateReason, setCandidateReason] = useState<string | null>(null);
  // 断线静默重连：只有持续 10 秒仍未连上才提示一行淡字。
  const [reconnectHint, setReconnectHint] = useState(false);
  useEffect(() => {
    if (chat.connection === 'connected') { setReconnectHint(false); return; }
    const timer = setTimeout(() => setReconnectHint(true), 10_000);
    return () => clearTimeout(timer);
  }, [chat.connection]);
  const resourceEpoch = useRef(0), scrollPositions = useRef(new Map<string, number>());
  const id = chat.conversation?.conversationId;
  const refreshResources = useCallback(() => {
    if (!id) return;
    const epoch = ++resourceEpoch.current;
    void getTasks(id).then((value) => { if (resourceEpoch.current === epoch) setTasks((current) => mergeTasks(current, { tasks: value }, id)); }).catch(() => {});
  }, [id]);
  useEffect(() => {
    setTasks([]); ++resourceEpoch.current;
    if (!id) return;
    const generation = localDataGeneration();
    if (generation === null) return;
    refreshResources(); let disposed = false;
    const source = new EventSource(`/api/tasks/events?conversationId=${encodeURIComponent(id)}&localDataGeneration=${generation}`);
    source.addEventListener('tasks', (event) => {
      if (disposed || localDataGeneration() !== generation) return;
      try { const update = readTaskUpdate((event as MessageEvent<string>).data); setTasks((current) => mergeTasks(current, update, id)); } catch { refreshResources(); }
    });
    source.addEventListener('lifecycle', () => {
      if (disposed) return;
      notifyLocalDataRevoked('本地资料资格已停用。');
      source.close();
      setTasks([]);
    });
    return () => { disposed = true; ++resourceEpoch.current; source.close(); };
  }, [id, refreshResources]);
  const state = chat.conversation;
  useEffect(() => {
    const conversationId = state?.conversationId, branchId = state?.branchId;
    if (!conversationId || !branchId) { setLinkedCandidates([]); setCandidateAvailability('available'); setCandidateReason(null); return; }
    let alive = true, timer = 0;
    const load = () => { void dataBrowserApi.conversationCandidates(conversationId, branchId).then(value => {
      if (!alive) return; setLinkedCandidates(value.items); setCandidateAvailability(value.availability); setCandidateReason(value.reason);
    }).catch((failure) => { if (alive) { setLinkedCandidates([]); setCandidateAvailability('unavailable'); setCandidateReason(errorDetail(failure)); } }); };
    load(); timer = window.setInterval(load, 6_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [state?.conversationId, state?.branchId]);
  const [manualCollapsed, setManualCollapsed] = useState<boolean | null>(null);
  const [narrow, setNarrow] = useState(false);
  const pageRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = pageRef.current;
    if (!node) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      setNarrow(width < 820);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const sidebarCollapsed = manualCollapsed ?? narrow;
  const dispatchReady = !dispatchBlocked && !controlUnconfirmed;
  const controlledChat = { ...chat, canSend: chat.canSend && dispatchReady, canRetrySend: chat.canRetrySend && dispatchReady, canQueue: chat.canQueue && dispatchReady,
    canSteer: chat.canSteer && dispatchReady, canSteerQueued: chat.canSteerQueued && dispatchReady, canInterrupt: chat.canInterrupt && dispatchReady,
    canCompact: chat.canCompact && dispatchReady, canChangeHistory: chat.canChangeHistory && dispatchReady };
  return <div ref={pageRef} className="conversation-page" data-sidebar-collapsed={sidebarCollapsed} hidden={hidden}>
    {sidebarCollapsed ? null : <ConversationList chat={chat} />}
    <div className="conversation-main">
      {sidebarCollapsed && <div className="conversation-toolbar">
        <IconButton label={words('展开会话列表', 'Show conversation list')} onClick={() => setManualCollapsed(false)}><MorphIcon name="panel-left-open" size={17} /></IconButton>
        <span className="conversation-toolbar-title">{words('会话', 'Conversations')}</span>
      </div>}
      {(chat.issue || chat.storageFrozen || chat.connection !== 'connected' || (chat.health && !chat.health.configured && chat.health.backend !== 'demo')) && <div className="conversation-notices">
        {chat.storageFrozen && <ErrorNote detail={state?.storageError}>{words('存储暂时不可用，提交已暂停，输入仍保留在本页。', 'Storage is unavailable. Submission is paused and your input remains in this window.')}</ErrorNote>}
        {chat.issue && <div className="dismissible-notice"><ErrorNote detail={chat.issue.detail}>{words('操作尚未确认，草稿与原记录已保留。', 'The action is unconfirmed. Drafts and original records are preserved.')}</ErrorNote><IconButton label={words('关闭提示', 'Dismiss notice')} onClick={chat.dismissIssue}><X size={16} /></IconButton></div>}
        {reconnectHint && <p className="reconnect-hint" role="status">{words('重连中…', 'Reconnecting…')}</p>}
        {chat.health && !chat.health.configured && chat.health.backend !== 'demo' && <p className="connection-notice">{words('模型尚未配置，可以先保存草稿。', 'The model is not configured. You can save a draft.')}</p>}
      </div>}
      {state ? <Thread key={state.conversationId} chat={controlledChat} tasks={tasks} scrollPositions={scrollPositions.current} hidden={hidden} linkedCandidates={linkedCandidates} candidateAvailability={candidateAvailability} candidateReason={candidateReason} />
        : <div className="conversation-loading" role="status"><BrandAsset kind="xuan" size={32} /><p>{chat.selectedId || chat.newPending ? words('正在读取会话…', 'Loading conversation…') : words('说点什么，或拖入文件…', 'Send a message or drop files…')}</p>{!chat.selectedId && !chat.listLoading && <button type="button" className="text-button" disabled={chat.newPending} onClick={() => void chat.newConversation()}>{words('新建会话', 'New conversation')}</button>}</div>}
      {chat.readOnly && state && <div className="read-only-bar"><p>{state.visibility === 'archived' ? words('此会话已归档。', 'This conversation is archived.') : words('此会话位于最近删除。', 'This conversation is in Recently deleted.')}</p><button type="button" className="text-button" disabled={chat.managementPending} onClick={() => void chat.changeVisibility(state.conversationId, 'active').catch(() => {})}>{words('恢复并继续会话', 'Restore and continue')}</button></div>}
      <PendingApprovals />
      <Composer chat={controlledChat} hidden={chat.readOnly} dispatchBlocked={dispatchBlocked} controlUnconfirmed={controlUnconfirmed} />
    </div>
  </div>;
}
