import type { PersonalCore } from '../agent/runtime/core.js';
import type { CoreDatabase } from '../../platform/state/database.js';
import type { WorkspaceServices } from '../../contracts/workspace-services.js';
import type { ModelTaskOrigin } from '../agent/model-tools.js';
import type { SkillRegistration } from '../../platform/plugins/registry.js';
import type { SkillField } from '../../contracts/skill-contracts.js';
import { TaskError, type TaskExecutionContext } from '../../platform/jobs/tasks.js';
import type { JsonValue, TaskResult } from '../../contracts/task-contracts.js';
import { isWfdRecord } from '../../adapters/database/wfd-transport.js';
import { acquireAuthority } from '../../platform/runtime/file-workspace.js';
import type { FileReferenceService } from '../../platform/resources/files.js';
import type { AlgorithmCatalogView } from './algorithm-types.js';
import { basicAlgorithmToolContract, bdSessionToolContract } from './basic-algorithm-tool-contract.js';

const ACTIONS = new Set(['bd.session.capabilities', 'algorithms.capabilities', 'algorithms.contract', 'algorithms.calculate', 'algorithms.status']);
const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;
const text = (key: string, label: string, maxLength = 160, required = true): SkillField =>
  ({ key, label, type: 'text', required, maxLength });
const view = (value: unknown): Record<string, JsonValue> => ({ kind: 'conversation-algorithm', modelPreview: json(value) });

/**
 * 基础算法与当前会话分支之间的只读/受控桥。
 *
 * - capabilities 只读目录、采用状态和真实数据库能力，不能采用、启用或授予 Python 执行权限。
 * - calculate 只提交已有 LocalAlgorithmService；审批仍由原服务任务和现有本机审批完成。
 * - status 只读本分支原任务；结果按有限窗口给模型，完整行留在原结果与后续候选对象中。
 */
export class ConversationAlgorithmBridge {
  readonly registrations: readonly SkillRegistration[];
  constructor(private readonly options: { database: CoreDatabase; core: PersonalCore; companion: WorkspaceServices; files?: FileReferenceService;
    origin(taskId: string): ModelTaskOrigin | null;
 }) {
    options.database.migrate('conversation_algorithm_links', 1, `CREATE TABLE conversation_algorithm_links(
      service_task_id TEXT PRIMARY KEY,local_task_id TEXT NOT NULL,operation TEXT NOT NULL,origin_json TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE INDEX conversation_algorithm_local ON conversation_algorithm_links(local_task_id);`);
    const registration = (action: string, title: string, description: string, fields: SkillField[]): SkillRegistration => ({
      action, title, description, fields, runtimeId: 'direct', kind: 'direct', modelCalls: 0,
      permissionSummary: ['只读取本机算法目录、采用状态与真实数据库能力；不能采用、启用或授予持续执行权限',
        '计算沿原算法服务任务与本机逐次审批；结果只是本地持久结果，不自动发布',
        '计算结果保留原身份；正式交接由 R1 单独核验并确认'],
      available: () => ({ available: !!options.companion.algorithms,
        ...(!options.companion.algorithms ? { reason: '基础算法服务尚未装配。' } : {}) }),
    });
    this.registrations = [
      registration('bd.session.capabilities', '查看 BD AGENTS 统一会话工具契约',
        '只读展示采集源、接口源、文件与基础算法的现有会话接口、边界和 WFD 输入要求；不启动采集、计算或发布。', []),
      registration('algorithms.contract', '读取基础算法统一接口契约',
        '返回各算法独立 methodId（算法编号）、参数、输入字段、版本及可调用状态。观测均线是基础算法目录的一个预留独立方法，尚未完成 WFD-only 移植时标记 blocked（不可执行）；不会假称已运行。',
        [text('methodId', '指定算法编号，留空返回全部', 160, false)]),
      registration('algorithms.capabilities', '发现本机基础算法与真实数据能力',
        '只读列出已登记基础算法、WFD 固定快照端口、采用状态及权限。不再提供文件/受管表直接计算；人类明确选择产品、算法和期间，模型据 WFD 实际元数据补齐调用参数。', []),
      registration('algorithms.calculate', '受控执行已登记基础算法',
        'calculationJson 由模型按 algorithms.contract 与 capabilities 的真实契约组装。只允许 kind=fixed_snapshot（WFD 固定快照）且必须人工明确请求；不接受受管原件。不自动入库、发布、唤醒或改用旧计算入口；沿原任务和本机权限核对后执行。', [
          text('calculationJson', '算法计算请求（模型从实际元数据组装）', 100_000),
        ]),
      registration('algorithms.status', '查看本会话原算法结果',
        '按本会话分支原算法任务编号读取真实状态、持久结果摘要、有限结果窗口和来源谱系。不重算、不发布、不读取其他会话任务；完整数值仍在原持久结果中。', [
          text('taskId', '原算法任务编号（来自本会话计算或状态结果）'),
        ]),
    ];
  }
  handles(action: string): boolean { return ACTIONS.has(action); }
  async execute(context: TaskExecutionContext): Promise<TaskResult> {
    const action = context.task.action, args = context.task.args as Record<string, JsonValue>;
    if (!this.handles(action)) throw new TaskError('ALGORITHM_ACTION', '未登记的算法会话动作。');
    const origin = this.options.origin(context.task.id);
    if (!origin) throw new TaskError('ALGORITHM_CONVERSATION_REQUIRED', '算法会话动作必须由本次真实会话代理调用。');
    const service = this.options.companion.algorithms;
    if (!service) throw new TaskError('ALGORITHM_UNAVAILABLE', '基础算法服务尚未装配。');
    // 直接模型动作必须先取得当前模型分享回执；否则 saveResultProof 会拒绝返回。
    const authority = await acquireAuthority(context, action, args, [],
      action === 'algorithms.calculate' ? { approvalMode: 'review' } : {});
    authority.assert(); this.options.companion.bd?.assertDispatch();
    if (action === 'bd.session.capabilities') {
      const contract = bdSessionToolContract(this.modelCatalog(service, origin));
      authority.assert();
      return { summary: '已读取 BD AGENTS 会话工具合同；只读，不创建采集、计算或发布任务。', data: view(contract) };
    }
    if (action === 'algorithms.contract') {
      const methodId = typeof args.methodId === 'string' && args.methodId.trim() ? args.methodId.trim() : undefined;
      const contract = basicAlgorithmToolContract(this.modelCatalog(service, origin), methodId);
      authority.assert();
      return { summary: '已读取基础算法独立接口及真实可用状态；未采用或执行任何方法。', data: view(contract) };
    }
    if (action === 'algorithms.capabilities') {
      const catalog = this.modelCatalog(service, origin);
      authority.assert();
      return { summary: catalog.enabled
        ? '已读取基础算法目录、受控采用状态和 WFD 固定快照能力；本动作只读，不能采用或授予权限。'
        : `算法入口当前未启用（${catalog.adoption.state}）；只能读取目录，不能计算。采用只由本机受控采用入口完成。`,
        data: view({ algorithms: catalog, database: json(catalog.inputs.fixedSnapshots), guidance: {
          humanInput: '人类只需说明材料/产品与算法；实例、快照、字段映射和内部编号由模型从实际元数据判断。',
          adoption: '工具不能自 adopt；未启用时不要改用旧 financial/compute_assets 入口。',
          managedTables: '已停止受管原件直接计算；必须先经原报管线发布 WFD 固定快照。',
          calculation: '计算沿原任务审批；publication=not_requested（未请求发布）只说明计算时状态，不能代替正式交接回执。',
          handoff: '计算结果本身不授予交接资格；正式交接须符合 R1（结构化交接）当前输入合同并由用户单独确认。',
        } }) };
    }
    if (action === 'algorithms.calculate') {
      let calculation: unknown;
      try { calculation = JSON.parse(String(args.calculationJson)); }
      catch { throw new TaskError('ALGORITHM_CALCULATION_JSON', '算法计算请求不是有效JSON。'); }
      if (!isWfdRecord(calculation)) throw new TaskError('ALGORITHM_CALCULATION_JSON', '算法计算请求必须是对象。');
      this.assertCalculationMaterials(calculation, origin);
      const submitted = service.submit('conversation:algorithms:' + context.task.id, calculation);
      const taskId = submitted.taskId;
      this.link(taskId, context.task.id, 'calculate', origin);
      await this.wait(context, taskId);
      const current = this.options.companion.tasks.get(taskId);
      authority.assert();
      return { summary: current.status === 'waiting_approval'
        ? '原算法任务正在等待本机操作者审批；尚未执行Python（编程语言）或产生结果。批准后按同一任务编号查询。'
        : current.status === 'succeeded' ? '算法计算已按原任务完成并持久结果；没有自动发布或提交。'
          : `算法任务当前状态为 ${current.status}；请按原编号核对，不能换号重算。`,
        data: view(this.statusPayload(taskId)) };
    }
    const taskId = String(args.taskId ?? '');
    this.assertLink(taskId, origin);
    if (action === 'algorithms.status') {
      authority.assert();
      return { summary: '已沿本会话原算法任务读取实际状态与持久结果；没有重算。publication 字段只是计算时状态，正式交接结果由原 R1（结构化交接）请求另行核对。', data: view(this.statusPayload(taskId)) };
    }
    throw new TaskError('ALGORITHM_ACTION', '未登记的算法会话动作。');
  }

  /** 代理只读取真实 WFD 固定快照目录；受管原件不再提供计算资格。 */
  private modelCatalog(service: NonNullable<WorkspaceServices['algorithms']>, _origin: ModelTaskOrigin): AlgorithmCatalogView {
    return service.catalog();
  }

  /** 计算请求只能引用 WFD 固定快照；权限由原服务读取端口继续核实。 */
  private assertCalculationMaterials(value: Record<string, unknown>, _origin: ModelTaskOrigin): void {
    const source = isWfdRecord(value.source) ? value.source : null;
    if (!source || source.kind !== 'fixed_snapshot') throw new TaskError('ALGORITHM_WFD_ONLY',
      '基础算法只接受 kind=fixed_snapshot 的 WFD 正式数据；不能让会话原件或模型自行取代已发布版本。');
  }

  private statusPayload(taskId: string) {
    const value = this.options.companion.algorithms!.view(taskId);
    const result = value.result;
    return { taskId: value.taskId, requestId: value.requestId, methodId: value.methodId, status: value.status,
      taskVersion: value.taskVersion, requiresReview: value.requiresReview, createdAt: value.createdAt, updatedAt: value.updatedAt,
      error: value.error, publication: value.publication, guidance: value.guidance,
      result: result ? { taskId: result.taskId, methodId: result.methodId, methodVersion: result.methodVersion,
        implementationVersion: result.implementationVersion, contractVersion: result.contractVersion, environment: result.environment,
        parameters: result.parameters, inputDigest: result.inputDigest, source: result.source, metadata: result.metadata,
        coverage: result.coverage, validInterval: result.validInterval, invalidIntervals: result.invalidIntervals,
        gaps: result.gaps, limitations: result.limitations, publication: result.publication, persistence: result.persistence,
        rowCount: result.rows.length, rows: result.rows.slice(0, 8),
        rowsOmitted: Math.max(0, result.rows.length - 8) } : null };
  }
  private link(serviceTaskId: string, localTaskId: string, operation: string, origin: ModelTaskOrigin) {
    this.options.database.connection.prepare('INSERT OR IGNORE INTO conversation_algorithm_links VALUES(?,?,?,?,?)')
      .run(serviceTaskId, localTaskId, operation, JSON.stringify(origin), Date.now());
    const row = this.options.database.connection.prepare('SELECT * FROM conversation_algorithm_links WHERE service_task_id=?')
      .get(serviceTaskId) as { local_task_id: string; operation: string; origin_json: string } | undefined;
    if (!row || row.local_task_id !== localTaskId || row.operation !== operation) {
      throw new TaskError('ALGORITHM_LINK_MISMATCH', '算法任务与原会话来源绑定不符。');
    }
    const saved = JSON.parse(row.origin_json) as ModelTaskOrigin;
    if (saved.conversationId !== origin.conversationId || saved.branchId !== origin.branchId) {
      throw new TaskError('ALGORITHM_LINK_MISMATCH', '算法任务不能跨会话分支登记。');
    }
  }
  private assertLink(taskId: string, origin: ModelTaskOrigin) {
    if (!/^[A-Za-z0-9_.:-]{1,160}$/u.test(taskId)) throw new TaskError('ALGORITHM_TASK_ID', '需要稳定的原算法任务编号。');
    const row = this.options.database.connection.prepare('SELECT origin_json,operation FROM conversation_algorithm_links WHERE service_task_id=?')
      .get(taskId) as { origin_json: string; operation: string } | undefined;
    const saved = row ? JSON.parse(row.origin_json) as ModelTaskOrigin : null;
    if (!row || !saved || saved.conversationId !== origin.conversationId || saved.branchId !== origin.branchId) {
      throw new TaskError('ALGORITHM_TASK_ORIGIN', '原算法任务不属于当前会话分支；不能跨分支查看或准备候选。');
    }
    return row;
  }
  private async wait(context: TaskExecutionContext, taskId: string) {
    const tasks = this.options.companion.tasks;
    context.signal.throwIfAborted();
    let abort!: () => void, unsubscribe = () => {};
    const stopped = new Promise<never>((_resolve, reject) => { abort = () => reject(new TaskError('ALGORITHM_WAIT_STOPPED', '会话已停止等待，原服务任务保持原身份。')); context.signal.addEventListener('abort', abort, { once: true }); });
    const ready = new Promise<void>((resolve, reject) => {
      const check = () => { const task = tasks.get(taskId); if (task.status === 'waiting_approval' || ['succeeded', 'failed', 'cancelled', 'interrupted', 'paused', 'needs_review'].includes(task.status)) resolve(); };
      unsubscribe = tasks.subscribe(event => { if (event.task.id === taskId) check(); });
      check(); void tasks.wait(taskId).then(() => resolve(), reject);
    });
    try { context.signal.throwIfAborted(); await Promise.race([ready, stopped]); }
    finally { unsubscribe(); context.signal.removeEventListener('abort', abort); }
  }
}
