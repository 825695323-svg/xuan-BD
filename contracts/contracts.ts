import type { RunConfiguration } from './ui-contracts.js';
export type ConversationStatus = 'IDLE' | 'RUNNING' | 'STOPPING' | 'INTERRUPTED' | 'ERROR';
export type ConversationVisibility = 'active' | 'archived' | 'trashed';
export type ConversationPlugin = 'pi' | 'direct';
export type ThinkingLevel = 'off' | 'low' | 'high' | 'max';
export interface ThinkingConfiguration {
  defaultLevel: ThinkingLevel;
  supportedLevels: readonly ThinkingLevel[];
}
export interface ConversationThinking extends ThinkingConfiguration { level: ThinkingLevel }
export type MessageStatus = 'running' | 'complete' | 'interrupted' | 'error';
export interface ConversationAttachmentRef {
  fileRefId: string;
  version: number;
  category: 'unclassified' | 'data' | 'tool';
  displayName?: string;
}
export interface MessageUsage {
  /** 最近单次请求的完整输入，包含缓存读取和写入；不是累计消耗。 */
  inputTokens: number;
  outputTokens: number;
  uncachedInputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  modelId?: string;
  provider?: string;
}
export interface ConversationContextUsage {
  modelId: string;
  provider: string;
  contextWindow: number;
  inputUpperBound: number;
  outputReserve: number;
  protocolReserve: number;
  totalUpperBound: number;
  measurement: 'utf8_upper_bound';
  /** next_request沿用最近装配的规则，不含尚未发送的新输入或以后变化的动态上下文。 */
  phase: 'request' | 'next_request';
  measuredAt: string;
}
export interface ChatMessage {
  id: string;
  parentId: string | null;
  runId: string | null;
  role: 'user' | 'assistant';
  text: string;
  /** 仅模型实际返回的可读思考文本，不包含原生消息、签名或隐藏载荷。 */
  thinking?: string;
  usage?: MessageUsage;
  /** 核心返回空数组；可选字段保留旧客户端兼容。只保存引用，不嵌入文件字节。 */
  attachmentRefs?: ConversationAttachmentRef[];
  createdAt: string;
  status: MessageStatus;
  rawStopReason?: string;
  failureCode?: string;
  /** 仅投影此消息所属运行中冻结的显示名；旧运行缺失时不补当前偏好。 */
  agentDisplayName?: string;
}
export interface DraftState {
  key: string;
  text: string;
  attachmentRefs?: ConversationAttachmentRef[];
  revision: number;
  updatedAt: string;
}
/** 派发前冻结的会话发送意图；原件、命令和任务仍是各自权威。 */
export type SendRequestMode = 'send' | 'queue' | 'steer' | 'interrupt';
export type SendRequestState = 'frozen' | 'accepted' | 'rejected' | 'abandoned' | 'unknown';
/** 冻结时由受信宿主选定的实际派发路由；恢复时按同一路由重新核对。 */
export interface SendRequestRoute {
  kind: 'model' | 'local';
  ruleId: string | null;
  ruleRevision: number | null;
  action: string | null;
  subjectDigest: string | null;
  versionsDigest: string | null;
}
export interface SendRequestDependencies {
  modelId: string | null;
  provider: string | null;
  modelConfigurationVersion: string | null;
  thinkingLevel: ThinkingLevel;
  preferenceRevision: number | null;
  personaSelectionRevision: number;
  internalAgentRules: { id: string; version: number; digest: string } | null;
  /** 冻结时观察到的权限策略；派发仍重新执行停止与授权闸门。 */
  permissionPolicyVersion: number | null;
  configurationDigest: string;
}
export interface SendRequestView {
  requestId: string;
  conversationId: string;
  branchId: string;
  mode: SendRequestMode;
  text: string;
  attachmentRefs: ConversationAttachmentRef[];
  draft: { key: string; revision: number };
  expectedRunId: string | null;
  state: SendRequestState;
  route: SendRequestRoute;
  dependencies: SendRequestDependencies;
  commandId: string | null;
  runId: string | null;
  taskId: string | null;
  commandState: SendReceipt['status'] | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  acceptedAt: string | null;
}
export interface FreezeSendRequestInput {
  requestId: string;
  branchId: string;
  mode: SendRequestMode;
  text: string;
  attachmentRefs?: ConversationAttachmentRef[];
  draft: { key: string; revision: number };
  expectedRunId?: string | null;
}
export interface BranchSummary {
  id: string;
  headId: string | null;
  createdAt: string;
}
export interface PendingInput {
  id: string;
  text: string;
  attachmentRefs?: ConversationAttachmentRef[];
  kind: 'queue' | 'steer' | 'interrupt';
  state: 'queued' | 'steering' | 'held' | 'consumed' | 'cancelled' | 'failed';
  createdAt: string;
  error: string | null;
}
export interface RunSummary {
  id: string;
  conversationId: string;
  branchId: string;
  kind: 'chat' | 'compaction';
  thinkingLevel?: ThinkingLevel;
  configuration?: RunConfiguration;
  compaction?: { changed: boolean; modelRequests: number; tokensBefore?: number; tokensAfter?: number };
  state: 'starting' | 'running' | 'stopping' | 'succeeded' | 'failed' | 'interrupted';
  generation: number;
  startedAt: string;
  settledAt: string | null;
  rawStopReason: string | null;
  failureCode: string | null;
}
/** 仅供会话列表组织展示，与项目、记忆和运行配置无关。 */
export interface ConversationDisplayMetadata {
  pinnedAt: string | null;
  group: string | null;
  revision: number;
}
export interface ConversationDisplayMetadataUpdate {
  revision: number;
  pinned?: boolean;
  group?: string | null;
}
export interface ConversationSummary {
  conversationId: string;
  title: string;
  pluginId: ConversationPlugin;
  backendId: string;
  projectId: string | null;
  visibility: ConversationVisibility;
  archivedAt?: string;
  deletedAt?: string;
  sequence: number;
  status: ConversationStatus;
  activeRunId: string | null;
  updatedAt: string;
  messageCount: number;
  displayMetadata?: ConversationDisplayMetadata;
}
export interface ConversationState {
  conversationId: string;
  title: string;
  pluginId: ConversationPlugin;
  backendId: string;
  projectId: string | null;
  visibility: ConversationVisibility;
  archivedAt?: string;
  deletedAt?: string;
  supportsCompaction: boolean;
  /** 会话选择由核心保存；实际运行档位在接收时冻结。 */
  thinking?: ConversationThinking;
  branchId: string;
  headId: string | null;
  treeRevision: number;
  updatedAt: string;
  sessionRef: string | null;
  status: ConversationStatus;
  activeRunId: string | null;
  messages: ChatMessage[];
  messageTree: ChatMessage[];
  directMessageCount: number;
  branches: BranchSummary[];
  draft: DraftState;
  queue: PendingInput[];
  queuePaused: boolean;
  lastRun: RunSummary | null;
  contextUsage?: ConversationContextUsage;
  error: string | null;
  sequence: number;
  storageError?: string;
  /** 仅供界面阅读的窗口；不代表完整模型历史或完整消息树。 */
  history?: MessageHistoryWindow;
}
export interface MessageHistoryWindow {
  before: string | null;
  hasMore: boolean;
  totalMessages: number;
  branchMessages: number;
}
export interface MessageHistoryPage {
  conversationId: string;
  branchId: string;
  messages: ChatMessage[];
  before: string | null;
  hasMore: boolean;
  sequence: number;
}
export type EventType = 'CONVERSATION_UPDATED' | 'BRANCH_CHANGED' | 'DRAFT_UPDATED' | 'QUEUE_UPDATED'
  | 'RUN_ACCEPTED' | 'RUN_STARTED' | 'INPUT_CONSUMED' | 'MESSAGE_STARTED' | 'MESSAGE_FINALIZED'
  | 'TEXT_DELTA' | 'THINKING_DELTA' | 'CONTEXT_USAGE_UPDATED' | 'RUN_STOPPING' | 'RUN_FINISHED' | 'RUN_INTERRUPTED' | 'RUN_ERROR';
export interface CoreEvent {
  type: EventType;
  conversationId: string;
  runId: string | null;
  messageId: string | null;
  sequence: number;
  timestamp: string;
  delta?: string;
  contextUsage?: ConversationContextUsage;
  error?: string;
}
export interface StateEnvelope {
  state: ConversationState;
  event?: CoreEvent;
}
export interface SendReceipt {
  commandId: string;
  runId: string | null;
  status: 'accepted' | 'queued' | 'steering' | 'consumed' | 'held' | 'cancelled' | 'failed';
  taskId?: string;
}
export interface HealthResponse {
  name: 'xuan BD';
  backend: 'pi' | 'demo';
  configured: boolean;
  model: string | null;
  provider: string | null;
  /** 受信模型配置中的显示名，旧宿主缺少时界面回落模型编号。 */
  displayName?: string | null;
  notice: string;
}
