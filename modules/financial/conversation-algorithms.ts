import type { PersonalCore } from '../agent/runtime/core.js';
import type { CoreDatabase } from '../../platform/state/database.js';
import type { WorkspaceServices } from '../../contracts/workspace-services.js';
import type { ModelTaskOrigin } from '../agent/model-tools.js';
import type { SkillRegistration } from '../../platform/plugins/registry.js';
import type { SkillField } from '../../contracts/skill-contracts.js';
import { TaskError, type TaskExecutionContext } from '../../platform/jobs/tasks.js';
import type { JsonValue, TaskResult } from '../../contracts/task-contracts.js';
import { canonicalWfdJson, isWfdRecord, wfdSha256 } from '../../adapters/database/wfd-transport.js';
import { acceptWorkspaceMaterial } from '../collection/accept-material.js';
import { acquireAuthority } from '../../platform/runtime/file-workspace.js';
import type { FileReferenceService } from '../../platform/resources/files.js';
import type { AlgorithmCatalogView } from './algorithm-types.js';
import { basicAlgorithmToolContract, bdSessionToolContract } from './basic-algorithm-tool-contract.js';

const ACTIONS = new Set(['bd.session.capabilities', 'algorithms.capabilities', 'algorithms.contract', 'algorithms.calculate', 'algorithms.stage', 'algorithms.status']);
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
    options.database.migrate('conversation_algorithm_derived', 1, `CREATE TABLE conversation_algorithm_derived (
      service_task_id TEXT PRIMARY KEY, material_id TEXT NOT NULL UNIQUE,
      material_sha256 TEXT NOT NULL, result_sha256 TEXT NOT NULL, origin_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );`);
    this.registrations = [
      registration('bd.session.capabilities', '查看 BD AGENTS 统一会话工具契约',
        '只读展示采集源、接口源、文件与基础算法的现有会话接口、边界和 WFD 输入要求；不启动采集、计算或发布。', []),
      registration('algorithms.contract', '读取基础算法统一接口契约',
        '返回各算法独立 methodId（算法编号）、参数、输入字段、版本及可调用状态。观测均线是基础算法目录的一个预留独立方法，尚未完成 WFD-only 移植时标记 blocked（不可执行）；不会假称已运行。',
        [text('methodId', '指定算法编号，留空返回全部', 160, false)]),
      registration('algorithms.capabilities', '发现本机基础算法与真实数据能力',
        '只读列出已登记基础算法、WFD 固定快照端口、采用状态及权限。不再提供文件/受管表直接计算；人类明确选择产品、算法和期间，模型据 WFD 实际元数据补齐调用参数。', []),
      registration('algorithms.calculate', '受控执行已登记基础算法',
        'calculationJson 由 BD AGENTS 按 algorithms.contract 与真实 WFD 快照组装。仅接受 fixed_snapshot（WFD 固定快照），不接受原件。AGENTS 完成计算后使用 algorithms.stage、五步加工、data.r1.prepare_derived 与 data.r1.submit 正式存回 WFD。', [
          text('calculationJson', '算法计算请求（模型从实际元数据组装）', 100_000),
        ]),
      registration('algorithms.stage', '保管本会话算法新数据供 WFD 正式入库',
        '只从本会话已完成的基础算法原任务取得完整计算结果，核实算法版本、WFD 输入快照和行摘要后保管为受管派生材料；由 data.processing.* 实际加工、data.r1.prepare_derived 和 data.r1.submit 核对正式发布。不允许模型提供结果行。',
        [text('taskId', '本会话已完成的基础算法任务编号')]),
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
      action === 'algorithms.stage' ? { approvalMode: 'review' } : {});
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
        ? '原算法任务等待独立执行权限审核；尚未执行 Python（编程语言）或产生结果。按原任务编号查询。'
        : current.status === 'succeeded' ? '算法结果已完成，尚需 AGENTS 保管新数据、加工并经 R1 写回 WFD，不能冒充正式入库。'
          : `算法任务当前状态为 ${current.status}；请按原编号核对，不能换号重算。`,
        data: view(this.statusPayload(taskId)) };
    }
    const taskId = String(args.taskId ?? '');
    this.assertLink(taskId, origin);
    if (action === 'algorithms.stage') {
      const completed = service.view(taskId);
      if (completed.status !== 'succeeded' || completed.requiresReview || completed.result?.status !== 'computed')
        throw new TaskError('ALGORITHM_RESULT_NOT_READY', '原算法任务未形成已核对的完整结果，禁止作为新数据入库。');
      const result = completed.result;
      if (!isWfdRecord(result.source) || result.source.kind !== 'wfd_fixed_snapshot'
        || !Array.isArray(result.rows) || !result.rows.length || result.source.snapshotId === 'latest')
        throw new TaskError('ALGORITHM_WFD_INPUT_REQUIRED', '派生候选缺少真实固定 WFD 输入及可核对的完整行。');
      const bytes = Buffer.from(canonicalWfdJson(result.rows), 'utf8');
      if (bytes.length > 2_000_000) throw new TaskError('ALGORITHM_DERIVED_BYTE_BUDGET', '计算结果超过受控派生材料的 2 MB 上限；不截断行。');
      const sha256 = wfdSha256(bytes), resultSha256 = wfdSha256(canonicalWfdJson(result));
      authority.assert();
      const custodyId = await acceptWorkspaceMaterial(this.options.companion, {
        bytes, name: 'algorithm-derived-' + taskId + '.json', category: 'data', requestId: 'alg-stage:' + taskId });
      const custody = await this.waitService(context, custodyId);
      const material = this.options.companion.materials?.getByTask(custody.id);
      if (custody.status !== 'succeeded' || !material || material.envelope.sha256 !== sha256)
        throw new TaskError('ALGORITHM_DERIVED_CUSTODY_PENDING', '派生候选未完成受控保管，保留原保管任务编号核对。');
      const prior = this.options.database.connection.prepare('SELECT * FROM conversation_algorithm_derived WHERE service_task_id=?')
        .get(taskId) as { service_task_id: string; material_id: string; material_sha256: string; result_sha256: string; origin_json: string } | undefined;
      if (prior && (prior.material_id !== material.envelope.materialId || prior.material_sha256 !== sha256
        || prior.result_sha256 !== resultSha256)) throw new TaskError('ALGORITHM_DERIVED_IDENTITY_CONFLICT', '原算法派生保管身份已固定，不能更换材料或结果。');
      if (!prior) this.options.database.connection.prepare('INSERT INTO conversation_algorithm_derived VALUES(?,?,?,?,?,?)')
        .run(taskId, material.envelope.materialId, sha256, resultSha256, JSON.stringify(origin), Date.now());
      authority.assert();
      return { summary: '已把真实算法结果保管为派生材料；尚未发布。请沿现有五步加工、R1 正式发布和固定读回完成入库。',
        data: view({ taskId, materialId: material.envelope.materialId, custodyTaskId: custodyId,
          materialSha256: sha256, resultSha256, methodId: result.methodId, methodVersion: result.methodVersion,
          inputSource: result.source, publication: 'not_requested', next: ['data.processing.capabilities',
            'data.processing.plan', 'data.processing.run', 'data.r1.prepare', 'data.r1.submit'] }) };
    }
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

  private async waitService(context: TaskExecutionContext, taskId: string) {
    context.signal.throwIfAborted();
    const task = await this.options.companion.tasks.wait(taskId);
    context.signal.throwIfAborted();
    return task;
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
