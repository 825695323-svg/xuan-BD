export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type TaskStatus = 'ready' | 'running' | 'waiting_approval' | 'pausing' | 'paused' | 'cancelling' | 'cancelled'
  | 'succeeded' | 'failed' | 'interrupted' | 'needs_review' | 'blocked' | 'awaiting_review';
export interface TaskResult { summary: string; artifactIds?: string[]; data?: JsonValue }
/** 失败分类只帮助调用方分流，权威事实仍是 code、原请求和外部回执。 */
export type TaskFailureCategory = 'invalid_input' | 'permission' | 'budget' | 'deadline' | 'dependency'
  | 'capability' | 'version_conflict' | 'storage' | 'external_unknown' | 'stopped' | 'runtime';
export interface TaskFailure {
  code: string; message: string;
  category?: TaskFailureCategory;
  stage?: 'dispatch' | 'execute' | 'settle' | 'recovery';
  recoverable?: boolean;
  sideEffect?: 'none' | 'started' | 'unknown';
  nextAction?: string;
}
/** A04 的八项计量：模型请求、Token、估计/确认费用、工具时间、尝试、活动时间、墙钟、存储。空上限表示当前宿主未设该项硬限。 */
export interface TaskBudgetLimits {
  maxActiveMs: number; maxNoProgressMs: number; maxAttempts: number; maxModelRequests: number;
  maxTokens: number | null;
  maxEstimatedCostMicros: number | null;
  maxConfirmedCostMicros: number | null;
  maxToolMs: number | null;
  maxStorageBytes: number | null;
}
export interface TaskBudgetState extends TaskBudgetLimits {
  scope: string; activeMs: number; attempts: number; modelRequests: number; progressActiveMs: number;
  tokens: number; estimatedCostMicros: number; confirmedCostMicros: number; toolMs: number; storageBytes: number;
}
export interface TaskBudgetConsumption {
  modelRequests?: number;
  tokens?: number;
  estimatedCostMicros?: number;
  confirmedCostMicros?: number;
  toolMs?: number;
  storageBytes?: number;
}
export interface TaskEffectRecord {
  taskId: string; runId: string; attemptId: string; generation: number; effectId: string;
  status: string; operation: JsonValue | null; evidence: string | null; data: JsonValue | null;
}
export interface TaskRecoveryResult {
  outcome: 'pending' | 'succeeded' | 'failed' | 'not_applied'; evidence: string; result?: TaskResult;
  effects: { attemptId: string; effectId: string; outcome: 'succeeded' | 'failed' | 'not_applied'; evidence: string; data?: JsonValue }[];
}
export interface TaskProgress { message: string; fraction: number | null; timestamp: string }
export type TaskOwnerRole = 'personal' | 'service';
export interface TaskControlState {
  scope: 'service';
  stopped: boolean;
  persisted: boolean;
  generation: number;
  reason: string | null;
  updatedAt: number;
  activeTaskIds: string[];
}
export interface TaskWorkerState {
  runId: string;
  attemptId: string;
  generation: number;
  kind: 'host' | 'tool';
  pid: number;
  startIdentity: string;
  status: 'running' | 'exited' | 'stale' | 'unknown';
  parentHeartbeatAt: number;
  lastHeartbeatAt: number;
  lastActivityAt: number;
  exitCode?: number | null;
  signal?: string | null;
}
export interface TaskProcessState {
  pid: number;
  startIdentity: string;
  state: 'started' | 'exited';
  timestamp: number;
  exitCode?: number | null;
  signal?: string | null;
  settlement?: 'settled' | 'unknown';
}
export interface TaskProcessHeartbeat { pid: number; startIdentity: string; timestamp: number; activity: boolean }
export interface TaskRecord {
  id: string;
  title: string;
  conversationId: string | null;
  runtimeId: string;
  action: string;
  args: JsonValue;
  requestId: string;
  ownerRole: TaskOwnerRole;
  /** 外部主体/委托记录；本机操作者任务为空。 */
  subject: string | null;
  parentTaskId: string | null;
  versions: Record<string, string | null>;
  budgetScope: string;
  /** 任务绝对截止时刻；空值表示沿用所属业务目标或不单独设限。 */
  deadlineAt: number | null;
  controlGeneration: number | null;
  status: TaskStatus;
  currentRunId: string | null;
  currentAttemptId: string | null;
  generation: number;
  checkpoint: JsonValue | null;
  result: TaskResult | null;
  resultRef: string | null;
  error: TaskFailure | null;
  approvalId: string | null;
  requiresReview: boolean;
  dependencyIds: string[];
  blockedReason: string | null;
  reviewRequired: boolean;
  worker?: TaskWorkerState;
  sequence: number;
  version: number;
  createdAt: number;
  updatedAt: number;
  progress?: TaskProgress | null;
}
export interface TaskRun {
  id: string;
  taskId: string;
  status: TaskStatus;
  currentAttemptId: string;
  result: TaskResult | null;
  error: TaskFailure | null;
  createdAt: number;
  endedAt: number | null;
}
export interface TaskAttempt {
  id: string;
  taskId: string;
  runId: string;
  generation: number;
  controlGeneration: number | null;
  ordinal: number;
  status: TaskStatus;
  sideEffectStarted: boolean;
  unconfirmedEffects: number;
  result: TaskResult | null;
  resultRef: string | null;
  error: TaskFailure | null;
  checkpoint: JsonValue | null;
  startedAt: number;
  endedAt: number | null;
}
export type TaskRuntimeEvent =
  | { type: 'progress'; message: string; progress?: number; evidenceKey?: string; data?: JsonValue }
  | { type: 'side_effect_started'; effectId?: string; description?: string; operation?: JsonValue }
  | { type: 'side_effect_result'; effectId: string; outcome: 'succeeded' | 'failed' | 'not_applied'; evidence: string; data?: JsonValue }
  | { type: 'checkpoint'; checkpoint: JsonValue }
  | ({ type: 'process_state' } & TaskProcessState)
  | ({ type: 'heartbeat' } & TaskProcessHeartbeat);
export type TaskEventType = 'TASK_CREATED' | 'RUN_STARTED' | 'PROGRESS' | 'SIDE_EFFECT_STARTED' | 'SIDE_EFFECT_RESULT' | 'CHECKPOINT'
  | 'APPROVAL_REQUESTED' | 'APPROVAL_RESOLVED' | 'PAUSE_REQUESTED' | 'CANCEL_REQUESTED' | 'TASK_PAUSED' | 'TASK_CANCELLED'
  | 'TASK_SUCCEEDED' | 'TASK_FAILED' | 'TASK_INTERRUPTED' | 'TASK_NEEDS_REVIEW' | 'TASK_RECONCILED'
  | 'LATE_RESULT_RECORDED' | 'RECOVERY_LOOKUP'
  | 'TASK_BLOCKED' | 'TASK_READY' | 'DEPENDENCIES_UPDATED' | 'REVIEW_REQUESTED' | 'REVIEW_ACCEPTED' | 'REVIEW_REJECTED' | 'WORKER_STATE';
export interface TaskEvent {
  sequence: number;
  taskId: string;
  runId: string | null;
  attemptId: string | null;
  generation: number;
  type: TaskEventType;
  timestamp: string;
  data: JsonValue;
}
export interface TaskEventEnvelope { task: TaskRecord; event: TaskEvent }
export interface TaskCompletionClaim extends TaskEventEnvelope {
  consumerId: string; claimId: string; sequence: number; attemptId: string; generation: number;
  controlGeneration: number | null; versions: Record<string, string | null>;
}
