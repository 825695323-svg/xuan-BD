import type { CoreDatabase } from '../../platform/state/database.js';
import type { WorkspaceServices } from '../../contracts/workspace-services.js';
import type { ModelTaskOrigin } from '../agent/model-tools.js';
import type { PersonalCore } from '../agent/runtime/core.js';
import type { SkillRegistration } from '../../platform/plugins/registry.js';
import type { SkillField } from '../../contracts/skill-contracts.js';
import { TaskError, type TaskExecutionContext } from '../../platform/jobs/tasks.js';
import type { JsonValue, TaskResult } from '../../contracts/task-contracts.js';
import { canonicalWfdJson, isWfdRecord } from '../../adapters/database/wfd-transport.js';
import { acquireAuthority } from '../../platform/runtime/file-workspace.js';
import { ALGORITHM_CONTRACT_VERSION, ALGORITHM_RUNTIME, isAlgorithmMethodId, type AlgorithmCatalogView, type AlgorithmSubmissionContext } from './algorithm-types.js';
import type { LocalAlgorithmService } from './algorithm-service.js';
import { algorithmAllowedByRules, basicAlgorithmToolContract, bdSessionToolContract, frozenAlgorithmCapabilities,
  BD_SESSION_TOOL_CONTRACT_VERSION } from './basic-algorithm-tool-contract.js';
import { ALGORITHM_REGISTRY_VERSION } from './algorithm-registry.js';
import { productionModuleDirectory, processingSessionContract } from '../collection/production-module-ports.js';
import { historicalExclusionSummary, screenFixedWfdStrategy, strategyScreenContract, STRATEGY_SCREEN_WFD_VERSION } from './strategy-screen-wfd.js';
import { STRATEGY_SCREEN_VERSION } from './strategy-screen.js';

const ACTIONS = new Set(['bd.session.capabilities', 'algorithms.capabilities', 'algorithms.contract', 'algorithms.calculate', 'algorithms.screen', 'algorithms.publish', 'algorithms.status', 'data.modules.calculate']);
const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;
const text = (key: string, label: string, maxLength = 160, required = true): SkillField =>
  ({ key, label, type: 'text', required, maxLength });
const view = (value: unknown): Record<string, JsonValue> => ({ kind: 'conversation-algorithm', modelPreview: json(value) });

function previewSource(source: JsonValue) {
  if (!isWfdRecord(source) || !isWfdRecord(source.resolution)) return source;
  const resolution = source.resolution, history = isWfdRecord(resolution.historicalRead) ? resolution.historicalRead : {};
  const diagnostics = Array.isArray(history.diagnostics) ? history.diagnostics : resolution.diagnostics;
  const historical = [source.perspective, history.actualPerspective, history.requestedPerspective]
    .some(mode => mode === 'market_known_at' || mode === 'system_held_at');
  if (!historical && !(Array.isArray(diagnostics) && diagnostics.length)) return source;
  // 逐行身份、原始诊断及完整读取证据留在原算法结果。模型只读固定身份、摘要与历史范围。
  return { ...source, resolution: {
    contract: resolution.contract, operation: resolution.operation, instanceId: resolution.instanceId,
    productId: resolution.productId, snapshotId: resolution.snapshotId, rowCount: resolution.rowCount,
    valueProjectionSha256: resolution.valueProjectionSha256,
    historicalRead: { actualPerspective: history.actualPerspective, actualAt: history.actualAt,
      actualHeldScope: history.actualHeldScope, actualUsableStage: history.actualUsableStage,
      countBasis: 'diagnostics_retained_in_original_task',
      historicalExclusions: Array.isArray(diagnostics) ? historicalExclusionSummary(diagnostics) : null },
  } };
}

function previewError(error: { code: string; message: string } | null) {
  if (error?.code !== 'ALGORITHM_HISTORICAL_NO_ELIGIBLE_VERSION') return error;
  // 旧失败回执的正文可能仍含原始诊断，或在任务错误长度上限处被截断。
  try {
    const detail: unknown = JSON.parse(error.message);
    if (isWfdRecord(detail) && Array.isArray(detail.diagnostics))
      return { code: error.code, message: JSON.stringify(historicalExclusionSummary(detail.diagnostics)) };
    if (isWfdRecord(detail) && isWfdRecord(detail.historicalExclusions) && isWfdRecord(detail.historicalExclusions.byReason))
      return { code: error.code, message: JSON.stringify(historicalExclusionSummary({ byReason: detail.historicalExclusions.byReason })) };
  } catch { /* 残缺的历史正文没有可安全读回的完整统计。 */ }
  return { code: error.code, message: '该固定快照在所请求的历史截止没有合格版本。' };
}

interface HistoricalIntent {
  action: 'algorithms.calculate' | 'algorithms.screen'; historyMode: string; cutoff: string;
  snapshotId: unknown; productId: unknown; methodId?: unknown; heldScope?: unknown; usableStage?: unknown;
}

/** 只认当前分支最后一个已消费的真实用户输入。结构化用途声明须由用户本人作出，不能从工具参数摘取任意原话。 */
export function conversationAlgorithmSubmission(core: PersonalCore, origin: ModelTaskOrigin, intent?: HistoricalIntent): AlgorithmSubmissionContext | undefined {
  if (!core.isRunActive(origin.parentRunId, origin.parentGeneration)) return;
  let source;
  try { source = core.captureTaskCompletionOrigin(origin.inputId); }
  catch { return; }
  const command = core.store.command(origin.inputId);
  if (source.conversationId !== origin.conversationId || source.branchId !== origin.branchId
    || source.sourceMessageId !== origin.messageId || source.sourceGeneration !== origin.parentGeneration
    || command.run_id !== origin.parentRunId) return;
  const message = core.store.message(origin.messageId);
  if (message.conversation_id !== origin.conversationId || message.role !== 'user' || message.text !== command.text) return;
  if (intent && !matchesHistoricalDeclaration(message.text, intent)) return;
  const context = { authority: 'user-message' as const, messageId: message.id, quote: message.text, observedAtUtc: message.created_at,
    conversationId: origin.conversationId, branchId: origin.branchId, parentRunId: origin.parentRunId };
  return context;
}

function matchesHistoricalDeclaration(text: string, intent: HistoricalIntent): boolean {
  const perspective = intent.historyMode === 'market_known_at' ? '市场可知' : '系统持有';
  const operation = intent.action === 'algorithms.screen' ? '筛选历史候选' : '执行历史计算';
  if (text.trim().replace(/。$/u, '') === `请按${perspective}视角，以 ${intent.cutoff} 为截止${operation}`) return true;
  let declaration: unknown;
  try { declaration = JSON.parse(text); }
  catch { return false; }
  return isWfdRecord(declaration) && declaration.purpose === 'historical_compute' && declaration.action === intent.action
    && declaration.historyMode === intent.historyMode && declaration.cutoff === intent.cutoff
    && Object.entries(declaration).every(([key, value]) => key === 'purpose'
      || Object.hasOwn(intent, key) && value === intent[key as keyof HistoricalIntent]);
}

function hasScreenReader(port: WorkspaceServices['r1Workspace']): boolean {
  if (typeof port?.readProduct !== 'function') return false;
  if (!port.capabilities) return true;
  try {
    const caps = port.capabilities();
    const configured = !!caps?.connection && typeof caps.connection.connectionId === 'string' && !!caps.connection.connectionId.trim()
      && (caps.configuration === undefined || caps.configuration?.state === 'configured');
    return configured && typeof port.readBinding === 'function' && !!port.readBinding();
  } catch { return false; }
}

/**
 * 基础算法与当前会话分支的工具桥：固定方法执行并经过一次独立核对写回 WFD。
 *
 * - capabilities 只读目录、历史采用诊断和真实数据库能力，不能启用或授予 Python 执行权限。
 * - calculate 调用注册固定算法；没有逐次业务审批，任务身份与错误仍由 TaskService 持有。
 * - screen 只对完整固定截面运行受限规则，返回研究候选；不执行 Python、不自动发布。
 * - publish 仅恢复原 WFD 写入身份；status 只读本分支原任务。
 */
export class ConversationAlgorithmBridge {
  readonly versionBinding = { algorithmRegistry: ALGORITHM_REGISTRY_VERSION, sessionTools: BD_SESSION_TOOL_CONTRACT_VERSION,
    strategyScreen: STRATEGY_SCREEN_VERSION, strategyScreenInput: STRATEGY_SCREEN_WFD_VERSION };
  readonly registrations: readonly SkillRegistration[];
  constructor(private readonly options: { database: CoreDatabase; companion: WorkspaceServices & { algorithms?: Pick<LocalAlgorithmService, 'submit'> };
    origin(taskId: string): ModelTaskOrigin | null;
    rulesVersion(runId: string): number | undefined;
    submissionContext?(origin: ModelTaskOrigin, intent?: HistoricalIntent): AlgorithmSubmissionContext | undefined;
 }) {
    options.database.migrate('conversation_algorithm_links', 1, `CREATE TABLE conversation_algorithm_links(
      service_task_id TEXT PRIMARY KEY,local_task_id TEXT NOT NULL,operation TEXT NOT NULL,origin_json TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE INDEX conversation_algorithm_local ON conversation_algorithm_links(local_task_id);`);
    const registration = (action: string, title: string, description: string, fields: SkillField[]): SkillRegistration => ({
      action, title, description, fields, runtimeId: 'direct', kind: 'direct', modelCalls: 0,
      permissionSummary: ['只读取固定算法目录及真实 WFD 快照能力；工具本身不能授予程序执行器权限',
        '固定算法无逐次业务审批；宿主执行器许可与方法版本仍需核实',
        '结构化计算结果由独立核对器检查，直接复用 R1 与 WFD 固定读回，不回到原报五步'],
      available: () => {
        const hasAlgorithms = !!options.companion.algorithms;
        const calculationAvailable = hasAlgorithms && !!options.companion.derivedPublisher
          && typeof options.companion.algorithms!.catalog === 'function'
          && options.companion.algorithms!.catalog().status === 'available';
        const enabled = options.companion.productionModuleSwitches?.calculate !== false;
        const discovery = ['algorithms.capabilities', 'algorithms.contract', 'bd.session.capabilities'].includes(action);
        const available = action === 'algorithms.screen' ? enabled && hasScreenReader(options.companion.r1Workspace)
          : action === 'data.modules.calculate' || action === 'algorithms.calculate' ? calculationAvailable && enabled
            : action === 'algorithms.publish' ? calculationAvailable
              : action === 'algorithms.status' ? hasAlgorithms
                : discovery && (hasAlgorithms || !!options.companion.r1Workspace?.readProduct
                  || action === 'bd.session.capabilities' && !!options.companion.processing);
        return { available, ...(!available
          ? { reason: action === 'algorithms.screen' ? !enabled ? '计算模块已停用。' : '受信 WFD 固定读取未装配。'
            : !enabled && (action === 'data.modules.calculate' || action === 'algorithms.calculate') ? '计算模块已停用。'
            : action === 'bd.session.capabilities'
            ? '清洗和计算工具均未装配。' : '计算服务或 WFD 固定输入/发布端口未就绪；只读目录或历史状态仍可单独查询。' } : {}) };
      },
    });
    this.registrations = [
      registration('bd.session.capabilities', '查看 BD AGENTS 统一会话工具契约',
        '只读展示采集源、接口源、文件与基础算法的现有会话接口、边界和 WFD 输入要求；不启动采集、计算或发布。', []),
      registration('algorithms.contract', '读取基础算法统一接口契约',
        '返回受控日线指标的 methodId（算法编号）、参数、输入字段、版本及可调用状态。MACD 沿用固定 12/26/9。',
        [text('methodId', '指定算法编号，留空返回全部', 160, false)]),
      registration('algorithms.capabilities', '发现本机基础算法与真实数据能力',
        '只读列出固定基础算法、WFD 固定快照输入和当前执行能力。新计算只走 AGENTS 工具，结果由独立核对器直接提交 WFD，无须沿原报五步加工。', []),
      registration('algorithms.calculate', '受控执行已登记基础算法',
        'calculationJson 由 BD AGENTS 按算法契约和真实 WFD 固定快照组装。固定算法直接计算，独立核对器检查数据身份、方法版本、行值和摘要，复用 R1 正式提交与 WFD 固定读回。无需人工算法执行或派生入库审批，也不走原报五步加工。', [
          text('calculationJson', '算法计算请求（模型从实际元数据组装）', 100_000),
        ]),
      registration('data.modules.calculate', '受控指标计算模块',
        '该入口是已有 algorithms.calculate 的受信别名，只接受登记公式和真实 WFD 固定引用，不允许用户指定执行器。结果保留原任务与 R1/WFD 发布身份。',
        [text('calculationJson', '算法计算请求，按固定WFD与方法契约组成', 100_000)]),
      { ...registration('algorithms.screen', '在固定 WFD 截面执行声明式策略筛选',
        'screenJson 固定 snapshotId/productId/historyMode、selection.dateField/date/dateFormat、factorNames/keyField/filter/orderBy/topN；历史视角须明确 at 等。完整有界读取后执行有限规则，返回候选与真实固定证据。缺少分页、日期或资格证据时拒绝；不接受自填行、不写回 WFD、不自动下单。先用 algorithms.contract methodId=strategy_screen 读取详细合同。',
        [text('screenJson', '固定 WFD 截面与声明式规则 JSON', 100_000)]),
        permissionSummary: ['只使用现有 WFD 固定读取，日期、历史视角与实际读取结果逐项核对',
          '完整截面上运行封闭规则，候选和排除原因返回原任务；不依赖 Python',
          '计算模块停用即拒绝；不自动发布、不改变参数或持仓、不下单'] },
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
    const screenReader = !!this.options.companion.r1Workspace?.readProduct;
    if (!service
      && !(screenReader && ['algorithms.screen', 'algorithms.capabilities', 'algorithms.contract', 'bd.session.capabilities'].includes(action))
      && (action !== 'bd.session.capabilities' || !this.options.companion.processing))
      throw new TaskError('PRODUCTION_CALCULATION_UNAVAILABLE', '计算模块未装配；不能伪造可执行算法。');
    // 直接模型动作必须先取得当前模型分享回执；否则 saveResultProof 会拒绝返回。
    const authority = await acquireAuthority(context, action, args, []);
    authority.assert(); this.options.companion.bd?.assertDispatch();
    const rulesVersion = this.options.rulesVersion(origin.parentRunId);
    if (action === 'bd.session.capabilities') {
      const catalog = this.modelCatalog(service, rulesVersion);
      const contract = bdSessionToolContract(catalog, rulesVersion);
      const processing = this.options.companion.processing?.catalog();
      const cleaning = isWfdRecord(processing) && isWfdRecord(processing.cleaningEngine)
        ? processing.cleaningEngine : { status: 'not_configured', reason: '数据清洗服务未装配。' };
      const modules = productionModuleDirectory({
        processing: this.options.companion.processing,
        algorithms: service ? { catalog: () => catalog } : undefined,
        hasWfdReader: !!this.options.companion.r1Workspace?.readProduct,
        hasSourceProfiles: !!this.options.companion.sourceFieldProfiles,
        enabled: this.options.companion.productionModuleSwitches,
      });
      authority.assert();
      return { summary: '已读取清洗与计算两条独立按需接口；只读发现，不启动自动清洗、因子计算或发布。',
        data: view({ ...contract, parallelModuleDirectory: modules, onDemand: {
          cleaning: { description: '原报解析与严格清洗；AGENTS每次执行一个步骤，读取反馈后再决定下一步',
            ...processingSessionContract(), engine: cleaning,
            source: '受管原件及冻结来源；不读取计算公式注册表' },
          calculation: { description: '读取 WFD 固定数据，执行已登记的受控日线指标',
            discovery: 'algorithms.contract', execute: contract.algorithms.calculateAction,
            publish: contract.algorithms.publishAction, engine: service ? contract.algorithms : null,
            source: 'WFD fixed snapshot; not original cleaning candidates' },
          screening: this.screenCapability(rulesVersion),
          sharedVerification: 'production-verifier (行、类型、结果摘要) + 领域专属方法核验',
          sharedPublication: 'existing R1/WFD readback only',
          automaticCrossTrigger: false,
        } }) };
    }
    if (action === 'algorithms.contract') {
      const methodId = typeof args.methodId === 'string' && args.methodId.trim() ? args.methodId.trim() : undefined;
      if (methodId !== undefined && (methodId === 'strategy_screen' || isAlgorithmMethodId(methodId)
        || !frozenAlgorithmCapabilities(rulesVersion).allFactorDefinitions)) this.assertMethodAllowed(methodId, rulesVersion);
      if (methodId === 'strategy_screen') {
        authority.assert();
        return { summary: '已读取固定截面筛选合同；未读取数据或执行规则。', data: view(this.screenCapability(rulesVersion)) };
      }
      const contract = basicAlgorithmToolContract(this.modelCatalog(service, rulesVersion), methodId, rulesVersion);
      authority.assert();
      return { summary: '已读取基础算法独立接口及真实可用状态；未采用或执行任何方法。',
        data: view({ ...contract, screening: this.screenCapability(rulesVersion) }) };
    }
    if (action === 'algorithms.capabilities') {
      const catalog = this.modelCatalog(service, rulesVersion);
      const screening = this.screenCapability(rulesVersion);
      authority.assert();
      return { summary: catalog.enabled
        ? '已读取基础算法目录、固定代码版本与 WFD 快照能力；本动作只读，不创建计算。'
        : screening.available ? '固定截面筛选可用；受控指标执行器未装配。本次只读返回各工具合同。'
          : `算法运行条件尚未就绪（${catalog.reason ?? '执行器或 WFD 快照端口不可用'}）；本次仅返回目录。`,
        data: view({ algorithms: catalog, methodDirectory: basicAlgorithmToolContract(catalog, undefined, rulesVersion).methods,
          screening,
          database: json(catalog.inputs.fixedSnapshots), guidance: {
          humanInput: '用户说明 WFD 数据和目标算法，由模型读取真实快照与方法契约形成调用，无需人工逐次计算确认。',
          adoption: '人工采用仅为历史诊断，不决定当前计算资格；执行器或固定快照不可用时不得改走旧入口。',
          managedTables: '已停止受管原件直接计算；必须先经原报管线发布 WFD 固定快照。',
          calculation: '已登记固定实现由 AGENTS 调用计算；没有逐次业务审核，但必须保留原任务、方法版本及 WFD 快照证据。',
          handoff: '独立核对后由专用 WFD 发布者复用 R1 正式写入和固定读回；无派生五步加工。',
        } }) };
    }
    if (action === 'algorithms.screen') {
      this.assertMethodAllowed('strategy_screen', rulesVersion);
      const port = this.options.companion.r1Workspace;
      if (!port?.readProduct) throw new TaskError('PRODUCTION_CALCULATION_UNAVAILABLE', '截面筛选需要实际 WFD 固定读取端口。');
      let request: unknown;
      if (Object.keys(args).some(name => name !== 'screenJson') || typeof args.screenJson !== 'string' || args.screenJson.length > 100_000)
        throw new TaskError('STRATEGY_SCREEN_WFD_INPUT', '筛选动作仅接受有界 screenJson。');
      try { request = JSON.parse(args.screenJson); }
      catch { throw new TaskError('STRATEGY_SCREEN_WFD_INPUT', 'screenJson 不是有效 JSON。'); }
      const intent: HistoricalIntent | undefined = isWfdRecord(request) && request.historyMode !== 'snapshot_contents'
        && typeof request.historyMode === 'string' && typeof request.at === 'string'
        ? { action, historyMode: request.historyMode, cutoff: request.at, snapshotId: request.snapshotId,
          productId: request.productId, heldScope: request.heldScope, usableStage: request.usableStage } : undefined;
      const submission = intent && this.options.submissionContext?.(origin, intent);
      const originalSubmission = submission && canonicalWfdJson(submission);
      const purposeContext = submission && intent ? { ...submission, purpose: 'historical_compute' as const,
        historyMode: intent.historyMode, cutoff: intent.cutoff } : undefined;
      const assertCurrent = () => {
        authority.assert(); this.options.companion.bd?.assertDispatch();
        if (this.options.companion.productionModuleSwitches?.calculate === false)
          throw new TaskError('PRODUCTION_CALCULATION_DISABLED', '计算模块已停用，未继续读取或返回筛选结果。');
        const currentOrigin = this.options.origin(context.task.id);
        if (!currentOrigin || currentOrigin.conversationId !== origin.conversationId || currentOrigin.branchId !== origin.branchId
          || currentOrigin.parentRunId !== origin.parentRunId || currentOrigin.inputId !== origin.inputId || currentOrigin.messageId !== origin.messageId)
          throw new TaskError('ALGORITHM_CONVERSATION_REQUIRED', '本次筛选的会话身份发生变化。');
        if (this.options.companion.r1Workspace !== port || !hasScreenReader(port))
          throw new TaskError('PRODUCTION_CALCULATION_UNAVAILABLE', '截面筛选缺少已配置的 WFD 固定读取连接。');
        if (originalSubmission && canonicalWfdJson(this.options.submissionContext?.(origin, intent) ?? null) !== originalSubmission)
          throw new TaskError('ALGORITHM_PURPOSE_EVIDENCE_REQUIRED', '历史用途的原用户输入或操作者声明已变化。');
      };
      assertCurrent();
      const result = await screenFixedWfdStrategy(request, (input, signal) => port.readProduct!(input, signal), context.signal, assertCurrent, purposeContext);
      assertCurrent();
      const { historicalExclusions, ...fixedRead } = result.fixedRead;
      return { summary: `已从完整固定截面 ${result.counts.input} 行中返回 ${result.counts.selected} 个研究候选；未发布或下单。`,
        data: { ...view({ ...result, taskId: context.task.id, fixedRead: { ...fixedRead,
          historicalExclusions: historicalExclusionSummary(historicalExclusions.diagnostics) } }),
          historicalExclusions: json(historicalExclusions), ...(purposeContext ? { purposeContext: json(purposeContext) } : {}) } };
    }
    if (action === 'algorithms.calculate' || action === 'data.modules.calculate') {
      let calculation: unknown;
      try { calculation = JSON.parse(String(args.calculationJson)); }
      catch { throw new TaskError('ALGORITHM_CALCULATION_JSON', '算法计算请求不是有效JSON。'); }
      if (!isWfdRecord(calculation)) throw new TaskError('ALGORITHM_CALCULATION_JSON', '算法计算请求必须是对象。');
      if (frozenAlgorithmCapabilities(rulesVersion).allFactorDefinitions && !isAlgorithmMethodId(calculation.methodId))
        throw new TaskError('INVALID_ALGORITHM_METHOD', '计算仅接受已登记的日线方法。');
      this.assertMethodAllowed(calculation.methodId, rulesVersion);
      if (this.options.companion.productionModuleSwitches?.calculate === false)
        throw new TaskError('PRODUCTION_CALCULATION_DISABLED', '计算模块已停用。');
      this.assertCalculationMaterials(calculation);
      const publisher = this.options.companion.derivedPublisher;
      if (!service || !publisher) throw new TaskError('PRODUCTION_CALCULATION_UNAVAILABLE',
        '计算模块未装配，不能把清洗管线当算法执行器。');
      // 已登记指标沿原 TaskService 执行，保留原任务与版本身份。
      const usage = isWfdRecord(calculation.usage) ? calculation.usage : null;
      const reference = isWfdRecord(calculation.source) && isWfdRecord(calculation.source.reference) ? calculation.source.reference : {};
      const intent: HistoricalIntent | undefined = usage?.purpose === 'historical_compute'
        ? { action: 'algorithms.calculate', historyMode: String(usage.historyMode), cutoff: String(usage.cutoff),
          snapshotId: reference.snapshotId, productId: reference.productId, methodId: calculation.methodId,
          heldScope: reference.heldScope, usableStage: reference.usableStage } : undefined;
      const submission = intent ? this.options.submissionContext?.(origin, intent) : undefined;
      if (intent && !submission) throw new TaskError('ALGORITHM_PURPOSE_EVIDENCE_REQUIRED', '历史计算需要本次真实用户输入中的历史用途声明。');
      const submitted = service.submit('conversation:algorithms:' + context.task.id, calculation, submission);
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
      const publication = await publisher.publish(taskId, context.signal);
      authority.assert();
      return { summary: publication.published
        ? '生产管线固定计算、独立来源核对和 WFD 正式发布/固定读回已完成。'
        : `计算已完成，但原 R1 提交状态为 ${publication.state}；未确认正式入库，必须按原任务继续核对。`,
        data: view({ ...this.statusPayload(taskId), wfdPublication: publication }) };
    }
    const taskId = String(args.taskId ?? '');
    this.assertLink(taskId, origin);
    if (action === 'algorithms.publish') {
      const publisher = this.options.companion.derivedPublisher;
      if (!service || !publisher) throw new TaskError('PRODUCTION_CALCULATION_UNAVAILABLE', '计算结果的原 R1/WFD 发布适配器未装配。');
      const task = this.options.companion.tasks.get(taskId);
      if (task.status !== 'succeeded' || task.requiresReview)
        throw new TaskError('DERIVED_RESULT_NOT_READY', '原计算任务未完成，不重新计算或更换任务身份。');
      const original = service.view(taskId);
      this.assertMethodAllowed(original.methodId, rulesVersion);
      if (task.runtimeId !== ALGORITHM_RUNTIME || !isAlgorithmMethodId(original.methodId) || original.taskId !== taskId)
        throw new TaskError('ALGORITHM_TASK_ID', '恢复发布须使用本分支原计算任务及其登记方法。');
      const publication = await publisher.publish(taskId, context.signal);
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

  private screenCapability(rulesVersion?: number) {
    if (!algorithmAllowedByRules('strategy_screen', rulesVersion))
      return { available: false, executable: false, reason: '受控截面筛选要求本会话冻结规则 v21 或以上。' };
    const enabled = this.options.companion.productionModuleSwitches?.calculate !== false;
    const reader = hasScreenReader(this.options.companion.r1Workspace);
    const available = enabled && reader;
    return { ...strategyScreenContract(), available, executable: available,
      reason: !enabled ? '计算模块已停用。' : !reader ? '受信 WFD 固定读取连接未就绪。' : null };
  }

  /** 代理只读取真实 WFD 固定快照目录；受管原件不再提供计算资格。 */
  private modelCatalog(service: WorkspaceServices['algorithms'], rulesVersion?: number): AlgorithmCatalogView {
    if (service) {
      const catalog = service.catalog();
      const methods = catalog.methods.filter(method => algorithmAllowedByRules(method.id, rulesVersion));
      const reason = !frozenAlgorithmCapabilities(rulesVersion).methods.length ? '本会话没有允许新计算的冻结规则。'
        : this.options.companion.productionModuleSwitches?.calculate === false ? '计算模块已停用。' : null;
      if (reason) return { ...catalog, enabled: false, status: 'unavailable', reason,
        methods: methods.map(method => ({ ...method, status: 'unavailable', reason })) };
      return { ...catalog, methods };
    }
    const reason = '受控指标计算服务未装配。';
    const fixed = hasScreenReader(this.options.companion.r1Workspace);
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
      }, limitations: ['受控指标由已登记的固定执行器提供。'],
    };
  }

  private assertMethodAllowed(methodId: unknown, rulesVersion?: number): void {
    if (algorithmAllowedByRules(methodId, rulesVersion)) return;
    const methods = frozenAlgorithmCapabilities(rulesVersion).methods;
    throw new TaskError('ALGORITHM_METHOD_NOT_ALLOWED_BY_RULES', !methods.length ? '本会话缺少可用的冻结规则版本，无法核验方法。'
      : methods.length === 1 ? `本会话冻结的内置代理规则 v${rulesVersion} 仅允许 macd。`
        : `本会话冻结的内置代理规则 v${rulesVersion} 未允许此方法。截面筛选要求 v21 或以上。`);
  }

  /** 计算请求只能引用 WFD 固定快照；权限由原服务读取端口继续核实。 */
  private assertCalculationMaterials(value: Record<string, unknown>): void {
    const source = isWfdRecord(value.source) ? value.source : null;
    if (!source || source.kind !== 'fixed_snapshot') throw new TaskError('ALGORITHM_WFD_ONLY',
      '基础算法只接受 kind=fixed_snapshot 的 WFD 正式数据；不能让会话原件或模型自行取代已发布版本。');
  }

  private statusPayload(taskId: string) {
    const task = this.options.companion.tasks.get(taskId);
    if (task.runtimeId !== ALGORITHM_RUNTIME) throw new TaskError('ALGORITHM_TASK_ID', '须使用受控指标执行器的原任务编号。');
    const value = this.options.companion.algorithms!.view(taskId);
    const result = value.result;
    return { taskId: value.taskId, requestId: value.requestId, methodId: value.methodId, status: value.status,
      taskVersion: value.taskVersion, requiresReview: value.requiresReview, createdAt: value.createdAt, updatedAt: value.updatedAt,
      error: previewError(value.error), publication: value.publication, guidance: value.guidance,
      result: result ? { taskId: result.taskId, methodId: result.methodId, methodVersion: result.methodVersion,
        implementationVersion: result.implementationVersion, contractVersion: result.contractVersion, environment: result.environment,
        parameters: result.parameters, inputDigest: result.inputDigest, source: previewSource(result.source), metadata: result.metadata,
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
