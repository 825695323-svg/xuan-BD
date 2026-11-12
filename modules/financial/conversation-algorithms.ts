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
import { ALGORITHM_CONTRACT_VERSION, ALGORITHM_RUNTIME, type AlgorithmCatalogView } from './algorithm-types.js';
import { basicAlgorithmToolContract, bdSessionToolContract } from './basic-algorithm-tool-contract.js';
import { UNIFIED_POLARS_RUNTIME } from './unified-polars-execution.js';

const ACTIONS = new Set(['bd.session.capabilities', 'algorithms.capabilities', 'algorithms.contract', 'algorithms.calculate', 'algorithms.publish', 'algorithms.status']);
const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;
const text = (key: string, label: string, maxLength = 160, required = true): SkillField =>
  ({ key, label, type: 'text', required, maxLength });
const view = (value: unknown): Record<string, JsonValue> => ({ kind: 'conversation-algorithm', modelPreview: json(value) });

/**
 * 基础算法与当前会话分支的工具桥：固定方法执行并经过一次独立核对写回 WFD。
 *
 * - capabilities 只读目录、采用状态和真实数据库能力，不能采用、启用或授予 Python 执行权限。
 * - calculate 调用注册固定算法；没有逐次业务审批，任务身份与错误仍由 TaskService 持有。
 * - publish 仅恢复原 WFD 写入身份；status 只读本分支原任务。
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
      permissionSummary: ['只读取固定算法目录及真实 WFD 快照能力；工具本身不能授予程序执行器权限',
        '固定算法无逐次业务审批；宿主执行器许可与方法版本仍需核实',
        '结构化计算结果由独立核对器检查，直接复用 R1 与 WFD 固定读回，不回到原报五步'],
      available: () => ({ available: !!options.companion.productionCalculation || !!options.companion.algorithms,
        ...(!options.companion.productionCalculation && !options.companion.algorithms
          ? { reason: '数据生产的计算模块尚未装配。' } : {}) }),
    });
    this.registrations = [
      registration('bd.session.capabilities', '查看 BD AGENTS 统一会话工具契约',
        '只读展示采集源、接口源、文件与基础算法的现有会话接口、边界和 WFD 输入要求；不启动采集、计算或发布。', []),
      registration('algorithms.contract', '读取基础算法统一接口契约',
        '返回各算法独立 methodId（算法编号）、参数、输入字段、版本及可调用状态。观测均线是基础算法目录的一个预留独立方法，尚未完成 WFD-only 移植时标记 blocked（不可执行）；不会假称已运行。',
        [text('methodId', '指定算法编号，留空返回全部', 160, false)]),
      registration('algorithms.capabilities', '发现本机基础算法与真实数据能力',
        '只读列出固定基础算法、WFD 固定快照输入和当前执行能力。新计算只走 AGENTS 工具，结果由独立核对器直接提交 WFD，无须沿原报五步加工。', []),
      registration('algorithms.calculate', '受控执行已登记基础算法',
        'calculationJson 由 BD AGENTS 按算法契约和真实 WFD 固定快照组装。固定算法直接计算，独立核对器检查数据身份、方法版本、行值和摘要，复用 R1 正式提交与 WFD 固定读回。无需人工算法执行或派生入库审批，也不走原报五步加工。', [
          text('calculationJson', '算法计算请求（模型从实际元数据组装）', 100_000),
        ]),
      registration('algorithms.publish', '按原算法任务恢复 WFD 派生结果发布',
        '不重新计算、不接受自填数据行。按本会话已成功的原算法任务，核独立派生校验并沿原 R1 请求恢复提交与固定读回。',
        [text('taskId', '已完成算法任务编号')]),
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
    if (!service && !this.options.companion.productionCalculation)
      throw new TaskError('PRODUCTION_CALCULATION_UNAVAILABLE', '数据生产计算模块尚未装配。');
    // 直接模型动作必须先取得当前模型分享回执；否则 saveResultProof 会拒绝返回。
    const authority = await acquireAuthority(context, action, args, []);
    authority.assert(); this.options.companion.bd?.assertDispatch();
    if (action === 'bd.session.capabilities') {
      const contract = bdSessionToolContract(this.modelCatalog(service, origin), this.options.companion.unifiedPolars?.capabilities());
      const processing = this.options.companion.processing?.catalog();
      const cleaning = isWfdRecord(processing) && isWfdRecord(processing.cleaningEngine)
        ? processing.cleaningEngine : { status: 'not_configured', reason: '数据清洗服务未装配。' };
      const calculation = this.options.companion.productionCalculation?.capabilities() ?? null;
      authority.assert();
      return { summary: '已读取清洗与计算两条独立按需接口；只读发现，不启动自动清洗、因子计算或发布。',
        data: view({ ...contract, onDemand: {
          cleaning: { description: '原报解析与严格清洗；按会话选择材料后显式计划/执行',
            discovery: 'data.processing.capabilities', plan: 'data.processing.plan',
            execute: 'data.processing.run', engine: cleaning,
            source: '受管原件及冻结来源；不读取计算公式注册表' },
          calculation: { description: '读取 WFD 固定数据，按登记方法执行 Polars 或受信 pandas 公式',
            discovery: 'algorithms.contract', execute: 'algorithms.calculate',
            publish: 'algorithms.publish', engine: calculation,
            source: 'WFD fixed snapshot; not original cleaning candidates' },
          sharedVerification: 'production-verifier (行、类型、结果摘要) + 领域专属方法核验',
          sharedPublication: 'existing R1/WFD readback only',
          automaticCrossTrigger: false,
        } }) };
    }
    if (action === 'algorithms.contract') {
      const methodId = typeof args.methodId === 'string' && args.methodId.trim() ? args.methodId.trim() : undefined;
      const contract = basicAlgorithmToolContract(this.modelCatalog(service, origin), methodId, this.options.companion.unifiedPolars?.capabilities());
      authority.assert();
      return { summary: '已读取基础算法独立接口及真实可用状态；未采用或执行任何方法。', data: view(contract) };
    }
    if (action === 'algorithms.capabilities') {
      const catalog = this.modelCatalog(service, origin), unified = this.options.companion.unifiedPolars?.capabilities();
      authority.assert();
      return { summary: catalog.enabled || unified?.status === 'ready'
        ? '已读取基础算法目录、固定代码版本与 WFD 快照能力；本动作只读，不创建计算。'
        : `算法运行条件尚未就绪（${catalog.reason ?? '执行器或 WFD 快照端口不可用'}）；本次仅返回目录。`,
        data: view({ algorithms: catalog, methodDirectory: basicAlgorithmToolContract(catalog, undefined, unified).methods,
          unifiedPolars: unified ? json(unified) : null,
          productionCalculation: this.options.companion.productionCalculation
            ? json(this.options.companion.productionCalculation.capabilities()) : null,
          database: json(catalog.inputs.fixedSnapshots), guidance: {
          humanInput: '用户说明 WFD 数据和目标算法，由模型读取真实快照与方法契约形成调用，无需人工逐次计算确认。',
          adoption: '工具不能自 adopt；未启用时不要改用旧 financial/compute_assets 入口。',
          managedTables: '已停止受管原件直接计算；必须先经原报管线发布 WFD 固定快照。',
          calculation: '已登记固定实现由 AGENTS 调用计算；没有逐次业务审核，但必须保留原任务、方法版本及 WFD 快照证据。',
          handoff: '独立核对后由专用 WFD 发布者复用 R1 正式写入和固定读回；无派生五步加工。',
        } }) };
    }
    if (action === 'algorithms.calculate') {
      let calculation: unknown;
      try { calculation = JSON.parse(String(args.calculationJson)); }
      catch { throw new TaskError('ALGORITHM_CALCULATION_JSON', '算法计算请求不是有效JSON。'); }
      if (!isWfdRecord(calculation)) throw new TaskError('ALGORITHM_CALCULATION_JSON', '算法计算请求必须是对象。');
      this.assertCalculationMaterials(calculation, origin);
      const production = this.options.companion.productionCalculation;
      if (!production) throw new TaskError('PRODUCTION_CALCULATION_UNAVAILABLE',
        '计算模块未装配，不能把清洗管线当算法执行器。');
      // 各方法按受信注册表选择 Polars / pandas；仍由唯一 TaskService 持有原任务。
      const submitted = production.submit('conversation:algorithms:' + context.task.id, calculation);
      const taskId = submitted.taskId;
      this.link(taskId, context.task.id, 'calculate', origin);
      await this.wait(context, taskId);
      const current = this.options.companion.tasks.get(taskId);
      authority.assert();
      if (current.status !== 'succeeded' || current.requiresReview) {
        return { summary: `原固定算法任务状态为 ${current.status}；尚未发布 WFD，必须按原号核对。`,
          data: view(this.statusPayload(taskId)) };
      }
      // 算法与清洗分别执行，结果只共用生产核对门禁和原 R1/WFD 正式交接。
      const publication = await production.publish(taskId, context.signal);
      authority.assert();
      return { summary: publication.published
        ? '生产管线固定计算、独立来源核对和 WFD 正式发布/固定读回已完成。'
        : `计算已完成，但原 R1 提交状态为 ${publication.state}；未确认正式入库，必须按原任务继续核对。`,
        data: view({ ...this.statusPayload(taskId), wfdPublication: publication }) };
    }
    const taskId = String(args.taskId ?? '');
    this.assertLink(taskId, origin);
    if (action === 'algorithms.publish') {
      const production = this.options.companion.productionCalculation;
      if (!production) throw new TaskError('PRODUCTION_CALCULATION_UNAVAILABLE', '计算结果的原 R1/WFD 发布适配器未装配。');
      const task = this.options.companion.tasks.get(taskId);
      if (task.status !== 'succeeded' || task.requiresReview)
        throw new TaskError('DERIVED_RESULT_NOT_READY', '原计算任务未完成，不重新计算或更换任务身份。');
      const publication = await production.publish(taskId, context.signal);
      authority.assert();
      return { summary: publication.published ? '原生产计算结果已完成 WFD 正式读回。'
        : `原派生请求状态为 ${publication.state}，保留身份继续核对。`,
        data: view({ taskId, wfdPublication: publication }) };
    }
    if (action === 'algorithms.status') {
      authority.assert();
      return { summary: '已沿本会话原算法任务读取实际状态与持久结果；没有重算。publication 字段只是计算时状态，正式交接结果由原 R1（结构化交接）请求另行核对。', data: view(this.statusPayload(taskId)) };
    }
    throw new TaskError('ALGORITHM_ACTION', '未登记的算法会话动作。');
  }

  /** 代理只读取真实 WFD 固定快照目录；受管原件不再提供计算资格。 */
  private modelCatalog(service: WorkspaceServices['algorithms'], _origin: ModelTaskOrigin): AlgorithmCatalogView {
    if (service) return service.catalog();
    // Polars 是可独立装配的生产计算引擎，不能被旧 Python 算法采用状态阻断。
    const reason = '原 Python 算法服务未装配；固定公式以数据生产方法表的实际能力为准。';
    const fixed = !!this.options.companion.r1Workspace?.capabilities().connection;
    return {
      contractVersion: ALGORITHM_CONTRACT_VERSION, runtime: ALGORITHM_RUNTIME,
      environment: 'local-review', status: 'unavailable', enabled: false, reason,
      adoption: { state: 'not_adopted', reason,
        current: { environment: 'local-review', assetsVersion: '', codeVersion: '', pythonDigest: '' },
        record: null, required: { environment: 'local-review', expectedAssetsVersion: '',
          expectedCodeVersion: '', confirmation: 'adopt-local-review' } },
      implementation: { version: '', files: {}, codeVersion: '', codeFiles: {},
        binding: 'source-code', bindingRequired: false },
      execution: { pythonDigest: null, permission: 'unavailable', reason },
      methods: [], inputs: {
        managedTables: { status: 'unavailable', reason: '生产计算只读取正式 WFD 固定快照。', items: [] },
        fixedSnapshots: { status: fixed ? 'available' : 'unavailable',
          reason: fixed ? null : '受信 WFD 固定读取尚未装配。',
          contract: { contract: 'wfd.data-service/v1', required: 'snapshotId,productId,recordVersion' } },
      }, limitations: ['不提供旧 Python 算法服务时，仍可使用已装配的 Polars 固定公式。'],
    };
  }

  /** 计算请求只能引用 WFD 固定快照；权限由原服务读取端口继续核实。 */
  private assertCalculationMaterials(value: Record<string, unknown>, _origin: ModelTaskOrigin): void {
    const source = isWfdRecord(value.source) ? value.source : null;
    if (!source || source.kind !== 'fixed_snapshot') throw new TaskError('ALGORITHM_WFD_ONLY',
      '基础算法只接受 kind=fixed_snapshot 的 WFD 正式数据；不能让会话原件或模型自行取代已发布版本。');
  }

  private statusPayload(taskId: string) {
    const task = this.options.companion.tasks.get(taskId);
    if (task.runtimeId === UNIFIED_POLARS_RUNTIME) {
      const structured = this.options.companion.unifiedPolars;
      if (!structured) throw new TaskError('UNIFIED_POLARS_UNAVAILABLE', '原计算执行器已下线；不能伪造结果。');
      const value = structured.view(taskId), result = value.result;
      return { taskId: value.taskId, requestId: value.requestId, methodId: value.methodId,
        status: value.status, taskVersion: value.taskVersion, requiresReview: value.requiresReview,
        createdAt: value.createdAt, updatedAt: value.updatedAt, error: value.error,
        publication: value.publication, guidance: value.guidance,
        result: result ? { taskId: result.taskId, methodId: result.methodId,
          methodVersion: result.methodVersion, implementationVersion: result.implementationVersion,
          version: result.version, source: result.source, candidateSha256: result.candidateSha256,
          inputDigest: result.inputDigest, computedAt: result.computedAt, publication: result.publication,
          rowCount: result.rows.length, rows: result.rows.slice(0, 8),
          rowsOmitted: Math.max(0, result.rows.length - 8) } : null };
    }
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
