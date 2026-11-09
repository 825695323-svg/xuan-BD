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
import { TaskResults, TaskState, isObject, tasksForBranch, taskStateText } from './TaskResults';
import ProcessingPanel from './ProcessingPanel';
import { localDataGeneration, notifyLocalDataRevoked } from '../local-data-context';

function toMessage(message: ChatMessage): ThreadMessageLike {
  ((window as unknown as { __tm?: unknown[] }).__tm ??= []).push([message.id.slice(0, 8), (message.text || '').length, message.role, message.status]);
  return { id: message.id, role: message.role, createdAt: new Date(message.createdAt), content: [{ type: 'text', text: message.text }],
    ...(message.role === 'assistant' ? { status: message.status === 'running' ? { type: 'running' as const } : message.status === 'complete' ? { type: 'complete' as const, reason: 'stop' as const }
      : { type: 'incomplete' as const, reason: message.status === 'interrupted' ? 'cancelled' as const : 'error' as const } } : {}),
    metadata: { custom: { coreStatus: message.status, attachmentRefs: message.attachmentRefs ?? [], failureCode: message.failureCode ?? null, rawStopReason: message.rawStopReason ?? null,
      agentDisplayName: message.agentDisplayName ?? null } } };
}
function MessageText({ text }: TextMessagePartProps) { return <MarkdownText text={text} />; }

const EMPTY_STEPS: readonly TaskRecord[] = [];
/** 把模型提出的工具任务按创建时间归到最近一条助手消息，形成与模型步骤一致的时间线。 */
function tasksByAssistantMessage(messages: readonly ChatMessage[], tasks: readonly TaskRecord[]): Map<string, TaskRecord[]> {
  const assistants = messages.filter((item) => item.role === 'assistant')
    .map((item) => ({ id: item.id, at: Date.parse(item.createdAt) })).filter((item) => Number.isFinite(item.at));
  const map = new Map<string, TaskRecord[]>();
  const firstAssistant = assistants[0]?.id ?? null;
  for (const task of tasks) {
    if (task.runtimeId === 'pi' || !Number.isFinite(task.createdAt)) continue;
    // 任务晚于已加载的最后一条消息时归到最近一条；早于全部消息时归到首条，避免过程行整段丢失。
    let owner: string | null = firstAssistant;
    for (const assistant of assistants) if (assistant.at <= task.createdAt) owner = assistant.id;
    if (!owner) continue;
    const list = map.get(owner) ?? [];
    list.push(task);
    map.set(owner, list);
  }
  for (const list of map.values()) list.sort((a, b) => a.createdAt - b.createdAt || a.sequence - b.sequence);
  return map;
}
/** 只显示受控动作的短名称与参数摘要，完整回执仍留在任务记录里。 */
/** 组标题按整轮实际动作拼，和 DSH 的「执行了命令，修改了文件」一致。 */
function processTitle(actions: ReadonlySet<string> | undefined, words: (zh: string, en: string) => string): string {
  const list = actions ? [...actions] : [];
  const has = (prefix: string) => list.some((action) => action.startsWith(prefix));
  const parts: string[] = [];
  if (list.some((action) => ['baidu.drive', 'web.search', 'web.read_public', 'video.transcribe_url'].includes(action))) parts.push(words('执行了命令', 'Executed commands'));
  if (has('file.') || has('model.files.')) parts.push(words('读写文件', 'Read or wrote files'));
  if (has('conversion.') || has('material.') || has('data.') || has('image.')) parts.push(words('处理数据', 'Processed data'));
  if (!parts.length) parts.push(words('思考', 'Thinking'));
  return parts.join(words('，', ', '));
}
function stepLabel(task: TaskRecord): string {
  const title = task.title.replace(/^模型提出[:：]\s*/u, '');
  const args = isObject(task.args) ? Object.entries(task.args).filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`).join(' ') : '';
  const detail = args.length > 90 ? `${args.slice(0, 90)}…` : args;
  return detail ? `${title} · ${detail}` : title;
}
/** 思考行默认收起，标题只放首行摘要；正文点开才展开，和 DSH 的步骤行一致。 */
function thinkingSummary(text: string): string {
  const line = text.replace(/\s+/gu, ' ').trim();
  return line.length > 84 ? `${line.slice(0, 84)}…` : line;
}

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

function Message({ chat, steps = EMPTY_STEPS, expanded = false, onToggle, groupTitle }: {
  chat: Chat; steps?: readonly TaskRecord[]; expanded?: boolean; onToggle?: () => void; groupTitle?: string;
}) {
  const words = useWords();
  const message = useAuiState((state) => state.message);
  if (message.composer.isEditing) return <MessageEditor chat={chat} />;
  const user = message.role === 'user', status = message.metadata.custom.coreStatus;
  const state = chat.conversation;
  const source = state?.messages.find((item) => item.id === message.id), usage = source?.usage;
  const lastRun = state?.lastRun;
  const run = lastRun && source?.runId === lastRun.id ? lastRun : null;
  const bodyText = source?.text ?? message.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('');
  const empty = !bodyText.trim();
  const budgetReason = !user && status === 'error' && state?.status === 'ERROR' && run?.state === 'failed' && run.failureCode === 'budget'
    ? state.error?.trim() : null;
  const elapsed = run?.settledAt ? Math.max(0, (Date.parse(run.settledAt) - Date.parse(run.startedAt)) / 1000) : null;
  const metrics = [elapsed !== null && Number.isFinite(elapsed) ? words(`${elapsed.toFixed(1)} 秒`, `${elapsed.toFixed(1)} s`) : '',
    usage && !(status === 'error' && empty && usage.inputTokens === 0 && usage.outputTokens === 0)
      ? words(`输入 ${usage.inputTokens.toLocaleString()} · 输出 ${usage.outputTokens.toLocaleString()} 词元`, `${usage.inputTokens.toLocaleString()} input · ${usage.outputTokens.toLocaleString()} output tokens`) : ''].filter(Boolean).join(' · ');
  const lastAssistant = [...(chat.conversation?.messages ?? [])].reverse().find((item) => item.role === 'assistant')?.id === message.id;
  const history = chat.conversation?.messages ?? [];
  const index = history.findIndex((item) => item.id === message.id);
  const continued = index >= 0 && history.slice(index + 1).some((item) => item.role === 'assistant');
  const previous = index > 0 ? history[index - 1] : undefined;
  const runStart = !user && (!previous || previous.role === 'user' || previous.runId !== source?.runId);
  const thinking = source?.thinking?.trim() ? source.thinking.trim() : '';
  const hasProcess = !user && (!!thinking || steps.length > 0);
  const open = expanded || status === 'running';
  const showSteps = hasProcess && open;
  const showTitle = hasProcess && runStart;
  if (!user && empty && continued && !thinking && steps.length === 0) return null;
  const processOnly = !user && empty && hasProcess;
  return <MessagePrimitive.Root className={`message message--${user ? 'user' : 'assistant'}${processOnly ? ' message--process' : ''}`} data-running={status === 'running'}>

    {!user && status === 'running' && <span className="message-thinking">{words('生成中…', 'Generating…')}</span>}
    {hasProcess && <div className="message-process">
      {showTitle && <button type="button" className="message-process-title" aria-expanded={open} onClick={() => onToggle?.()}>
        <span className="message-process-chevron">{open ? '▾' : '▸'}</span>
        {groupTitle ?? words('执行了命令', 'Executed commands')}
      </button>}
      {showSteps && <div className="message-steps">
        {thinking && <details className="message-step message-step--thinking">
          <summary><span className="message-step-label">{words('思考', 'Thinking')}</span><span className="message-step-name">{thinkingSummary(thinking)}</span></summary>
          <p className="message-step-text">{thinking}</p>
        </details>}
        {steps.map((task) => <div className="message-step" key={task.id} data-state={task.status}>
          <span className="message-step-label">{words('运行命令', 'Command')}</span>
          <span className="message-step-name">{stepLabel(task)}</span>
          <span className={`message-step-state${task.status === 'failed' ? ' danger-text' : ''}`}>{taskStateText(task.status, words)}</span>
          {task.error?.message && <p className="message-step-detail">{task.error.message}</p>}
        </div>)}
      </div>}
    </div>}
    {(!empty || user) && <div className="message-body">{isConversationAttachmentRefs(message.metadata.custom.attachmentRefs) && <AttachmentList refs={message.metadata.custom.attachmentRefs} />}
      {empty ? <p className="waiting-response">{status === 'running' ? words('正在等待模型回应…', 'Waiting for the model…') : words('本轮没有输出正文。', 'This run produced no message text.')}</p> : <MessagePrimitive.Parts components={{ Text: MessageText }} />}
    </div>}
    {status === 'interrupted' && <p className="message-outcome">{words('本轮已停止', 'Run stopped')}</p>}{status === 'error' && <p className="message-outcome danger-text">{budgetReason || words('本轮未完成', 'Run incomplete')}</p>}
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

function Thread({ chat, tasks, scrollPositions, hidden }: { chat: Chat; tasks: TaskRecord[]; scrollPositions: Map<string, number>; hidden: boolean }) {
  const words = useWords(), state = chat.conversation!;
  const viewport = useRef<HTMLDivElement>(null), branch = useRef(state.branchId), [atBottom, setAtBottom] = useState(true);
  branch.current = state.branchId;
  const scrollKey = `${state.conversationId}:${state.branchId}`;
  const stepMap = useMemo(() => tasksByAssistantMessage(state.messages, tasks), [state.messages, tasks]);
  const [expandedRuns, setExpandedRuns] = useState<ReadonlySet<string>>(() => new Set<string>());
  const toggleRun = useCallback((runId: string) => {
    if (!runId) return;
    setExpandedRuns((previous) => {
      const next = new Set(previous);
      if (next.has(runId)) next.delete(runId); else next.add(runId);
      return next;
    });
  }, []);
  const runIdOf = useMemo(() => new Map(state.messages.map((message) => [message.id, message.runId ?? ''])), [state.messages]);
  const runActions = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const message of state.messages) {
      const list = stepMap.get(message.id);
      if (!list?.length || !message.runId) continue;
      const actions = map.get(message.runId) ?? new Set<string>();
      for (const task of list) actions.add(task.action);
      map.set(message.runId, actions);
    }
    return map;
  }, [state.messages, stepMap]);
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
        <ThreadPrimitive.Messages>{({ message }) => message.metadata.isOptimistic ? null : (() => {
          const runId = runIdOf.get(message.id) ?? '';
          return <Message chat={chat} steps={stepMap.get(message.id) ?? EMPTY_STEPS} expanded={!!runId && expandedRuns.has(runId)}
            onToggle={() => toggleRun(runId)} groupTitle={processTitle(runActions.get(runId), words)} />;
        })()}</ThreadPrimitive.Messages>
        <QuestionCards key={`questions:${scrollKey}`} chat={chat} />
        <TaskResults tasks={results} />
        <ProcessingPanel conversationId={state.conversationId} branchId={state.branchId} />
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

export default function ConversationView({ chat, hidden, dispatchBlocked, controlUnconfirmed, compact = false, tasks: sharedTasks }: { chat: Chat; hidden: boolean; dispatchBlocked: boolean; controlUnconfirmed: boolean; compact?: boolean; tasks?: TaskRecord[] }) {
  const words = useWords();
  // 应用层已订阅真实任务流时直接复用，避免同一会话开两条 SSE 和两份任务状态。
  const [ownTasks, setOwnTasks] = useState<TaskRecord[]>([]);
  const shared = sharedTasks !== undefined;
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
    void getTasks(id).then((value) => { if (resourceEpoch.current === epoch) setOwnTasks((current) => mergeTasks(current, { tasks: value }, id)); }).catch(() => {});
  }, [id]);
  useEffect(() => {
    if (shared) return;
    setOwnTasks([]); ++resourceEpoch.current;
    if (!id) return;
    const generation = localDataGeneration();
    if (generation === null) return;
    refreshResources(); let disposed = false;
    const source = new EventSource(`/api/tasks/events?conversationId=${encodeURIComponent(id)}&localDataGeneration=${generation}`);
    source.addEventListener('tasks', (event) => {
      if (disposed || localDataGeneration() !== generation) return;
      try { const update = readTaskUpdate((event as MessageEvent<string>).data); setOwnTasks((current) => mergeTasks(current, update, id)); } catch { refreshResources(); }
    });
    source.addEventListener('lifecycle', () => {
      if (disposed) return;
      notifyLocalDataRevoked('本地资料资格已停用。');
      source.close();
      setOwnTasks([]);
    });
    return () => { disposed = true; ++resourceEpoch.current; source.close(); };
  }, [id, refreshResources, shared]);
  const state = chat.conversation;
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
  // 工作台窄栏里由外部固定收起会话列表；页面主区域仍按容器宽度自动判断。
  const sidebarCollapsed = compact || (manualCollapsed ?? narrow);
  const dispatchReady = !dispatchBlocked && !controlUnconfirmed;
  const controlledChat = { ...chat, canSend: chat.canSend && dispatchReady, canRetrySend: chat.canRetrySend && dispatchReady, canQueue: chat.canQueue && dispatchReady,
    canSteer: chat.canSteer && dispatchReady, canSteerQueued: chat.canSteerQueued && dispatchReady, canInterrupt: chat.canInterrupt && dispatchReady,
    canCompact: chat.canCompact && dispatchReady, canChangeHistory: chat.canChangeHistory && dispatchReady };
  return <div ref={pageRef} className="conversation-page" data-sidebar-collapsed={sidebarCollapsed} hidden={hidden}>
    {sidebarCollapsed ? null : <ConversationList chat={chat} />}
    <div className="conversation-main">
      {sidebarCollapsed && !compact && <div className="conversation-toolbar">
        <IconButton label={words('展开会话列表', 'Show conversation list')} onClick={() => setManualCollapsed(false)}><MorphIcon name="panel-left-open" size={17} /></IconButton>
        <span className="conversation-toolbar-title">{words('会话', 'Conversations')}</span>
      </div>}
      {(chat.issue || chat.storageFrozen || chat.connection !== 'connected' || (chat.health && !chat.health.configured && chat.health.backend !== 'demo')) && <div className="conversation-notices">
        {chat.storageFrozen && <ErrorNote detail={state?.storageError}>{words('存储暂时不可用，提交已暂停，输入仍保留在本页。', 'Storage is unavailable. Submission is paused and your input remains in this window.')}</ErrorNote>}
        {chat.issue && <div className="dismissible-notice"><ErrorNote detail={chat.issue.detail}>{words('操作尚未确认，草稿与原记录已保留。', 'The action is unconfirmed. Drafts and original records are preserved.')}</ErrorNote><IconButton label={words('关闭提示', 'Dismiss notice')} onClick={chat.dismissIssue}><X size={16} /></IconButton></div>}
        {reconnectHint && <p className="reconnect-hint" role="status">{words('重连中…', 'Reconnecting…')}</p>}
        {chat.health && !chat.health.configured && chat.health.backend !== 'demo' && <p className="connection-notice">{words('模型尚未配置，可以先保存草稿。', 'The model is not configured. You can save a draft.')}</p>}
      </div>}
      {state ? <Thread key={state.conversationId} chat={controlledChat} tasks={sharedTasks ?? ownTasks} scrollPositions={scrollPositions.current} hidden={hidden} />
        : <div className="conversation-loading" role="status"><BrandAsset kind="xuan" size={32} /><p>{chat.selectedId || chat.newPending ? words('正在读取会话…', 'Loading conversation…') : words('说点什么，或拖入文件…', 'Send a message or drop files…')}</p>{!chat.selectedId && !chat.listLoading && <button type="button" className="text-button" disabled={chat.newPending} onClick={() => void chat.newConversation()}>{words('新建会话', 'New conversation')}</button>}</div>}
      {chat.readOnly && state && <div className="read-only-bar"><p>{state.visibility === 'archived' ? words('此会话已归档。', 'This conversation is archived.') : words('此会话位于最近删除。', 'This conversation is in Recently deleted.')}</p><button type="button" className="text-button" disabled={chat.managementPending} onClick={() => void chat.changeVisibility(state.conversationId, 'active').catch(() => {})}>{words('恢复并继续会话', 'Restore and continue')}</button></div>}
      <PendingApprovals />
      <Composer chat={controlledChat} hidden={chat.readOnly} dispatchBlocked={dispatchBlocked} controlUnconfirmed={controlUnconfirmed} />
    </div>
  </div>;
}
