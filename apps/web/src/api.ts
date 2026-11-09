import type {
  ChatMessage, ConversationAttachmentRef, ConversationDisplayMetadata, ConversationDisplayMetadataUpdate, ConversationPlugin, ConversationState, ConversationSummary, ConversationVisibility, DraftState, FreezeSendRequestInput, HealthResponse,
  MessageHistoryPage, SendReceipt, SendRequestDependencies, SendRequestView, StateEnvelope, ThinkingLevel,
} from '../../../contracts/contracts';
import type { AgentQuestion } from '../../../contracts/agent-question-contracts';
import { localDataGeneration, localDataRevision, notifyLocalDataRevoked } from './local-data-context';

export class RequestError extends Error {
  constructor(message: string, readonly status: number | null = null,
    readonly code: string | null = null, readonly draft: DraftState | null = null) {
    super(message);
    this.name = 'RequestError';
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function nullableString(value: unknown): boolean { return value === null || typeof value === 'string'; }
function isConversationPlugin(value: unknown): value is ConversationPlugin { return value === 'pi' || value === 'direct'; }
function isVisibility(value: unknown): value is ConversationVisibility { return ['active', 'archived', 'trashed'].includes(String(value)); }
function hasVisibility(value: Record<string, unknown>): boolean {
  return isVisibility(value.visibility) && (value.archivedAt === undefined || typeof value.archivedAt === 'string')
    && (value.deletedAt === undefined || typeof value.deletedAt === 'string');
}
export function isConversationAttachmentRefs(value: unknown): value is ConversationAttachmentRef[] {
  return Array.isArray(value) && value.length <= 32 && value.every((ref) => isRecord(ref) && typeof ref.fileRefId === 'string' && !!ref.fileRefId.trim()
    && Number.isSafeInteger(ref.version) && Number(ref.version) > 0 && ['unclassified', 'data', 'tool'].includes(String(ref.category))
    && (ref.displayName === undefined || typeof ref.displayName === 'string'));
}
export function isDraftState(value: unknown): value is DraftState {
  return isRecord(value) && typeof value.key === 'string' && typeof value.text === 'string'
    && Number.isSafeInteger(value.revision) && Number(value.revision) >= 0
    && typeof value.updatedAt === 'string' && (value.attachmentRefs === undefined || isConversationAttachmentRefs(value.attachmentRefs));
}
function isSendRequestDependencies(value: unknown): value is SendRequestDependencies {
  if (!isRecord(value)) return false;
  const rules = value.internalAgentRules;
  return ['modelId', 'provider', 'modelConfigurationVersion'].every((key) => nullableString(value[key]))
    && ['off', 'low', 'high', 'max'].includes(String(value.thinkingLevel))
    && (value.preferenceRevision === null || Number.isSafeInteger(value.preferenceRevision))
    && Number.isSafeInteger(value.personaSelectionRevision) && Number(value.personaSelectionRevision) >= 0
    && (rules === null || (isRecord(rules) && typeof rules.id === 'string' && Number.isSafeInteger(rules.version) && typeof rules.digest === 'string'))
    && (value.permissionPolicyVersion === null || (Number.isSafeInteger(value.permissionPolicyVersion) && Number(value.permissionPolicyVersion) >= 0))
    && typeof value.configurationDigest === 'string' && !!value.configurationDigest;
}
export function isSendRequestView(value: unknown): value is SendRequestView {
  return isRecord(value) && typeof value.requestId === 'string' && typeof value.conversationId === 'string'
    && typeof value.branchId === 'string' && ['send', 'queue', 'steer', 'interrupt'].includes(String(value.mode))
    && typeof value.text === 'string' && isConversationAttachmentRefs(value.attachmentRefs)
    && isRecord(value.draft) && typeof value.draft.key === 'string' && Number.isSafeInteger(value.draft.revision) && Number(value.draft.revision) >= 0
    && nullableString(value.expectedRunId) && ['frozen', 'accepted', 'rejected', 'abandoned', 'unknown'].includes(String(value.state))
    && isSendRequestDependencies(value.dependencies) && nullableString(value.commandId) && nullableString(value.runId) && nullableString(value.taskId)
    && (value.commandState === null || ['accepted', 'queued', 'steering', 'consumed', 'held', 'cancelled', 'failed'].includes(String(value.commandState)))
    && (value.error === null || typeof value.error === 'string') && typeof value.createdAt === 'string' && typeof value.updatedAt === 'string'
    && nullableString(value.acceptedAt);
}
function isMessageUsage(value: unknown): boolean {
  return isRecord(value)
    && ['inputTokens', 'outputTokens'].every((key) => Number.isSafeInteger(value[key]) && Number(value[key]) >= 0)
    && ['uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens'].every((key) => value[key] === undefined || (Number.isSafeInteger(value[key]) && Number(value[key]) >= 0))
    && ['modelId', 'provider'].every((key) => value[key] === undefined || typeof value[key] === 'string');
}
function isMessage(value: unknown): value is ChatMessage {
  return isRecord(value) && typeof value.id === 'string' && nullableString(value.parentId)
    && nullableString(value.runId) && ['user', 'assistant'].includes(String(value.role))
    && typeof value.text === 'string' && typeof value.createdAt === 'string'
    && ['running', 'complete', 'interrupted', 'error'].includes(String(value.status))
    && (value.thinking === undefined || typeof value.thinking === 'string')
    && (value.usage === undefined || isMessageUsage(value.usage))
    && (value.attachmentRefs === undefined || isConversationAttachmentRefs(value.attachmentRefs))
    && (value.agentDisplayName === undefined || typeof value.agentDisplayName === 'string');
}
function isDisplayMetadata(value: unknown): value is ConversationDisplayMetadata {
  return isRecord(value) && nullableString(value.pinnedAt) && nullableString(value.group)
    && Number.isSafeInteger(value.revision) && Number(value.revision) >= 0;
}
function isHistoryWindow(value: unknown): boolean {
  return isRecord(value) && nullableString(value.before) && typeof value.hasMore === 'boolean'
    && (value.hasMore ? typeof value.before === 'string' : value.before === null)
    && Number.isSafeInteger(value.totalMessages) && Number(value.totalMessages) >= 0
    && Number.isSafeInteger(value.branchMessages) && Number(value.branchMessages) >= 0;
}
function isThinking(value: unknown): boolean {
  return isRecord(value) && ['off', 'low', 'high', 'max'].includes(String(value.level))
    && ['off', 'low', 'high', 'max'].includes(String(value.defaultLevel))
    && Array.isArray(value.supportedLevels) && value.supportedLevels.length > 0
    && value.supportedLevels.every((level: unknown) => ['off', 'low', 'high', 'max'].includes(String(level)));
}
function isContextUsage(value: unknown): boolean {
  return isRecord(value) && typeof value.modelId === 'string' && typeof value.provider === 'string'
    && Number.isSafeInteger(value.contextWindow) && Number(value.contextWindow) > 0
    && ['inputUpperBound', 'outputReserve', 'protocolReserve', 'totalUpperBound'].every((key) => Number.isSafeInteger(value[key]) && Number(value[key]) >= 0)
    && value.measurement === 'utf8_upper_bound' && ['request', 'next_request'].includes(String(value.phase)) && typeof value.measuredAt === 'string';
}
export function isConversationState(value: unknown): value is ConversationState {
  return isRecord(value) && typeof value.conversationId === 'string' && typeof value.title === 'string'
    && isConversationPlugin(value.pluginId) && hasVisibility(value)
    && typeof value.branchId === 'string' && nullableString(value.headId)
    && typeof value.backendId === 'string' && nullableString(value.sessionRef)
    && ['IDLE', 'RUNNING', 'STOPPING', 'INTERRUPTED', 'ERROR'].includes(String(value.status))
    && nullableString(value.activeRunId) && nullableString(value.error)
    && Number.isSafeInteger(value.sequence) && Number(value.sequence) >= 0
    && Number.isSafeInteger(value.treeRevision) && isDraftState(value.draft)
    && Array.isArray(value.messages) && value.messages.every(isMessage)
    && Array.isArray(value.messageTree) && value.messageTree.every(isMessage)
    && Array.isArray(value.branches) && Array.isArray(value.queue)
    && typeof value.queuePaused === 'boolean' && (value.history === undefined || isHistoryWindow(value.history))
    && (value.thinking === undefined || isThinking(value.thinking))
    && (value.contextUsage === undefined || isContextUsage(value.contextUsage));
}
export function readStateEnvelope(data: string): StateEnvelope {
  const value: unknown = JSON.parse(data);
  if (!isRecord(value) || !isConversationState(value.state)) throw new RequestError('会话数据暂时无法同步。');
  return value as unknown as StateEnvelope;
}
export async function request(path: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH' = 'GET', body?: unknown): Promise<unknown> {
  let response: Response;
  const privateRequest = !path.startsWith('/api/bd/local-data') && !path.startsWith('/api/health');
  // 请求发出前固定本页已核实的 dataId 代次与撤销 epoch；迟到回执不能进入新上下文。
  const generation = privateRequest ? localDataGeneration() : null;
  const revision = privateRequest ? localDataRevision() : 0;
  const sameContext = () => localDataRevision() === revision && localDataGeneration() === generation;
  const stale = () => new RequestError('本次请求的回执属于旧本地资料代次，未用于当前界面。', 409, 'STALE_LOCAL_DATA_GENERATION');
  const headers: Record<string, string> = {};
  const binary = body instanceof Blob;
  if (method !== 'GET') { headers['Content-Type'] = binary ? 'application/octet-stream' : 'application/json'; headers['x-mashiro-client'] = 'web'; }
  if (generation !== null) headers['x-local-data-generation'] = String(generation);
  try {
    response = await fetch(path, {
      method, credentials: 'same-origin', cache: 'no-store', keepalive: method === 'PUT',
      signal: AbortSignal.timeout(method === 'GET' ? 8_000 : 30_000),
      headers,
      ...(method === 'GET' ? {} : { body: binary ? body : JSON.stringify(body) }),
    });
  } catch { throw new RequestError('未收到本机服务的确认，请检查连接状态。'); }
  let value: unknown;
  try { value = await response.json(); }
  catch {
    if (privateRequest && !sameContext()) throw stale();
    throw new RequestError('本机服务返回了无法读取的响应。', response.status);
  }
  if (privateRequest && !sameContext()) throw stale();
  if (!response.ok) {
    const code = isRecord(value) && typeof value.code === 'string' ? value.code : null;
    if (code && (code.startsWith('LOCAL_DATA_') || code === 'STALE_LOCAL_DATA_GENERATION')) notifyLocalDataRevoked(code);
    throw new RequestError(isRecord(value) && typeof value.error === 'string' ? value.error
      : '本机服务暂时无法完成请求。', response.status, code,
    isRecord(value) && isDraftState(value.draft) ? value.draft : null);
  }
  return value;
}
const pathFor = (id: string) => `/api/conversations/${encodeURIComponent(id)}`;
export const historyPageSize = 40;
const windowPath = (path: string) => `${path}?historyLimit=${historyPageSize}`;
function stateResponse(value: unknown, pluginId?: ConversationPlugin): ConversationState {
  if (!isConversationState(value)) throw new RequestError('会话数据暂时无法读取。');
  if (pluginId && value.pluginId !== pluginId) throw new RequestError('会话不属于当前插件，请重新选择。');
  return value;
}
function receiptResponse(value: unknown): SendReceipt {
  if (!isRecord(value) || typeof value.commandId !== 'string' || !nullableString(value.runId)
    || (value.taskId !== undefined && typeof value.taskId !== 'string')
    || !['accepted', 'queued', 'steering', 'consumed', 'held', 'cancelled', 'failed'].includes(String(value.status))) {
    throw new RequestError('本机服务没有返回请求确认。');
  }
  return value as unknown as SendReceipt;
}
export async function getHealth(): Promise<HealthResponse> {
  const value = await request('/api/health');
  if (!isRecord(value) || !['pi', 'demo'].includes(String(value.backend))
    || typeof value.configured !== 'boolean' || typeof value.notice !== 'string') {
    throw new RequestError('模型配置状态暂时无法读取。');
  }
  return value as unknown as HealthResponse;
}
export async function getConversations(options: { pluginId?: ConversationPlugin; view?: ConversationVisibility; q?: string } = {}): Promise<ConversationSummary[]> {
  const pluginId = options.pluginId ?? 'pi';
  const query = new URLSearchParams({ pluginId, view: options.view ?? 'active' });
  if (options.q?.trim()) query.set('q', options.q.trim());
  const value = await request(`/api/conversations?${query}`);
  if (!Array.isArray(value) || !value.every((item: unknown) => isRecord(item)
    && typeof item.conversationId === 'string' && typeof item.title === 'string'
    && item.pluginId === pluginId
    && typeof item.status === 'string' && typeof item.updatedAt === 'string' && hasVisibility(item)
    && Number.isSafeInteger(item.sequence) && Number(item.sequence) >= 0
    && (item.displayMetadata === undefined || isDisplayMetadata(item.displayMetadata)))) {
    throw new RequestError('会话列表暂时无法读取。');
  }
  return value as ConversationSummary[];
}
export async function updateConversationDisplayMetadata(id: string, pluginId: ConversationPlugin, update: ConversationDisplayMetadataUpdate): Promise<ConversationDisplayMetadata> {
  const query = new URLSearchParams({ pluginId });
  const value = await request(`${pathFor(id)}/display-metadata?${query}`, 'PUT', update);
  if (!isRecord(value) || value.conversationId !== id || !isDisplayMetadata(value.displayMetadata)) throw new RequestError('会话展示设置的保存结果暂时无法读取。');
  return value.displayMetadata;
}
export async function createConversation(pluginId: ConversationPlugin = 'pi', title?: string): Promise<ConversationState> {
  return stateResponse(await request(windowPath('/api/conversations'), 'POST', { pluginId, ...(title === undefined ? {} : { title }) }), pluginId);
}
export async function getConversation(id: string, pluginId?: ConversationPlugin): Promise<ConversationState> {
  const state = stateResponse(await request(windowPath(pathFor(id))), pluginId);
  if (state.conversationId !== id) throw new RequestError('会话来源不一致，请重新选择。');
  return state;
}
export async function getHistoryPage(id: string, branchId: string, before: string): Promise<MessageHistoryPage> {
  const query = new URLSearchParams({ branchId, before, limit: String(historyPageSize) });
  const value = await request(`${pathFor(id)}/history?${query}`);
  if (!isRecord(value) || value.conversationId !== id || value.branchId !== branchId || !Array.isArray(value.messages)
    || !value.messages.every(isMessage) || !nullableString(value.before) || typeof value.hasMore !== 'boolean'
    || (value.hasMore ? typeof value.before !== 'string' : value.before !== null)
    || !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 0) throw new RequestError('较早消息暂时无法读取。');
  return value as unknown as MessageHistoryPage;
}
export async function renameConversation(id: string, title: string): Promise<ConversationState> {
  return stateResponse(await request(windowPath(pathFor(id)), 'PATCH', { title }));
}
export async function setThinkingLevel(id: string, level: ThinkingLevel): Promise<ConversationState> {
  return stateResponse(await request(windowPath(`${pathFor(id)}/thinking`), 'PATCH', { level }));
}
export async function changeConversationVisibility(id: string, visibility: ConversationVisibility, sequence: number): Promise<ConversationState> {
  return stateResponse(await request(windowPath(`${pathFor(id)}/visibility`), 'POST', { visibility, sequence }));
}
export async function getDraft(id: string, messageId?: string, branchId?: string): Promise<DraftState> {
  const query = (messageId ? `kind=edit&messageId=${encodeURIComponent(messageId)}` : 'kind=main')
    + (branchId ? `&branchId=${encodeURIComponent(branchId)}` : '');
  const value = await request(`${pathFor(id)}/draft?${query}`);
  if (!isDraftState(value)) throw new RequestError('草稿暂时无法读取。');
  return value;
}
export async function saveDraft(id: string, draft: Pick<DraftState, 'text' | 'revision' | 'key' | 'attachmentRefs'>): Promise<DraftState> {
  const value = await request(`${pathFor(id)}/draft`, 'PUT', { ...draft, attachmentRefs: draft.attachmentRefs ?? [] });
  if (!isDraftState(value)) throw new RequestError('草稿保存结果暂时无法读取。');
  return value;
}
export async function bindDraftReferences(id: string, branchId: string, refs: ConversationAttachmentRef[]): Promise<ConversationAttachmentRef[]> {
  const value = await request('/api/ui/draft-references', 'POST', { conversationId: id, branchId, refs });
  if (!isConversationAttachmentRefs(value)) throw new RequestError('原件引用未能确认，草稿仍保留原范围。');
  return value;
}
/** 派发前固定会话、分支、草稿修订、正文、附件版本与实际模型依赖。 */
export async function freezeSendRequest(id: string, input: FreezeSendRequestInput): Promise<SendRequestView> {
  const value = await request(`${pathFor(id)}/send-requests`, 'POST', input);
  if (!isSendRequestView(value) || value.conversationId !== id) throw new RequestError('发送请求的保存结果暂时无法读取。');
  return value;
}
/** 只返回待核或明确未受理的原请求；已受理项按命令或任务回到原记录。 */
export async function getSendRequests(id: string): Promise<SendRequestView[]> {
  const value = await request(`${pathFor(id)}/send-requests`);
  if (!Array.isArray(value) || !value.every((item: unknown) => isSendRequestView(item) && item.conversationId === id)) {
    throw new RequestError('未确认发送的原请求暂时无法读取。');
  }
  return value as SendRequestView[];
}
export async function getSendRequest(id: string, requestId: string): Promise<SendRequestView> {
  const value = await request(`${pathFor(id)}/send-requests/${encodeURIComponent(requestId)}`);
  if (!isSendRequestView(value) || value.conversationId !== id || value.requestId !== requestId) {
    throw new RequestError('原发送请求暂时无法核对。');
  }
  return value;
}
export async function abandonSendRequest(id: string, requestId: string): Promise<SendRequestView> {
  const value = await request(`${pathFor(id)}/send-requests/${encodeURIComponent(requestId)}/abandon`, 'POST', {});
  if (!isSendRequestView(value) || value.conversationId !== id || value.requestId !== requestId || value.state !== 'abandoned') {
    throw new RequestError('放弃原发送请求的结果暂时无法核对。');
  }
  return value;
}
export async function postMessage(id: string, text: string, requestId: string,
  mode: 'send' | 'queue' | 'steer', draft: Pick<DraftState, 'key' | 'revision'>, attachmentRefs: ConversationAttachmentRef[] = []): Promise<SendReceipt> {
  return receiptResponse(await request(`${pathFor(id)}/messages`, 'POST', { text, requestId, mode, draft, attachmentRefs }));
}
export async function interruptAndSend(id: string, text: string, requestId: string,
  draft: Pick<DraftState, 'key' | 'revision'>, expectedRunId?: string, attachmentRefs: ConversationAttachmentRef[] = []): Promise<SendReceipt> {
  return receiptResponse(await request(`${pathFor(id)}/interrupt-send`, 'POST', { text, requestId, draft, expectedRunId, attachmentRefs }));
}
export async function editMessage(id: string, messageId: string, text: string,
  requestId: string, treeRevision: number, draft?: Pick<DraftState, 'key' | 'revision'>, attachmentRefs?: ConversationAttachmentRef[]): Promise<SendReceipt> {
  return receiptResponse(await request(`${pathFor(id)}/edit`, 'POST', { messageId, text, requestId, treeRevision, draft, ...(attachmentRefs === undefined ? {} : { attachmentRefs }) }));
}
export async function retryMessage(id: string, messageId: string, requestId: string,
  treeRevision: number): Promise<SendReceipt> {
  return receiptResponse(await request(`${pathFor(id)}/retry`, 'POST', { messageId, requestId, treeRevision }));
}
export async function compactConversation(id: string, requestId: string, treeRevision: number): Promise<SendReceipt> {
  return receiptResponse(await request(`${pathFor(id)}/compact`, 'POST', { requestId, treeRevision }));
}
export async function switchBranch(id: string, headId: string, treeRevision: number): Promise<ConversationState> {
  return stateResponse(await request(windowPath(`${pathFor(id)}/branch`), 'POST', { headId, treeRevision }));
}
export async function forkConversation(id: string, treeRevision: number, requestId: string): Promise<ConversationState> {
  return stateResponse(await request(windowPath(`${pathFor(id)}/fork`), 'POST', { treeRevision, requestId }));
}
export async function abortRun(id: string, runId: string): Promise<ConversationState> {
  return stateResponse(await request(windowPath(`${pathFor(id)}/abort`), 'POST', { runId }));
}
export async function cancelQueuedInput(id: string, commandId: string): Promise<ConversationState> {
  return stateResponse(await request(windowPath(`${pathFor(id)}/queue/${encodeURIComponent(commandId)}/cancel`), 'POST', {}));
}
export async function editQueuedInput(id: string, commandId: string, text: string, expectedText: string, requestId: string): Promise<ConversationState> {
  return stateResponse(await request(windowPath(`${pathFor(id)}/queue/${encodeURIComponent(commandId)}/edit`), 'POST', { text, expectedText, requestId }));
}
export async function steerQueuedInput(id: string, commandId: string, expectedRunId: string, requestId: string): Promise<ConversationState> {
  return stateResponse(await request(windowPath(`${pathFor(id)}/queue/${encodeURIComponent(commandId)}/steer`), 'POST', { expectedRunId, requestId }));
}
export async function resumeQueue(id: string): Promise<ConversationState> {
  return stateResponse(await request(windowPath(`${pathFor(id)}/queue/resume`), 'POST', {}));
}

function isAgentQuestion(value: unknown): value is AgentQuestion {
  return isRecord(value) && typeof value.id === 'string' && typeof value.conversationId === 'string' && typeof value.branchId === 'string'
    && typeof value.question === 'string' && Array.isArray(value.options) && value.options.every((option) => typeof option === 'string')
    && ['pending', 'answered', 'dismissed'].includes(String(value.status)) && nullableString(value.answer)
    && Number.isSafeInteger(value.createdAt) && Number.isSafeInteger(value.updatedAt);
}
export async function getQuestions(conversationId: string, branchId: string): Promise<AgentQuestion[]> {
  const query = new URLSearchParams({ conversationId, branchId }), value = await request(`/api/questions?${query}`);
  if (!isRecord(value) || !Array.isArray(value.questions) || !value.questions.every((question) => isAgentQuestion(question) && question.conversationId === conversationId && question.branchId === branchId)) throw new RequestError('待回答问题暂时无法读取。');
  return value.questions as AgentQuestion[];
}
export async function answerQuestion(id: string, answer: string, requestId: string): Promise<{ question: AgentQuestion; receipt: SendReceipt }> {
  const value = await request(`/api/questions/${encodeURIComponent(id)}/answer`, 'POST', { answer, requestId });
  if (!isRecord(value) || !isAgentQuestion(value.question) || value.question.id !== id) throw new RequestError('回答的接收结果暂未确认。', 200);
  return { question: value.question, receipt: receiptResponse(value.receipt) };
}
export async function dismissQuestion(id: string): Promise<AgentQuestion> {
  const value = await request(`/api/questions/${encodeURIComponent(id)}/dismiss`, 'POST', {});
  if (!isRecord(value) || !isAgentQuestion(value.question) || value.question.id !== id) throw new RequestError('跳过结果暂未确认。', 200);
  return value.question;
}
