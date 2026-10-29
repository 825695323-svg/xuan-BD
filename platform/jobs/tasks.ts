import { randomUUID } from 'node:crypto';
import type { CoreDatabase } from '../state/database.js';
import { LocalDataLifecycleError } from '../runtime/errors.js';
import { digestOperationArgs, PermissionError, type ApprovalRequest, type AuthorizationReceipt, type OperationScope, type PermissionCapability, type PermissionService } from '../security/permissions.js';
import type { JsonValue, TaskAttempt, TaskBudgetConsumption, TaskBudgetLimits, TaskBudgetState, TaskCompletionClaim, TaskControlState, TaskEffectRecord, TaskEvent, TaskEventEnvelope, TaskEventType, TaskFailure, TaskFailureCategory, TaskOwnerRole, TaskRecord, TaskRecoveryResult, TaskResult, TaskRun, TaskRuntimeEvent, TaskStatus, TaskWorkerState } from '../../contracts/task-contracts.js';
export type { JsonValue, TaskAttempt, TaskControlState, TaskEvent, TaskEventEnvelope, TaskOwnerRole, TaskRecord, TaskResult, TaskRun, TaskRuntimeEvent, TaskStatus } from '../../contracts/task-contracts.js';

export type TaskOperation = Omit<OperationScope, 'runId' | 'attemptId' | 'generation'>;
export interface TaskExecutionContext {
  readonly task: TaskRecord;
  readonly runId: string;
  readonly attemptId: string;
  readonly generation: number;
  readonly controlGeneration: number | null;
  readonly signal: AbortSignal;
  emit(event: TaskRuntimeEvent): Promise<void>;
  consumeBudget(input: TaskBudgetConsumption): TaskBudgetState;
  operationScope(operation: TaskOperation): OperationScope;
  assertAuthorized(operation: TaskOperation, capabilities: readonly PermissionCapability[], options?: { approvalId?: string }): AuthorizationReceipt;
  requestApproval(operation: TaskOperation, capabilities: readonly PermissionCapability[], options?: { signal?: AbortSignal }): Promise<AuthorizationReceipt>;
}
export interface TaskRuntime {
  readonly id: string;
  execute(context: TaskExecutionContext): Promise<TaskResult>;
  /** 只核原动作身份；没有派发、授权或更换操作编号的能力。 */
  recover?(context: { readonly task: TaskRecord; readonly effects: readonly TaskEffectRecord[]; readonly signal: AbortSignal }): Promise<TaskRecoveryResult>;
}

/**
 * 宿主提供的同步派发闸门。assertDispatch 必须在创建尝试的同一数据库事务内调用；
 * assertAction 在每次新动作、预算计量与授权前调用，保证停用代次没有异步绕过的间隙。
 */
export interface TaskDispatchGuard {
  assertDispatch(task: TaskRecord): void;
  assertAction(taskId: string, attemptGeneration: number): void;
  release?(taskId: string): void;
}
export interface TaskCreateInput {
  title: string; conversationId?: string; runtimeId: string; action: string; args: JsonValue; requestId: string;
  dependencies?: string[]; reviewRequired?: boolean;
  ownerRole?: TaskOwnerRole; parentTaskId?: string; versions?: Record<string, string | null>;
  budgetScope?: string; budget?: Partial<TaskBudgetLimits>;
  /** 外部主体/委托记录；本地授权仍按持续与运行两种形态核对。 */
  subject?: string;
  /** 任务绝对截止时刻；不传表示不单独设限。 */
  deadlineAt?: number;
}
export class TaskError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'TaskError'; }
}
export class TaskRuntimeRegistry {
  private readonly entries = new Map<string, TaskRuntime>();
  register(runtime: TaskRuntime): void {
    validId(runtime.id);
    if (this.entries.has(runtime.id)) throw new TaskError('DUPLICATE_RUNTIME', '任务运行时已经登记。');
    this.entries.set(runtime.id, runtime);
  }
  get(id: string): TaskRuntime {
    const runtime = this.entries.get(id);
    if (!runtime) throw new TaskError('RUNTIME_NOT_CONFIGURED', '此任务运行时尚未配置。');
    return runtime;
  }
  list(): TaskRuntime[] { return [...this.entries.values()]; }
}
interface ActiveAttempt {
  taskId: string;
  runId: string;
  attemptId: string;
  generation: number;
  ownerRole: TaskOwnerRole;
  controlGeneration: number | null;
  controller: AbortController;
  stop?: 'pause' | 'cancel';
  approvalId?: string;
  done: Promise<void>;
  settle(error?: unknown): void;
  watchdogFailure?: TaskFailure;
  settled?: boolean;
}
interface ApprovalWaiter {
  active: ActiveAttempt;
  operation: OperationScope;
  capabilities: readonly PermissionCapability[];
  resolve(receipt: AuthorizationReceipt): void;
  reject(error: Error): void;
  signal?: AbortSignal;
  cleanup(): void;
}
const TERMINAL: readonly TaskStatus[] = ['succeeded', 'failed', 'cancelled'];
const SCHEMA = `
CREATE TABLE tasks (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, conversation_id TEXT, runtime_id TEXT NOT NULL,
  action TEXT NOT NULL, args TEXT NOT NULL, request_id TEXT NOT NULL UNIQUE, input_digest TEXT NOT NULL,
  status TEXT NOT NULL, current_run_id TEXT, current_attempt_id TEXT, generation INTEGER NOT NULL DEFAULT 0,
  checkpoint TEXT, result TEXT, error TEXT, approval_id TEXT, requires_review INTEGER NOT NULL DEFAULT 0,
  sequence INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE task_runs (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), status TEXT NOT NULL,
  current_attempt_id TEXT NOT NULL, result TEXT, error TEXT, created_at INTEGER NOT NULL, ended_at INTEGER
);
CREATE TABLE task_attempts (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), run_id TEXT NOT NULL REFERENCES task_runs(id),
  generation INTEGER NOT NULL, ordinal INTEGER NOT NULL, status TEXT NOT NULL,
  side_effect_started INTEGER NOT NULL DEFAULT 0, unconfirmed_effects INTEGER NOT NULL DEFAULT 0,
  result TEXT, error TEXT, checkpoint TEXT, started_at INTEGER NOT NULL, ended_at INTEGER,
  UNIQUE(run_id,ordinal), UNIQUE(task_id,generation)
);
CREATE TABLE task_effects (
  attempt_id TEXT NOT NULL REFERENCES task_attempts(id), id TEXT NOT NULL,
  status TEXT NOT NULL, description TEXT, operation TEXT, evidence TEXT, data TEXT,
  PRIMARY KEY(attempt_id,id)
);
CREATE TABLE task_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id), run_id TEXT,
  attempt_id TEXT, generation INTEGER NOT NULL, type TEXT NOT NULL, timestamp TEXT NOT NULL, data TEXT NOT NULL
);
CREATE INDEX task_events_lookup ON task_events(task_id,sequence);
CREATE INDEX task_attempts_run ON task_attempts(run_id,ordinal);
CREATE INDEX tasks_conversation ON tasks(conversation_id,created_at);
`;
const TASK_LIFECYCLE_SCHEMA = `
ALTER TABLE tasks ADD COLUMN blocked_reason TEXT;
ALTER TABLE tasks ADD COLUMN blocked_kind TEXT;
ALTER TABLE tasks ADD COLUMN review_required INTEGER NOT NULL DEFAULT 0;
CREATE TABLE task_dependencies (
  task_id TEXT NOT NULL REFERENCES tasks(id), dependency_id TEXT NOT NULL REFERENCES tasks(id),
  PRIMARY KEY(task_id,dependency_id), CHECK(task_id<>dependency_id)
);
CREATE INDEX task_dependencies_parent ON task_dependencies(dependency_id,task_id);
CREATE TABLE task_workers (
  attempt_id TEXT PRIMARY KEY REFERENCES task_attempts(id), run_id TEXT NOT NULL REFERENCES task_runs(id),
  generation INTEGER NOT NULL, kind TEXT NOT NULL, pid INTEGER NOT NULL, start_identity TEXT NOT NULL,
  status TEXT NOT NULL, parent_heartbeat_at INTEGER NOT NULL, last_heartbeat_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL, exit_code INTEGER, termination_signal TEXT
);
`;
const SERVICE_CONTROL_SCHEMA = `
ALTER TABLE tasks ADD COLUMN owner_role TEXT NOT NULL DEFAULT 'personal';
ALTER TABLE tasks ADD COLUMN parent_task_id TEXT REFERENCES tasks(id);
ALTER TABLE tasks ADD COLUMN versions TEXT NOT NULL DEFAULT '{}';
ALTER TABLE tasks ADD COLUMN control_generation INTEGER;
ALTER TABLE task_attempts ADD COLUMN control_generation INTEGER;
CREATE TABLE task_control (
  scope TEXT PRIMARY KEY CHECK(scope='service'), stopped INTEGER NOT NULL DEFAULT 0,
  generation INTEGER NOT NULL DEFAULT 0, reason TEXT, updated_at INTEGER NOT NULL
);
INSERT INTO task_control(scope,updated_at) VALUES('service',0);
CREATE TABLE task_control_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, generation INTEGER NOT NULL, stopped INTEGER NOT NULL,
  reason TEXT NOT NULL, timestamp TEXT NOT NULL
);
CREATE INDEX tasks_owner ON tasks(owner_role,created_at);
`;
const DURABILITY_SCHEMA = `
ALTER TABLE tasks ADD COLUMN budget_scope TEXT;
ALTER TABLE tasks ADD COLUMN progress_fraction REAL;
ALTER TABLE task_attempts ADD COLUMN accounted_at INTEGER;
ALTER TABLE task_attempts ADD COLUMN stop_intent TEXT;
CREATE TABLE task_budgets (
  scope TEXT PRIMARY KEY, max_active_ms INTEGER NOT NULL, max_no_progress_ms INTEGER NOT NULL,
  max_attempts INTEGER NOT NULL, max_model_requests INTEGER NOT NULL,
  active_ms INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
  model_requests INTEGER NOT NULL DEFAULT 0, progress_active_ms INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE task_progress_evidence (
  scope TEXT NOT NULL REFERENCES task_budgets(scope), evidence_key TEXT NOT NULL,
  PRIMARY KEY(scope,evidence_key)
);
CREATE TABLE task_completion_deliveries (
  consumer_id TEXT NOT NULL, sequence INTEGER NOT NULL REFERENCES task_events(sequence),
  claim_id TEXT NOT NULL, lease_until INTEGER NOT NULL, acknowledged_at INTEGER,
  PRIMARY KEY(consumer_id,sequence)
);
UPDATE tasks SET budget_scope=(WITH RECURSIVE parents(id,parent_task_id) AS (
  SELECT id,parent_task_id FROM tasks origin WHERE origin.id=tasks.id
  UNION ALL SELECT t.id,t.parent_task_id FROM tasks t JOIN parents p ON t.id=p.parent_task_id
) SELECT id FROM parents WHERE parent_task_id IS NULL LIMIT 1);
INSERT INTO task_budgets(scope,max_active_ms,max_no_progress_ms,max_attempts,max_model_requests,active_ms,attempts)
 SELECT t.budget_scope,900000,120000,32,8,
 COALESCE(SUM(CASE WHEN a.id IS NULL THEN 0 ELSE MAX(0,COALESCE(a.ended_at,CAST(strftime('%s','now') AS INTEGER)*1000)-a.started_at) END),0),
 COUNT(a.id) FROM tasks t LEFT JOIN task_attempts a ON a.task_id=t.id GROUP BY t.budget_scope;
UPDATE task_budgets SET progress_active_ms=active_ms;
UPDATE task_attempts SET accounted_at=COALESCE(ended_at,CAST(strftime('%s','now') AS INTEGER)*1000);
UPDATE task_attempts SET stop_intent=(SELECT CASE t.status WHEN 'pausing' THEN 'pause' WHEN 'cancelling' THEN 'cancel' END FROM tasks t WHERE t.id=task_id) WHERE ended_at IS NULL;
`;
const BASE_EXTENSION_SCHEMA = `
ALTER TABLE tasks ADD COLUMN deadline_at INTEGER;
ALTER TABLE tasks ADD COLUMN subject TEXT;
`;
const BUDGET_DIMENSIONS_SCHEMA = `
ALTER TABLE task_budgets ADD COLUMN max_tokens INTEGER;
ALTER TABLE task_budgets ADD COLUMN max_estimated_cost_micros INTEGER;
ALTER TABLE task_budgets ADD COLUMN max_confirmed_cost_micros INTEGER;
ALTER TABLE task_budgets ADD COLUMN max_tool_ms INTEGER;
ALTER TABLE task_budgets ADD COLUMN max_storage_bytes INTEGER;
ALTER TABLE task_budgets ADD COLUMN tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE task_budgets ADD COLUMN estimated_cost_micros INTEGER NOT NULL DEFAULT 0;
ALTER TABLE task_budgets ADD COLUMN confirmed_cost_micros INTEGER NOT NULL DEFAULT 0;
ALTER TABLE task_budgets ADD COLUMN tool_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE task_budgets ADD COLUMN storage_bytes INTEGER NOT NULL DEFAULT 0;
`;
const DEFAULT_BUDGET: TaskBudgetLimits = { maxActiveMs: 900_000, maxNoProgressMs: 120_000, maxAttempts: 32, maxModelRequests: 8,
  maxTokens: null, maxEstimatedCostMicros: null, maxConfirmedCostMicros: null, maxToolMs: null, maxStorageBytes: null };
const BUDGET_DIMENSIONS = [
  { input: 'modelRequests', limit: 'maxModelRequests', state: 'modelRequests', column: 'model_requests', limitColumn: 'max_model_requests', error: 'MODEL_BUDGET_EXHAUSTED', label: '模型请求' },
  { input: 'tokens', limit: 'maxTokens', state: 'tokens', column: 'tokens', limitColumn: 'max_tokens', error: 'TOKEN_BUDGET_EXHAUSTED', label: 'Token' },
  { input: 'estimatedCostMicros', limit: 'maxEstimatedCostMicros', state: 'estimatedCostMicros', column: 'estimated_cost_micros', limitColumn: 'max_estimated_cost_micros', error: 'ESTIMATED_COST_BUDGET_EXHAUSTED', label: '估计费用' },
  { input: 'confirmedCostMicros', limit: 'maxConfirmedCostMicros', state: 'confirmedCostMicros', column: 'confirmed_cost_micros', limitColumn: 'max_confirmed_cost_micros', error: 'CONFIRMED_COST_BUDGET_EXHAUSTED', label: '确认费用' },
  { input: 'toolMs', limit: 'maxToolMs', state: 'toolMs', column: 'tool_ms', limitColumn: 'max_tool_ms', error: 'TOOL_TIME_BUDGET_EXHAUSTED', label: '工具时间' },
  { input: 'storageBytes', limit: 'maxStorageBytes', state: 'storageBytes', column: 'storage_bytes', limitColumn: 'max_storage_bytes', error: 'STORAGE_BUDGET_EXHAUSTED', label: '存储用量' },
] as const;
const COMPLETION_EVENTS = ['TASK_SUCCEEDED', 'TASK_FAILED', 'TASK_NEEDS_REVIEW', 'TASK_INTERRUPTED', 'TASK_RECONCILED', 'REVIEW_REQUESTED', 'REVIEW_ACCEPTED'] as const;

/** 单个 Core 的持久任务所有者；一次调用一个运行时，重试只由明确的用户命令产生。 */
export class TaskService {
  private readonly database: CoreDatabase;
  private readonly runtimes: TaskRuntimeRegistry;
  private readonly permissions?: PermissionService;
  private readonly active = new Map<string, ActiveAttempt>();
  /** active 被有界等待移除后，runtime 真正返回前仍保留实际执行事实。 */
  private readonly executing = new Map<string, Promise<void>>();
  private readonly waiters = new Map<string, ApprovalWaiter>();
  private readonly listeners = new Set<(envelope: TaskEventEnvelope) => void>();
  private readonly publications: TaskEventEnvelope[] = [];
  private publishing = false;
  private closing = false;
  private serviceStopRequested = false;
  private serviceStopReason: string | null = null;
  private readonly hostIdentity = randomUUID();
  private readonly isConversationActive?: (id: string) => boolean;
  private readonly heartbeatTimer: ReturnType<typeof setInterval>;
  private readonly staleAfterMs: number;
  private readonly controlsAllTasks: boolean;
  private readonly dispatchGuard?: TaskDispatchGuard;

  constructor(options: { database: CoreDatabase; runtimes: TaskRuntimeRegistry; permissions?: PermissionService; recover?: boolean;
    isConversationActive?: (id: string) => boolean; heartbeatIntervalMs?: number; staleAfterMs?: number; controlsAllTasks?: boolean;
    dispatchGuard?: TaskDispatchGuard }) {
    this.database = options.database;
    this.runtimes = options.runtimes;
    this.permissions = options.permissions;
    this.isConversationActive = options.isConversationActive;
    this.controlsAllTasks = options.controlsAllTasks ?? false;
    this.dispatchGuard = options.dispatchGuard;
    const interval = options.heartbeatIntervalMs ?? 5000;
    this.staleAfterMs = options.staleAfterMs ?? 60_000;
    if (!Number.isSafeInteger(interval) || interval < 10 || interval > 60_000 || !Number.isSafeInteger(this.staleAfterMs) || this.staleAfterMs <= interval) {
      throw new TaskError('INVALID_HEARTBEAT', '任务心跳与失活观察时间无效。');
    }
    const version = Number(this.database.connection.prepare('SELECT version FROM schema_versions WHERE module=?').get('tasks')?.version ?? 0);
    this.database.migrate('tasks', 6, `${version === 0 ? SCHEMA : ''}${version < 2 ? TASK_LIFECYCLE_SCHEMA : ''}${version < 3 ? SERVICE_CONTROL_SCHEMA : ''}${version < 4 ? DURABILITY_SCHEMA : ''}${version < 5 ? BASE_EXTENSION_SCHEMA : ''}${version < 6 ? BUDGET_DIMENSIONS_SCHEMA : ''}`);
    if (options.recover !== false) this.recoverInterrupted();
    this.heartbeatTimer = setInterval(() => this.pulse(), interval);
    this.heartbeatTimer.unref();
  }

  create(input: TaskCreateInput): TaskRecord {
    const created = this.database.transaction(() => this.persistCreate(input));
    if (created.envelope) this.publish(created.envelope);
    return created.task;
  }

  createInTransaction(input: TaskCreateInput): { task: TaskRecord; publish(): void } {
    if (!this.database.connection.isTransaction) throw new TaskError('TRANSACTION_REQUIRED', '任务接收须在所属核心数据库事务内进行。');
    const created = this.persistCreate(input);
    let published = false;
    return { task: created.task, publish: () => {
      if (published || !created.envelope) return;
      if (this.database.connection.isTransaction) throw new TaskError('TRANSACTION_OPEN', '任务事件须在核心事务提交后发布。');
      const event = created.envelope.event;
      if (!this.database.connection.prepare("SELECT 1 FROM task_events WHERE sequence=? AND task_id=? AND type='TASK_CREATED'").get(event.sequence, event.taskId)) {
        throw new TaskError('TASK_NOT_COMMITTED', '任务接收尚未提交，事件不能发布。');
      }
      published = true;
      this.publish(created.envelope);
    } };
  }

  private persistCreate(input: TaskCreateInput): { task: TaskRecord; envelope?: TaskEventEnvelope } {
    this.assertOpen();
    if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 1000) throw new TaskError('INVALID_TASK', '任务需要 1 到 1,000 个字符的标题。');
    for (const value of [input.runtimeId, input.action, input.requestId]) validId(value);
    if (input.conversationId !== undefined) validId(input.conversationId);
    const ownerRole = input.ownerRole ?? 'personal';
    if (!['personal', 'service'].includes(ownerRole)) throw new TaskError('INVALID_TASK', '任务所属角色无效。');
    if (input.subject !== undefined) validId(input.subject);
    if (input.deadlineAt !== undefined && (!Number.isSafeInteger(input.deadlineAt) || input.deadlineAt < 1)) throw new TaskError('INVALID_DEADLINE', '任务截止时刻必须是正整数时间戳。');
    if (input.parentTaskId !== undefined) validId(input.parentTaskId);
    if (input.budgetScope !== undefined) validId(input.budgetScope);
    const now = Date.now();
    if (input.deadlineAt !== undefined && input.deadlineAt <= now) throw new TaskError('INVALID_DEADLINE', '任务截止时刻必须晚于受理时间。');
    const budget = validateBudget(input.budget);
    const versions = validateVersions(input.versions ?? {});
    const dependencyIds = validateDependencies(input.dependencies ?? []);
    if (input.reviewRequired !== undefined && typeof input.reviewRequired !== 'boolean') throw new TaskError('INVALID_TASK', '成果审核选项必须是布尔值。');
    const args = json(input.args, 128_000);
    const intent = { title: input.title.trim(), conversationId: input.conversationId ?? null, runtimeId: input.runtimeId, action: input.action, args: args.value,
      ...(dependencyIds.length ? { dependencies: dependencyIds } : {}), ...(input.reviewRequired ? { reviewRequired: true } : {}),
      ...(ownerRole === 'service' ? { ownerRole } : {}), ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
      ...(input.subject ? { subject: input.subject } : {}), ...(input.deadlineAt ? { deadlineAt: input.deadlineAt } : {}),
      ...(Object.keys(versions).length ? { versions } : {}),
      ...(input.budgetScope ? { budgetScope: input.budgetScope } : {}), ...(input.budget ? { budget } : {}) };
    const digest = digestOperationArgs(intent);
    const previous = this.database.connection.prepare('SELECT id,input_digest FROM tasks WHERE request_id=?').get(input.requestId);
    if (previous) {
      if (previous.input_digest !== digest) throw new TaskError('REQUEST_CONFLICT', '同一请求标识不能用于不同任务。');
      return { task: this.get(String(previous.id)) };
    }
    if (input.parentTaskId && this.get(input.parentTaskId).ownerRole !== ownerRole) throw new TaskError('TASK_OWNER_MISMATCH', '关联任务必须属于同一角色。');
    // 接收前置：新任务也先过当前本地资料资格；不靠创建后再派发失败。
    this.dispatchGuard?.assertDispatch({ id: 'receive', args: args.value } as TaskRecord);
    const id = randomUUID();
    const parent = input.parentTaskId ? this.get(input.parentTaskId) : null;
    if (parent && input.budgetScope && input.budgetScope !== parent.budgetScope) throw new TaskError('BUDGET_SCOPE_CONFLICT', '子任务必须沿用原目标的累计预算。');
    const budgetScope = parent?.budgetScope ?? input.budgetScope ?? id;
    const existingBudget = this.database.connection.prepare('SELECT * FROM task_budgets WHERE scope=?').get(budgetScope);
    if (existingBudget && input.budget && !sameBudget(existingBudget, budget)) throw new TaskError('BUDGET_IMMUTABLE', '原目标预算已冻结，续接或子任务不能扩大或重置。');
    if (!existingBudget) this.database.connection.prepare(`INSERT INTO task_budgets(scope,max_active_ms,max_no_progress_ms,max_attempts,max_model_requests,
      max_tokens,max_estimated_cost_micros,max_confirmed_cost_micros,max_tool_ms,max_storage_bytes) VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run(budgetScope, budget.maxActiveMs, budget.maxNoProgressMs, budget.maxAttempts, budget.maxModelRequests,
        budget.maxTokens, budget.maxEstimatedCostMicros, budget.maxConfirmedCostMicros, budget.maxToolMs, budget.maxStorageBytes);
    this.validateDependencyEdges(id, dependencyIds);
    const blocked = dependencyIds.some((dependencyId) => this.get(dependencyId).status !== 'succeeded');
    this.database.connection.prepare('INSERT INTO tasks(id,title,conversation_id,runtime_id,action,args,request_id,input_digest,status,created_at,updated_at,blocked_reason,blocked_kind,review_required,owner_role,parent_task_id,versions,subject,deadline_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, intent.title, intent.conversationId, input.runtimeId, input.action, args.text, input.requestId, digest, blocked ? 'blocked' : 'ready', now, now,
        blocked ? '等待依赖任务完成。' : null, blocked ? 'dependencies' : null, Number(input.reviewRequired ?? false), ownerRole, input.parentTaskId ?? null, json(versions).text,
        input.subject ?? null, input.deadlineAt ?? null);
    for (const dependencyId of dependencyIds) this.database.connection.prepare('INSERT INTO task_dependencies(task_id,dependency_id) VALUES(?,?)').run(id, dependencyId);
    this.database.connection.prepare('UPDATE tasks SET budget_scope=? WHERE id=?').run(budgetScope, id);
    const task = this.get(id);
    const envelope = this.record(task, 'TASK_CREATED', { runtimeId: input.runtimeId, action: input.action, dependencies: dependencyIds, reviewRequired: input.reviewRequired ?? false,
      ownerRole, parentTaskId: input.parentTaskId ?? null, versions,
      ...(input.subject ? { subject: input.subject } : {}), ...(input.deadlineAt ? { deadlineAt: input.deadlineAt } : {}) });
    return { task, envelope };
  }

  get(taskId: string): TaskRecord {
    const row = this.database.connection.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
    if (!row) throw new TaskError('TASK_NOT_FOUND', '没有找到此任务。');
    return {
      id: String(row.id), title: String(row.title), conversationId: nullableString(row.conversation_id), runtimeId: String(row.runtime_id),
      action: String(row.action), args: stored<JsonValue>(row.args), requestId: String(row.request_id), status: String(row.status) as TaskStatus,
      ownerRole: String(row.owner_role) as TaskOwnerRole, subject: nullableString(row.subject), parentTaskId: nullableString(row.parent_task_id), versions: stored<Record<string, string | null>>(row.versions),
      budgetScope: String(row.budget_scope ?? row.id), deadlineAt: row.deadline_at === null || row.deadline_at === undefined ? null : Number(row.deadline_at),
      controlGeneration: row.control_generation === null ? null : Number(row.control_generation), resultRef: row.result === null ? null : resultReference(nullableString(row.current_run_id)),
      currentRunId: nullableString(row.current_run_id), currentAttemptId: nullableString(row.current_attempt_id), generation: Number(row.generation),
      checkpoint: optionalStored<JsonValue>(row.checkpoint), result: optionalStored<TaskResult>(row.result), error: optionalStored<TaskFailure>(row.error),
      approvalId: nullableString(row.approval_id), requiresReview: Number(row.requires_review) === 1, sequence: Number(row.sequence), version: Number(row.version),
      dependencyIds: this.database.connection.prepare('SELECT dependency_id FROM task_dependencies WHERE task_id=? ORDER BY dependency_id').all(taskId).map((dependency) => String(dependency.dependency_id)),
      blockedReason: nullableString(row.blocked_reason), reviewRequired: Number(row.review_required) === 1,
      ...this.worker(taskId, nullableString(row.current_attempt_id)),
      createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), progress: this.latestProgress(nullableString(row.current_attempt_id)),
    };
  }

  list(filter: { conversationId?: string; ownerRole?: TaskOwnerRole; limit?: number } = {}): TaskRecord[] {
    const limit = filter.limit ?? 200;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new TaskError('INVALID_LIMIT', '任务查询上限需要在 1 到 1,000 之间。');
    if (filter.conversationId !== undefined) validId(filter.conversationId);
    if (filter.ownerRole !== undefined && !['personal', 'service'].includes(filter.ownerRole)) throw new TaskError('INVALID_TASK', '任务所属角色无效。');
    const rows = this.database.connection.prepare('SELECT id FROM tasks WHERE (? IS NULL OR conversation_id=?) AND (? IS NULL OR owner_role=?) ORDER BY created_at DESC,rowid DESC LIMIT ?')
      .all(filter.conversationId ?? null, filter.conversationId ?? null, filter.ownerRole ?? null, filter.ownerRole ?? null, limit);
    return rows.map((row) => this.get(String(row.id)));
  }

  getResult(reference: string): TaskResult {
    const prefix = typeof reference === 'string' && reference.startsWith('task-attempt-result:') ? 'task-attempt-result:' : 'task-result:';
    if (typeof reference !== 'string' || !reference.startsWith(prefix)) throw new TaskError('INVALID_RESULT_REFERENCE', '任务结果引用无效。');
    const id = reference.slice(prefix.length); validId(id);
    const row = prefix === 'task-result:'
      ? this.database.connection.prepare('SELECT result FROM task_runs WHERE id=?').get(id)
      : this.database.connection.prepare('SELECT result FROM task_attempts WHERE id=?').get(id);
    if (!row || row.result === null) throw new TaskError('RESULT_NOT_FOUND', '此运行没有已保存的任务结果。');
    return stored<TaskResult>(row.result);
  }

  getControl(): TaskControlState {
    const row = this.database.connection.prepare("SELECT * FROM task_control WHERE scope='service'").get();
    if (!row) throw new TaskError('CONTROL_NOT_FOUND', '服务角色控制记录缺失，禁止派发。');
    const persistedStop = Number(row.stopped) === 1;
    return { scope: 'service', stopped: this.serviceStopRequested || persistedStop, persisted: !this.serviceStopRequested || persistedStop,
      generation: Number(row.generation), reason: this.serviceStopRequested && !persistedStop ? this.serviceStopReason : nullableString(row.reason), updatedAt: Number(row.updated_at),
      activeTaskIds: this.database.connection.prepare("SELECT id FROM tasks WHERE (?=1 OR owner_role='service') AND status IN ('running','waiting_approval','pausing','cancelling') ORDER BY created_at,rowid").all(Number(this.controlsAllTasks)).map((task) => String(task.id)) };
  }

  async stopControl(reason: string): Promise<TaskControlState> {
    this.assertOpen();
    const message = validateReason(reason);
    this.serviceStopRequested = true; this.serviceStopReason = message;
    try {
      this.database.transaction(() => {
        const control = this.getControl();
        if (control.stopped && control.persisted) return;
        this.persistControl(true, control.generation + 1, message);
      });
    } catch {
      throw new TaskError('CONTROL_PERSISTENCE_FAILED', '本进程服务派发已停止，但控制记录未能持久化；不能保证重启后仍停止，请修复后重试停止。');
    } finally {
      // 本机停止不依赖持久化健康或模型配合；无本进程所有权的在途任务继续如实显示待收束。
      for (const active of this.active.values()) if (this.controlsAllTasks || active.ownerRole === 'service') {
        void this.pause(active.taskId).catch(() => { /* 本机闸门保持停止，持久缺口由控制/任务状态表示。 */ });
      }
    }
    return this.getControl();
  }

  resumeControl(expectedGeneration: number, reason: string): TaskControlState {
    this.assertOpen();
    const message = validateReason(reason);
    let resumed = false;
    try {
      this.database.transaction(() => {
        const control = this.getControl();
        if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) throw new TaskError('INVALID_VERSION', '控制代次必须是非负整数。');
        if (control.generation !== expectedGeneration) throw new TaskError('CONTROL_GENERATION_CONFLICT', '控制状态已经变化，请重新核对。');
        if (!control.stopped) return;
        if (control.activeTaskIds.length) throw new TaskError('CONTROL_BUSY', '服务任务尚未确认收束，请先核对其状态。');
        this.persistControl(false, control.generation + 1, message);
        resumed = true;
      });
    } catch (error) {
      if (error instanceof TaskError) throw error;
      this.serviceStopRequested = true;
      this.serviceStopReason ??= '恢复控制记录未能确认持久化。';
      throw new TaskError('CONTROL_PERSISTENCE_FAILED', '恢复控制记录未能持久化，服务派发继续保持停止。');
    }
    if (resumed) { this.serviceStopRequested = false; this.serviceStopReason = null; }
    return this.getControl();
  }

  private persistControl(stopped: boolean, generation: number, reason: string): void {
    this.database.connection.prepare("UPDATE task_control SET stopped=?,generation=?,reason=?,updated_at=? WHERE scope='service'")
      .run(Number(stopped), generation, reason, Date.now());
    this.database.connection.prepare('INSERT INTO task_control_events(generation,stopped,reason,timestamp) VALUES(?,?,?,?)')
      .run(generation, Number(stopped), reason, new Date().toISOString());
  }

  getRuns(taskId: string): TaskRun[] {
    this.get(taskId);
    return this.database.connection.prepare('SELECT * FROM task_runs WHERE task_id=? ORDER BY created_at,rowid').all(taskId).map((row) => ({
      id: String(row.id), taskId: String(row.task_id), status: String(row.status) as TaskStatus, currentAttemptId: String(row.current_attempt_id),
      result: optionalStored<TaskResult>(row.result), error: optionalStored<TaskFailure>(row.error), createdAt: Number(row.created_at), endedAt: row.ended_at === null ? null : Number(row.ended_at),
    }));
  }

  getAttempts(runId: string): TaskAttempt[] {
    return this.database.connection.prepare('SELECT * FROM task_attempts WHERE run_id=? ORDER BY ordinal').all(runId).map(attemptFromRow);
  }

  events(taskId: string, afterSequence = 0): TaskEvent[] {
    this.get(taskId);
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new TaskError('INVALID_SEQUENCE', '事件序号无效。');
    return this.database.connection.prepare('SELECT * FROM task_events WHERE task_id=? AND sequence>? ORDER BY sequence').all(taskId, afterSequence).map((row) => ({
      sequence: Number(row.sequence), taskId: String(row.task_id), runId: nullableString(row.run_id), attemptId: nullableString(row.attempt_id),
      generation: Number(row.generation), type: String(row.type) as TaskEventType, timestamp: String(row.timestamp), data: stored<JsonValue>(row.data),
    }));
  }

  subscribe(listener: (envelope: TaskEventEnvelope) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getBudget(taskId: string): TaskBudgetState {
    const task = this.get(taskId);
    const row = this.database.connection.prepare('SELECT * FROM task_budgets WHERE scope=?').get(task.budgetScope);
    if (!row) throw new TaskError('BUDGET_MISSING', '原任务累计预算记录缺失，禁止派发。');
    const now = Date.now(), live = this.budgetAttempts(task.budgetScope);
    const activeMs = Number(row.active_ms) + live.reduce((sum, attempt) => sum + (attempt.approvalWaiting ? 0 : Math.max(0, now - attempt.accountedAt)), 0);
    const limit = (column: string): number | null => row[column] === null || row[column] === undefined ? null : Number(row[column]);
    return { scope: task.budgetScope, maxActiveMs: Number(row.max_active_ms), maxNoProgressMs: Number(row.max_no_progress_ms), maxAttempts: Number(row.max_attempts),
      maxModelRequests: Number(row.max_model_requests), maxTokens: limit('max_tokens'), maxEstimatedCostMicros: limit('max_estimated_cost_micros'),
      maxConfirmedCostMicros: limit('max_confirmed_cost_micros'), maxToolMs: limit('max_tool_ms'), maxStorageBytes: limit('max_storage_bytes'),
      activeMs, attempts: Number(row.attempts), modelRequests: Number(row.model_requests), progressActiveMs: Number(row.progress_active_ms),
      tokens: Number(row.tokens ?? 0), estimatedCostMicros: Number(row.estimated_cost_micros ?? 0), confirmedCostMicros: Number(row.confirmed_cost_micros ?? 0),
      toolMs: Number(row.tool_ms ?? 0), storageBytes: Number(row.storage_bytes ?? 0) };
  }

  consumeBudget(taskId: string, input: TaskBudgetConsumption): TaskBudgetState {
    const amounts = BUDGET_DIMENSIONS.map((dimension) => ({ ...dimension, amount: input[dimension.input] ?? 0 }));
    if (amounts.some((entry) => !Number.isSafeInteger(entry.amount) || entry.amount < 0) || !amounts.some((entry) => entry.amount > 0)) {
      throw new TaskError('INVALID_BUDGET', '预算计量需要至少一项非负整数消耗。');
    }
    const work = () => {
      // 截止只阻断新增模型请求；已执行工作的 Token/费用/工具时间属于结算，不因结算时刻晚于截止而伪造未完成。
      if ((input.modelRequests ?? 0) > 0) this.assertDeadline(this.get(taskId), 'request');
      const budget = this.getBudget(taskId);
      this.assertBudgetAvailable(budget);
      for (const entry of amounts) {
        if (entry.amount === 0) continue;
        const maximum = budget[entry.limit];
        if (maximum !== null && budget[entry.state] + entry.amount > maximum) throw new TaskError(entry.error, `同一目标的累计${entry.label}预算已耗尽。`);
      }
      const consumed = amounts.filter((entry) => entry.amount > 0);
      const assignments = consumed.map((entry) => `${entry.column}=${entry.column}+?`).join(',');
      this.database.connection.prepare(`UPDATE task_budgets SET ${assignments} WHERE scope=?`)
        .run(...consumed.map((entry) => entry.amount), budget.scope);
      return this.getBudget(taskId);
    };
    return this.inTransaction(work);
  }

  /** 领取是持久租约；模型接收与 ack 应在同一核心事务内完成。 */
  claimCompletion(consumerId: string, options: { leaseMs?: number; taskId?: string } = {}): TaskCompletionClaim | null {
    validId(consumerId);
    if (options.taskId !== undefined) validId(options.taskId);
    const leaseMs = options.leaseMs ?? 30_000;
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 300_000) throw new TaskError('INVALID_LEASE', '完成事件租约无效。');
    return this.inTransaction(() => {
      const rows = this.database.connection.prepare(`SELECT e.* FROM task_events e
        JOIN tasks t ON t.id=e.task_id LEFT JOIN task_completion_deliveries d ON d.sequence=e.sequence AND d.consumer_id=?
        WHERE e.type IN (${COMPLETION_EVENTS.map(() => '?').join(',')}) AND (? IS NULL OR e.task_id=?)
        AND (d.sequence IS NULL OR (d.acknowledged_at IS NULL AND d.lease_until<=?)) ORDER BY e.sequence LIMIT 200`)
        .all(consumerId, ...COMPLETION_EVENTS, options.taskId ?? null, options.taskId ?? null, Date.now());
      for (const row of rows) {
        const task = this.get(String(row.task_id));
        if (!this.completionEligible(task, row)) {
          this.database.connection.prepare('INSERT INTO task_completion_deliveries(consumer_id,sequence,claim_id,lease_until,acknowledged_at) VALUES(?,?,?,?,?) ON CONFLICT(consumer_id,sequence) DO UPDATE SET acknowledged_at=excluded.acknowledged_at')
            .run(consumerId, Number(row.sequence), randomUUID(), 0, Date.now());
          continue;
        }
        const claimId = randomUUID(), sequence = Number(row.sequence);
        this.database.connection.prepare(`INSERT INTO task_completion_deliveries(consumer_id,sequence,claim_id,lease_until) VALUES(?,?,?,?)
          ON CONFLICT(consumer_id,sequence) DO UPDATE SET claim_id=excluded.claim_id,lease_until=excluded.lease_until`)
          .run(consumerId, sequence, claimId, Date.now() + leaseMs);
        const event: TaskEvent = { sequence, taskId: task.id, runId: nullableString(row.run_id), attemptId: nullableString(row.attempt_id), generation: Number(row.generation),
          type: String(row.type) as TaskEventType, timestamp: String(row.timestamp), data: stored<JsonValue>(row.data) };
        return { task, event, consumerId, claimId, sequence, attemptId: event.attemptId!, generation: event.generation, controlGeneration: task.controlGeneration, versions: task.versions };
      }
      return null;
    });
  }

  ackCompletion(consumerId: string, sequence: number, claimId: string): void {
    validId(consumerId); validId(claimId);
    this.inTransaction(() => {
      const row = this.database.connection.prepare('SELECT * FROM task_completion_deliveries WHERE consumer_id=? AND sequence=?').get(consumerId, sequence);
      if (row?.acknowledged_at !== null && row?.acknowledged_at !== undefined) return;
      if (!row || row.claim_id !== claimId || Number(row.lease_until) < Date.now()) throw new TaskError('COMPLETION_CLAIM_EXPIRED', '完成事件领取已失效，不能确认。');
      this.database.connection.prepare('UPDATE task_completion_deliveries SET acknowledged_at=? WHERE consumer_id=? AND sequence=?').run(Date.now(), consumerId, sequence);
    });
  }

  releaseCompletion(consumerId: string, sequence: number, claimId: string): void {
    validId(consumerId); validId(claimId);
    this.inTransaction(() => this.database.connection.prepare('UPDATE task_completion_deliveries SET lease_until=0 WHERE consumer_id=? AND sequence=? AND claim_id=? AND acknowledged_at IS NULL')
      .run(consumerId, sequence, claimId));
  }

  private completionEligible(task: TaskRecord, row: Record<string, unknown>): boolean {
    if (!row.attempt_id || task.currentAttemptId !== row.attempt_id || task.currentRunId !== row.run_id || task.generation !== Number(row.generation)
      || !['succeeded', 'failed', 'needs_review', 'interrupted', 'awaiting_review'].includes(task.status)) return false;
    const newer = this.database.connection.prepare(`SELECT 1 FROM task_events WHERE task_id=? AND attempt_id=? AND sequence>? AND type IN (${COMPLETION_EVENTS.map(() => '?').join(',')}) LIMIT 1`)
      .get(task.id, String(row.attempt_id), Number(row.sequence), ...COMPLETION_EVENTS);
    if (newer) return false;
    const attempt = this.database.connection.prepare('SELECT stop_intent FROM task_attempts WHERE id=?').get(task.currentAttemptId);
    if (attempt?.stop_intent) return false;
    if (this.controlsAllTasks || task.ownerRole === 'service') {
      const control = this.getControl();
      if (control.stopped || control.generation !== task.controlGeneration) return false;
    }
    return true;
  }

  private inTransaction<T>(work: () => T): T { return this.database.connection.isTransaction ? work() : this.database.transaction(work); }

  private budgetAttempts(scope: string): { id: string; accountedAt: number; approvalWaiting: boolean }[] {
    // 审批阻塞本尝试及同预算范围内的真实祖先；并行兄弟仍累计实际执行时间。
    return this.database.connection.prepare(`WITH RECURSIVE waiting(id) AS (
      SELECT t.id FROM tasks t JOIN task_attempts a ON a.id=t.current_attempt_id
        WHERE t.budget_scope=? AND a.ended_at IS NULL AND a.status='waiting_approval'
      UNION
      SELECT t.parent_task_id FROM tasks t JOIN waiting w ON w.id=t.id
        JOIN tasks p ON p.id=t.parent_task_id WHERE p.budget_scope=?
    ) SELECT a.id,a.accounted_at,w.id AS waiting_id FROM task_attempts a
      JOIN tasks t ON t.id=a.task_id LEFT JOIN waiting w ON w.id=t.id
      WHERE t.budget_scope=? AND a.ended_at IS NULL`).all(scope, scope, scope)
      .map(row => ({ id: String(row.id), accountedAt: Number(row.accounted_at), approvalWaiting: row.waiting_id !== null }));
  }

  private accountAttempt(attemptId: string, now = Date.now()): void {
    const row = this.database.connection.prepare('SELECT a.ended_at,t.budget_scope FROM task_attempts a JOIN tasks t ON t.id=a.task_id WHERE a.id=?').get(attemptId);
    if (!row || row.ended_at !== null) return;
    // 状态切换前结算整个范围，避免子任务离开审批态后把祖先的等待补算成活动。
    let delta = 0;
    for (const attempt of this.budgetAttempts(String(row.budget_scope))) {
      if (!attempt.approvalWaiting) delta += Math.max(0, now - attempt.accountedAt);
      this.database.connection.prepare('UPDATE task_attempts SET accounted_at=MAX(accounted_at,?) WHERE id=?').run(now, attempt.id);
    }
    this.database.connection.prepare('UPDATE task_budgets SET active_ms=active_ms+? WHERE scope=?').run(delta, row.budget_scope);
  }

  private assertBudgetAvailable(budget: TaskBudgetState): void {
    if (budget.activeMs >= budget.maxActiveMs) throw new TaskError('TASK_BUDGET_EXHAUSTED', '同一目标的累计执行时间预算已耗尽。');
    if (budget.activeMs - budget.progressActiveMs >= budget.maxNoProgressMs) throw new TaskError('TASK_NO_PROGRESS', '任务在有界等待内没有新的业务进展；未知外部结果保留待核。');
    for (const entry of BUDGET_DIMENSIONS) {
      const maximum = budget[entry.limit];
      if (maximum !== null && budget[entry.state] >= maximum) throw new TaskError(entry.error, `同一目标的累计${entry.label}预算已耗尽。`);
    }
  }

  /** 绝对截止与活动/无进展预算分别执行；截止到期后不再新增派发或模型请求。 */
  private assertDeadline(task: TaskRecord, stage: 'dispatch' | 'request'): void {
    if (task.deadlineAt === null) return;
    if (Date.now() >= task.deadlineAt) throw new TaskError('TASK_DEADLINE_EXCEEDED',
      stage === 'dispatch' ? '任务绝对截止时间已到，不能新增派发。' : '任务绝对截止时间已到，不能新增模型请求。');
  }

  start(taskId: string, expectedVersion?: number): TaskRecord { return this.launch(taskId, 'start', expectedVersion); }
  resume(taskId: string, expectedVersion?: number): TaskRecord { return this.launch(taskId, 'resume', expectedVersion); }
  retry(taskId: string, expectedVersion?: number): TaskRecord { return this.launch(taskId, 'retry', expectedVersion); }
  pause(taskId: string): Promise<TaskRecord> { return this.stop(taskId, 'pause'); }
  cancel(taskId: string): Promise<TaskRecord> { return this.stop(taskId, 'cancel'); }

  block(taskId: string, reason: string, expectedVersion: number): TaskRecord {
    const message = validateReason(reason);
    return this.mutateIdle(taskId, expectedVersion, 'TASK_BLOCKED', { reason: message }, (task) => {
      if (task.status === 'succeeded' || task.status === 'awaiting_review') throw new TaskError('INVALID_TASK_STATE', '已完成的成果请使用成果审核操作。');
      task.status = 'blocked'; task.blockedReason = message;
      this.database.connection.prepare("UPDATE tasks SET blocked_kind='manual' WHERE id=?").run(task.id);
    });
  }

  unblock(taskId: string, expectedVersion: number): TaskRecord {
    return this.mutateIdle(taskId, expectedVersion, 'TASK_READY', {}, (task) => {
      if (task.status !== 'blocked') throw new TaskError('INVALID_TASK_STATE', '只有已阻塞的任务可以解除阻塞。');
      if (!this.dependenciesSatisfied(task.id)) throw new TaskError('DEPENDENCY_UNSATISFIED', '依赖任务尚未完成，当前任务继续保持阻塞。');
      task.status = 'ready'; task.blockedReason = null; task.error = null;
    });
  }

  acceptReview(taskId: string, expectedVersion: number): TaskRecord {
    return this.mutateIdle(taskId, expectedVersion, 'REVIEW_ACCEPTED', {}, (task) => {
      if (task.status !== 'awaiting_review' || !task.result) throw new TaskError('INVALID_TASK_STATE', '此任务没有等待审核的已完成成果。');
      task.status = 'succeeded'; task.blockedReason = null; task.error = null;
      if (task.currentRunId) this.database.connection.prepare("UPDATE task_runs SET status='succeeded' WHERE id=?").run(task.currentRunId);
    });
  }

  rejectReview(taskId: string, reason: string, expectedVersion: number): TaskRecord {
    const message = validateReason(reason);
    return this.mutateIdle(taskId, expectedVersion, 'REVIEW_REJECTED', { reason: message }, (task) => {
      if (task.status !== 'awaiting_review' || !task.result) throw new TaskError('INVALID_TASK_STATE', '此任务没有等待审核的已完成成果。');
      task.status = 'blocked'; task.blockedReason = message; task.error = { code: 'REVIEW_REJECTED', message };
      this.database.connection.prepare("UPDATE tasks SET blocked_kind='review' WHERE id=?").run(task.id);
      if (task.currentRunId) this.database.connection.prepare("UPDATE task_runs SET status='blocked' WHERE id=?").run(task.currentRunId);
    });
  }

  setDependencies(taskId: string, dependencies: string[], expectedVersion: number): TaskRecord {
    const ids = validateDependencies(dependencies);
    return this.mutateIdle(taskId, expectedVersion, 'DEPENDENCIES_UPDATED', { dependencies: ids }, (task) => {
      if (task.status === 'succeeded' || task.status === 'awaiting_review') throw new TaskError('INVALID_TASK_STATE', '完成后的成果不能改写原依赖，请创建新的任务。');
      this.validateDependencyEdges(task.id, ids);
      const kind = this.database.connection.prepare('SELECT blocked_kind FROM tasks WHERE id=?').get(task.id)?.blocked_kind;
      this.database.connection.prepare('DELETE FROM task_dependencies WHERE task_id=?').run(task.id);
      for (const dependencyId of ids) this.database.connection.prepare('INSERT INTO task_dependencies(task_id,dependency_id) VALUES(?,?)').run(task.id, dependencyId);
      task.dependencyIds = ids;
      if (task.status !== 'blocked' || kind === 'dependencies') {
        if (!this.dependenciesSatisfied(task.id)) {
          task.status = 'blocked'; task.blockedReason = '等待依赖任务完成。';
          this.database.connection.prepare("UPDATE tasks SET blocked_kind='dependencies' WHERE id=?").run(task.id);
        } else if (task.status === 'blocked') { task.status = 'ready'; task.blockedReason = null; }
      }
    });
  }

  isRunActive(runId: string, generation: number): boolean {
    const live = [...this.active.values()].find((entry) => entry.runId === runId && entry.generation === generation);
    if (!live || live.stop || live.controller.signal.aborted || !this.owns(live)) return false;
    try { this.dispatchGuard?.assertAction(live.taskId, live.generation); } catch { return false; }
    if (!this.controlsAllTasks && live.ownerRole !== 'service') return true;
    if (this.serviceStopRequested) return false;
    const control = this.getControl();
    return !control.stopped && control.generation === live.controlGeneration;
  }

  async wait(taskId: string): Promise<TaskRecord> {
    const active = this.active.get(taskId);
    if (active) await active.done;
    return this.get(taskId);
  }

  approve(approvalId: string, capabilities?: readonly PermissionCapability[]): ApprovalRequest {
    const waiter = this.requireWaiter(approvalId);
    const permissions = this.requirePermissions();
    const approved = permissions.approve(approvalId, capabilities ?? waiter.capabilities);
    try {
      const receipt = permissions.assertAuthorized(waiter.operation, waiter.capabilities, { approvalId });
      this.resolveApproval(waiter, approvalId, 'approved');
      waiter.resolve(receipt);
      return approved;
    } catch (error) {
      waiter.cleanup();
      this.waiters.delete(approvalId);
      waiter.active.approvalId = undefined;
      waiter.reject(asError(error));
      throw error;
    }
  }

  deny(approvalId: string): ApprovalRequest {
    const waiter = this.requireWaiter(approvalId);
    const denied = this.requirePermissions().deny(approvalId);
    try {
      this.resolveApproval(waiter, approvalId, 'denied');
      waiter.reject(new TaskError('APPROVAL_DENIED', '用户拒绝了此任务动作。'));
      return denied;
    } catch (error) {
      waiter.cleanup();
      this.waiters.delete(approvalId); waiter.active.approvalId = undefined; waiter.reject(asError(error));
      throw error;
    }
  }

  reconcile(taskId: string, input: { outcome: 'succeeded' | 'failed' | 'not_applied' | 'cancelled' | 'pending'; evidence: string; result?: TaskResult }, expectedVersion?: number): TaskRecord {
    this.assertOpen();
    if (!['succeeded', 'failed', 'not_applied', 'cancelled', 'pending'].includes(input.outcome) || typeof input.evidence !== 'string' || !input.evidence.trim() || input.evidence.length > 32_000
      || (input.result !== undefined && input.outcome !== 'succeeded')) {
      throw new TaskError('INVALID_RECONCILIATION', '结果核对需要明确的结论和证据。');
    }
    let envelope!: TaskEventEnvelope;
    let dependencyEvents: TaskEventEnvelope[] = [];
    const task = this.database.transaction(() => {
      const current = this.get(taskId);
      if (expectedVersion !== undefined) this.assertVersion(current, expectedVersion);
      if ((input.result !== undefined || input.outcome === 'cancelled' || input.outcome === 'pending') && current.ownerRole !== 'service') throw new TaskError('INVALID_RECONCILIATION', '外部服务回执回填与确认取消只适用于服务任务。');
      const confirmedResult = input.result === undefined ? null : validateResult(input.result);
      const externalRecovery = current.ownerRole === 'service' && (confirmedResult !== null || input.outcome === 'cancelled' || input.outcome === 'pending');
      if (externalRecovery && (expectedVersion === undefined || !this.database.connection.prepare(`
        SELECT 1 FROM task_effects e JOIN task_attempts a ON a.id=e.attempt_id WHERE a.task_id=?
        AND json_type(e.operation,'$.handoffId')='text' AND json_type(e.operation,'$.requestId')='text' LIMIT 1
      `).get(taskId))) throw new TaskError('INVALID_RECONCILIATION', '外部核对必须指定当前版本，并保有原交接动作记录。');
      const waitingReview = current.status === 'needs_review' && current.requiresReview;
      const waitingExternal = externalRecovery && ['failed', 'paused', 'interrupted'].includes(current.status);
      if ((!waitingReview && !waitingExternal) || this.active.has(taskId)) throw new TaskError('REVIEW_NOT_REQUIRED', '此任务没有等待核对的未知结果。');
      const status: TaskStatus = input.outcome === 'not_applied' || input.outcome === 'pending' ? 'interrupted' : input.outcome === 'succeeded' && current.reviewRequired ? 'awaiting_review' : input.outcome;
      current.status = status;
      current.requiresReview = false;
      current.approvalId = null;
      current.error = input.outcome === 'failed' ? { ...classifiedFailure('RECONCILED_FAILED', '人工核对确认任务失败。'), stage: 'recovery' as const }
        : input.outcome === 'pending' ? { ...classifiedFailure('RECOVERY_PENDING', '外部服务已持久接手原动作，等待明确继续原业务。'), stage: 'recovery' as const } : null;
      const lateResult = current.ownerRole === 'service' && current.currentAttemptId ? this.attempt(current.currentAttemptId).result : null;
      current.result = input.outcome === 'succeeded' ? confirmedResult ?? current.result ?? lateResult ?? { summary: '已核对任务完成。', data: { reconciliationEvidence: input.evidence.trim() } } : null;
      this.database.connection.prepare('UPDATE task_effects SET status=?,evidence=? WHERE attempt_id=? AND status=\'started\'')
        .run(input.outcome === 'pending' ? 'succeeded' : input.outcome, input.evidence.trim(), current.currentAttemptId);
      // 历次尝试保留崩溃时的终态；核对结论追加到事件和运行投影，不覆写旧尝试。
      this.database.connection.prepare('UPDATE task_runs SET status=?,result=?,error=?,ended_at=? WHERE id=?')
        .run(status, encode(current.result), encode(current.error), status === 'interrupted' ? null : Date.now(), current.currentRunId);
      envelope = this.record(current, 'TASK_RECONCILED', { outcome: input.outcome, evidence: input.evidence.trim() });
      dependencyEvents = this.refreshDependents(current.id);
      return current;
    });
    this.publishMany([envelope, ...dependencyEvents]);
    return task;
  }

  /** 恢复只调用已登记运行时的原身份核对，不启动 execute，也不重新分配操作号。 */
  async recover(taskId: string): Promise<TaskRecord> {
    this.assertOpen();
    const task = this.get(taskId);
    if (this.active.has(taskId) || !['needs_review', 'interrupted', 'failed', 'paused'].includes(task.status)) throw new TaskError('RECOVERY_NOT_REQUIRED', '先等待原尝试收束，再核对其外部事实。');
    const runtime = this.runtimes.get(task.runtimeId);
    if (!runtime.recover) throw new TaskError('RECOVERY_NOT_SUPPORTED', '此运行时没有原外部身份核对接口；未知事实继续保留，禁止自动重发。');
    const effects = this.database.connection.prepare('SELECT e.*,a.task_id,a.run_id,a.generation FROM task_effects e JOIN task_attempts a ON a.id=e.attempt_id WHERE a.task_id=? ORDER BY a.started_at,e.id').all(taskId)
      .map((row): TaskEffectRecord => ({ taskId, runId: String(row.run_id), attemptId: String(row.attempt_id), generation: Number(row.generation), effectId: String(row.id),
        status: String(row.status), operation: optionalStored<JsonValue>(row.operation), evidence: nullableString(row.evidence), data: optionalStored<JsonValue>(row.data) }));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new TaskError('RECOVERY_TIMEOUT', '原外部身份核对超时，事实仍未知。')), 30_000);
    let recovered: TaskRecoveryResult;
    try {
      recovered = await Promise.race([runtime.recover({ task: structuredClone(task), effects: structuredClone(effects), signal: controller.signal }),
        new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }))]);
    } finally { clearTimeout(timeout); }
    if (!recovered || !['pending', 'succeeded', 'failed', 'not_applied'].includes(recovered.outcome) || typeof recovered.evidence !== 'string' || !recovered.evidence.trim()
      || recovered.evidence.length > 32_000 || !Array.isArray(recovered.effects) || recovered.effects.length > effects.length) throw new TaskError('INVALID_RECOVERY', '原身份核对没有返回有效证据。');
    const result = recovered.result === undefined ? null : validateResult(recovered.result);
    if (result && recovered.outcome !== 'succeeded') throw new TaskError('INVALID_RECOVERY', '只有确认成功的原动作能回填成果。');
    let envelope!: TaskEventEnvelope;
    let dependencyEvents: TaskEventEnvelope[] = [];
    this.database.transaction(() => {
      const current = this.get(taskId); this.assertVersion(current, task.version);
      if (this.active.has(taskId)) throw new TaskError('TASK_BUSY', '核对期间任务已开始新的尝试。');
      const seen = new Set<string>();
      for (const update of recovered.effects) {
        const key = `${update.attemptId}\0${update.effectId}`;
        const original = effects.find((effect) => effect.attemptId === update.attemptId && effect.effectId === update.effectId);
        if (!original || seen.has(key) || !['succeeded', 'failed', 'not_applied'].includes(update.outcome) || typeof update.evidence !== 'string' || !update.evidence.trim() || update.evidence.length > 32_000) throw new TaskError('INVALID_RECOVERY', '核对结果必须逐项对应原动作身份并带证据。');
        seen.add(key);
        if (original.status !== 'started') {
          if (original.status !== update.outcome) throw new TaskError('RECOVERY_CONFLICT', '核对结论与原已确认动作矛盾，保留原证据。');
          continue;
        }
        this.database.connection.prepare('UPDATE task_effects SET status=?,evidence=?,data=? WHERE attempt_id=? AND id=? AND status=\'started\'')
          .run(update.outcome, update.evidence.trim(), update.data === undefined ? null : json(update.data).text, update.attemptId, update.effectId);
        this.database.connection.prepare('UPDATE task_attempts SET unconfirmed_effects=MAX(0,unconfirmed_effects-1) WHERE id=?').run(update.attemptId);
      }
      const unknown = this.hasUnconfirmedTaskEffects(taskId);
      if (recovered.outcome !== 'pending' && unknown) throw new TaskError('RECOVERY_INCOMPLETE', '仍有原动作缺少确认，不能把任务核对为已完成。');
      if (recovered.outcome === 'pending') {
        envelope = this.record(current, 'RECOVERY_LOOKUP', { outcome: 'pending', evidence: recovered.evidence.trim() });
        return;
      }
      const stopIntent = current.currentAttemptId ? this.database.connection.prepare('SELECT stop_intent FROM task_attempts WHERE id=?').get(current.currentAttemptId)?.stop_intent : null;
      current.status = stopIntent ? stopIntent === 'cancel' ? 'cancelled' : 'paused' : recovered.outcome === 'not_applied' ? 'interrupted'
        : recovered.outcome === 'succeeded' ? current.reviewRequired ? 'awaiting_review' : 'succeeded' : 'failed';
      current.requiresReview = false;
      current.result = recovered.outcome === 'succeeded' ? result ?? { summary: '原动作已按固定身份核对完成。', data: { recoveryEvidence: recovered.evidence.trim() } } : null;
      current.error = recovered.outcome === 'failed' ? { ...classifiedFailure('RECOVERED_FAILED', '原外部动作核对为失败。'), stage: 'recovery' as const } : null;
      if (recovered.outcome === 'succeeded') this.database.connection.prepare('UPDATE task_budgets SET progress_active_ms=active_ms WHERE scope=?').run(current.budgetScope);
      if (current.currentAttemptId) this.database.connection.prepare("UPDATE task_workers SET status='exited' WHERE attempt_id=?").run(current.currentAttemptId);
      if (current.currentRunId) this.database.connection.prepare('UPDATE task_runs SET status=?,result=?,error=?,ended_at=? WHERE id=?')
        .run(current.status, encode(current.result), encode(current.error), Date.now(), current.currentRunId);
      envelope = this.record(current, 'TASK_RECONCILED', { outcome: recovered.outcome, evidence: recovered.evidence.trim(), stopRequested: stopIntent ? String(stopIntent) : null, source: 'runtime_original_identity' });
      dependencyEvents = this.refreshDependents(current.id);
    });
    this.publishMany([envelope, ...dependencyEvents]);
    return this.get(taskId);
  }

  /**
   * 只读实际执行事实：active 被有界等待移除后，drive 仍可能在运行；tool worker 以现存
   * pid/start_identity 和实际进程事实核对。不更新 worker 记录，不杀进程。
   */
  executionFacts(): { executing: number; active: number; unconfirmedWorkers: number; unconfirmedTaskIds: string[] } {
    this.assertOpen();
    const ids = new Set<string>(this.executing.keys());
    for (const taskId of this.active.keys()) ids.add(taskId);
    const rows = this.database.connection.prepare(`SELECT w.attempt_id,w.kind,w.pid,w.start_identity,w.status,t.id AS task_id
      FROM task_workers w JOIN task_attempts a ON a.id=w.attempt_id JOIN tasks t ON t.id=a.task_id
      WHERE w.status <> 'exited'`).all() as Array<{ attempt_id: string; kind: string; pid: number; start_identity: string; status: string; task_id: string }>;
    let unconfirmedWorkers = 0;
    for (const row of rows) {
      if (!row.start_identity) { unconfirmedWorkers += 1; ids.add(String(row.task_id)); continue; }
      const actual = processFact(Number(row.pid));
      if (actual === 'exited') continue;
      unconfirmedWorkers += 1;
      ids.add(String(row.task_id));
    }
    return { executing: this.executing.size, active: this.active.size, unconfirmedWorkers, unconfirmedTaskIds: [...ids] };
  }

  async dispose(): Promise<void> {
    this.closing = true;
    clearInterval(this.heartbeatTimer);
    const results = await Promise.allSettled([...this.active.keys()].map((id) => this.cancel(id)));
    this.listeners.clear();
    if (results.some((result) => result.status === 'rejected')) throw new TaskError('TASK_SHUTDOWN_FAILED', '任务已请求停止，但部分结果未能持久化。');
  }

  private launch(taskId: string, command: 'start' | 'resume' | 'retry', expectedVersion?: number): TaskRecord {
    this.assertOpen();
    const now = Date.now();
    let active!: ActiveAttempt;
    let envelope: TaskEventEnvelope | undefined;
    let dependencyEvents: TaskEventEnvelope[] = [];
    const task = this.database.transaction(() => {
      const current = this.get(taskId);
      if (expectedVersion !== undefined) this.assertVersion(current, expectedVersion);
      this.assertConversationActive(current);
      if (current.ownerRole === 'service' && current.status === 'succeeded' && command !== 'start') {
        throw new TaskError('TASK_COMPLETED', '已完成的服务任务不能原地重跑，请创建新任务并关联原任务。');
      }
      const previousActive = this.active.get(taskId);
      if (previousActive) {
        if (current.ownerRole === 'service' && previousActive.stop && command !== 'start') throw new TaskError('TASK_BUSY', '当前服务尝试尚未收束，请等待其实际状态。');
        return current;
      }
      if (this.executing.has(taskId)) throw new TaskError('TASK_EXECUTION_ACTIVE', '上一次实际执行尚未退出，不能派发同一任务的新尝试。');
      if (current.requiresReview || current.status === 'needs_review' || this.hasUnconfirmedTaskEffects(taskId)) {
        throw new TaskError('UNKNOWN_RESULT', '先核对上一次动作的实际结果，再继续任务。');
      }
      if (current.status === 'awaiting_review') throw new TaskError('REVIEW_PENDING', '请先接受成果或提出修改原因。');
      const blockedKind = this.database.connection.prepare('SELECT blocked_kind FROM tasks WHERE id=?').get(taskId)?.blocked_kind;
      if (current.status === 'blocked' && blockedKind !== 'dependencies') throw new TaskError('TASK_BLOCKED', '请先明确解除任务阻塞。');
      if (!this.dependenciesSatisfied(taskId)) {
        if (current.status !== 'blocked') {
          current.status = 'blocked'; current.blockedReason = '等待依赖任务完成。';
          this.database.connection.prepare("UPDATE tasks SET blocked_kind='dependencies' WHERE id=?").run(taskId);
          envelope = this.record(current, 'TASK_BLOCKED', { reason: current.blockedReason, kind: 'dependencies' });
        }
        return current;
      }
      if (current.status === 'blocked') { current.status = 'ready'; current.blockedReason = null; }
      if (command === 'start' && current.status !== 'ready') {
        if (current.currentRunId !== null) return current;
        throw new TaskError('INVALID_TASK_STATE', '任务当前不能启动。');
      }
      if (command === 'resume' && !['paused', 'interrupted'].includes(current.status)) throw new TaskError('INVALID_TASK_STATE', '只有暂停或已中断的任务可以继续。');
      if (command === 'retry' && !['failed', 'cancelled', 'interrupted', 'paused', 'succeeded'].includes(current.status)) throw new TaskError('INVALID_TASK_STATE', '任务当前不能重试。');
      if (current.status === 'succeeded' && this.hasActiveDependents(current.id)) throw new TaskError('DEPENDENT_BUSY', '依赖此成果的任务仍在运行，请等待或停止相关任务后重试。');
      const control = this.controlsAllTasks || current.ownerRole === 'service' ? this.getControl() : null;
      if (control?.stopped) throw new TaskError('HARNESS_STOPPED', '服务角色已停止；先核对状态并明确恢复控制。');
      this.assertDeadline(current, 'dispatch');
      const budget = this.getBudget(taskId); this.assertBudgetAvailable(budget);
      if (budget.attempts >= budget.maxAttempts) throw new TaskError('TASK_ATTEMPT_BUDGET_EXHAUSTED', '同一目标的累计尝试预算已耗尽。');
      // 停用检查与尝试写入同处一个同步事务；此处没有 await，失败即整体回滚。
      this.dispatchGuard?.assertDispatch(current);
      this.database.connection.prepare('UPDATE task_budgets SET attempts=attempts+1 WHERE scope=?').run(budget.scope);
      const runId = command === 'resume' && current.currentRunId ? current.currentRunId : randomUUID();
      const attemptId = randomUUID();
      const generation = current.generation + 1;
      const count = this.database.connection.prepare('SELECT COUNT(*) AS count FROM task_attempts WHERE run_id=?').get(runId);
      const ordinal = Number(count?.count ?? 0) + 1;
      if (ordinal === 1) this.database.connection.prepare('INSERT INTO task_runs(id,task_id,status,current_attempt_id,created_at) VALUES(?,?,?,?,?)').run(runId, taskId, 'running', attemptId, now);
      else this.database.connection.prepare('UPDATE task_runs SET status=\'running\',current_attempt_id=?,result=NULL,error=NULL,ended_at=NULL WHERE id=?').run(attemptId, runId);
      this.database.connection.prepare('INSERT INTO task_attempts(id,task_id,run_id,generation,ordinal,status,checkpoint,started_at,control_generation) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(attemptId, taskId, runId, generation, ordinal, 'running', encode(current.checkpoint), now, control?.generation ?? null);
      this.database.connection.prepare('UPDATE task_attempts SET accounted_at=? WHERE id=?').run(now, attemptId);
      current.status = 'running'; current.currentRunId = runId; current.currentAttemptId = attemptId; current.generation = generation;
      current.controlGeneration = control?.generation ?? null;
      this.database.connection.prepare("INSERT INTO task_workers(attempt_id,run_id,generation,kind,pid,start_identity,status,parent_heartbeat_at,last_heartbeat_at,last_activity_at) VALUES(?,?,?,'host',?,?,'running',?,?,?)")
        .run(attemptId, runId, generation, process.pid, this.hostIdentity, now, now, now);
      current.result = null; current.error = null; current.approvalId = null; current.blockedReason = null;
      envelope = this.record(current, 'RUN_STARTED', { command, ordinal, controlGeneration: current.controlGeneration });
      dependencyEvents = this.refreshDependents(current.id);
      active = activeAttempt(taskId, runId, attemptId, generation, current.ownerRole, current.controlGeneration);
      return current;
    });
    // 已启动或已结束的重复 start 不创建第二次执行。
    if (!active) { if (envelope) this.publish(envelope); return task; }
    this.active.set(taskId, active);
    this.publishMany([...(envelope ? [envelope] : []), ...dependencyEvents]);
    const execution = this.drive(active);
    this.executing.set(taskId, execution);
    void execution.finally(() => {
      if (this.executing.get(taskId) === execution) this.executing.delete(taskId);
    }).catch(() => { /* drive 已自行收束；这里只清理实际执行观察。 */ });
    return task;
  }

  private async drive(active: ActiveAttempt): Promise<void> {
    let result: TaskResult | null = null;
    let failure: TaskFailure | null = null;
    try {
      if (active.controller.signal.aborted) throw new TaskError('TASK_STOPPED', '任务已停止。');
      const runtime = this.runtimes.get(this.get(active.taskId).runtimeId);
      const scoped = (operation: TaskOperation): OperationScope => ({ ...operation, runId: active.runId, attemptId: active.attemptId, generation: active.generation });
      const context: TaskExecutionContext = {
        task: this.get(active.taskId), runId: active.runId, attemptId: active.attemptId, generation: active.generation, controlGeneration: active.controlGeneration, signal: active.controller.signal,
        emit: (event) => this.emitRuntime(active, event),
        consumeBudget: (input) => { this.assertAcceptsActions(active); return this.consumeBudget(active.taskId, input); },
        operationScope: scoped,
        assertAuthorized: (operation, capabilities, options) => {
          this.assertAcceptsActions(active);
          return this.requirePermissions().assertAuthorized(scoped(operation), capabilities, options);
        },
        requestApproval: (operation, capabilities, options) => this.awaitApproval(active, scoped(operation), capabilities, options),
      };
      const returned = await runtime.execute(context);
      if (active.approvalId) throw new TaskError('UNSETTLED_APPROVAL', '运行时返回前必须等待当前审批收口。');
      result = validateResult(returned);
    } catch (error) { failure = safeFailure(error); }
    if (failure) failure.stage ??= 'execute';
    if (active.watchdogFailure && !active.settled) { result = null; failure = active.watchdogFailure; }
    let envelopes: TaskEventEnvelope[] = [];
    let settleError: TaskError | undefined;
    try {
      if (active.approvalId) this.permissions?.invalidateAttempt(active.runId, active.attemptId, active.generation);
      envelopes = this.finish(active, result, failure);
    } catch {
      // 结果写入失败不发布成功；保留未收口记录，重启恢复按副作用标记核对。
      settleError = new TaskError('PERSISTENCE_FAILED', '执行已收束，但任务结果未能持久化，请重新打开后核对。');
    } finally {
      this.rejectWaiter(active, new TaskError('TASK_STOPPED', '任务已结束，审批不再有效。'));
      if (this.active.get(active.taskId) === active) this.active.delete(active.taskId);
      active.settle(settleError);
    }
    this.publishMany(envelopes);
  }

  private finish(active: ActiveAttempt, result: TaskResult | null, failure: TaskFailure | null): TaskEventEnvelope[] {
    const envelopes: TaskEventEnvelope[] = [];
    this.database.transaction(() => {
      if (active.settled || !this.owns(active)) {
        if (active.ownerRole !== 'service') return;
        const old = this.database.connection.prepare('SELECT result FROM task_attempts WHERE id=? AND task_id=? AND run_id=? AND generation=?')
          .get(active.attemptId, active.taskId, active.runId, active.generation);
        if (!old || old.result !== null) return;
        if (result) this.database.connection.prepare('UPDATE task_attempts SET result=? WHERE id=?').run(encode(result), active.attemptId);
        envelopes.push(this.record(this.get(active.taskId), 'LATE_RESULT_RECORDED', { source: 'runtime', resultRef: result ? `task-attempt-result:${active.attemptId}` : null,
          error: failure ? { code: failure.code, message: failure.message } : null }, active));
        return;
      }
      const task = this.get(active.taskId);
      this.accountAttempt(active.attemptId);
      const attempt = this.attempt(active.attemptId);
      // 每个副作用都需要结果证据；完整成功与停止相遇时不能落成可继续重放的暂停。
      const worker = this.database.connection.prepare('SELECT kind,status FROM task_workers WHERE attempt_id=?').get(active.attemptId);
      const processUnknown = worker?.kind === 'tool' && worker.status !== 'exited';
      const unknown = this.hasUnconfirmedEffects(active.attemptId) || processUnknown;
      if (!unknown && result) this.database.connection.prepare('UPDATE task_budgets SET progress_active_ms=active_ms WHERE scope=?').run(task.budgetScope);
      const status: TaskStatus = unknown ? 'needs_review' : result ? task.reviewRequired ? 'awaiting_review' : 'succeeded'
        : active.stop === 'pause' ? 'paused' : active.stop === 'cancel' ? 'cancelled' : 'failed';
      const error = unknown ? { ...classifiedFailure('RESULT_UNKNOWN', '动作已经开始，但结果未确认；先核对再重试。'), stage: 'settle' as const } : active.stop ? null : failure;
      task.status = status; task.result = result; task.error = error; task.requiresReview = unknown; task.approvalId = null;
      this.database.connection.prepare("UPDATE task_workers SET status=CASE WHEN kind='host' THEN 'exited' WHEN status='exited' THEN status ELSE 'unknown' END WHERE attempt_id=?").run(active.attemptId);
      this.database.connection.prepare('UPDATE task_attempts SET status=?,result=?,error=?,unconfirmed_effects=?,ended_at=? WHERE id=? AND ended_at IS NULL')
        .run(status === 'awaiting_review' ? 'succeeded' : status, encode(result), encode(error), attempt.unconfirmedEffects, Date.now(), active.attemptId);
      this.database.connection.prepare('UPDATE task_runs SET status=?,result=?,error=?,ended_at=? WHERE id=? AND current_attempt_id=?')
        .run(status, encode(result), encode(error), status === 'paused' ? null : Date.now(), active.runId, active.attemptId);
      envelopes.push(this.record(task, terminalEvent(status), { outcomeKnown: !unknown, stopRequested: active.stop ?? null, ...(active.watchdogFailure ? { watchdog: active.watchdogFailure.code } : {}) }));
      envelopes.push(...this.refreshDependents(task.id));
    });
    this.dispatchGuard?.release?.(active.taskId);
    return envelopes;
  }

  private async stop(taskId: string, command: 'pause' | 'cancel'): Promise<TaskRecord> {
    const active = this.active.get(taskId);
    if (!active) {
      const task = this.get(taskId);
      if (TERMINAL.includes(task.status) || task.status === 'needs_review' || task.status === 'awaiting_review' || (command === 'pause' && task.status === 'paused')) return task;
      let envelope!: TaskEventEnvelope;
      this.database.transaction(() => {
        const current = this.get(taskId);
        if (current.currentAttemptId) {
          this.accountAttempt(current.currentAttemptId);
          this.database.connection.prepare('UPDATE task_attempts SET stop_intent=? WHERE id=?').run(command, current.currentAttemptId);
        }
      const unknown = this.hasUnconfirmedTaskEffects(taskId);
        current.status = unknown ? 'needs_review' : command === 'pause' ? 'paused' : 'cancelled';
        current.requiresReview = unknown;
        if (unknown) current.error = { ...classifiedFailure('RESULT_UNKNOWN', '执行所有者已失联，已开始动作的结果需要核对。'), stage: 'recovery' as const };
        current.approvalId = null;
        if (current.currentAttemptId) this.database.connection.prepare('UPDATE task_attempts SET status=?,error=?,ended_at=? WHERE id=? AND ended_at IS NULL')
          .run(current.status, encode(current.error), Date.now(), current.currentAttemptId);
        if (current.currentRunId) this.database.connection.prepare('UPDATE task_runs SET status=?,ended_at=? WHERE id=?').run(current.status, command === 'pause' ? null : Date.now(), current.currentRunId);
        envelope = this.record(current, unknown ? 'TASK_NEEDS_REVIEW' : command === 'pause' ? 'TASK_PAUSED' : 'TASK_CANCELLED', { hadActiveAttempt: false, outcomeKnown: !unknown });
      });
      if (task.currentRunId) this.permissions?.cancelForRun(task.currentRunId, task.generation);
      this.dispatchGuard?.release?.(taskId);
      this.publish(envelope);
      return this.get(taskId);
    }
    if (active.stop !== 'cancel' && active.stop !== command) {
      // 此标记立即撤销动作资格；持久化和停止等待期间不能继续申请授权。
      active.stop = command;
      let envelope: TaskEventEnvelope | undefined;
      let requestFailed = false;
      try {
        this.database.transaction(() => {
          if (!this.owns(active)) return;
          const task = this.get(taskId);
          this.accountAttempt(active.attemptId);
          task.status = command === 'pause' ? 'pausing' : 'cancelling'; task.approvalId = null;
          this.database.connection.prepare('UPDATE task_attempts SET stop_intent=? WHERE id=?').run(command, active.attemptId);
          this.database.connection.prepare('UPDATE task_attempts SET status=? WHERE id=? AND ended_at IS NULL').run(task.status, active.attemptId);
          this.database.connection.prepare('UPDATE task_runs SET status=? WHERE id=?').run(task.status, active.runId);
          envelope = this.record(task, command === 'pause' ? 'PAUSE_REQUESTED' : 'CANCEL_REQUESTED', {});
        });
        this.permissions?.cancelForRun(active.runId, active.generation);
      } catch { requestFailed = true;
      } finally {
        this.rejectWaiter(active, new TaskError('TASK_STOPPED', '任务已停止，待审批动作未执行。'));
        active.controller.abort(new TaskError('TASK_STOPPED', '任务已请求停止。'));
      }
      if (envelope) this.publish(envelope);
      await this.waitForStop(active);
      if (requestFailed) throw new TaskError('PERSISTENCE_FAILED', '停止已收束，但部分控制记录未能持久化，请核对任务状态。');
      return this.get(taskId);
    }
    await this.waitForStop(active);
    return this.get(taskId);
  }

  private async emitRuntime(active: ActiveAttempt, input: TaskRuntimeEvent): Promise<void> {
    const event = normalizeRuntimeEvent(input);
    if (!this.owns(active)) {
      if (event.type === 'side_effect_started') throw new TaskError('STALE_ATTEMPT', '较早的尝试不能启动新动作。');
      if (active.ownerRole === 'service' && event.type === 'side_effect_result') this.recordLateEffect(active, event);
      return;
    }
    if (event.type === 'side_effect_started') this.assertAcceptsActions(active);
    if (event.type === 'progress' && active.stop) return;
    if (event.type === 'heartbeat') {
      this.database.transaction(() => {
        if (!this.owns(active)) return;
        const now = Date.now();
        this.database.connection.prepare("UPDATE task_workers SET last_heartbeat_at=?,last_activity_at=CASE WHEN ? THEN ? ELSE last_activity_at END,status=CASE WHEN ? AND status='stale' THEN 'running' ELSE status END WHERE attempt_id=? AND run_id=? AND generation=? AND kind='tool' AND pid=? AND start_identity=? AND status IN ('running','stale')")
          .run(now, Number(event.activity), now, Number(event.activity), active.attemptId, active.runId, active.generation, event.pid, event.startIdentity);
      });
      return;
    }
    let envelope: TaskEventEnvelope | undefined;
    this.database.transaction(() => {
      if (!this.owns(active)) throw new TaskError('STALE_ATTEMPT', '任务尝试已经被替换。');
      const task = this.get(active.taskId);
      if (event.type !== 'process_state') this.database.connection.prepare("UPDATE task_workers SET last_activity_at=?,status=CASE WHEN status='stale' THEN 'running' ELSE status END WHERE attempt_id=?").run(Date.now(), active.attemptId);
      switch (event.type) {
        case 'process_state': {
          const row = this.database.connection.prepare('SELECT kind,pid,start_identity,status FROM task_workers WHERE attempt_id=?').get(active.attemptId);
          if (!row) throw new TaskError('WORKER_RECORD_MISSING', '当前任务的运行观察记录缺失。');
          if (event.state === 'started') {
            if (row.kind === 'tool' && row.status !== 'exited' && row.start_identity !== event.startIdentity) {
              throw new TaskError('PROCESS_BUSY', '上一工具进程尚未确认收束，不能覆盖其运行身份。');
            }
            this.database.connection.prepare("UPDATE task_workers SET kind='tool',pid=?,start_identity=?,status='running',last_heartbeat_at=?,last_activity_at=?,exit_code=NULL,termination_signal=NULL WHERE attempt_id=?")
              .run(event.pid, event.startIdentity, Date.now(), Date.now(), active.attemptId);
          } else {
            if (row.kind !== 'tool' || row.pid !== event.pid || row.start_identity !== event.startIdentity) return;
            this.database.connection.prepare('UPDATE task_workers SET status=?,last_heartbeat_at=?,last_activity_at=?,exit_code=?,termination_signal=? WHERE attempt_id=?')
              .run(event.settlement === 'unknown' ? 'unknown' : 'exited', Date.now(), Date.now(), event.exitCode ?? null, event.signal ?? null, active.attemptId);
          }
          envelope = this.record(task, 'WORKER_STATE', event as unknown as JsonValue);
          break;
        }
        case 'progress':
          if (typeof event.message !== 'string' || event.message.length > 32_000 || (event.progress !== undefined && (!Number.isFinite(event.progress) || event.progress < 0 || event.progress > 1))) throw new TaskError('INVALID_EVENT', '进度内容或比例无效。');
          this.accountAttempt(active.attemptId);
          if (event.evidenceKey !== undefined) validId(event.evidenceKey);
          const oldFraction = this.database.connection.prepare('SELECT progress_fraction FROM tasks WHERE id=?').get(task.id)?.progress_fraction;
          const newEvidence = event.evidenceKey === undefined ? false : this.database.connection.prepare('INSERT OR IGNORE INTO task_progress_evidence(scope,evidence_key) VALUES(?,?)').run(task.budgetScope, event.evidenceKey).changes === 1;
          const advancing = event.progress !== undefined && event.progress > Number(oldFraction ?? 0);
          if (advancing) this.database.connection.prepare('UPDATE tasks SET progress_fraction=? WHERE id=?').run(event.progress!, task.id);
          if (newEvidence || advancing) this.database.connection.prepare('UPDATE task_budgets SET progress_active_ms=active_ms WHERE scope=?').run(task.budgetScope);
          envelope = this.record(task, 'PROGRESS', event as unknown as JsonValue);
          break;
        case 'checkpoint':
          task.checkpoint = json(event.checkpoint).value;
          this.database.connection.prepare('UPDATE task_attempts SET checkpoint=? WHERE id=?').run(encode(task.checkpoint), active.attemptId);
          envelope = this.record(task, 'CHECKPOINT', { checkpoint: task.checkpoint });
          break;
        case 'side_effect_started': {
          const effectId = event.effectId ?? randomUUID(); validId(effectId);
          if (event.description !== undefined && (typeof event.description !== 'string' || event.description.length > 32_000)) throw new TaskError('INVALID_EVENT', '动作说明无效。');
          if (this.database.connection.prepare('SELECT 1 FROM task_effects WHERE attempt_id=? AND id=?').get(active.attemptId, effectId)) throw new TaskError('DUPLICATE_EFFECT', '同一尝试的动作标识不能重复执行。');
          this.database.connection.prepare('INSERT INTO task_effects(attempt_id,id,status,description,operation) VALUES(?,?,\'started\',?,?)')
            .run(active.attemptId, effectId, event.description ?? null, event.operation === undefined ? null : json(event.operation).text);
          this.database.connection.prepare('UPDATE task_attempts SET side_effect_started=1,unconfirmed_effects=unconfirmed_effects+1 WHERE id=?').run(active.attemptId);
          envelope = this.record(task, 'SIDE_EFFECT_STARTED', { effectId, description: event.description ?? null, operation: event.operation ?? null });
          break;
        }
        case 'side_effect_result': {
          validId(event.effectId);
          if (!['succeeded', 'failed', 'not_applied'].includes(event.outcome) || typeof event.evidence !== 'string' || !event.evidence.trim() || event.evidence.length > 32_000) throw new TaskError('INVALID_EVENT', '动作结果需要明确结论与证据。');
          const effect = this.database.connection.prepare('SELECT status,operation FROM task_effects WHERE attempt_id=? AND id=?').get(active.attemptId, event.effectId);
          if (!effect || effect.status !== 'started') throw new TaskError('INVALID_EFFECT', '没有待确认的对应动作。');
          this.database.connection.prepare('UPDATE task_effects SET status=?,evidence=?,data=? WHERE attempt_id=? AND id=?')
            .run(event.outcome, event.evidence.trim(), event.data === undefined ? null : json(event.data).text, active.attemptId, event.effectId);
          this.database.connection.prepare('UPDATE task_attempts SET unconfirmed_effects=unconfirmed_effects-1 WHERE id=?').run(active.attemptId);
          this.accountAttempt(active.attemptId);
          // 只有带明确原操作的完全重复事实去重；新失败或未应用仍是可核的新事实。
          const operation = optionalStored<JsonValue>(effect.operation);
          const evidenceKey = operation === null ? null : 'side-effect:' + digestOperationArgs({ action: task.action,
            operation, outcome: event.outcome, evidence: event.evidence.trim(), data: event.data ?? null });
          if (evidenceKey === null || this.database.connection.prepare('INSERT OR IGNORE INTO task_progress_evidence(scope,evidence_key) VALUES(?,?)').run(task.budgetScope, evidenceKey).changes === 1) {
            this.database.connection.prepare('UPDATE task_budgets SET progress_active_ms=active_ms WHERE scope=?').run(task.budgetScope);
          }
          envelope = this.record(task, 'SIDE_EFFECT_RESULT', event as unknown as JsonValue);
          break;
        }
        default: throw new TaskError('INVALID_EVENT', '不支持此任务事件。');
      }
    });
    if (envelope) this.publish(envelope);
  }

  private recordLateEffect(active: ActiveAttempt, event: Extract<TaskRuntimeEvent, { type: 'side_effect_result' }>): void {
    validId(event.effectId);
    if (!['succeeded', 'failed', 'not_applied'].includes(event.outcome) || typeof event.evidence !== 'string' || !event.evidence.trim() || event.evidence.length > 32_000) {
      throw new TaskError('INVALID_EVENT', '迟到动作结果需要明确结论与证据。');
    }
    let envelope: TaskEventEnvelope | undefined;
    this.database.transaction(() => {
      const effect = this.database.connection.prepare('SELECT status FROM task_effects WHERE attempt_id=? AND id=?').get(active.attemptId, event.effectId);
      if (!effect || effect.status !== 'started') return;
      this.database.connection.prepare('UPDATE task_effects SET status=?,evidence=?,data=? WHERE attempt_id=? AND id=?')
        .run(event.outcome, event.evidence.trim(), event.data === undefined ? null : json(event.data).text, active.attemptId, event.effectId);
      this.database.connection.prepare('UPDATE task_attempts SET unconfirmed_effects=MAX(0,unconfirmed_effects-1) WHERE id=?').run(active.attemptId);
      envelope = this.record(this.get(active.taskId), 'LATE_RESULT_RECORDED', json({ source: 'side_effect', ...event }).value, active);
    });
    if (envelope) this.publish(envelope);
  }

  private awaitApproval(active: ActiveAttempt, operation: OperationScope, capabilities: readonly PermissionCapability[], options: { signal?: AbortSignal } = {}): Promise<AuthorizationReceipt> {
    this.assertAcceptsActions(active);
    if (options.signal?.aborted) throw new TaskError('APPROVAL_SCOPE_STOPPED', '当前动作已停止，审批未发起。');
    if (active.approvalId) throw new TaskError('APPROVAL_ALREADY_PENDING', '当前尝试已有一个待审批动作。');
    const permissions = this.requirePermissions();
    const request = permissions.requestApproval(operation, capabilities);
    let envelope!: TaskEventEnvelope;
    try {
      this.database.transaction(() => {
        this.assertAcceptsActions(active);
        const task = this.get(active.taskId);
        this.accountAttempt(active.attemptId);
        task.status = 'waiting_approval'; task.approvalId = request.id;
        this.database.connection.prepare('UPDATE task_attempts SET status=\'waiting_approval\' WHERE id=?').run(active.attemptId);
        this.database.connection.prepare('UPDATE task_runs SET status=\'waiting_approval\' WHERE id=?').run(active.runId);
        envelope = this.record(task, 'APPROVAL_REQUESTED', { approvalId: request.id });
      });
    } catch (error) {
      // 权限请求已经提交，但任务事件未提交；不能留下一条没有等待者的待审批。
      permissions.invalidateAttempt(active.runId, active.attemptId, active.generation);
      throw error;
    }
    let cancelScope!: () => void;
    const waiting = new Promise<AuthorizationReceipt>((resolve, reject) => {
      active.approvalId = request.id;
      this.waiters.set(request.id, { active, operation: structuredClone(operation), capabilities: structuredClone(capabilities), resolve, reject,
        signal: options.signal, cleanup: () => options.signal?.removeEventListener('abort', cancelScope) });
    });
    void waiting.catch(() => {});
    cancelScope = () => { this.cancelScopedApproval(request.id); };
    options.signal?.addEventListener('abort', cancelScope, { once: true });
    if (options.signal?.aborted) {
      const cancelled = this.cancelScopedApproval(request.id, false);
      this.publishMany([envelope, ...(cancelled ? [cancelled] : [])]);
    } else this.publish(envelope);
    return waiting;
  }

  private cancelScopedApproval(id: string, publish = true, reason?: TaskError): TaskEventEnvelope | undefined {
    const waiter = this.waiters.get(id);
    if (!waiter || waiter.active.approvalId !== id) return;
    // 持久化失败可能同步中止组合 signal；先移除本次监听，避免撤销再次进入。
    waiter.cleanup();
    let envelope: TaskEventEnvelope | undefined;
    let error = reason ?? new TaskError('APPROVAL_SCOPE_STOPPED', '当前动作已停止，其待审批请求已撤销。');
    try {
      this.requirePermissions().cancelPendingApproval(id, waiter.operation);
      this.database.transaction(() => {
        if (!this.owns(waiter.active)) return;
        const task = this.get(waiter.active.taskId);
        if (task.approvalId !== id) return;
        this.accountAttempt(waiter.active.attemptId);
        task.approvalId = null;
        task.status = waiter.active.stop === 'pause' ? 'pausing' : waiter.active.stop === 'cancel' ? 'cancelling' : 'running';
        this.database.connection.prepare('UPDATE task_attempts SET status=? WHERE id=? AND ended_at IS NULL').run(task.status, waiter.active.attemptId);
        this.database.connection.prepare('UPDATE task_runs SET status=? WHERE id=? AND current_attempt_id=?').run(task.status, waiter.active.runId, waiter.active.attemptId);
        envelope = this.record(task, 'APPROVAL_RESOLVED', { approvalId: id, decision: 'invalidated', scoped: true,
          ...(reason ? { reason: reason.code } : {}) });
      });
    } catch {
      error = new TaskError('PERSISTENCE_FAILED', '当前审批撤销未能持久化，任务已请求停止并保留待核对记录。');
      waiter.active.stop = 'cancel';
      waiter.active.controller.abort(error);
    } finally {
      waiter.cleanup(); this.waiters.delete(id);
      if (waiter.active.approvalId === id) waiter.active.approvalId = undefined;
      waiter.reject(error);
    }
    if (publish && envelope) this.publish(envelope);
    return envelope;
  }

  private requireWaiter(id: string): ApprovalWaiter {
    const waiter = this.waiters.get(id);
    if (!waiter || waiter.signal?.aborted || !this.isRunActive(waiter.active.runId, waiter.active.generation)) throw new TaskError('APPROVAL_NOT_WAITING', '此审批没有当前有效的待执行任务。');
    return waiter;
  }

  private resolveApproval(waiter: ApprovalWaiter, id: string, decision: 'approved' | 'denied'): void {
    let envelope!: TaskEventEnvelope;
    this.database.transaction(() => {
      this.assertAcceptsActions(waiter.active);
      const task = this.get(waiter.active.taskId);
      if (task.approvalId !== id) throw new TaskError('STALE_APPROVAL', '此审批已被替换。');
      this.accountAttempt(waiter.active.attemptId);
      task.status = 'running'; task.approvalId = null;
      this.database.connection.prepare('UPDATE task_attempts SET status=\'running\' WHERE id=?').run(waiter.active.attemptId);
      this.database.connection.prepare('UPDATE task_runs SET status=\'running\' WHERE id=?').run(waiter.active.runId);
      envelope = this.record(task, 'APPROVAL_RESOLVED', { approvalId: id, decision });
    });
    waiter.cleanup(); this.waiters.delete(id); waiter.active.approvalId = undefined;
    this.publish(envelope);
  }

  private rejectWaiter(active: ActiveAttempt, error: Error): void {
    if (!active.approvalId) return;
    const waiter = this.waiters.get(active.approvalId);
    waiter?.cleanup();
    this.waiters.delete(active.approvalId); active.approvalId = undefined;
    waiter?.reject(error);
  }

  private mutateIdle(taskId: string, expectedVersion: number, type: TaskEventType, data: JsonValue,
    mutation: (task: TaskRecord) => void): TaskRecord {
    this.assertOpen();
    let envelope!: TaskEventEnvelope;
    let dependents: TaskEventEnvelope[] = [];
    this.database.transaction(() => {
      const task = this.get(taskId);
      this.assertVersion(task, expectedVersion);
      if (this.active.has(taskId) || (task.currentAttemptId && this.attempt(task.currentAttemptId).endedAt === null)) {
        throw new TaskError('TASK_BUSY', '请等待当前任务尝试真正收束后再操作。');
      }
      if (task.requiresReview || task.status === 'needs_review' || (task.currentAttemptId && this.hasUnconfirmedEffects(task.currentAttemptId))) {
        throw new TaskError('UNKNOWN_RESULT', '未知动作结果须先人工核对，不能用阻塞或成果审核替代。');
      }
      mutation(task);
      envelope = this.record(task, type, data);
      dependents = this.refreshDependents(task.id);
    });
    this.publishMany([envelope, ...dependents]);
    return this.get(taskId);
  }

  private assertVersion(task: TaskRecord, version: number): void {
    if (!Number.isSafeInteger(version) || version < 0) throw new TaskError('INVALID_VERSION', '任务版本必须是非负整数。');
    if (task.version !== version) throw new TaskError('TASK_VERSION_CONFLICT', '任务状态已经变化，请重新查看。');
  }

  private assertConversationActive(task: TaskRecord): void {
    if (task.conversationId && this.isConversationActive && !this.isConversationActive(task.conversationId)) {
      throw new TaskError('CONVERSATION_INACTIVE', '请先恢复关联会话，再开始或继续任务。');
    }
  }

  private dependenciesSatisfied(taskId: string): boolean {
    return !this.database.connection.prepare("SELECT 1 FROM task_dependencies d JOIN tasks p ON p.id=d.dependency_id WHERE d.task_id=? AND p.status<>'succeeded' LIMIT 1").get(taskId);
  }

  private validateDependencyEdges(taskId: string, ids: readonly string[]): void {
    for (const id of ids) {
      if (id === taskId) throw new TaskError('DEPENDENCY_CYCLE', '任务不能依赖自身。');
      if (!this.database.connection.prepare('SELECT id FROM tasks WHERE id=?').get(id)) throw new TaskError('DEPENDENCY_NOT_FOUND', '依赖任务不存在。');
      const cycle = this.database.connection.prepare(`WITH RECURSIVE ancestors(id) AS (
        SELECT dependency_id FROM task_dependencies WHERE task_id=?
        UNION SELECT d.dependency_id FROM task_dependencies d JOIN ancestors a ON d.task_id=a.id
      ) SELECT 1 FROM ancestors WHERE id=? LIMIT 1`).get(id, taskId);
      if (cycle) throw new TaskError('DEPENDENCY_CYCLE', '这些依赖会形成任务循环。');
    }
  }

  private hasActiveDependents(taskId: string): boolean {
    return !!this.database.connection.prepare("SELECT 1 FROM task_dependencies d JOIN tasks t ON t.id=d.task_id WHERE d.dependency_id=? AND t.status IN ('running','waiting_approval','pausing','cancelling') LIMIT 1").get(taskId);
  }

  private refreshDependents(taskId: string): TaskEventEnvelope[] {
    const events: TaskEventEnvelope[] = [];
    const children = this.database.connection.prepare(`SELECT t.id,t.status,t.blocked_kind FROM task_dependencies d JOIN tasks t ON t.id=d.task_id
      WHERE d.dependency_id=? AND (t.status='ready' OR (t.status='blocked' AND t.blocked_kind='dependencies'))`).all(taskId);
    for (const child of children) {
      const satisfied = this.dependenciesSatisfied(String(child.id));
      if ((child.status === 'ready') === satisfied) continue;
      const task = this.get(String(child.id));
      task.status = satisfied ? 'ready' : 'blocked'; task.blockedReason = satisfied ? null : '等待依赖任务完成。';
      this.database.connection.prepare('UPDATE tasks SET blocked_kind=? WHERE id=?').run(satisfied ? null : 'dependencies', task.id);
      events.push(this.record(task, satisfied ? 'TASK_READY' : 'TASK_BLOCKED', { kind: 'dependencies', parentId: taskId }));
    }
    return events;
  }

  private worker(taskId: string, attemptId: string | null): { worker?: TaskWorkerState } {
    if (!attemptId) return {};
    const row = this.database.connection.prepare('SELECT w.*,a.ended_at FROM task_workers w JOIN task_attempts a ON a.id=w.attempt_id WHERE a.task_id=? AND w.attempt_id=?').get(taskId, attemptId);
    if (!row) return {};
    const status = row.status === 'running' && row.ended_at === null && Date.now() - Number(row.parent_heartbeat_at) > this.staleAfterMs ? 'stale' : String(row.status) as TaskWorkerState['status'];
    return { worker: { runId: String(row.run_id), attemptId, generation: Number(row.generation), kind: String(row.kind) as 'host' | 'tool',
      pid: Number(row.pid), startIdentity: String(row.start_identity), status, parentHeartbeatAt: Number(row.parent_heartbeat_at),
      lastHeartbeatAt: Number(row.last_heartbeat_at), lastActivityAt: Number(row.last_activity_at),
      ...(row.kind === 'tool' ? { exitCode: row.exit_code === null ? null : Number(row.exit_code), signal: nullableString(row.termination_signal) } : {}) } };
  }

  private pulse(): void {
    if (this.closing || !this.active.size) return;
    const events: TaskEventEnvelope[] = [];
    try {
      this.database.transaction(() => {
        for (const active of this.active.values()) {
          if (!this.owns(active)) continue;
          const now = Date.now();
          this.accountAttempt(active.attemptId, now);
          const row = this.database.connection.prepare('SELECT status,parent_heartbeat_at FROM task_workers WHERE attempt_id=?').get(active.attemptId);
          if (!row) throw new TaskError('WORKER_RECORD_MISSING', '当前任务的运行观察记录缺失。');
          const stale = row.status === 'running' && now - Number(row.parent_heartbeat_at) > this.staleAfterMs;
          this.database.connection.prepare("UPDATE task_workers SET parent_heartbeat_at=?,last_heartbeat_at=CASE WHEN kind='host' THEN ? ELSE last_heartbeat_at END,status=CASE WHEN ? THEN 'stale' ELSE status END WHERE attempt_id=? AND run_id=? AND generation=?")
            .run(now, now, Number(stale), active.attemptId, active.runId, active.generation);
          if (stale) events.push(this.record(this.get(active.taskId), 'WORKER_STATE', { status: 'stale', reason: 'host_heartbeat_gap' }));
        }
      });
      for (const [id, waiter] of [...this.waiters]) {
        const approval = this.requirePermissions().getApproval(id);
        if (approval.status === 'pending' || approval.status === 'approved') continue;
        const error = new TaskError(approval.status === 'expired' ? 'APPROVAL_EXPIRED' : approval.status === 'denied' ? 'APPROVAL_DENIED' : 'APPROVAL_INVALIDATED',
          approval.status === 'expired' ? '审批有效期已到，待审批动作未执行。' : '审批已被拒绝或撤销，待审批动作未执行。');
        this.cancelScopedApproval(id, true, error);
        this.expireActive(waiter.active, safeFailure(error));
      }
    } catch {
      this.closing = true; clearInterval(this.heartbeatTimer);
      for (const active of this.active.values()) {
        active.stop = 'cancel';
        this.rejectWaiter(active, new TaskError('PERSISTENCE_FAILED', '运行观察未能持久化，任务已请求停止。'));
        active.controller.abort(new TaskError('PERSISTENCE_FAILED', '运行观察未能持久化，任务已请求停止。'));
        active.settle(new TaskError('PERSISTENCE_FAILED', '运行观察未能持久化，已终止宿主等待；原外部事实须重启后核对。'));
      }
      this.active.clear();
      return;
    }
    this.publishMany(events);
    for (const active of [...this.active.values()]) {
      try { this.assertBudgetAvailable(this.getBudget(active.taskId)); }
      catch (error) { this.expireActive(active, safeFailure(error)); }
    }
  }

  private expireActive(active: ActiveAttempt, failure: TaskFailure): void {
    if (active.settled || !this.owns(active)) return;
    active.watchdogFailure = failure;
    this.rejectWaiter(active, new TaskError(failure.code, failure.message));
    active.controller.abort(new TaskError(failure.code, failure.message));
    let events: TaskEventEnvelope[] = [];
    let persistenceFailure: TaskError | undefined;
    try {
      events = this.finish(active, null, failure);
    } catch { persistenceFailure = new TaskError('PERSISTENCE_FAILED', '有界等待已终止，但结果未能持久化；重启后须核对。'); }
    if (this.active.get(active.taskId) === active) this.active.delete(active.taskId);
    active.settle(persistenceFailure);
    this.publishMany(events);
  }

  private async waitForStop(active: ActiveAttempt): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([active.done, new Promise<void>((resolve) => { timeout = setTimeout(resolve, 1000); })]);
      if (!active.settled) this.expireActive(active, classifiedFailure('TASK_STOPPED', '停止等待已收束；未确认的外部事实继续保留待核。'));
      await active.done;
    } finally { if (timeout) clearTimeout(timeout); }
  }

  private recoverInterrupted(): void {
    const ids = this.database.connection.prepare(`SELECT id FROM tasks WHERE status IN ('running','waiting_approval','pausing','cancelling')`).all();
    for (const row of ids) {
      let envelope!: TaskEventEnvelope;
      this.database.transaction(() => {
        const task = this.get(String(row.id));
        const attempt = task.currentAttemptId ? this.attempt(task.currentAttemptId) : null;
        if (attempt) this.accountAttempt(attempt.id);
        const worker = attempt ? this.database.connection.prepare('SELECT kind,status FROM task_workers WHERE attempt_id=?').get(attempt.id) : null;
        const unknown = this.hasUnconfirmedTaskEffects(task.id) || !!(worker?.kind === 'tool' && worker.status !== 'exited');
        task.status = unknown ? 'needs_review' : 'interrupted'; task.requiresReview = unknown; task.approvalId = null;
        task.error = unknown ? { ...classifiedFailure('RESULT_UNKNOWN', '上次运行已启动动作但结果缺失；先核对实际状态。'), stage: 'recovery' as const }
          : { ...classifiedFailure('PROCESS_INTERRUPTED', '上次运行被中断，可明确继续任务。'), stage: 'recovery' as const };
        if (attempt) this.database.connection.prepare('UPDATE task_attempts SET status=?,error=?,ended_at=? WHERE id=? AND ended_at IS NULL')
          .run(task.status, encode(task.error), Date.now(), attempt.id);
        if (attempt) this.database.connection.prepare("UPDATE task_workers SET status='unknown' WHERE attempt_id=?").run(attempt.id);
        if (task.currentRunId) this.database.connection.prepare('UPDATE task_runs SET status=?,error=?,ended_at=? WHERE id=?')
          .run(task.status, encode(task.error), Date.now(), task.currentRunId);
        envelope = this.record(task, unknown ? 'TASK_NEEDS_REVIEW' : 'TASK_INTERRUPTED', { recovery: true, outcomeKnown: !unknown });
      });
      if (envelope.task.currentRunId) this.permissions?.cancelForRun(envelope.task.currentRunId, envelope.task.generation);
      this.publish(envelope);
    }
  }

  private owns(active: ActiveAttempt): boolean {
    const row = this.database.connection.prepare('SELECT t.current_run_id,t.current_attempt_id,t.generation,a.ended_at FROM tasks t JOIN task_attempts a ON a.id=t.current_attempt_id WHERE t.id=?').get(active.taskId);
    return !!row && row.current_run_id === active.runId && row.current_attempt_id === active.attemptId && Number(row.generation) === active.generation && row.ended_at === null;
  }

  private assertAcceptsActions(active: ActiveAttempt): void {
    if (active.stop || active.controller.signal.aborted || !this.owns(active)) throw new TaskError('STALE_ATTEMPT', '当前尝试已停止或失去所有权。');
    // 与派发闸门共用同一份内存与持久代次；此处同步抛出，不能被后面的 await 绕过。
    this.dispatchGuard?.assertAction(active.taskId, active.generation);
    this.assertBudgetAvailable(this.getBudget(active.taskId));
    if (this.controlsAllTasks || active.ownerRole === 'service') {
      if (this.serviceStopRequested) throw new TaskError('HARNESS_STOPPED', '本进程服务角色已停止，当前尝试不能派发新动作。');
      const control = this.getControl();
      if (control.stopped) throw new TaskError('HARNESS_STOPPED', '服务角色已停止，当前尝试不能派发新动作。');
      if (control.generation !== active.controlGeneration) throw new TaskError('CONTROL_GENERATION_CONFLICT', '当前尝试的控制资格已经过期。');
    }
  }

  private attempt(id: string): TaskAttempt {
    const row = this.database.connection.prepare('SELECT * FROM task_attempts WHERE id=?').get(id);
    if (!row) throw new TaskError('ATTEMPT_NOT_FOUND', '任务尝试记录缺失。');
    return attemptFromRow(row);
  }

  private hasUnconfirmedEffects(attemptId: string): boolean {
    return !!this.database.connection.prepare("SELECT 1 FROM task_effects WHERE attempt_id=? AND status='started' LIMIT 1").get(attemptId);
  }

  private hasUnconfirmedTaskEffects(taskId: string): boolean {
    return !!this.database.connection.prepare("SELECT 1 FROM task_effects e JOIN task_attempts a ON a.id=e.attempt_id WHERE a.task_id=? AND e.status='started' LIMIT 1").get(taskId);
  }

  private latestProgress(attemptId: string | null): TaskRecord['progress'] {
    if (!attemptId) return null;
    const row = this.database.connection.prepare("SELECT data,timestamp FROM task_events WHERE attempt_id=? AND type='PROGRESS' ORDER BY sequence DESC LIMIT 1").get(attemptId);
    if (!row) return null;
    const value = stored<Record<string, JsonValue>>(row.data);
    return { message: String(value.message), fraction: typeof value.progress === 'number' ? value.progress : null, timestamp: String(row.timestamp) };
  }

  private record(task: TaskRecord, type: TaskEventType, data: JsonValue, source?: Pick<ActiveAttempt, 'runId' | 'attemptId' | 'generation'>): TaskEventEnvelope {
    const payload = json(data);
    const timestamp = new Date().toISOString();
    const runId = source ? source.runId : task.currentRunId, attemptId = source ? source.attemptId : task.currentAttemptId, generation = source ? source.generation : task.generation;
    const insert = this.database.connection.prepare('INSERT INTO task_events(task_id,run_id,attempt_id,generation,type,timestamp,data) VALUES(?,?,?,?,?,?,?)')
      .run(task.id, runId, attemptId, generation, type, timestamp, payload.text);
    const previousVersion = task.version;
    task.sequence = Number(insert.lastInsertRowid); task.version += 1; task.updatedAt = Date.now();
    task.resultRef = task.result === null ? null : resultReference(task.currentRunId);
    const updated = this.database.connection.prepare("UPDATE tasks SET status=?,current_run_id=?,current_attempt_id=?,generation=?,checkpoint=?,result=?,error=?,approval_id=?,requires_review=?,blocked_reason=?,review_required=?,blocked_kind=CASE WHEN ?='blocked' THEN blocked_kind ELSE NULL END,sequence=?,version=?,updated_at=?,control_generation=? WHERE id=? AND version=?")
      .run(task.status, task.currentRunId, task.currentAttemptId, task.generation, encode(task.checkpoint), encode(task.result), encode(task.error), task.approvalId,
        Number(task.requiresReview), task.blockedReason, Number(task.reviewRequired), task.status, task.sequence, task.version, task.updatedAt, task.controlGeneration, task.id, previousVersion);
    if (updated.changes !== 1) throw new TaskError('STALE_TASK', '任务状态已被其他操作更新。');
    return { task: { ...structuredClone(task), ...this.worker(task.id, task.currentAttemptId), progress: this.latestProgress(task.currentAttemptId) }, event: { sequence: task.sequence, taskId: task.id, runId, attemptId, generation, type, timestamp, data: payload.value } };
  }

  private publish(envelope: TaskEventEnvelope): void {
    this.publishMany([envelope]);
  }
  private publishMany(envelopes: TaskEventEnvelope[]): void {
    this.publications.push(...envelopes);
    if (this.publishing) return;
    this.publishing = true;
    try {
      while (this.publications.length) {
        const next = this.publications.shift()!;
        for (const listener of this.listeners) {
          try { listener(structuredClone(next)); } catch { /* 展示订阅异常不影响持久任务。 */ }
        }
      }
    } finally { this.publishing = false; }
  }
  private requirePermissions(): PermissionService {
    if (!this.permissions) throw new TaskError('PERMISSION_SERVICE_UNAVAILABLE', '任务权限服务尚未配置，动作未被授权。');
    return this.permissions;
  }
  private assertOpen(): void { if (this.closing) throw new TaskError('TASK_SERVICE_CLOSED', '任务服务正在关闭。'); }
}

function processFact(pid: number): 'exited' | 'active' | 'unknown' {
  if (!Number.isSafeInteger(pid) || pid < 1) return 'unknown';
  try { process.kill(pid, 0); return 'active'; }
  catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    return code === 'ESRCH' ? 'exited' : 'unknown';
  }
}

function activeAttempt(taskId: string, runId: string, attemptId: string, generation: number, ownerRole: TaskOwnerRole, controlGeneration: number | null): ActiveAttempt {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const done = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  // 后台任务的结果写失败仍由 wait/stop/dispose 返回，未订阅时不能成为未处理拒绝。
  void done.catch(() => {});
  const active: ActiveAttempt = { taskId, runId, attemptId, generation, ownerRole, controlGeneration, controller: new AbortController(), done,
    settle(error) { if (active.settled) return; active.settled = true; if (error) reject(error); else resolve(); } };
  return active;
}
function attemptFromRow(row: Record<string, unknown>): TaskAttempt {
  return { id: String(row.id), taskId: String(row.task_id), runId: String(row.run_id), generation: Number(row.generation), ordinal: Number(row.ordinal),
    controlGeneration: row.control_generation === null ? null : Number(row.control_generation),
    status: String(row.status) as TaskStatus, sideEffectStarted: Number(row.side_effect_started) === 1, unconfirmedEffects: Number(row.unconfirmed_effects),
    result: optionalStored<TaskResult>(row.result), error: optionalStored<TaskFailure>(row.error), checkpoint: optionalStored<JsonValue>(row.checkpoint),
    resultRef: row.result === null ? null : `task-attempt-result:${String(row.id)}`,
    startedAt: Number(row.started_at), endedAt: row.ended_at === null ? null : Number(row.ended_at) };
}
function validateResult(input: TaskResult): TaskResult {
  if (!input || typeof input !== 'object') throw new TaskError('INVALID_RESULT', '运行时没有返回有效的任务结果。');
  const result = json({ summary: input.summary,
    ...input.artifactIds === undefined ? {} : { artifactIds: input.artifactIds },
    ...input.data === undefined ? {} : { data: input.data },
  }).value as unknown as TaskResult;
  if (!result || typeof result.summary !== 'string' || !result.summary.trim() || result.summary.length > 32_000
    || (result.artifactIds !== undefined && (!Array.isArray(result.artifactIds) || result.artifactIds.length > 256))) throw new TaskError('INVALID_RESULT', '运行时没有返回有效的任务结果。');
  result.artifactIds?.forEach(validId);
  return result;
}
function normalizeRuntimeEvent(input: TaskRuntimeEvent): TaskRuntimeEvent {
  if (!input || typeof input !== 'object') throw new TaskError('INVALID_EVENT', '任务事件无效。');
  let event: TaskRuntimeEvent;
  switch (input.type) {
    case 'progress': event = { type: input.type, message: input.message,
      ...input.progress === undefined ? {} : { progress: input.progress }, ...input.evidenceKey === undefined ? {} : { evidenceKey: input.evidenceKey }, ...input.data === undefined ? {} : { data: input.data } }; break;
    case 'side_effect_started': event = { type: input.type,
      ...input.effectId === undefined ? {} : { effectId: input.effectId },
      ...input.description === undefined ? {} : { description: input.description },
      ...input.operation === undefined ? {} : { operation: input.operation } }; break;
    case 'side_effect_result': event = { type: input.type, effectId: input.effectId, outcome: input.outcome, evidence: input.evidence,
      ...input.data === undefined ? {} : { data: input.data } }; break;
    case 'checkpoint': event = { type: input.type, checkpoint: input.checkpoint }; break;
    case 'process_state':
      validateProcessIdentity(input);
      if (!['started', 'exited'].includes(input.state) || (input.settlement !== undefined && !['settled', 'unknown'].includes(input.settlement))
        || (input.exitCode !== undefined && input.exitCode !== null && !Number.isSafeInteger(input.exitCode))
        || (input.signal !== undefined && input.signal !== null && (typeof input.signal !== 'string' || input.signal.length > 32))) throw new TaskError('INVALID_EVENT', '工具进程状态无效。');
      event = { type: input.type, pid: input.pid, startIdentity: input.startIdentity, state: input.state, timestamp: input.timestamp,
        ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }), ...(input.signal === undefined ? {} : { signal: input.signal }),
        ...(input.settlement === undefined ? {} : { settlement: input.settlement }) }; break;
    case 'heartbeat':
      validateProcessIdentity(input);
      if (typeof input.activity !== 'boolean') throw new TaskError('INVALID_EVENT', '进程活动观察无效。');
      event = { type: input.type, pid: input.pid, startIdentity: input.startIdentity, timestamp: input.timestamp, activity: input.activity }; break;
    default: throw new TaskError('INVALID_EVENT', '不支持此任务事件。');
  }
  return json(event).value as unknown as TaskRuntimeEvent;
}
function terminalEvent(status: TaskStatus): TaskEventType {
  switch (status) {
    case 'paused': return 'TASK_PAUSED'; case 'cancelled': return 'TASK_CANCELLED'; case 'succeeded': return 'TASK_SUCCEEDED';
    case 'needs_review': return 'TASK_NEEDS_REVIEW'; case 'interrupted': return 'TASK_INTERRUPTED';
    case 'awaiting_review': return 'REVIEW_REQUESTED'; case 'blocked': return 'TASK_BLOCKED'; default: return 'TASK_FAILED';
  }
}
function safeFailure(error: unknown): TaskFailure {
  if (error instanceof TaskError || error instanceof PermissionError || error instanceof LocalDataLifecycleError) return classifiedFailure(error.code, error.message);
  return classifiedFailure('RUNTIME_FAILED', '任务执行失败，已有记录已保留。');
}

/** 把稳定错误码映射为调用方可分流的类别；code 与原始证据仍是权威。 */
export function classifyTaskFailure(code: string): Pick<TaskFailure, 'category' | 'recoverable' | 'sideEffect' | 'nextAction'> {
  const category = failureCategory(code);
  return {
    category, recoverable: category === 'external_unknown' || category === 'runtime' || category === 'storage',
    sideEffect: category === 'external_unknown' ? 'unknown' : 'none',
    nextAction: FAILURE_NEXT_ACTION[category],
  };
}
function classifiedFailure(code: string, message: string): TaskFailure {
  return { code, message, ...classifyTaskFailure(code) };
}
function failureCategory(code: string): TaskFailureCategory {
  for (const rule of FAILURE_RULES) if (rule.match.test(code)) return rule.category;
  return 'runtime';
}
const FAILURE_RULES: readonly { category: TaskFailureCategory; match: RegExp }[] = [
  { category: 'invalid_input', match: /^(INVALID_|REQUEST_CONFLICT$|TARGET_(?!CHANGED$)|UNDECLARED_TARGET$|MESSAGE_CHAIN_INVALID$|UNKNOWN_ACTION$)/u },
  { category: 'permission', match: /^(PERMISSION_|APPROVAL_|POLICY_|GRANT_|RUN_INACTIVE$|REVIEW_PENDING$|UNSETTLED_APPROVAL$|TARGET_CHANGED$|MODEL_ACTION_REQUIRES_REVIEW$|DATA_CYCLE_AUTHORIZATION_REQUIRED$|FINANCIAL_AUTHORITY|WFD_AUTHORITY)/u },
  { category: 'budget', match: /(BUDGET_|BUDGET$)/u },
  { category: 'deadline', match: /DEADLINE/u },
  { category: 'dependency', match: /^(DEPENDENCY_|DEPENDENT_BUSY$)/u },
  { category: 'version_conflict', match: /(VERSION_CONFLICT$|VERSION_CHANGED$|VERSION_MISSING$|^STALE_|CONTROL_GENERATION_CONFLICT$|^FINANCIAL_IMPLEMENTATION_CHANGED$|^FINANCIAL_SNAPSHOT_MISMATCH$)/u },
  { category: 'storage', match: /(^STORAGE_|^PERSISTENCE_FAILED$|_STORAGE_|^INVALID_TASK_STORAGE$|^READBACK_)/u },
  { category: 'external_unknown', match: /(UNKNOWN_RESULT$|^RESULT_UNKNOWN$|^STOP_UNCONFIRMED$|^RECOVERY_|^HANDOFF_UNKNOWN$|_PENDING$|^CANCELLATION_)/u },
  { category: 'stopped', match: /(^TASK_STOPPED$|_STOPPED$|^TASK_PAUSED$|_CANCELLED$|^HARNESS_STOPPED$|^TASK_SERVICE_CLOSED$|^STOP_)/u },
  { category: 'capability', match: /(NOT_CONFIGURED$|UNAVAILABLE$|NOT_SUPPORTED$|NOT_ENABLED$|NOT_SELECTED$|UNBOUND$|_REQUIRED$|^WORKER_RECORD_MISSING$|^RUNTIME_NOT_|^SERVICE_NOT_READY$)/u },
];
const FAILURE_NEXT_ACTION: Record<TaskFailureCategory, string> = {
  invalid_input: '修正请求或参数后重新受理。',
  permission: '按当前策略取得明确授权或缩小范围。',
  budget: '预算耗尽；保留已完成结果，需新预算或缩小范围。',
  deadline: '截止已到；保留已完成结果，需新的明确截止。',
  dependency: '先核对或完成依赖任务。',
  capability: '先配置或启用所需能力。',
  version_conflict: '按原身份核对；需要时建立关联的新任务。',
  storage: '先恢复存储并核对已保存事实。',
  external_unknown: '按原请求与原实例核对，不换号重发。',
  stopped: '保留已发生事实；按原任务决定是否继续。',
  runtime: '核对原结果与记录后决定是否重试。',
};
function validId(value: string): void {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || value.includes('\0')) throw new TaskError('INVALID_TASK', '任务、运行时或动作标识无效。');
}
function validateBudget(input: Partial<TaskBudgetLimits> | undefined): TaskBudgetLimits {
  if (input !== undefined && (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !(key in DEFAULT_BUDGET)))) throw new TaskError('INVALID_BUDGET', '任务预算字段无效。');
  const result = { ...DEFAULT_BUDGET, ...input } as TaskBudgetLimits;
  for (const [key, value] of Object.entries(result)) {
    const hostLimit = DEFAULT_BUDGET[key as keyof TaskBudgetLimits];
    if (value === null) {
      if (hostLimit !== null) throw new TaskError('INVALID_BUDGET', '基础预算不能为空。');
      continue;
    }
    if (!Number.isSafeInteger(value) || value < 1 || (hostLimit !== null && value > hostLimit)) {
      throw new TaskError('INVALID_BUDGET', '预算上限必须为正整数，不能超过宿主上限；新增维度可用空值表示未设硬限。');
    }
  }
  return result;
}
function sameBudget(row: Record<string, unknown>, value: TaskBudgetLimits): boolean {
  const fields: [string, keyof TaskBudgetLimits][] = [
    ['max_active_ms', 'maxActiveMs'], ['max_no_progress_ms', 'maxNoProgressMs'], ['max_attempts', 'maxAttempts'], ['max_model_requests', 'maxModelRequests'],
    ['max_tokens', 'maxTokens'], ['max_estimated_cost_micros', 'maxEstimatedCostMicros'], ['max_confirmed_cost_micros', 'maxConfirmedCostMicros'],
    ['max_tool_ms', 'maxToolMs'], ['max_storage_bytes', 'maxStorageBytes'],
  ];
  return fields.every(([column, key]) => {
    const expected = value[key];
    return expected === null ? row[column] === null || row[column] === undefined : Number(row[column]) === expected;
  });
}
function validateDependencies(value: string[]): string[] {
  if (!Array.isArray(value) || value.length > 64 || new Set(value).size !== value.length) throw new TaskError('INVALID_DEPENDENCIES', '最多选择64个不同的依赖任务。');
  value.forEach(validId);
  return [...value].sort();
}
function validateVersions(value: Record<string, string | null>): Record<string, string | null> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 64) throw new TaskError('INVALID_VERSIONS', '任务版本必须是最多64项的对象。');
  for (const [key, version] of Object.entries(value)) {
    validId(key);
    if (version !== null && (typeof version !== 'string' || !version.trim() || version.length > 1000 || version.includes('\0'))) {
      throw new TaskError('INVALID_VERSIONS', '已知任务版本须为有效字符串，未知版本用 null。');
    }
  }
  return json(value, 32_000).value as Record<string, string | null>;
}
function resultReference(runId: string | null): string | null { return runId === null ? null : `task-result:${runId}`; }
function validateReason(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 4000 || value.includes('\0')) throw new TaskError('INVALID_REASON', '请提供不超过4,000个字符的明确原因。');
  return value.trim();
}
function validateProcessIdentity(value: { pid: number; startIdentity: string; timestamp: number }): void {
  if (!Number.isSafeInteger(value.pid) || value.pid < 1 || !Number.isSafeInteger(value.timestamp) || value.timestamp < 1 || value.timestamp > Date.now() + 5000) {
    throw new TaskError('INVALID_EVENT', '进程身份或观察时间无效。');
  }
  validId(value.startIdentity);
}
function json(value: unknown, maxBytes = 1_000_000): { value: JsonValue; text: string } {
  let snapshot: unknown;
  try { snapshot = structuredClone(value); digestOperationArgs(snapshot); } catch { throw new TaskError('INVALID_DATA', '任务数据必须可完整保存为 JSON。'); }
  const text = JSON.stringify(snapshot);
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new TaskError('DATA_LIMIT', '任务数据超出保存上限。');
  return { value: snapshot as JsonValue, text };
}
function encode(value: unknown): string | null { return value === null ? null : json(value).text; }
function nullableString(value: unknown): string | null { return value === null ? null : String(value); }
function stored<T>(value: unknown): T {
  try { return JSON.parse(String(value)) as T; } catch { throw new TaskError('INVALID_TASK_STORAGE', '任务记录无法读取。'); }
}
function optionalStored<T>(value: unknown): T | null { return value === null ? null : stored<T>(value); }
function asError(error: unknown): Error { return error instanceof Error ? error : new TaskError('RUNTIME_FAILED', '任务操作失败。'); }
