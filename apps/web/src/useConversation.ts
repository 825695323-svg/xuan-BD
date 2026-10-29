import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { ChatMessage, ConversationAttachmentRef, ConversationDisplayMetadataUpdate, ConversationPlugin, ConversationState, ConversationSummary, ConversationVisibility, DraftState, FreezeSendRequestInput, HealthResponse, SendReceipt, SendRequestView, ThinkingLevel } from '../../../contracts/contracts';
import * as api from './api';
import { Drafts, draftContentSignature } from './drafts';
import { forgetSend, readRememberedSends, rememberSend } from './send-recovery';
import { uploadFile } from './platform-api';
import { localDataGeneration, notifyLocalDataRevoked } from './local-data-context';

export type ConnectionPhase = 'connecting' | 'connected' | 'reconnecting';
export interface ActionIssue { title: string; detail: string }
export interface ConversationAttachmentTarget { conversationId: string; branchId: string }
export class AttachmentUploadError extends Error {
  constructor(readonly failures: Array<{ file: File; message: string; unconfirmed: boolean }>, readonly accepted: ConversationAttachmentRef[]) {
    super(failures.map(item => `${item.file.name}: ${item.message}`).join('\n'));
    this.name = 'AttachmentUploadError';
  }
}
const selectionKey = 'mashiro.selected-conversation';
const selectionKeyFor = (pluginId: ConversationPlugin, view: ConversationVisibility) =>
  `${selectionKey}.${pluginId}${view === 'active' ? '' : `.${view}`}`;
const legacySelectionKeyFor = (view: ConversationVisibility) => view === 'active' ? selectionKey : `${selectionKey}.${view}`;
const detailOf = (error: unknown) => error instanceof Error ? error.message : '本机服务暂时无法完成请求。';
const mayHaveCommitted = (error: unknown) => error instanceof api.RequestError
  && (error.status === null || error.status >= 500 || (error.status >= 200 && error.status < 300));
interface FailedCommand { requestId: string; treeRevision: number; saved?: DraftState; scope: string; branchId: string }

function readingPath(messages: ChatMessage[], headId: string | null): ChatMessage[] {
  const byId = new Map(messages.map((message) => [message.id, message])), path: ChatMessage[] = [], seen = new Set<string>();
  let id = headId;
  while (id && !seen.has(id)) {
    const message = byId.get(id);
    if (!message) break;
    seen.add(id); path.push(message); id = message.parentId;
  }
  return path.reverse();
}
function mergeReadingWindow(current: ConversationState | undefined, incoming: ConversationState): ConversationState {
  if (!incoming.history || !current?.history || current.branchId !== incoming.branchId) return incoming;
  const messages = readingPath([...current.messages, ...incoming.messages], incoming.headId);
  const retainCursor = messages[0]?.id === current.messages[0]?.id;
  const history = { ...incoming.history, before: retainCursor ? current.history.before : incoming.history.before,
    hasMore: retainCursor ? current.history.hasMore : incoming.history.hasMore };
  return { ...incoming, messages, messageTree: messages, history };
}

// App keeps one instance per plugin mounted, including each plugin's draft buffer.
export function useConversation(pluginId: ConversationPlugin = 'pi') {
  const [conversation, setConversation] = useState<ConversationState | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversationView, setView] = useState<ConversationVisibility>('active');
  const [searchQuery, setQuery] = useState('');
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [managingId, setManagingId] = useState<string | null>(null);
  const [managementError, setManagementError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [connection, setConnection] = useState<ConnectionPhase>('connecting');
  const [issue, setIssue] = useState<ActionIssue | null>(null);
  const [newPending, setNewPending] = useState(false);
  const [sendRequests, setSendRequests] = useState<SendRequestView[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [treeReset, resetTree] = useReducer((value: number) => value + 1, 0);
  const [version, rerender] = useReducer((value: number) => value + 1, 0);
  const selectedRef = useRef<string | null>(null);
  const selectionEpoch = useRef(0);
  const viewRef = useRef<ConversationVisibility>('active');
  const queryRef = useRef('');
  const listRef = useRef<ConversationSummary[]>([]);
  const listEpoch = useRef(0);
  const listInFlight = useRef<number | null>(null);
  const managementLock = useRef(false);
  const creating = useRef(false);
  const cache = useRef(new Map<string, ConversationState>());
  const connectionRef = useRef(connection);
  const healthRef = useRef(health);
  const healthErrorRef = useRef(healthError);
  const epoch = useRef(0);
  const historyEpoch = useRef(0);
  const historyRequest = useRef<number | null>(null);
  const pending = useRef(new Set<string>());
  const stopping = useRef(new Set<string>());
  const attachmentUploads = useRef(new Set<string>());
  const sendRequestsRef = useRef<SendRequestView[]>([]);
  const sendRequestsEpoch = useRef(0);
  const forkRequests = useRef(new Map<string, string>());
  const queueRequests = useRef(new Map<string, { requestId: string; expectedRunId?: string }>());
  const failedCommands = useRef(new Map<string, FailedCommand>());
  const draftOwners = useRef(new Map<string, string>());
  const editLoads = useRef(new Map<string, Promise<void>>());
  const [drafts] = useState(() => new Drafts((scope, draft) => api.saveDraft(
    draftOwners.current.get(scope) ?? scope, draft), rerender));
  const mainScope = (id: string, branchId = cache.current.get(id)?.branchId) => JSON.stringify([id, branchId, 'main']);
  const editScope = (id: string, messageId: string, branchId = cache.current.get(id)?.branchId) => JSON.stringify([id, branchId, 'edit', messageId]);

  const report = useCallback((id: string | null, title: string, error: unknown) => {
    if (id === selectedRef.current) setIssue({ title, detail: detailOf(error) });
  }, []);
  const changeConnection = useCallback((next: ConnectionPhase) => {
    connectionRef.current = next;
    setConnection(next);
  }, []);
  const applySnapshot = useCallback((incoming: ConversationState, reset = false) => {
    if (incoming.pluginId !== pluginId) throw new api.RequestError('会话不属于当前插件，请重新选择。');
    const current = cache.current.get(incoming.conversationId);
    if (current && (incoming.sequence < current.sequence || (!reset && incoming.sequence === current.sequence))) return;
    const next = mergeReadingWindow(current, incoming);
    cache.current.set(incoming.conversationId, next);
    const scope = mainScope(incoming.conversationId, incoming.branchId);
    draftOwners.current.set(scope, incoming.conversationId);
    drafts.receive(scope, incoming.draft, reset);
    if (selectedRef.current === incoming.conversationId) {
      if (current?.branchId !== incoming.branchId) {
        ++historyEpoch.current; historyRequest.current = null; setHistoryLoading(false); setHistoryError(null);
      }
      setConversation(next);
    }
  }, [drafts, pluginId]);
  const draftWritable = useCallback((scope: string) => {
    const owner = draftOwners.current.get(scope) ?? scope;
    const state = cache.current.get(owner);
    return state?.pluginId === pluginId && !state.storageError && state.visibility !== 'archived' && state.visibility !== 'trashed'
      && !pending.current.has(owner);
  }, [pluginId]);
  /**
   * 服务端只列出待核/明确未受理项；本页另按冻结时记下的编号查一次已受理事实。
   * 查询失败时返回 blocked，调用方不得为同一输入另生成请求编号。
   */
  const loadSendRequests = useCallback(async (id: string) => {
    const epoch = ++sendRequestsEpoch.current;
    let blocked = false, listError: string | null = null, list: SendRequestView[] = [];
    try { list = await api.getSendRequests(id); }
    catch (error) { listError = detailOf(error); }
    const map = new Map(list.map((request) => [request.requestId, request]));
    for (const entry of readRememberedSends(id)) {
      if (map.has(entry.requestId)) continue;
      try {
        const request = await api.getSendRequest(id, entry.requestId);
        if (request.state === 'accepted' || request.state === 'abandoned') { forgetSend(id, entry.requestId); continue; }
        map.set(request.requestId, request);
      } catch (error) {
        if (error instanceof api.RequestError && error.status === 404) forgetSend(id, entry.requestId);
        else blocked = true;
      }
    }
    if (epoch !== sendRequestsEpoch.current || selectedRef.current !== id) return { blocked, listError };
    const requests = [...map.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    sendRequestsRef.current = requests;
    setSendRequests(requests);
    return { blocked, listError };
  }, []);
  const pageChangesConfirmed = useCallback(() => !pending.current.size && !failedCommands.current.size && !editLoads.current.size
    && !managementLock.current && !creating.current && ![...draftOwners.current.keys()].some((scope) => {
      const value = drafts.get(scope);
      // A saved snapshot can confirm the content even if an older HTTP receipt was lost.
      return value && (value.dirty || value.saving || value.conflict);
    }), [drafts]);
  const selectConversation = useCallback((id: string | null) => {
    if (id && cache.current.get(id)?.pluginId !== pluginId
      && !listRef.current.some((item) => item.conversationId === id && item.pluginId === pluginId)) {
      setIssue({ title: '会话暂未切换。', detail: '会话不属于当前插件，请从当前会话列表选择。' });
      return;
    }
    if (selectedRef.current === id) return;
    const previous = selectedRef.current;
    if (previous) {
      const scope = mainScope(previous);
      if (!managementLock.current && drafts.get(scope)?.dirty && draftWritable(scope)) void drafts.persist(scope).catch(() => {});
    }
    ++epoch.current;
    ++selectionEpoch.current;
    ++sendRequestsEpoch.current;
    ++historyEpoch.current; historyRequest.current = null; setHistoryLoading(false); setHistoryError(null);
    sendRequestsRef.current = []; setSendRequests([]);
    selectedRef.current = id;
    setSelectedId(id);
    setConversation(id ? cache.current.get(id) ?? null : null);
    setIssue(null);
    changeConnection('connecting');
    if (id) {
      try {
        localStorage.setItem(selectionKeyFor(pluginId, viewRef.current), id);
        if (pluginId === 'pi') localStorage.removeItem(legacySelectionKeyFor(viewRef.current));
      }
      catch { /* Selection is only a browser preference. */ }
      void loadSendRequests(id).catch(() => {});
    }
  }, [changeConnection, drafts, draftWritable, loadSendRequests, pluginId]);

  const refreshList = useCallback(async () => {
    const requestView = viewRef.current, requestQuery = queryRef.current;
    const selectionOwner = selectionEpoch.current;
    const owner = ++listEpoch.current;
    listInFlight.current = owner; setListLoading(true);
    try {
      const list = await api.getConversations({ pluginId, view: requestView, q: requestQuery });
      if (owner !== listEpoch.current || requestView !== viewRef.current || requestQuery !== queryRef.current) return list;
      listRef.current = list; setConversations(list); setListError(null);
      const selected = selectedRef.current;
      const current = selected ? cache.current.get(selected) : undefined;
      if (selectionOwner === selectionEpoch.current && !creating.current
        && (!selected || (current && current.visibility !== requestView) || (!requestQuery.trim() && !list.some((item) => item.conversationId === selected)))) {
        let stored: string | null = null;
        try {
          stored = localStorage.getItem(selectionKeyFor(pluginId, requestView));
          if (!stored && pluginId === 'pi') stored = localStorage.getItem(legacySelectionKeyFor(requestView));
        }
        catch { /* Browser preferences do not own the conversation. */ }
        selectConversation(list.find((item) => item.conversationId === stored)?.conversationId ?? list[0]?.conversationId ?? null);
      }
      return list;
    } catch (error) {
      if (owner === listEpoch.current) setListError(detailOf(error));
      throw error;
    } finally {
      if (listInFlight.current === owner) listInFlight.current = null;
      if (owner === listEpoch.current) setListLoading(false);
    }
  }, [pluginId, selectConversation]);

  const setConversationView = useCallback((view: ConversationVisibility) => {
    if (managementLock.current || creating.current || viewRef.current === view) return;
    viewRef.current = view; setView(view); ++listEpoch.current;
    listRef.current = []; setConversations([]); setListError(null); setManagementError(null); setListLoading(true);
    selectConversation(null);
  }, [selectConversation]);
  const setSearchQuery = useCallback((query: string) => {
    if (managementLock.current || creating.current) return;
    queryRef.current = query.slice(0, 240); setQuery(queryRef.current); ++listEpoch.current; setListLoading(true);
  }, []);

  useEffect(() => {
    let disposed = false;
    async function refreshHealth() {
      try {
        const next = await api.getHealth();
        if (disposed) return;
        healthRef.current = next;
        healthErrorRef.current = null;
        setHealth(next);
        setHealthError(null);
      } catch (error) {
        if (disposed) return;
        healthErrorRef.current = detailOf(error);
        setHealthError(detailOf(error));
      }
    }
    void refreshHealth();
    const healthTimer = setInterval(refreshHealth, 30_000);
    return () => { disposed = true; clearInterval(healthTimer); };
  }, []);
  useEffect(() => {
    const first = setTimeout(() => { void refreshList().catch(() => {}); }, searchQuery ? 250 : 0);
    const timer = setInterval(() => { if (listInFlight.current === null) void refreshList().catch(() => {}); }, 4_000);
    return () => { clearTimeout(first); clearInterval(timer); ++listEpoch.current; };
  }, [conversationView, searchQuery, refreshList]);
  useEffect(() => {
    if (!selectedId) return;
    const refresh = () => { if (selectedRef.current === selectedId) void loadSendRequests(selectedId).catch(() => {}); };
    const timer = setInterval(refresh, 15_000);
    window.addEventListener('focus', refresh);
    return () => { clearInterval(timer); window.removeEventListener('focus', refresh); ++sendRequestsEpoch.current; };
  }, [selectedId, loadSendRequests]);

  useEffect(() => {
    if (!selectedId) return;
    let disposed = false;
    let stream: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let listTimer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    let received = false;
    const owner = ++epoch.current;
    const current = () => !disposed && owner === epoch.current && selectedRef.current === selectedId;
    function connect() {
      if (!current()) return;
      const generation = localDataGeneration();
      const source = new EventSource(`/api/events?conversationId=${encodeURIComponent(selectedId!)}&historyLimit=${api.historyPageSize}`
        + (generation === null ? '' : `&localDataGeneration=${generation}`));
      stream = source;
      const reconnect = () => {
        if (!current() || stream !== source) return;
        source.close();
        stream = null;
        changeConnection('reconnecting');
        retryTimer = setTimeout(connect, Math.min(8_000, 1_200 * 2 ** attempts++));
      };
      source.addEventListener('state', (event) => {
        if (!current() || stream !== source) return;
        try {
          const envelope = api.readStateEnvelope((event as MessageEvent<string>).data);
          if (envelope.state.conversationId !== selectedId || envelope.state.pluginId !== pluginId) throw new Error('会话来源不一致。');
          applySnapshot(envelope.state, !envelope.event);
          received = true;
          attempts = 0;
          changeConnection('connected');
          if (!listTimer) listTimer = setTimeout(() => {
            listTimer = null;
            if (current()) void refreshList().catch(() => {});
          }, 600);
        } catch { reconnect(); }
      });
      source.addEventListener('lifecycle', () => {
        notifyLocalDataRevoked('本地资料资格已停用。');
        source.close();
        stream = null;
        changeConnection('reconnecting');
      });
      source.onerror = reconnect;
    }
    void api.getConversation(selectedId, pluginId).then((state) => {
      if (current() && !received) applySnapshot(state);
    }).catch((error) => { if (current()) report(selectedId, '会话暂未加载。', error); });
    connect();
    return () => {
      disposed = true;
      stream?.close();
      if (retryTimer) clearTimeout(retryTimer);
      if (listTimer) clearTimeout(listTimer);
    };
  }, [selectedId, applySnapshot, changeConnection, refreshList, report, pluginId]);

  useEffect(() => {
    const timer = setTimeout(() => { if (!managementLock.current) drafts.flush(draftWritable); }, 250);
    return () => clearTimeout(timer);
  }, [selectedId, drafts, version, draftWritable, conversation?.storageError]);
  useEffect(() => {
    const flush = () => { if (!managementLock.current) drafts.flush(draftWritable); };
    const hidden = () => { if (document.visibilityState === 'hidden') flush(); };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', hidden);
      flush();
    };
  }, [drafts, draftWritable]);

  const getActive = useCallback((requireModel = true) => {
    if (requireModel && pluginId !== 'pi') throw new Error('当前插件使用本机直接执行，不能发起模型操作。');
    const id = selectedRef.current;
    const state = id ? cache.current.get(id) : undefined;
    const configuration = healthRef.current;
    if (!state || state.pluginId !== pluginId || state.visibility !== 'active' || managementLock.current || state.storageError || connectionRef.current !== 'connected' || pending.current.has(state.conversationId)
      || (requireModel && (!configuration || healthErrorRef.current
        || (configuration.backend !== 'demo' && !configuration.configured)))) {
      setIssue({ title: '操作暂未提交。', detail: '会话暂时无法执行操作，请等待连接和配置恢复。' });
      resetTree();
      throw new Error('会话暂时无法执行操作，请等待连接和配置恢复。');
    }
    return state;
  }, [pluginId]);
  const captureAttachmentTarget = useCallback((): ConversationAttachmentTarget => {
    const state = getActive(false);
    return { conversationId: state.conversationId, branchId: state.branchId };
  }, [getActive]);
  const uploadAttachments = useCallback(async (selected: File[], target: ConversationAttachmentTarget) => {
    const id = target.conversationId, state = cache.current.get(id), scope = mainScope(id, target.branchId);
    if (pluginId !== 'pi' || !state || state.pluginId !== 'pi' || state.visibility !== 'active' || state.storageError
      || managementLock.current || pending.current.has(id) || !drafts.get(scope)) throw new Error('原会话草稿暂时无法接收附件，请先核对状态。');
    if (!selected.length) return [];
    if (drafts.get(scope)!.attachmentRefs.length + selected.length > 32) throw new Error('每份草稿最多附加 32 个原件，请分次提交。');
    pending.current.add(id); attachmentUploads.current.add(id); rerender(); setIssue(null);
    const accepted: ConversationAttachmentRef[] = [], failures: AttachmentUploadError['failures'] = [];
    try {
      for (const file of selected) {
        let received = false;
        try {
          const reference = await uploadFile(id, file), draft = drafts.get(scope);
          received = true;
          if (!draft) throw new Error('原件已接收，但原草稿关联暂不可用，请在该会话的文件列表核对。');
          const attachment: ConversationAttachmentRef = { fileRefId: reference.id, version: reference.version, category: 'unclassified', displayName: reference.displayName };
          drafts.setAttachments(scope, [...draft.attachmentRefs.filter((ref) => ref.fileRefId !== reference.id), attachment]);
          accepted.push(attachment);
          await drafts.persist(scope);
        } catch (error) {
          failures.push({ file, message: detailOf(error), unconfirmed: received || mayHaveCommitted(error) });
        }
      }
      if (failures.length) throw new AttachmentUploadError(failures, accepted);
      return accepted;
    } catch (error) { report(id, '附件接收或草稿关联暂未确认。', error); throw error; }
    finally { pending.current.delete(id); attachmentUploads.current.delete(id); rerender(); }
  }, [drafts, report, pluginId]);
  const addDraftAttachments = useCallback(async (refs: ConversationAttachmentRef[]) => {
    const state = getActive(false), id = state.conversationId, scope = mainScope(id, state.branchId), draft = drafts.get(scope);
    if (pluginId !== 'pi' || !draft || !api.isConversationAttachmentRefs(refs)) throw new Error('请选择已有的有效原件引用。');
    const unique = new Map([...draft.attachmentRefs, ...refs].map(ref => [ref.fileRefId, ref]));
    if (unique.size > 32) throw new Error('每份草稿最多附加 32 个原件。');
    pending.current.add(id); attachmentUploads.current.add(id); rerender();
    try {
      const bound = await api.bindDraftReferences(id, state.branchId, refs);
      const current = drafts.get(scope);
      if (!current) throw new Error('引用已核对，但原草稿已变化，请回到原会话查看。');
      drafts.setAttachments(scope, [...new Map([...current.attachmentRefs, ...bound].map(ref => [ref.fileRefId, ref])).values()]);
      await drafts.persist(scope);
    } catch (error) { report(id, '原件引用暂未加入草稿。', error); throw error; }
    finally { pending.current.delete(id); attachmentUploads.current.delete(id); rerender(); }
  }, [drafts, getActive, pluginId, report]);
  const loadEditDraft = useCallback(async (messageId: string, sourceText: string) => {
    if (pluginId !== 'pi') throw new Error('当前插件不能编辑并重新执行历史消息。');
    const id = selectedRef.current;
    if (!id) return;
    const branchId = cache.current.get(id)?.branchId;
    const scope = editScope(id, messageId, branchId);
    if (drafts.get(scope)) return;
    if (editLoads.current.has(scope)) return editLoads.current.get(scope);
    draftOwners.current.set(scope, id);
    const task = api.getDraft(id, messageId, branchId).then((saved) => {
      drafts.receive(scope, saved);
      if (saved.revision === 0 && !saved.text) drafts.edit(scope, sourceText);
    }).finally(() => { editLoads.current.delete(scope); });
    editLoads.current.set(scope, task);
    return task;
  }, [drafts, pluginId]);
  const reconcile = useCallback(async (id: string) => {
    try { applySnapshot(await api.getConversation(id, pluginId)); }
    catch { /* The acknowledged command remains owned by Core; SSE will reconcile it. */ }
    void refreshList().catch(() => {});
  }, [applySnapshot, refreshList, pluginId]);
  const setThinkingLevel = useCallback(async (level: ThinkingLevel) => {
    if (pluginId !== 'pi') throw new Error('本机直接执行不使用模型思考档位。');
    const state = getActive(false), id = state.conversationId;
    if (!state.thinking?.supportedLevels.includes(level)) throw new Error('当前模型不支持所选择的思考档位。');
    pending.current.add(id); rerender(); setIssue(null);
    try { applySnapshot(await api.setThinkingLevel(id, level)); }
    catch (error) { await reconcile(id); report(id, '思考档位暂未确认保存。', error); throw error; }
    finally { pending.current.delete(id); rerender(); }
  }, [applySnapshot, getActive, reconcile, report, pluginId]);

  const loadMoreHistory = useCallback(async () => {
    const id = selectedRef.current, state = id ? cache.current.get(id) : undefined;
    if (!id || !state?.history?.hasMore || !state.history.before || historyRequest.current !== null) return;
    const owner = ++historyEpoch.current, before = state.history.before, branchId = state.branchId;
    historyRequest.current = owner; setHistoryLoading(true); setHistoryError(null);
    try {
      const page = await api.getHistoryPage(id, branchId, before), current = cache.current.get(id);
      if (owner !== historyEpoch.current || selectedRef.current !== id || current?.branchId !== branchId || current.history?.before !== before) return;
      if (page.messages.length && page.messages.at(-1)?.id !== current.messages[0]?.parentId) throw new Error('历史窗口已变化，请重新同步后再读取较早消息。');
      const messages = readingPath([...page.messages, ...current.messages], current.headId);
      const next: ConversationState = { ...current, messages, messageTree: messages,
        history: { ...current.history, before: page.before, hasMore: page.hasMore } };
      cache.current.set(id, next); setConversation(next);
    } catch (error) {
      if (owner === historyEpoch.current && selectedRef.current === id) setHistoryError(detailOf(error));
    } finally {
      if (historyRequest.current === owner) { historyRequest.current = null; setHistoryLoading(false); }
    }
  }, []);

  const send = useCallback(async (mode?: 'queue' | 'steer' | 'interrupt', suppliedText?: string) => {
    if (pluginId !== 'pi' && mode) throw new Error('本机直接执行暂不支持引导或打断后发送。');
    const state = getActive(pluginId === 'pi');
    const id = state.conversationId;
    const scope = mainScope(id, state.branchId);
    const capture = drafts.capture(scope);
    if (suppliedText !== undefined && suppliedText !== capture.text) throw new Error('输入已发生变化，请从当前输入框发送。');
    if (!capture.text.trim()) {
      if (capture.attachmentRefs.length) { const error = new Error('请补一句希望如何处理这些原件，再发送。'); report(id, '还需要一句处理需求。', error); throw error; }
      return;
    }
    const signature = draftContentSignature(capture);
    pending.current.add(id);
    rerender();
    setIssue(null);
    let saved: DraftState | undefined;
    let request: SendRequestView | undefined;
    let requestId: string = crypto.randomUUID();
    try {
      const { blocked, listError } = await loadSendRequests(id);
      // 恢复列表失败时，服务端可能还有本页不知道的旧请求；无本地记忆也不能换新编号。
      if (blocked || listError) {
        const error = new Error(listError
          ? '原发送请求列表暂时无法读取，不能为这条输入另建请求编号；请恢复连接后重试核对。'
          : '原发送请求的受理事实尚未核清，暂不能为这条输入另建请求；请恢复连接后重试核对。');
        report(id, '原发送请求待核。', error);
        throw error;
      }
      // 只续接本页记住的原编号；同正文的其他待核请求是另一个请求身份，不能按内容合并。
      const rememberedIds = new Set(readRememberedSends(id).map((entry) => entry.requestId));
      const existing = sendRequestsRef.current.find((item) => item.branchId === state.branchId
        && rememberedIds.has(item.requestId)
        && (item.state === 'frozen' || item.state === 'rejected' || item.state === 'unknown')
        && draftContentSignature(item) === signature);
      if (existing?.state === 'unknown') {
        const error = new Error('原发送请求没有可核对的命令或任务，受理事实待核；不能换号重发。');
        report(id, '原发送请求待核。', error);
        throw error;
      }
      request = existing;
      requestId = existing?.requestId ?? requestId;
      const selectedMode = existing?.mode ?? mode ?? 'send';
      if (!existing && selectedMode === 'send' && (state.status === 'RUNNING' || state.status === 'STOPPING')) throw new Error('当前回复尚未结束，请选择排队、引导或打断后发送。');
      if (!existing && selectedMode === 'steer' && (state.status !== 'RUNNING' || state.lastRun?.kind === 'compaction')) throw new Error('只有正在回复的会话可以接收引导。');
      const expectedRunId = existing?.expectedRunId
        ?? (selectedMode === 'interrupt' || selectedMode === 'steer' ? state.activeRunId ?? undefined : undefined);
      // A retry of an unconfirmed command keeps its complete original identity.
      saved = await drafts.persist(scope, capture);
      if (!request) {
        rememberSend(id, requestId, state.branchId);
        const input: FreezeSendRequestInput = { requestId, branchId: state.branchId, mode: selectedMode, text: capture.text,
          attachmentRefs: capture.attachmentRefs, draft: saved, ...(expectedRunId ? { expectedRunId } : {}) };
        request = await api.freezeSendRequest(id, input);
        if (request.requestId !== requestId) forgetSend(id, requestId);
        requestId = request.requestId;
      }
      rememberSend(id, requestId, request.branchId);
      drafts.beginSubmission(scope, capture, saved);
      const receipt = selectedMode === 'interrupt'
        ? await api.interruptAndSend(id, capture.text, requestId, saved, expectedRunId, saved.attachmentRefs ?? capture.attachmentRefs)
        : await api.postMessage(id, capture.text, requestId, selectedMode, saved, saved.attachmentRefs ?? capture.attachmentRefs);
      if (receipt.status === 'failed' || receipt.status === 'cancelled') throw new Error('输入未被执行，请查看队列状态。');
      forgetSend(id, requestId);
      await reconcile(id);
      // 只在本轮草稿修订仍与冻结修订一致时退休；较新的草稿修订由服务端保持，旧回执不清空。
      const retirementExpected = !!saved && saved.revision === request.draft.revision
        && draftContentSignature(saved) === draftContentSignature(request);
      drafts.settleSubmission(scope, capture, true, retirementExpected);
      await loadSendRequests(id).catch(() => {});
    } catch (error) {
      let recovered: SendRequestView | null = null;
      let lookupFailed = false;
      if (request || saved) {
        try { recovered = await api.getSendRequest(id, requestId); }
        catch (lookupError) {
          if (lookupError instanceof api.RequestError && lookupError.status === 404) forgetSend(id, requestId);
          else lookupFailed = true;
        }
      }
      if (recovered?.state === 'accepted') {
        forgetSend(id, requestId);
        await reconcile(id);
        const retirementExpected = !!saved && !!request && saved.revision === request.draft.revision
          && draftContentSignature(saved) === draftContentSignature(request);
        drafts.settleSubmission(scope, capture, true, retirementExpected);
        await loadSendRequests(id).catch(() => {});
        return;
      }
      drafts.settleSubmission(scope, capture, false);
      await loadSendRequests(id).catch(() => {});
      report(id, lookupFailed || recovered?.state === 'unknown' ? '原发送请求受理事实待核。' : '请求暂未确认，输入已保留。', error);
      throw error;
    } finally { pending.current.delete(id); rerender(); }
  }, [drafts, getActive, loadSendRequests, reconcile, report, pluginId]);

  /** 按原请求编号查询受理事实；已受理回到原命令/任务，不新建同义请求。 */
  const checkSendRequest = useCallback(async (requestId: string) => {
    const id = selectedRef.current;
    if (!id) return null;
    try {
      const request = await api.getSendRequest(id, requestId);
      if (request.state === 'accepted' || request.state === 'abandoned') forgetSend(id, requestId);
      if (request.state === 'accepted') await reconcile(id);
      await loadSendRequests(id).catch(() => {});
      if (request.state === 'unknown') report(id, '原发送请求待核。', new Error(request.error ?? '原请求没有可核对的命令或任务。'));
      return request;
    } catch (error) {
      report(id, '原发送请求暂未核对。', error);
      throw error;
    }
  }, [loadSendRequests, reconcile, report]);
  /** 未受理或明确拒绝的原请求按原编号、原正文和原分支继续；不能借新编号重发。 */
  const retrySendRequest = useCallback(async (requestId: string) => {
    const id = selectedRef.current, state = id ? cache.current.get(id) : undefined;
    const request = sendRequestsRef.current.find((item) => item.requestId === requestId);
    if (!id || !state || !request) throw new Error('原发送请求已不在当前会话列表。');
    if (request.state === 'accepted') return checkSendRequest(requestId);
    if (request.state === 'unknown' || request.state === 'abandoned') throw new Error('原发送请求当前不能继续发送。');
    if (request.branchId !== state.branchId) throw new Error('原发送请求属于其他分支，请先回到原分支再继续。');
    const scope = mainScope(id, request.branchId), entry = drafts.get(scope);
    const capture = entry && entry.generation === 0 && entry.server.revision === request.draft.revision
      && draftContentSignature(entry) === draftContentSignature(request) ? drafts.capture(scope) : null;
    pending.current.add(id); rerender(); setIssue(null);
    try {
      const saved = { key: request.draft.key, revision: request.draft.revision };
      if (capture && entry) drafts.beginSubmission(scope, capture, entry.server);
      const receipt = request.mode === 'interrupt'
        ? await api.interruptAndSend(id, request.text, requestId, saved, request.expectedRunId ?? undefined, request.attachmentRefs)
        : await api.postMessage(id, request.text, requestId, request.mode, saved, request.attachmentRefs);
      if (receipt.status === 'failed' || receipt.status === 'cancelled') throw new Error('原请求未被执行，请查看队列状态。');
      forgetSend(id, requestId);
      await reconcile(id);
      if (capture) drafts.settleSubmission(scope, capture, true, true);
      await loadSendRequests(id).catch(() => {});
    } catch (error) {
      let recovered: SendRequestView | null = null;
      try { recovered = await api.getSendRequest(id, requestId); } catch { /* 保留原请求编号，等下一次核对。 */ }
      if (recovered?.state === 'accepted') {
        forgetSend(id, requestId); await reconcile(id);
        if (capture) drafts.settleSubmission(scope, capture, true, true);
        await loadSendRequests(id).catch(() => {});
        return;
      }
      if (capture) drafts.settleSubmission(scope, capture, false);
      await loadSendRequests(id).catch(() => {});
      report(id, '按原请求继续暂未确认。', error);
      throw error;
    } finally { pending.current.delete(id); rerender(); }
  }, [checkSendRequest, drafts, loadSendRequests, reconcile, report]);
  const abandonSendRequest = useCallback(async (requestId: string) => {
    const id = selectedRef.current;
    if (!id) return;
    pending.current.add(id); rerender(); setIssue(null);
    try {
      await api.abandonSendRequest(id, requestId);
      forgetSend(id, requestId);
      await loadSendRequests(id).catch(() => {});
    } catch (error) {
      report(id, '原发送请求暂未放弃。', error);
      throw error;
    } finally { pending.current.delete(id); rerender(); }
  }, [loadSendRequests, report]);

  const mutateHistory = useCallback(async (kind: 'edit' | 'retry', messageId: string, text?: string) => {
    const state = getActive();
    if (state.status === 'RUNNING' || state.status === 'STOPPING') throw new Error('请等待当前输出结束后再修改历史。');
    const id = state.conversationId;
    const signature = JSON.stringify([id, kind, messageId, text, kind === 'edit' ? drafts.get(editScope(id, messageId, state.branchId))?.attachmentRefs ?? [] : null]);
    const previous = failedCommands.current.get(signature);
    const requestId = previous?.requestId ?? crypto.randomUUID();
    const branchId = previous?.branchId ?? state.branchId;
    const treeRevision = previous?.treeRevision ?? state.treeRevision;
    const scope = previous?.scope ?? editScope(id, messageId, branchId);
    const capture = kind === 'edit' ? drafts.capture(scope) : null;
    if (capture && capture.text !== text) throw new Error('编辑草稿已变化，请从当前编辑框发送。');
    pending.current.add(id);
    rerender();
    setIssue(null);
    let saved: DraftState | undefined;
    try {
      saved = previous?.saved ?? (capture ? await drafts.persist(scope, capture) : undefined);
      if (capture && saved) drafts.beginSubmission(scope, capture, saved);
      const receipt: SendReceipt = kind === 'edit'
        ? await api.editMessage(id, messageId, text ?? '', requestId, treeRevision, saved, saved?.attachmentRefs ?? capture?.attachmentRefs)
        : await api.retryMessage(id, messageId, requestId, treeRevision);
      if (receipt.status === 'failed' || receipt.status === 'cancelled') throw new Error('请求未被执行。');
      failedCommands.current.delete(signature);
      if (capture) {
        try { drafts.receive(scope, await api.getDraft(id, messageId, branchId)); } catch { /* Receipt has acknowledged the edit. */ }
        drafts.settleSubmission(scope, capture, true);
      }
      await reconcile(id);
    } catch (error) {
      if (capture) drafts.settleSubmission(scope, capture, false);
      if (mayHaveCommitted(error)) failedCommands.current.set(signature, { requestId, treeRevision, saved, scope, branchId });
      else failedCommands.current.delete(signature);
      await reconcile(id);
      resetTree();
      report(id, kind === 'edit' ? '编辑暂未确认，编辑内容已保留。' : '重试暂未确认。', error);
      throw error;
    } finally { pending.current.delete(id); rerender(); }
  }, [getActive, reconcile, report, drafts]);
  const branch = useCallback(async (headId: string) => {
    if (pluginId !== 'pi') throw new Error('当前插件不能切换模型历史分支。');
    const state = getActive(false);
    const id = state.conversationId;
    if (state.status === 'RUNNING' || state.status === 'STOPPING'
      || (!state.branches.some((branch) => branch.headId === headId)
        && (!state.messageTree.some((message) => message.id === headId) || state.messageTree.some((message) => message.parentId === headId)))) {
      resetTree();
      throw new Error('此时无法切换分支。');
    }
    pending.current.add(id);
    rerender();
    try { applySnapshot(await api.switchBranch(id, headId, state.treeRevision)); }
    catch (error) { await reconcile(id); resetTree(); report(id, '分支切换暂未完成。', error); throw error; }
    finally { pending.current.delete(id); rerender(); }
  }, [getActive, applySnapshot, reconcile, report, pluginId]);
  const canForkConversation = useCallback((id: string) => {
    const saved = cache.current.get(id), item = listRef.current.find((item) => item.conversationId === id);
    const target = saved && (!item || saved.sequence >= item.sequence) ? saved : item;
    return pluginId === 'pi' && target?.pluginId === pluginId && target.visibility === 'active'
      && target.status !== 'RUNNING' && target.status !== 'STOPPING' && !saved?.storageError
      && connectionRef.current === 'connected' && !managementLock.current && !creating.current
      && !pending.current.size && !stopping.current.size && !sendRequestsRef.current.length && !failedCommands.current.size
      && ('headId' in target ? !!target.headId : target.messageCount > 0);
  }, [pluginId]);
  const forkConversation = useCallback(async (id: string) => {
    if (!canForkConversation(id)) {
      const error = new Error('此时无法操作分支，请等待会话空闲并确认连接。');
      setManagementError(error.message); queryRef.current = ''; setQuery(''); ++listEpoch.current;
      await refreshList().catch(() => {}); throw error;
    }
    const selectionOwner = selectionEpoch.current, previous = selectedRef.current;
    managementLock.current = true; setManagingId(id); setManagementError(null);
    try {
      await Promise.all(editLoads.current.values());
      // 保存菜单目标和离开会话的原草稿；每份草稿仍使用原会话、原分支的键。
      for (const [scope, owner] of draftOwners.current) {
        const draft = drafts.get(scope);
        if ((owner === id || owner === previous) && draft && (draft.dirty || draft.saving || draft.conflict)) {
          if (!draftWritable(scope)) throw new Error('原草稿暂时无法保存，请先核对会话状态。');
          await drafts.persist(scope);
        }
      }
      const current = await api.getConversation(id, pluginId);
      applySnapshot(current);
      if (current.visibility !== 'active' || current.storageError || current.status === 'RUNNING' || current.status === 'STOPPING') throw new Error('此时无法操作分支，请等待会话空闲。');
      if (!current.headId) throw new Error('发送消息后才能新建分支。');
      const signature = JSON.stringify([id, current.treeRevision]);
      const storageKey = `mashiro.fork-request.${pluginId}.${id}.${current.treeRevision}`;
      let remembered = forkRequests.current.get(signature);
      try { remembered ??= sessionStorage.getItem(storageKey) ?? undefined; } catch { /* 当前页仍保留原请求身份。 */ }
      const requestId = remembered ?? crypto.randomUUID();
      forkRequests.current.set(signature, requestId);
      try { sessionStorage.setItem(storageKey, requestId); } catch { /* 浏览器不可保存偏好时，继续使用当前页映射。 */ }
      const updated = await api.forkConversation(id, current.treeRevision, requestId);
      if (updated.conversationId === id || updated.pluginId !== pluginId) throw new api.RequestError('新会话的返回结果不一致，请重新核对会话列表。', 200);
      forkRequests.current.delete(signature);
      try { sessionStorage.removeItem(storageKey); } catch { /* 已确认结果以服务端记录为准。 */ }
      applySnapshot(updated);
      if (selectionOwner === selectionEpoch.current) {
        viewRef.current = 'active'; setView('active'); queryRef.current = ''; setQuery(''); ++listEpoch.current;
        listRef.current = []; setConversations([]); selectConversation(updated.conversationId);
      }
      await refreshList().catch(() => {});
      return updated;
    } catch (error) {
      setManagementError(detailOf(error));
      queryRef.current = ''; setQuery(''); ++listEpoch.current;
      try { applySnapshot(await api.getConversation(id, pluginId)); } catch { /* 保留原会话，列表从实际服务重新读取。 */ }
      await refreshList().catch(() => {});
      throw error;
    } finally { managementLock.current = false; setManagingId(null); }
  }, [applySnapshot, canForkConversation, drafts, draftWritable, refreshList, selectConversation, pluginId]);
  const stop = useCallback(async () => {
    if (pluginId !== 'pi') return;
    const id = selectedRef.current;
    const state = id ? cache.current.get(id) : undefined;
    if (!id || !state?.activeRunId || state.storageError || state.status !== 'RUNNING'
      || connectionRef.current !== 'connected' || stopping.current.has(id)) return;
    stopping.current.add(id);
    rerender();
    try { applySnapshot(await api.abortRun(id, state.activeRunId)); }
    catch (error) { report(id, '停止请求暂未确认。', error); }
    finally { stopping.current.delete(id); rerender(); }
  }, [applySnapshot, report, pluginId]);
  const queueAction = useCallback(async (commandId?: string) => {
    if (pluginId !== 'pi') throw new Error('当前插件不能操作模型输入队列。');
    const state = getActive(false);
    const id = state.conversationId;
    pending.current.add(id);
    rerender();
    try { applySnapshot(commandId ? await api.cancelQueuedInput(id, commandId) : await api.resumeQueue(id)); }
    catch (error) { report(id, '队列操作暂未完成。', error); }
    finally { pending.current.delete(id); rerender(); }
  }, [applySnapshot, getActive, report, pluginId]);
  const updateQueuedInput = useCallback(async (commandId: string, edit?: { text: string; expectedText: string }) => {
    if (pluginId !== 'pi') throw new Error('当前插件不能操作模型输入队列。');
    const state = getActive(!edit);
    const id = state.conversationId;
    const signature = JSON.stringify([id, state.branchId, commandId, edit ?? 'steer']);
    const command = queueRequests.current.get(signature) ?? { requestId: crypto.randomUUID(), expectedRunId: edit ? undefined : state.activeRunId ?? undefined };
    if (!edit && !command.expectedRunId) throw new Error('当前没有正在回复的会话，无法引导。');
    queueRequests.current.set(signature, command);
    pending.current.add(id);
    rerender();
    setIssue(null);
    try {
      applySnapshot(edit
        ? await api.editQueuedInput(id, commandId, edit.text, edit.expectedText, command.requestId)
        : await api.steerQueuedInput(id, commandId, command.expectedRunId!, command.requestId));
      queueRequests.current.delete(signature);
    } catch (error) {
      if (!mayHaveCommitted(error)) queueRequests.current.delete(signature);
      await reconcile(id).catch(() => {});
      report(id, edit ? '排队消息修改暂未确认。' : '引导请求暂未确认。', error);
      throw error;
    } finally { pending.current.delete(id); rerender(); }
  }, [applySnapshot, getActive, reconcile, report, pluginId]);
  const newConversation = useCallback(async () => {
    if (creating.current || managementLock.current || cache.current.get(selectedRef.current ?? '')?.storageError) return;
    const selectionOwner = selectionEpoch.current;
    creating.current = true; setNewPending(true);
    try {
      const state = await api.createConversation(pluginId);
      applySnapshot(state);
      if (selectionOwner === selectionEpoch.current) {
        viewRef.current = 'active'; setView('active'); queryRef.current = ''; setQuery(''); ++listEpoch.current;
        listRef.current = []; setConversations([]); setManagementError(null);
        selectConversation(state.conversationId);
      }
      void refreshList().catch(() => {});
      return state;
    } catch (error) { report(selectedRef.current, '新对话暂未创建。', error); }
    finally { creating.current = false; setNewPending(false); }
  }, [applySnapshot, selectConversation, refreshList, report, pluginId]);

  const changeVisibility = useCallback(async (id: string, visibility: ConversationVisibility) => {
    if (managementLock.current || creating.current) throw new Error('请等待当前会话操作完成。');
    const expectedVisibility = listRef.current.find((item) => item.conversationId === id)?.visibility ?? cache.current.get(id)?.visibility;
    managementLock.current = true; setManagingId(id); setManagementError(null);
    try {
      if (visibility !== 'active') {
        const ensureConfirmed = () => {
          if (pending.current.size || sendRequestsRef.current.length || failedCommands.current.size) {
            throw new Error('还有发送或历史操作未确认，请先核对接收结果，再归档或删除会话。');
          }
        };
        ensureConfirmed();
        await Promise.all(editLoads.current.values());
        for (const [scope, owner] of draftOwners.current) {
          if (drafts.get(scope)?.conflict) throw new Error(`会话“${cache.current.get(owner)?.title || '新对话'}”有草稿版本冲突，请先选择保留哪一份。`);
        }
        await drafts.flushAndWait(draftWritable);
        ensureConfirmed();
      }
      // 草稿保存会推进会话序号；从核心读取保存后的版本，再进行状态 CAS。
      const current = await api.getConversation(id, pluginId);
      applySnapshot(current);
      if (expectedVisibility && current.visibility !== expectedVisibility) {
        throw new api.RequestError('会话状态已变化，列表已经更新，请核对后再操作。', 409, 'CONVERSATION_CONFLICT');
      }
      const updated = await api.changeConversationVisibility(id, visibility, current.sequence);
      applySnapshot(updated);
      if (visibility === 'active') {
        viewRef.current = 'active'; setView('active'); queryRef.current = ''; setQuery(''); ++listEpoch.current;
        listRef.current = []; setConversations([]); selectConversation(id);
      } else if (selectedRef.current === id) selectConversation(null);
      await refreshList().catch(() => {});
      return updated;
    } catch (error) {
      setManagementError(detailOf(error));
      try { applySnapshot(await api.getConversation(id, pluginId)); } catch { /* 保留原缓冲，后续快照继续核对。 */ }
      await refreshList().catch(() => {});
      throw error;
    } finally { managementLock.current = false; setManagingId(null); }
  }, [applySnapshot, drafts, draftWritable, refreshList, selectConversation, pluginId]);

  const renameConversation = useCallback(async (id: string, title: string) => {
    if (managementLock.current || creating.current) throw new Error('请等待当前会话操作完成。');
    if (cache.current.get(id)?.pluginId !== pluginId
      && !listRef.current.some((item) => item.conversationId === id && item.pluginId === pluginId)) throw new Error('会话不属于当前插件，请从当前会话列表选择。');
    const next = title.trim();
    if (!next || next.length > 120) throw new Error('会话名称需为1到120个字符。');
    managementLock.current = true; setManagingId(id); setManagementError(null);
    try {
      const updated = await api.renameConversation(id, next);
      applySnapshot(updated); await refreshList().catch(() => {});
      return updated;
    } catch (error) {
      setManagementError(detailOf(error));
      try { applySnapshot(await api.getConversation(id, pluginId)); } catch { /* 保留当前会话，等待重新核对。 */ }
      await refreshList().catch(() => {});
      throw error;
    } finally { managementLock.current = false; setManagingId(null); }
  }, [applySnapshot, refreshList, pluginId]);

  const updateDisplayMetadata = useCallback(async (id: string, update: ConversationDisplayMetadataUpdate) => {
    if (managementLock.current || creating.current) throw new Error('请等待当前会话操作完成。');
    if (!listRef.current.some(item => item.conversationId === id && item.pluginId === pluginId)) throw new Error('请从当前会话列表选择。');
    managementLock.current = true; setManagingId(id); setManagementError(null);
    // 先前发出的列表读取不能覆盖本次已确认的展示设置。
    ++listEpoch.current;
    try {
      const displayMetadata = await api.updateConversationDisplayMetadata(id, pluginId, update);
      const list = listRef.current.map(item => item.conversationId === id ? { ...item, displayMetadata } : item);
      listRef.current = list; setConversations(list);
      await refreshList().catch(() => {});
      return displayMetadata;
    } catch (error) {
      setManagementError(detailOf(error));
      await refreshList().catch(() => {});
      throw error;
    } finally { managementLock.current = false; setManagingId(null); }
  }, [refreshList, pluginId]);

  const compact = useCallback(async () => {
    const state = getActive();
    if (!state.supportsCompaction || state.status === 'RUNNING' || state.status === 'STOPPING') throw new Error('当前会话暂时不能整理上下文。');
    const id = state.conversationId, signature = JSON.stringify([id, 'compact', state.branchId]);
    const previous = failedCommands.current.get(signature);
    const requestId = previous?.requestId ?? crypto.randomUUID();
    const treeRevision = previous?.treeRevision ?? state.treeRevision;
    pending.current.add(id); rerender(); setIssue(null);
    try {
      const receipt = await api.compactConversation(id, requestId, treeRevision);
      if (receipt.status === 'failed' || receipt.status === 'cancelled') throw new Error('上下文整理未完成，原历史和已有检查点保留。');
      failedCommands.current.delete(signature);
      await reconcile(id);
    } catch (error) {
      if (mayHaveCommitted(error)) failedCommands.current.set(signature, { requestId, treeRevision, scope: mainScope(id), branchId: state.branchId });
      else failedCommands.current.delete(signature);
      await reconcile(id).catch(() => {});
      report(id, '上下文整理请求暂未确认。', error);
      throw error;
    } finally { pending.current.delete(id); rerender(); }
  }, [getActive, reconcile, report]);

  const isRunning = conversation?.status === 'RUNNING' || conversation?.status === 'STOPPING';
  const readOnly = !!conversation && conversation.visibility !== 'active';
  const managementPending = managingId !== null;
  const storageFrozen = !!conversation?.storageError;
  const actionPending = !!selectedId && pending.current.has(selectedId);
  const stopPending = !!selectedId && stopping.current.has(selectedId);
  const modelReady = !!health && (health.backend === 'demo' || health.configured) && !healthError;
  const thinkingReady = !conversation?.thinking || conversation.thinking.supportedLevels.includes(conversation.thinking.level);
  const draft = selectedId ? drafts.get(mainScope(selectedId)) : null;
  const draftSignature = draft ? draftContentSignature(draft) : null;
  const unconfirmedSend = !!selectedId && !!draftSignature
    && sendRequests.some((request) => request.branchId === conversation?.branchId
      && (request.state === 'frozen' || request.state === 'rejected' || request.state === 'unknown')
      && draftContentSignature(request) === draftSignature);
  const canSubmit = !!conversation && !readOnly && !managementPending && !!draft && connection === 'connected' && (pluginId === 'direct' || modelReady)
    && !storageFrozen && !actionPending && !attachmentUploads.current.has(selectedId ?? '') && !draft.conflict && thinkingReady;
  const canSend = canSubmit && !isRunning;
  const canManageQueue = !!conversation && !readOnly && !managementPending && !storageFrozen && !actionPending && connection === 'connected';
  const canReloadPage = pageChangesConfirmed();
  useEffect(() => {
    if (canReloadPage) return;
    const protect = (event: BeforeUnloadEvent) => {
      if (pageChangesConfirmed()) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, [canReloadPage, pageChangesConfirmed]);
  return { pluginId, conversation, conversations, selectedId, health, healthError, connection, issue,
    conversationView, searchQuery, setConversationView, setSearchQuery, listLoading, listError,
    managementPending, managingId, managementError, readOnly, renameConversation, changeVisibility, updateDisplayMetadata,
    draft, newPending, treeReset, isRunning, actionPending, sendPending: actionPending, stopPending, unconfirmedSend, storageFrozen,
    sendRequests, checkSendRequest, retrySendRequest, abandonSendRequest,
    attachmentPending: !!selectedId && attachmentUploads.current.has(selectedId),
    canAttach: pluginId === 'pi' && !!conversation && !readOnly && !managementPending && !storageFrozen && !actionPending && !!draft && connection === 'connected',
    captureAttachmentTarget, uploadAttachments, addDraftAttachments, setThinkingLevel,
    canChangeThinking: pluginId === 'pi' && !!conversation?.thinking && !readOnly && !managementPending && !storageFrozen && !actionPending && connection === 'connected',
    historyLoading, historyError, loadMoreHistory, canReloadPage,
    canSend, canRetrySend: unconfirmedSend && canSubmit, canQueue: pluginId === 'pi' && canSubmit,
    canSteer: pluginId === 'pi' && canSubmit && conversation?.status === 'RUNNING' && conversation.lastRun?.kind !== 'compaction' && !stopPending && !unconfirmedSend,
    canInterrupt: pluginId === 'pi' && canSubmit && conversation?.status === 'RUNNING' && !stopPending && !unconfirmedSend,
    canManageQueue,
    canSteerQueued: pluginId === 'pi' && canManageQueue && modelReady && conversation.status === 'RUNNING' && conversation.lastRun?.kind !== 'compaction' && !stopPending,
    canStop: pluginId === 'pi' && !readOnly && !managementPending && !storageFrozen && connection === 'connected' && conversation?.status === 'RUNNING' && !stopPending,
    canChangeHistory: pluginId === 'pi' && !readOnly && !managementPending && !storageFrozen && connection === 'connected' && !isRunning && !actionPending && modelReady,
    canBranch: pluginId === 'pi' && !readOnly && !managementPending && !storageFrozen && connection === 'connected' && !isRunning && !actionPending,
    canCompact: pluginId === 'pi' && !readOnly && !managementPending && !!conversation?.supportsCompaction && conversation.messages.length > 0 && !storageFrozen && connection === 'connected' && !isRunning && !actionPending && modelReady,
    unconfirmedCompaction: !!conversation && failedCommands.current.has(JSON.stringify([conversation.conversationId, 'compact', conversation.branchId])),
    selectConversation, newConversation, send, stop, branch, queueAction, compact,
    editQueuedInput: (commandId: string, text: string, expectedText: string) => updateQueuedInput(commandId, { text, expectedText }),
    steerQueuedInput: (commandId: string) => updateQueuedInput(commandId),
    canForkConversation, forkConversation,
    edit: (id: string, text: string) => mutateHistory('edit', id, text),
    retry: (id: string) => mutateHistory('retry', id),
    setDraftText: (text: string) => { if (selectedId && !managementLock.current && cache.current.get(selectedId)?.visibility === 'active') drafts.edit(mainScope(selectedId), text); },
    removeDraftAttachment: (fileRefId: string) => {
      if (!selectedId || managementLock.current || pending.current.has(selectedId) || cache.current.get(selectedId)?.visibility !== 'active') return;
      const scope = mainScope(selectedId), value = drafts.get(scope); if (value) drafts.setAttachments(scope, value.attachmentRefs.filter((ref) => ref.fileRefId !== fileRefId));
    },
    saveDraftNow: () => {
      if (selectedId && !managementLock.current) { const scope = mainScope(selectedId); if (draftWritable(scope)) void drafts.persist(scope).catch(() => {}); }
    },
    loadEditDraft,
    getEditDraft: (messageId: string) => selectedId ? drafts.get(editScope(selectedId, messageId)) : null,
    setEditDraftText: (messageId: string, text: string) => { if (selectedId && !managementLock.current && cache.current.get(selectedId)?.visibility === 'active') drafts.edit(editScope(selectedId, messageId), text); },
    removeEditDraftAttachment: (messageId: string, fileRefId: string) => {
      if (!selectedId || managementLock.current || pending.current.has(selectedId) || cache.current.get(selectedId)?.visibility !== 'active') return;
      const scope = editScope(selectedId, messageId), value = drafts.get(scope); if (value) drafts.setAttachments(scope, value.attachmentRefs.filter((ref) => ref.fileRefId !== fileRefId));
    },
    saveEditDraft: (messageId: string) => {
      if (!selectedId || managementLock.current) return;
      const scope = editScope(selectedId, messageId);
      if (drafts.get(scope) && draftWritable(scope)) void drafts.persist(scope).catch(() => {});
    },
    resolveEditDraftConflict: (messageId: string, choice: 'local' | 'saved') => {
      if (selectedId) drafts.resolveConflict(editScope(selectedId, messageId), choice);
    },
    resolveDraftConflict: (choice: 'local' | 'saved') => { if (selectedId) drafts.resolveConflict(mainScope(selectedId), choice); },
    dismissIssue: () => setIssue(null),
  };
}
