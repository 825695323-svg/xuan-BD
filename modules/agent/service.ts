import { TaskError, type TaskRuntime, type TaskService } from '../../platform/jobs/tasks.js';
import type { PersonalCore } from '../../modules/agent/runtime/core.js';
import type { HealthResponse } from '../../contracts/contracts.js';
import type { JsonValue, TaskRecord } from '../../contracts/task-contracts.js';
import { digestOperationArgs } from '../../platform/security/permissions.js';
import { DATABASE_PORT_RESERVATION } from '../../adapters/database/data-service-port.js';
import type { CollectionService } from '../../modules/collection/service.js';
import type { FinancialService } from '../../modules/financial/service.js';
import type { FinancialHostSubmission } from '../../modules/financial/types.js';
import { financialPublicError } from '../../modules/financial/contracts.js';
import type { MaterialService } from '../../modules/collection/materials/service.js';
import type { MaterialSemanticService } from '../../modules/collection/materials/semantic.js';

export const BD_VERSION = 'xuan-bd-data-service.1';
export const COLLECTION_BD_VERSION = 'xuan-bd-data-collection.2';
export const WORKSPACE_BD_VERSION = 'xuan-bd-data-workspace.3';
export const WORKSPACE_SYSTEM_PROMPT = '你是 xuan BD（数据处理与导入应用）的内置数据服务代理，只负责数据处理、导入交接和已登记的基础数据算法。默认中文。采集源、接口源和文件都从当前会话受控工具入口办理，首先读取 bd.session.capabilities（BD AGENTS 会话工具目录）。基础算法先读取 algorithms.contract（统一算法接口契约）及 algorithms.capabilities（当前真实可用性），由 BD AGENTS 调用 algorithms.calculate（基础算法计算）提交；输入必须是 WFD 已正式发布的固定快照，不能直接读取文件或受管原件计算。AGENTS 计算后依次使用 algorithms.stage（结果保管）、data.processing.*（五步加工）、data.r1.prepare_derived（派生交接准备）、data.r1.submit（受控正式提交），再核 WFD 固定读回；旧金融工具不得绕过 WFD 输入限制或发布关口；插件状态用 plugins_status（插件状态）。只处理用户明确提供的输入或受信宿主已登记的固定快照；金融单位、币种、复权、周期和可得时间不足时不能猜补。计算结果 computed（已计算）表示计算完成，未正式入库。新数据交接使用 BD 工作台的 R1（结构化交接）受控入口，先核实际装配与加工证据，再由用户单独确认提交；本代理没有因此获得新的 R1 工具。保管、受理、正式提交、固定读回分开报告，未知二进制只保管并返回缺口。原件及有界预览保留本地；上传代码不授予执行权。停止、恢复和插件开关由本机用户控制。工具失败时先读回执里的具体原因，并按原因核对真实能力边界：参数或路径规则错误按回执修正后重试，不能把连续失败当成能力不存在；重试三次仍失败就直接说明受阻原因和已有证据。结论须区分已核实、推断和未知。思考结束后必须在正文给出结论，不能只停在思考里；正文为空会被判为未完成。报告四行以内，写实际结果和任务引用，完整证据留在程序入口。';
export const SERVICE_RUNTIME = 'bd.service';
export const SERVICE_TOOLS = ['runtime_status', 'jobs_get', 'test_echo'] as const;
export const SERVICE_SYSTEM_PROMPT = '你是 xuan BD（数据处理与导入应用）的内置数据服务代理，只负责数据处理、导入交接和已登记的基础数据算法。默认中文。只使用本阶段提供的平台只读工具和合成测试工具；业务事实以工具的持久结果及编号为依据。数据收集、金融工具、外部主体、风险和市场模块均未启用。停止及恢复由用户的程序入口控制，你没有否决权。不要声称已执行工具未证明的操作。';
export const COLLECTION_SYSTEM_PROMPT = '你是 xuan BD（数据处理与导入应用）的内置数据服务代理，只负责数据处理和已登记的基础数据算法。默认中文。当前入口只启用平台查询及宿主已登记的隔离合成材料收集和本地五步加工。collection_run（合成材料处理）只接受 processed（加工完成）；新交接使用 BD 工作台 R1（结构化交接）受控入口并由用户单独确认，不因本提示获得新工具或权限。原件、单位、精度、质量和状态以工具持久事实为准，禁止口头补全。停止及恢复由用户程序入口控制。报告四行以内，写实际结果和任务引用。';

/** 本地服务角色的窄门面；任务、尝试、结果与控制仍由现有 TaskService 唯一持有。 */
export class BdService {
  constructor(readonly options: {
    tasks(): TaskService; core: PersonalCore; health: HealthResponse;
    versions?: Record<string, string | null>;
    collection?: CollectionService;
    financial?: FinancialService;
    materials?: MaterialService;
    semantics?: MaterialSemanticService;
  }) {}

  get toolNames(): readonly string[] { return [...SERVICE_TOOLS, ...(this.options.collection ? ['collection_run'] : []), ...(this.options.financial ? ['tools_list', 'tools_describe', 'tools_call', 'plugins_status'] : [])]; }
  get systemPrompt(): string { return this.isWorkspace ? WORKSPACE_SYSTEM_PROMPT : this.options.collection ? COLLECTION_SYSTEM_PROMPT : SERVICE_SYSTEM_PROMPT; }
  get isWorkspace(): boolean { return !!(this.options.financial || this.options.materials); }

  get versions(): Record<string, string | null> {
    return { bd: this.isWorkspace ? WORKSPACE_BD_VERSION : this.options.collection ? COLLECTION_BD_VERSION : BD_VERSION, contract: 'bd-service/1', module: 'bd_agent',
      role: 'service', caller: 'local-operator', environment: 'local', ...this.options.versions,
      ...(this.options.collection ? { collectionBinding: digestOperationArgs(this.options.collection.versionBinding) } : {}),
      ...(this.options.financial ? { financialBinding: digestOperationArgs(this.options.financial.versionBinding) } : {}),
      ...(this.options.materials ? { materialsBinding: digestOperationArgs(this.options.materials.versionBinding) } : {}),
      ...(this.options.semantics ? { semanticsBinding: digestOperationArgs(this.options.semantics.versionBinding) } : {}) };
  }

  assertDispatch(): void {
    if (this.options.tasks().getControl().stopped) throw new TaskError('SERVICE_STOPPED', '框架已停止新增派发，请由本机操作者明确恢复。');
  }

  assertVersion(task: TaskRecord): void {
    if (task.ownerRole !== 'service' || digestOperationArgs(task.versions) !== digestOperationArgs(this.versions)) {
      throw new TaskError('SERVICE_VERSION_CONFLICT', '原任务绑定的实现或模型配置与当前版本不同，请核对后建立关联的新任务。');
    }
  }

  status(): JsonValue {
    const health = this.options.health;
    const collection = this.options.collection;
    return { ownerService: 'bd_agents', role: 'service', stage: this.isWorkspace ? 3 : collection ? 2 : 1, version: this.versions.bd,
      control: asJson(this.options.tasks().getControl()),
      model: { provider: health.provider, model: health.model, configured: health.configured,
        availability: 'not_probed', note: '配置可用不代表模型当前在线；实际调用以任务结果为准。' },
      tools: [...this.toolNames],
      modules: { bd_agent: 'enabled', collection: collection ? 'isolated_synthetic' : 'not_enabled', financial_tools: this.options.financial ? 'enabled' : 'not_enabled', materials: this.options.materials ? 'local_review' : 'not_enabled',
        external_subject: 'not_enabled', risk: 'not_enabled', market: 'not_enabled' },
      database: { binding: DATABASE_PORT_RESERVATION.state, code: DATABASE_PORT_RESERVATION.code,
        contract: 'reserved', realIntegration: 'not_executed',
        note: '本代理的数据库交接由独立 R1（结构化交接）入口按实际装配与用户确认执行。' },
      ...(collection ? { collection: collection.status() } : {}),
      ...(this.options.financial ? { financial: asJson(this.options.financial.status()) } : {}),
      limits: { modelRequests: this.isWorkspace ? 4 : 2, timeoutMs: 60_000, maxOutputTokens: 1024 },
      isolation: '本机操作者入口；尚未实现远程或多主体鉴权。' };
  }

  getTask(id: string): TaskRecord {
    identifier(id);
    const task = this.options.tasks().get(id);
    if (task.ownerRole !== 'service') throw new TaskError('TASK_NOT_FOUND', '服务角色中没有此任务。');
    return task;
  }

  hasUnresolvedResult(task: TaskRecord): boolean {
    if (task.status === 'needs_review' || task.requiresReview) return true;
    if (task.action !== 'collection.run' || !this.options.collection) return false;
    const checkpoint = task.checkpoint && typeof task.checkpoint === 'object' && !Array.isArray(task.checkpoint) ? task.checkpoint : {};
    const childId = checkpoint.processingTaskId ?? checkpoint.collectionTaskId;
    return typeof childId === 'string' && this.hasUnresolvedResult(this.getTask(childId));
  }

  taskView(id: string): Record<string, JsonValue> {
    const task = this.getTask(id);
    const publicFinancial = this.options.financial?.publicTaskView?.(task) as Record<string, JsonValue> | null | undefined;
    return asJson({ ownerService: 'bd_agents', requestId: task.requestId, jobId: task.id,
      parentJobId: task.parentTaskId, operation: task.action, status: task.status, version: task.version,
      runId: task.currentRunId, attemptId: task.currentAttemptId, generation: task.generation,
      controlGeneration: task.controlGeneration, approvalId: task.approvalId, versions: task.versions, resultRef: task.resultRef,
      result: publicFinancial ? publicFinancial.result : task.result, error: publicFinancial ? publicFinancial.error : task.error,
      ...(publicFinancial ? { publicContract: publicFinancial } : {}), requiresReview: task.requiresReview }) as Record<string, JsonValue>;
  }

  requestTask(operation: string, requestId: string): TaskRecord | null {
    identifier(operation); identifier(requestId);
    if (this.options.collection && isCollectionOperation(operation)) return this.options.collection.requestTask(operation, requestId);
    if (this.options.financial && operation === 'tools.call') return this.options.financial.requestTask(operation, requestId);
    if (this.options.materials && operation === 'materials.inspect') return this.options.materials.requestTask(requestId);
    if (this.options.semantics && operation === 'materials.semantic-process') return this.options.semantics.requestTask(requestId);
    const row = this.options.core.store.one<{ id: string }>('SELECT id FROM tasks WHERE request_id=? AND owner_role=?',
      `service:local-operator:${operation}:${requestId}`, 'service');
    return row ? this.getTask(row.id) : null;
  }

  /** 模型只取完成判断与追溯编号；完整原件、步骤和读回仍在程序证据入口。 */
  modelTaskView(id: string): Record<string, JsonValue> {
    const task = this.getTask(id);
    const publicFinancial = this.options.financial?.publicTaskView?.(task);
    if (publicFinancial) return asJson({ ownerService: 'bd_agents', jobId: task.id, status: task.status, resultRef: task.resultRef,
      publicContract: publicFinancial, requiresReview: task.requiresReview }) as Record<string, JsonValue>;
    if (task.action === 'jobs.get' && task.status === 'succeeded') {
      const target = object(task.result?.data);
      return asJson({ ownerService: 'bd_agents', jobId: task.id, status: task.status, resultRef: task.resultRef,
        queriedTask: { jobId: target.jobId, operation: target.operation, status: target.status, resultRef: target.resultRef,
          requiresReview: target.requiresReview, error: target.error },
        note: '查询仅向模型返回任务状态与结果引用；原件、材料身份摘要与完整计算内容在本机入口查看。' }) as Record<string, JsonValue>;
    }
    if (task.action === 'runtime.status' && task.status === 'succeeded') {
      const status = object(task.result?.data), control = object(status.control);
      return asJson({ ownerService: 'bd_agents', jobId: task.id, status: task.status, resultRef: task.resultRef,
        runtime: { ...status, control: { stopped: control.stopped, generation: control.generation,
          activeTaskCount: Array.isArray(control.activeTaskIds) ? control.activeTaskIds.length : null } } }) as Record<string, JsonValue>;
    }
    if (task.action === 'tools.list' && task.status === 'succeeded') {
      const data = task.result?.data;
      return asJson({ ownerService: 'bd_agents', jobId: task.id, status: task.status, resultRef: task.resultRef,
        tools: Array.isArray(data) ? data.map(value => { const tool = object(value); return { capabilityId: tool.capabilityId,
          title: tool.title, pluginVersion: tool.pluginVersion, methodVersion: tool.methodVersion, implementationVersion: tool.implementationVersion }; }) : [],
        next: '计算前使用 tools_describe 读取所选方法的精确输入契约。' }) as Record<string, JsonValue>;
    }
    if (task.action === 'tools.call' && task.status === 'succeeded') {
      const result = object(task.result?.data);
      return asJson({ ownerService: 'bd_agents', jobId: task.id, status: task.status, resultRef: task.resultRef,
        computation: result.status, persistence: result.persistence, capabilityId: result.capabilityId,
        inputDigest: result.inputDigest, rowCount: Array.isArray(result.rows) ? result.rows.length : null,
        validInterval: result.validInterval, invalidIntervals: result.invalidIntervals,
        lastRows: Array.isArray(result.rows) ? result.rows.slice(-3) : [], limitations: result.limitations }) as Record<string, JsonValue>;
    }
    if (task.action === 'materials.inspect' || task.action === 'materials.semantic-process') return asJson({ ownerService: 'bd_agents', jobId: task.id, status: task.status,
      resultRef: task.resultRef, note: '原件与预览仅供本机查看；模型入口不返回材料内容。' }) as Record<string, JsonValue>;
    if (task.action !== 'collection.run' || task.status !== 'succeeded') return this.taskView(id);
    const data = object(task.result?.data), processed = object(object(data.result).data);
    const receipt = processed.receipt === null ? null : object(processed.receipt);
    const readback = processed.readback === null ? null : object(processed.readback);
    return asJson({ ownerService: 'bd_agents', jobId: task.id, status: task.status, resultRef: task.resultRef,
      environment: 'synthetic-test', completionCondition: data.completionCondition,
      collectionTaskId: data.collectionTaskId, collectionResultRef: data.collectionResultRef,
      processingTaskId: data.processingTaskId, processingResultRef: data.processingResultRef,
      database: receipt ? { state: receipt.state, jobId: receipt.databaseTaskId, receiptId: receipt.receiptId,
        commitId: receipt.commitId, snapshotId: receipt.snapshotId, outputIdentity: receipt.outputIdentity } : { state: 'not_sent' },
      readback: readback ? { state: 'matched', snapshotId: readback.snapshotId,
        rowCount: Array.isArray(readback.rows) ? readback.rows.length : null } : { state: 'not_requested' },
      limitations: ['仅隔离合成验收；正式绑定未启用。', '历史公开可得资格未知。'],
    }) as Record<string, JsonValue>;
  }

  validate(operation: string, args: unknown): Record<string, JsonValue> {
    const data = object(args);
    if (this.options.collection && isCollectionOperation(operation)) return this.options.collection.validate(operation, data);
    if (this.options.financial && ['tools.list', 'tools.describe', 'tools.call', 'plugins.status'].includes(operation)) return this.options.financial.validate(operation, data);
    if (operation === 'runtime.status') keys(data, []);
    else if (operation === 'jobs.get') { keys(data, ['jobId']); identifier(data.jobId); this.getTask(data.jobId); }
    else if (operation === 'test.echo') {
      keys(data, ['value']);
      if (data.value !== 'phase-one-synthetic') throw new TaskError('INVALID_SERVICE_ARGS', '安全测试只接受固定合成标记。');
    } else if (operation === 'collection.run' && this.options.collection) {
      keys(data, ['kind', 'inputId', 'planId', 'completionCondition', 'expectedSnapshotId']);
      if (!['file', 'source'].includes(String(data.kind))) throw new TaskError('INVALID_SERVICE_ARGS', '收集入口须选择已登记的文件或来源。');
      identifier(data.inputId); identifier(data.planId);
      if (data.completionCondition !== 'processed') throw new TaskError('INVALID_SERVICE_ARGS', '合成材料入口的完成条件须为加工完成。');
      if (data.expectedSnapshotId !== undefined && data.expectedSnapshotId !== null) identifier(data.expectedSnapshotId);
      this.options.collection.validate(data.kind === 'file' ? 'collection.receive' : 'collection.collect',
        data.kind === 'file' ? { fileInputId: data.inputId } : { sourceId: data.inputId });
      const catalog = object(this.options.collection.catalog());
      if (!Array.isArray(catalog.plans) || !catalog.plans.includes(data.planId)) throw new TaskError('PLAN_NOT_REGISTERED', '加工计划未由受信宿主登记。');
    } else if (operation === 'agent.chat') {
      keys(data, ['prompt']);
      if (typeof data.prompt !== 'string' || !data.prompt.trim() || data.prompt.length > 2000) throw new TaskError('INVALID_SERVICE_ARGS', '服务请求需要 1 到 2,000 个字符。');
    } else throw new TaskError('SERVICE_OPERATION_DISABLED', '此操作未在当前阶段启用。');
    return data as Record<string, JsonValue>;
  }

  submit(operation: string, args: unknown, requestId: string, parentTaskId?: string, host?: FinancialHostSubmission): TaskRecord {
    identifier(requestId);
    const data = this.validate(operation, args);
    if (parentTaskId !== undefined) this.getTask(parentTaskId);
    if (this.options.collection && isCollectionOperation(operation)) return this.options.collection.submit(operation, data, requestId, parentTaskId);
    if (this.options.financial && operation === 'tools.call') return this.options.financial.submit(operation, data, requestId, parentTaskId, host);
    const namespacedRequest = `service:local-operator:${operation}:${requestId}`;
    const existing = this.requestTask(operation, requestId);
    if (existing) {
      this.assertDispatch();
      if (existing.conversationId !== null || existing.title !== `框架服务：${operation}`
        || existing.runtimeId !== (operation === 'agent.chat' ? 'pi' : SERVICE_RUNTIME)
        || existing.action !== (operation === 'agent.chat' ? 'pi.prompt' : operation)
        || digestOperationArgs(existing.args) !== digestOperationArgs(data) || existing.parentTaskId !== (parentTaskId ?? null)
        || digestOperationArgs(existing.versions) !== digestOperationArgs(this.versions)) {
        throw new TaskError('REQUEST_CONFLICT', '同一原请求不能使用不同参数或关联任务。');
      }
      return existing;
    }
    this.assertDispatch();
    if (operation === 'collection.run') {
      const candidates = this.options.core.store.all<{ id: string }>("SELECT DISTINCT p.id FROM tasks p JOIN tasks c ON c.parent_task_id=p.id JOIN tasks s ON s.parent_task_id=c.id WHERE p.owner_role='service' AND p.action='collection.run' AND (s.requires_review=1 OR s.status='needs_review')");
      if (candidates.some(row => collectionMaterialIdentity(this.getTask(row.id).args) === collectionMaterialIdentity(data))) {
        throw new TaskError('COLLECTION_RESULT_UNCONFIRMED', '相同材料的原交接结果尚未确认，请先按原加工任务核对，不能建立另一交接。');
      }
    }
    const task = this.options.tasks().create({ title: `框架服务：${operation}`, ownerRole: 'service',
      runtimeId: operation === 'agent.chat' ? 'pi' : SERVICE_RUNTIME,
      action: operation === 'agent.chat' ? 'pi.prompt' : operation, args: data,
      requestId: namespacedRequest, parentTaskId,
      versions: this.versions });
    return this.options.tasks().start(task.id);
  }

  readonly runtime: TaskRuntime = {
    id: SERVICE_RUNTIME,
    execute: async (context) => {
      if (context.task.ownerRole !== 'service') throw new TaskError('SERVICE_ROLE_REQUIRED', '需要服务任务身份。');
      this.assertVersion(context.task);
      context.signal.throwIfAborted(); this.assertDispatch();
      if (this.options.financial && ['tools.list', 'tools.describe', 'plugins.status'].includes(context.task.action)) {
        const args = this.validate(context.task.action, context.task.args), financial = this.options.financial;
        return { summary: '金融能力查询已完成。', data: asJson(context.task.action === 'tools.list' ? financial.list()
          : context.task.action === 'tools.describe' ? financial.describe(String(args.capabilityId)) : financial.status()) };
      }
      if (context.task.action === 'collection.run' && this.options.collection) {
        const args = this.validate(context.task.action, context.task.args), collection = this.options.collection;
        const receive = collection.submit(args.kind === 'file' ? 'collection.receive' : 'collection.collect',
          args.kind === 'file' ? { fileInputId: args.inputId } : { sourceId: args.inputId }, `run:${context.task.id}:collect`, context.task.id);
        await context.emit({ type: 'checkpoint', checkpoint: { collectionTaskId: receive.id } });
        const collected = await this.options.tasks().wait(receive.id);
        context.signal.throwIfAborted(); this.assertDispatch();
        if (collected.status !== 'succeeded') throw new TaskError('COLLECTION_CHILD_INCOMPLETE', `收集任务 ${collected.id} 状态为 ${collected.status}；请按原编号恢复。`);
        const process = collection.submit('collection.process', { collectionTaskId: collected.id,
          planId: args.planId, completionCondition: args.completionCondition, expectedSnapshotId: args.expectedSnapshotId ?? null }, `run:${context.task.id}:process`);
        await context.emit({ type: 'checkpoint', checkpoint: { collectionTaskId: receive.id, processingTaskId: process.id } });
        const processed = await this.options.tasks().wait(process.id);
        context.signal.throwIfAborted();
        if (processed.status !== 'succeeded') throw new TaskError('COLLECTION_CHILD_INCOMPLETE', `加工任务 ${processed.id} 状态为 ${processed.status}；请按原编号核对或恢复，禁止重新交接。`);
        return { summary: '隔离合成数据的受控程序已达到所选完成条件。', data: {
          environment: 'synthetic-test', completionCondition: args.completionCondition,
          collectionTaskId: collected.id, collectionResultRef: collected.resultRef,
          processingTaskId: processed.id, processingResultRef: processed.resultRef, result: asJson(processed.result) } };
      }
      if (!['runtime.status', 'jobs.get', 'test.echo'].includes(context.task.action)) throw new TaskError('SERVICE_OPERATION_DISABLED', '此操作不属于本地平台执行器。');
      const args = this.validate(context.task.action, context.task.args);
      const data = context.task.action === 'runtime.status' ? this.status()
        : context.task.action === 'jobs.get' ? this.taskView(String(args.jobId))
        : { environment: 'synthetic-test', value: args.value, processed: true };
      return { summary: context.task.action === 'test.echo' ? '合成测试已执行。' : '平台只读查询已完成。', data };
    },
  };

}

function isCollectionOperation(operation: string): boolean { return ['collection.receive', 'collection.collect', 'collection.process'].includes(operation); }
function collectionMaterialIdentity(args: unknown): string {
  const data = object(args); return digestOperationArgs({ kind: data.kind, inputId: data.inputId, planId: data.planId });
}

function asJson(value: unknown): JsonValue { return JSON.parse(JSON.stringify(value)) as JsonValue; }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TaskError('INVALID_SERVICE_ARGS', '参数必须是对象。');
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new TaskError('INVALID_SERVICE_ARGS', '参数包含未允许的字段。');
}
function identifier(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(value)) throw new TaskError('INVALID_SERVICE_ARGS', '请求、任务或操作编号无效。');
}
function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new TaskError('INVALID_SERVICE_ARGS', '需要当前非负整数版本。');
  return Number(value);
}
function reason(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 500) throw new TaskError('INVALID_SERVICE_ARGS', '请填写明确控制原因。');
  return value;
}
