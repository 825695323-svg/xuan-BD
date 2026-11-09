import type { CoreDatabase } from '../../platform/state/database.js';
import type { SkillRegistration } from '../../platform/plugins/registry.js';
import { TaskError, type TaskExecutionContext, type TaskRecord } from '../../platform/jobs/tasks.js';
import { acquireAuthority } from '../../platform/runtime/file-workspace.js';
import type { JsonValue, TaskResult } from '../../contracts/task-contracts.js';
import type { ModelTaskOrigin } from '../agent/model-tools.js';
import type { WorkspaceServices } from '../../contracts/workspace-services.js';
import { financialDigest } from '../../plugins/financial/local-compute/assets.js';
import type { FinancialCallArgs } from './types.js';

const OPERATIONS: Readonly<Record<string, string>> = {
  'financial.list': 'tools.list', 'financial.describe': 'tools.describe', 'financial.call': 'tools.call',
  'financial.status': 'plugins.status',
};
type Link = { service_task_id: string; operation: string; origin_json: string };
export interface ConversationFinancialBridgeOptions {
  database: CoreDatabase; companion: WorkspaceServices; origin(taskId: string): ModelTaskOrigin | null;
  /** 受信宿主在服务任务启动前保存实际个人运行及分支来源，模型不能传此回调。 */
  bindFinancialTask?(taskId: string, origin: ModelTaskOrigin): void;
  observeFinancialResult?(origin: ModelTaskOrigin, serviceTask: TaskRecord): void;
  resolveFinancialCall?(origin: ModelTaskOrigin, normalizedCall: FinancialCallArgs): TaskRecord | null;
}

/** Cross-store references only: the companion retains calculation, permission and stop authority. */
export class ConversationFinancialBridge {
  readonly registrations: readonly SkillRegistration[];
  constructor(private readonly options: ConversationFinancialBridgeOptions) {
    options.database.migrate('conversation_financial_calls', 1, `CREATE TABLE conversation_financial_calls (
      local_task_id TEXT PRIMARY KEY REFERENCES tasks(id), service_task_id TEXT NOT NULL,
      operation TEXT NOT NULL, origin_json TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX conversation_financial_service_task ON conversation_financial_calls(service_task_id);`);
    this.registrations = [
      this.registration('financial.status', '查询本机金融插件状态', '查询已登记插件的真实状态和版本。启停只能由本机用户在工具页操作；模型没有启停动作。', []),
      this.registration('financial.list', '发现金融计算方法', '读取本机金融服务当前启用的方法和固定版本；计算前读取 financial.describe，或采用 data.submit 已返回的同版完整 financialContracts。', []),
      this.registration('financial.describe', '读取金融方法契约', '读取指定已登记方法的完整输入、参数、单位、时区、可得时间和实现版本。未知语义不能猜补。', [
        { key: 'capabilityId', label: '已登记金融能力编号', type: 'text', required: true, maxLength: 160 },
      ]),
      this.registration('financial.call', '执行已登记金融计算', 'callJson 是 financial.describe 所示 tools.call 参数对象的 JSON 文本。优先按 publicContract.input_schema 提供封闭0.1公共请求，固定 request_id；兼容原 capabilityId、pluginVersion、methodVersion、implementationVersion、input、parameters。仅使用用户明确提供的数据或宿主已绑定快照；计算结果不自动入库。', [
        { key: 'callJson', label: '完整金融调用参数 JSON（结构化文本）', type: 'text', required: true, maxLength: 100_000 },
      ]),
      this.registration('financial.result', '查看本会话的金融任务结果', '按本会话同分支原金融任务编号查看实际状态和结果；不能读取其他会话或任意服务任务。', [
        { key: 'serviceTaskId', label: '原金融服务任务编号', type: 'text', required: true, maxLength: 160 },
      ]),
    ];
  }
  handles(action: string): boolean { return Object.hasOwn(OPERATIONS, action) || action === 'financial.result'; }
  /** The original service task is the review authority; local failure or a new request cannot clear it. */
  hasUnresolvedCall(conversationId: string, args: JsonValue): boolean {
    const digest = financialDigest(this.normalizedInput(this.callInput(args as Record<string, JsonValue>)));
    const links = this.options.database.connection.prepare(`SELECT link.service_task_id, task.args AS local_args
      FROM conversation_financial_calls link JOIN tasks task ON task.id=link.local_task_id
      WHERE task.conversation_id=? AND task.action='financial.call' AND link.operation='tools.call'`)
      .all(conversationId) as unknown as { service_task_id: string; local_args: string }[];
    for (const link of links) {
      try {
        if (financialDigest(this.normalizedInput(this.callInput(JSON.parse(link.local_args) as Record<string, JsonValue>))) !== digest) continue;
        const original = this.options.companion.bd!.getTask(link.service_task_id);
        if (original.action !== 'tools.call' || financialDigest(original.args) !== digest
          || this.options.companion.bd!.hasUnresolvedResult(original)) return true;
      } catch {
        // An unreadable linked identity is not evidence that its unknown result was reconciled.
        return true;
      }
    }
    return false;
  }
  private callInput(args: Record<string, JsonValue>): Record<string, JsonValue> {
    let input: unknown;
    try { input = JSON.parse(String(args.callJson)); }
    catch { throw new TaskError('INVALID_FINANCIAL_ARGS', '金融调用参数不是有效 JSON（结构化文本）。'); }
    return this.options.companion.bd!.validate('tools.call', input);
  }
  private normalizedInput(value: Record<string, JsonValue>): JsonValue {
    const financial = this.options.companion.financial;
    return financial?.normalizeCall ? json(financial.normalizeCall(value).args) : value;
  }
  private link(context: TaskExecutionContext, task: TaskRecord, origin: ModelTaskOrigin): void {
    this.options.database.connection.prepare('INSERT OR IGNORE INTO conversation_financial_calls VALUES(?,?,?,?,?)')
      .run(context.task.id, task.id, task.action, JSON.stringify(origin), Date.now());
    const link = this.options.database.connection.prepare('SELECT * FROM conversation_financial_calls WHERE local_task_id=?')
      .get(context.task.id) as unknown as Link;
    if (link.service_task_id !== task.id || link.operation !== task.action || financialDigest(JSON.parse(link.origin_json)) !== financialDigest(origin)) {
      throw new TaskError('FINANCIAL_RECEIPT_MISMATCH', '金融任务或当前来源与原调用绑定不符。');
    }
  }
  private observe(context: TaskExecutionContext, task: TaskRecord): Promise<void> {
    return context.emit({ type: 'checkpoint', checkpoint: { kind: 'conversation-financial', ownerService: 'bd_agents',
      serviceTaskId: task.id, serviceOperation: task.action, serviceStatus: task.status,
      requiresReview: task.requiresReview, serviceResultRef: task.resultRef, serviceError: json(task.error) } });
  }
  private registration(action: string, title: string, description: string, fields: SkillRegistration['fields']): SkillRegistration {
    return { action, title, description, fields, runtimeId: 'direct', kind: 'direct', modelCalls: 0,
      permissionSummary: ['当前会话及当前模型的显式审批', '金融服务独立核对执行权限与停止状态', '不启用插件、不执行上传代码、不正式入库'],
      available: () => this.options.companion.financial && this.options.companion.bd
        ? { available: true } : { available: false, reason: '本机金融服务尚未装配。' } };
  }
  async execute(context: TaskExecutionContext): Promise<TaskResult> {
    const action = context.task.action, args = context.task.args as Record<string, JsonValue>;
    if (!this.handles(action)) throw new TaskError('UNKNOWN_ACTION', '没有此金融会话动作。');
    const origin = this.options.origin(context.task.id);
    if (!origin) throw new TaskError('FINANCIAL_CONVERSATION_REQUIRED', '金融会话动作须经当前会话的受控工具调用。');
    const companion = this.options.companion, bd = companion.bd!;
    const authority = await acquireAuthority(context, action, args, []);
    authority.assert(); bd.assertDispatch();
    let serviceTask: TaskRecord;
    if (action === 'financial.result') {
      const links = this.options.database.connection.prepare('SELECT * FROM conversation_financial_calls WHERE service_task_id=? AND operation=?')
        .all(String(args.serviceTaskId), 'tools.call') as unknown as Link[];
      if (!links.some(link => {
        const owner = JSON.parse(link.origin_json) as ModelTaskOrigin;
        return owner.conversationId === origin.conversationId && owner.branchId === origin.branchId;
      })) throw new TaskError('FINANCIAL_RESULT_NOT_BOUND', '原金融任务不属于当前会话与分支。');
      serviceTask = bd.getTask(String(args.serviceTaskId));
      if (serviceTask.action !== 'tools.call') throw new TaskError('FINANCIAL_RESULT_NOT_BOUND', '原编号没有绑定金融计算。');
    } else {
      const operation = OPERATIONS[action]!;
      let input: unknown = action === 'financial.describe' ? { capabilityId: args.capabilityId } : {};
      let resolved: TaskRecord | null = null;
      if (action === 'financial.call') {
        input = this.callInput(args);
        if (this.options.resolveFinancialCall) {
          const normalized = companion.financial!.normalizeCall(input).args;
          const value: unknown = this.options.resolveFinancialCall(origin, normalized);
          if (value && typeof value === 'object' && 'then' in value) {
            if (value instanceof Promise) void value.catch(() => {});
            throw new TaskError('FINANCIAL_HOST_RESOLUTION_ASYNC_UNSUPPORTED', '原金融业务步骤尚未同步核对。');
          }
          if (value !== null) {
            const original = bd.getTask((value as TaskRecord).id);
            if (original.action !== 'tools.call' || original.runtimeId !== companion.financial!.runtime.id
              || financialDigest(original.args) !== financialDigest(normalized)) throw new TaskError('FINANCIAL_STABLE_CALL_MISMATCH', '原业务任务与当前固定方法、版本、输入或参数不一致。');
            resolved = original;
          }
        }
        // 已固定业务步骤直接观察原任务；未知任务不会借新toolCallId重启。
        if (!resolved && this.hasUnresolvedCall(origin.conversationId, args)) throw new TaskError('MODEL_ACTION_REQUIRES_REVIEW', '同一金融计算的原服务结果尚待核对；新请求不能替代原任务核对。');
      }
      const publicRequestId = action === 'financial.call' && input && typeof input === 'object'
        && 'protocol_version' in input ? String((input as Record<string, unknown>).request_id) : null;
      // 本地父ID不当作服务父任务；真实来源在持久登记后、启动前独立绑定。
      serviceTask = resolved ?? bd.submit(operation, input, publicRequestId ?? `conversation:${context.task.id}`, undefined,
        operation === 'tools.call' ? { beforeStart: task => {
          authority.assert(); bd.assertDispatch();
          const bound: unknown = this.options.bindFinancialTask?.(task.id, origin);
          if (bound && typeof bound === 'object' && 'then' in bound) {
            if (bound instanceof Promise) void bound.catch(() => {});
            throw new TaskError('FINANCIAL_HOST_BINDING_ASYNC_UNSUPPORTED', '金融来源绑定尚未同步确认保存，不能启动计算。');
          }
          this.link(context, task, origin);
        } } : undefined);
    }
    this.link(context, serviceTask, origin);
    await this.observe(context, serviceTask);
    if (action !== 'financial.result') {
      let cancellation: Promise<TaskRecord> | undefined;
      const stop = () => { cancellation ??= companion.tasks.cancel(serviceTask.id); void cancellation.catch(() => {}); };
      context.signal.addEventListener('abort', stop, { once: true });
      try {
        if (context.signal.aborted) stop();
        serviceTask = await companion.tasks.wait(serviceTask.id);
        if (cancellation) await cancellation;
      } finally {
        context.signal.removeEventListener('abort', stop);
        if (cancellation) await cancellation;
        serviceTask = bd.getTask(serviceTask.id);
        await this.observe(context, serviceTask);
      }
      if (bd.hasUnresolvedResult(serviceTask)) throw new TaskError('MODEL_ACTION_REQUIRES_REVIEW', `金融服务任务 ${serviceTask.id} 结果尚待核对；未确认成功，也不能重提相同计算。`);
      context.signal.throwIfAborted();
      if (serviceTask.status !== 'succeeded' || serviceTask.requiresReview || !serviceTask.resultRef || !serviceTask.result) {
        throw new TaskError('FINANCIAL_SERVICE_NOT_SUCCEEDED', `金融服务任务 ${serviceTask.id} 实际状态为 ${serviceTask.status}；请按原编号核对。`);
      }
    }
    authority.assert(); bd.assertDispatch();
    const stored = bd.getTask(serviceTask.id);
    if (stored.version !== serviceTask.version || stored.resultRef !== serviceTask.resultRef) throw new TaskError('FINANCIAL_RESULT_CHANGED', '金融任务在读取期间变化，请按原编号核对。');
    if (serviceTask.action === 'tools.call' && serviceTask.status === 'succeeded' && !serviceTask.requiresReview && serviceTask.resultRef && serviceTask.result) {
      const observed: unknown = this.options.observeFinancialResult?.(origin, serviceTask);
      if (observed && typeof observed === 'object' && 'then' in observed) {
        if (observed instanceof Promise) void observed.catch(() => {});
        throw new TaskError('FINANCIAL_HOST_OBSERVATION_ASYNC_UNSUPPORTED', '金融结果关联尚未同步确认保存。');
      }
    }
    return { summary: action === 'financial.call' ? serviceTask.result!.summary : `已读取金融服务任务的实际状态：${serviceTask.status}。`,
      data: json({ kind: 'conversation-financial', ownerService: 'bd_agents',
        conversationSource: { conversationId: origin.conversationId, branchId: origin.branchId, messageId: origin.messageId, runId: origin.parentRunId },
        serviceTaskId: serviceTask.id, serviceOperation: serviceTask.action, serviceStatus: serviceTask.status,
        serviceResultRef: serviceTask.resultRef, serviceError: serviceTask.error, requiresReview: serviceTask.requiresReview,
        result: serviceTask.result, publicContract: companion.financial?.publicTaskView?.(serviceTask) ?? null,
        modelPreview: bd.modelTaskView(serviceTask.id) }) };
  }
}
function json(value: unknown): JsonValue { return JSON.parse(JSON.stringify(value)) as JsonValue; }
