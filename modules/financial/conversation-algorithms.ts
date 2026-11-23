import type { CoreDatabase } from '../../platform/state/database.js';
import type { WorkspaceServices } from '../../contracts/workspace-services.js';
import type { ModelTaskOrigin } from '../agent/model-tools.js';
import type { PersonalCore } from '../agent/runtime/core.js';
import type { SkillRegistration } from '../../platform/plugins/registry.js';
import type { SkillField } from '../../contracts/skill-contracts.js';
import { TaskError, type TaskExecutionContext } from '../../platform/jobs/tasks.js';
import type { JsonValue, TaskResult } from '../../contracts/task-contracts.js';
import { INTERNAL_AGENT_RULES } from '../agent/instructions/rules.js';
import { fixedWfdBinding, pureOperatorAvailability } from './tool-library.js';
import { PureOperatorRunner } from './pure-operator-runner.js';
import { PURE_OPERATOR_VERSION, PURE_VERIFICATION_VERSION } from './algorithm-pure-operators.js';
import { canonicalWfdJson, isWfdRecord, wfdSha256 } from '../../adapters/database/wfd-transport.js';
import { acquireAuthority } from '../../platform/runtime/file-workspace.js';
import { ALGORITHM_CONTRACT_VERSION, ALGORITHM_RUNTIME, isAlgorithmMethodId, isPureOperatorId, type AlgorithmCatalogView, type AlgorithmSubmissionContext } from './algorithm-types.js';
import type { LocalAlgorithmService } from './algorithm-service.js';
import { algorithmAllowedByRules, basicAlgorithmToolContract, bdSessionToolContract, frozenAlgorithmCapabilities,
  BD_SESSION_TOOL_CONTRACT_VERSION } from './basic-algorithm-tool-contract.js';
import { ALGORITHM_REGISTRY_VERSION } from './algorithm-registry.js';
import { productionModuleDirectory, processingSessionContract } from '../collection/production-module-ports.js';
import { fixedProductIdentifier, historicalExclusionSummary, screenFixedWfdStrategy, strategyScreenContract, STRATEGY_SCREEN_WFD_VERSION } from './strategy-screen-wfd.js';
import { STRATEGY_SCREEN_VERSION } from './strategy-screen.js';

const ACTIONS = new Set(['bd.session.capabilities', 'algorithms.capabilities', 'algorithms.contract', 'algorithms.calculate', 'algorithms.screen', 'algorithms.publish', 'algorithms.status', 'data.modules.calculate']);
const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;
const text = (key: string, label: string, maxLength = 160, required = true): SkillField =>
  ({ key, label, type: 'text', required, maxLength });
const view = (value: unknown): Record<string, JsonValue> => ({ kind: 'conversation-algorithm', modelPreview: json(value) });

/** 执行与 Direct 版本捕获从同一份封闭请求确定方法。 */
export function parseConversationCalculation(value: unknown) {
  let calculation: unknown;
  try { calculation = JSON.parse(String(value)); }
  catch { throw new TaskError('ALGORITHM_CALCULATION_JSON', '算法计算请求不是有效JSON。'); }
  if (!isWfdRecord(calculation)) throw new TaskError('ALGORITHM_CALCULATION_JSON', '算法计算请求必须是对象。');
  return calculation;
}

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

const ELIGIBILITY_FALLBACK = '该固定快照未通过所请求用途的资格核对；完整明细保留在原任务审计记录。';
const HISTORY_INCOMPLETE_FALLBACK = '历史版本选择存在待补证据；完整核对明细保留在原任务审计记录。';
export const SAFE_ALGORITHM_RULES_ERROR = /^本会话(?:缺少可用的冻结规则版本，无法核验方法|冻结的内置代理规则 v\d+ (?:仅允许 macd|未允许此方法。截面筛选要求 v21 或以上|未允许此方法。纯算子要求 v22 或以上)|冻结规则不允许读取该因子定义)。$/u;
export const ALGORITHM_RULES_FALLBACK = '本会话冻结规则不允许所选方法或因子；完整核对明细保留在原任务审计记录。';
const ELIGIBILITY_RULE_VERSION_RE = /^bd\.purpose-eligibility\/\d+$/u;
const ELIGIBILITY_CUTOFF_INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|([+-])(\d{2}):(\d{2}))$/u;
export function isValidEligibilityCutoff(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = ELIGIBILITY_CUTOFF_INSTANT_RE.exec(value);
  if (!match || match[1] === '0000') return false;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const hour = Number(match[4]), minute = Number(match[5]), second = Number(match[6]);
  if (match[7]) {
    const offH = Number(match[8]), offM = Number(match[9]);
    if (offH > 23 || offM > 59) return false;
  }
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  calendar.setUTCHours(hour, minute, second, 0);
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day
    || calendar.getUTCHours() !== hour || calendar.getUTCMinutes() !== minute || calendar.getUTCSeconds() !== second) return false;
  return Number.isFinite(Date.parse(value));
}
function isValidEligibilityHistory(value: unknown): value is Record<string, unknown> {
  if (!isWfdRecord(value)) return false;
  if (Object.keys(value).some(key => !['mode', 'cutoff', 'perspective', 'historical'].includes(key))) return false;
  const modeOk = value.mode === null || ['snapshot_contents', 'market_known_at', 'system_held_at'].includes(String(value.mode));
  const perspectiveOk = value.perspective === null || ['snapshot_contents', 'market_known_at', 'system_held_at'].includes(String(value.perspective));
  return modeOk && perspectiveOk && (value.cutoff === null || isValidEligibilityCutoff(value.cutoff)) && typeof value.historical === 'boolean';
}
function isStrictCurrentComputeHistory(history: unknown): boolean {
  return isValidEligibilityHistory(history)
    && history.historical === false
    && (history.mode === null || history.mode === 'snapshot_contents')
    && history.cutoff === null
    && (history.perspective === null || history.perspective === 'snapshot_contents');
}
function sanitizeEligibilityMessage(rawMessage: string): string {
  try {
    const detail: unknown = JSON.parse(rawMessage);
    if (isWfdRecord(detail)) {
      const ruleVersion = typeof detail.ruleVersion === 'string' && ELIGIBILITY_RULE_VERSION_RE.test(detail.ruleVersion) ? detail.ruleVersion : null;
      const status = detail.status === 'ineligible' || detail.status === 'insufficient_evidence' ? detail.status : null;
      if (!ruleVersion || !status) return ELIGIBILITY_FALLBACK;
      if (detail.purpose === 'current_compute' && isStrictCurrentComputeHistory(detail.history)) return rawMessage;
      if (detail.purpose === 'historical_compute' || detail.purpose === 'current_compute') {
        const history = isWfdRecord(detail.history) ? {
          mode: detail.history.mode === null || ['snapshot_contents', 'market_known_at', 'system_held_at'].includes(String(detail.history.mode))
            ? detail.history.mode : null,
          cutoff: isValidEligibilityCutoff(detail.history.cutoff) ? detail.history.cutoff : null,
          perspective: detail.history.perspective === null || ['snapshot_contents', 'market_known_at', 'system_held_at'].includes(String(detail.history.perspective))
            ? detail.history.perspective : null,
          historical: typeof detail.history.historical === 'boolean' ? detail.history.historical : detail.purpose === 'historical_compute',
        } : null;
        const gapCodes = Array.isArray(detail.blockingGapCodes)
          ? detail.blockingGapCodes.filter((item): item is string => typeof item === 'string' && /^[A-Z0-9_]+$/u.test(item))
          : Array.isArray(detail.gaps)
            ? detail.gaps.map(item => isWfdRecord(item) && typeof item.code === 'string' && /^[A-Z0-9_]+$/u.test(item.code) ? item.code : null).filter((item): item is string => item !== null)
            : [];
        return canonicalWfdJson({
          ruleVersion,
          status,
          purpose: detail.purpose,
          history,
          blockingGapCodes: [...new Set(gapCodes)],
          evidenceSha256: typeof detail.evidenceSha256 === 'string' && /^[a-f0-9]{64}$/u.test(detail.evidenceSha256) ? detail.evidenceSha256 : null,
          action: ELIGIBILITY_FALLBACK,
        });
      }
    }
  } catch { /* 残缺或非结构化历史错误正文不予透传。 */ }
  return ELIGIBILITY_FALLBACK;
}

function previewError(error: { code: string; message: string } | null) {
  if (!error) return null;
  if (error.code === 'PURPOSE_ELIGIBILITY_INELIGIBLE' || error.code === 'PURPOSE_ELIGIBILITY_INSUFFICIENT') {
    return { code: error.code, message: sanitizeEligibilityMessage(error.message) };
  }
  if (error.code === 'ALGORITHM_SNAPSHOT_HISTORY_INCOMPLETE') {
    return { code: error.code, message: HISTORY_INCOMPLETE_FALLBACK };
  }
  if (error.code === 'ALGORITHM_METHOD_NOT_ALLOWED_BY_RULES') {
    return { code: error.code, message: typeof error.message === 'string' && SAFE_ALGORITHM_RULES_ERROR.test(error.message) ? error.message : ALGORITHM_RULES_FALLBACK };
  }
  if (error.code !== 'ALGORITHM_HISTORICAL_NO_ELIGIBLE_VERSION') return { code: error.code, message: error.message };
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

/**
 * 基础算法与当前会话分支的工具桥：固定方法执行并经过一次独立核对写回 WFD。
 *
 * - capabilities 只读目录、历史采用诊断和真实数据库能力，不能启用或授予 Python 执行权限。
 * - calculate 调用注册固定算法；没有逐次业务审批，任务身份与错误仍由 TaskService 持有。
 * - screen 只对完整固定截面运行受限规则，返回研究候选；不执行 Python、不自动发布。
 * - publish 仅恢复原 WFD 写入身份；status 只读本分支原任务。
 */
export class ConversationAlgorithmBridge {
  private readonly pure: PureOperatorRunner;
  readonly versionBinding = { algorithmRegistry: ALGORITHM_REGISTRY_VERSION, sessionTools: BD_SESSION_TOOL_CONTRACT_VERSION,
    pureOperators: PURE_OPERATOR_VERSION, pureVerification: PURE_VERIFICATION_VERSION,
    strategyScreen: STRATEGY_SCREEN_VERSION, strategyScreenInput: STRATEGY_SCREEN_WFD_VERSION };
  readonly registrations: readonly SkillRegistration[];
  constructor(private readonly options: { database: CoreDatabase; companion: WorkspaceServices & { algorithms?: Pick<LocalAlgorithmService, 'submit'> };
    origin(taskId: string): ModelTaskOrigin | null;
    rulesVersion(runId: string): number | undefined;
    submissionContext?(origin: ModelTaskOrigin, intent?: HistoricalIntent): AlgorithmSubmissionContext | undefined;
 }) {
    this.pure = new PureOperatorRunner(options.database);
    options.database.migrate('conversation_algorithm_links', 1, `CREATE TABLE conversation_algorithm_links(
      service_task_id TEXT PRIMARY KEY,local_task_id TEXT NOT NULL,operation TEXT NOT NULL,origin_json TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE INDEX conversation_algorithm_local ON conversation_algorithm_links(local_task_id);`);
    const registration = (action: string, title: string, description: string, fields: SkillField[]): SkillRegistration => ({
      action, title, description, fields, runtimeId: 'direct', kind: 'direct', modelCalls: 0,
      permissionSummary: ['只读取固定算法目录及真实 WFD 快照能力；工具本身不能授予程序执行器权限',
        '执行按冻结规则和实际执行器核验',
        '纯 TS 算子独立核验后保留本地回执，正式发布需要显式 R1 交接'],
      available: () => this.availabilityForRules(action, INTERNAL_AGENT_RULES.version),
    });
    this.registrations = [
      registration('bd.session.capabilities', '查看 BD AGENTS 统一会话工具契约',
        '只读展示采集源、接口源、文件与基础算法的现有会话接口、边界和 WFD 输入要求；不启动采集、计算或发布。', []),
      registration('algorithms.contract', '读取基础算法统一接口契约',
        '按会话冻结版本返回受控指标与算子的参数、固定产品输入合同及可调用状态。',
        [text('methodId', '指定算法编号，留空返回全部', 160, false)]),
      registration('algorithms.capabilities', '发现本机基础算法与真实数据能力',
        '只读发现算法和执行条件。v22 可指定固定快照读取产品、字段与合同概况。', [text('snapshotId', '固定 WFD 快照编号', 128, false)]),
      registration('algorithms.calculate', '受控执行已登记基础算法',
        'calculationJson 由 BD AGENTS 按算法契约和真实 WFD 固定快照组装。日线指标沿原发布流程，纯 TS 算子独立核验后返回可读回的本地结果，发布须显式 R1 交接。', [
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
  availabilityForRules(action: string, rulesVersion?: number) {
    const { companion } = this.options;
    const publishes = !!companion.algorithms && !!companion.derivedPublisher;
    const enabled = companion.productionModuleSwitches?.calculate !== false;
    if (action === 'algorithms.publish') return publishes ? { available: true }
      : { available: false, reason: '计算服务或 WFD 发布端口未就绪。' };
    if (action === 'algorithms.screen' || action === 'algorithms.calculate' || action === 'data.modules.calculate') {
      if (!enabled) return { available: false, reason: '计算模块已停用。' };
      const rules = frozenAlgorithmCapabilities(rulesVersion);
      const fixed = !!fixedWfdBinding(companion.r1Workspace);
      if (action === 'algorithms.screen') return rules.screen && fixed ? { available: true }
        : { available: false, reason: '当前规则或 WFD 固定读取未就绪。' };
      if (!(rules.pureOperators && fixed) && !(rules.methods.length && publishes && companion.algorithms?.catalog?.().status === 'available'))
        return { available: false, reason: '当前规则可用的计算服务或 WFD 端口未就绪。' };
    }
    return { available: true };
  }

  handles(action: string): boolean { return ACTIONS.has(action); }
  async execute(context: TaskExecutionContext): Promise<TaskResult> {
    const action = context.task.action, args = context.task.args as Record<string, JsonValue>;
    if (!this.handles(action)) throw new TaskError('ALGORITHM_ACTION', '未登记的算法会话动作。');
    const origin = this.options.origin(context.task.id);
    if (!origin) throw new TaskError('ALGORITHM_CONVERSATION_REQUIRED', '算法会话动作必须由本次真实会话代理调用。');
    const service = this.options.companion.algorithms;
    // 直接模型动作必须先取得当前模型分享回执；否则 saveResultProof 会拒绝返回。
    const authority = await acquireAuthority(context, action, args, []);
    authority.assert(); this.options.companion.bd?.assertDispatch();
    const rulesVersion = this.options.rulesVersion(origin.parentRunId);
    const checks = { hasWfdReader: () => !!fixedWfdBinding(this.options.companion.r1Workspace),
      calculateEnabled: () => this.options.companion.productionModuleSwitches?.calculate !== false };
    if (action === 'bd.session.capabilities') {
      const catalog = this.modelCatalog(service, rulesVersion);
      const contract = bdSessionToolContract(catalog, rulesVersion, checks);
      const processing = this.options.companion.processing?.catalog();
      const cleaning = isWfdRecord(processing) && isWfdRecord(processing.cleaningEngine)
        ? processing.cleaningEngine : { status: 'not_configured', reason: '数据清洗服务未装配。' };
      const modules = productionModuleDirectory({
        processing: this.options.companion.processing,
        algorithms: service ? { catalog: () => catalog } : undefined,
        pureOperators: frozenAlgorithmCapabilities(rulesVersion).pureOperators ? pureOperatorAvailability(checks) : undefined,
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
            publish: contract.algorithms.publishAction, engine: service || contract.algorithms.enabled ? contract.algorithms : null,
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
      const contract = basicAlgorithmToolContract(this.modelCatalog(service, rulesVersion), methodId, rulesVersion, checks);
      authority.assert();
      return { summary: '已读取基础算法独立接口及真实可用状态；未采用或执行任何方法。',
        data: view({ ...contract, screening: this.screenCapability(rulesVersion) }) };
    }
    if (action === 'algorithms.capabilities') {
      const catalog = this.modelCatalog(service, rulesVersion);
      const screening = this.screenCapability(rulesVersion);
      const snapshotDiscovery = Object.hasOwn(args, 'snapshotId')
        ? await this.discoverSnapshot(args.snapshotId, rulesVersion, context.signal, () => {
          authority.assert(); this.options.companion.bd?.assertDispatch();
        }) : undefined;
      const contract = basicAlgorithmToolContract(catalog, undefined, rulesVersion, checks);
      authority.assert();
      return { summary: contract.enabled
        ? '已读取基础算法目录、固定代码版本与 WFD 快照能力；本动作只读，不创建计算。'
        : screening.available ? '固定截面筛选可用；受控指标执行器未装配。本次只读返回各工具合同。'
          : `算法运行条件尚未就绪（${catalog.reason ?? '执行器或 WFD 快照端口不可用'}）；本次仅返回目录。`,
        data: view({ enabled: contract.enabled, status: contract.status, algorithms: catalog, methodDirectory: contract.methods, ...(snapshotDiscovery ? { snapshotDiscovery } : {}),
          screening,
          database: json(catalog.inputs.fixedSnapshots), guidance: {
          humanInput: '用户说明 WFD 数据和目标算法，由模型读取真实快照与方法契约形成调用，无需人工逐次计算确认。',
          adoption: '人工采用仅为历史诊断，不决定当前计算资格；执行器或固定快照不可用时不得改走旧入口。',
          managedTables: '已停止受管原件直接计算；必须先经原报管线发布 WFD 固定快照。',
          calculation: '已登记固定实现由 AGENTS 调用计算；没有逐次业务审核，但必须保留原任务、方法版本及 WFD 快照证据。',
          handoff: '日线指标沿原发布流程。纯 TS 结果保留在本地，须显式 R1 交接。',
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
      const { assertCurrent, purposeContext } = this.fixedExecution(context, origin, port, rulesVersion, authority.assert, intent);
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
      const calculation = parseConversationCalculation(args.calculationJson);
      if (frozenAlgorithmCapabilities(rulesVersion).allFactorDefinitions && !isAlgorithmMethodId(calculation.methodId) && !isPureOperatorId(calculation.methodId))
        throw new TaskError('INVALID_ALGORITHM_METHOD', '计算仅接受已登记的方法。');
      this.assertMethodAllowed(calculation.methodId, rulesVersion);
      if (this.options.companion.productionModuleSwitches?.calculate === false)
        throw new TaskError('PRODUCTION_CALCULATION_DISABLED', '计算模块已停用。');
      this.assertCalculationMaterials(calculation);
      const usage = isWfdRecord(calculation.usage) ? calculation.usage : null;
      const reference = isWfdRecord(calculation.source) && isWfdRecord(calculation.source.reference) ? calculation.source.reference : {};
      const intent: HistoricalIntent | undefined = usage?.purpose === 'historical_compute'
        ? { action: 'algorithms.calculate', historyMode: String(usage.historyMode), cutoff: String(usage.cutoff),
          snapshotId: reference.snapshotId, productId: reference.productId, methodId: calculation.methodId,
          heldScope: reference.heldScope, usableStage: reference.usableStage } : undefined;
      if (isPureOperatorId(calculation.methodId)) {
        const port = this.options.companion.r1Workspace;
        if (!port?.readProduct) throw new TaskError('PRODUCTION_CALCULATION_UNAVAILABLE', '纯算子需要受信 WFD 固定读取端口。');
        const { assertCurrent, purposeContext, binding, connectionId } = this.fixedExecution(context, origin, port, rulesVersion, authority.assert, intent);
        if (intent && (!purposeContext || purposeContext.authority !== 'user-message' || purposeContext.messageId !== origin.messageId
          || !matchesHistoricalDeclaration(purposeContext.quote, intent)))
          throw new TaskError('ALGORITHM_PURPOSE_EVIDENCE_REQUIRED', '历史计算需要本次真实用户对于该视角和截止的声明。');
        assertCurrent();
        const receipt = await this.pure.run(calculation.methodId, calculation, { taskId: context.task.id,
          connectionId, versions: { ...context.task.versions, fixedReaderSha256: wfdSha256(binding) }, rulesVersion: rulesVersion!,
          read: (input, wait) => port.readProduct!(input, wait), signal: context.signal, purpose: purposeContext,
          assertCurrent, link: () => this.link(context.task.id, context.task.id, 'pure_calculate', origin) });
        assertCurrent();
        return { summary: '纯算子已从完整固定产品计算并独立核验，回执已保存在原会话。', data: view(receipt) };
      }
      const publisher = this.options.companion.derivedPublisher;
      if (!service || !publisher) throw new TaskError('PRODUCTION_CALCULATION_UNAVAILABLE',
        '计算模块未装配，不能把清洗管线当算法执行器。');
      // 已登记指标沿原 TaskService 执行，保留原任务与版本身份。
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
    const link = this.assertLink(taskId, origin);
    if (link.operation === 'pure_calculate') {
      authority.assert();
      if (action === 'algorithms.publish') throw new TaskError('PURE_OPERATOR_R1_HANDOFF_REQUIRED', '纯算子发布须显式发起 R1 交接。');
      const receipt = this.pure.status(taskId);
      if (!receipt) throw new TaskError('ALGORITHM_TASK_ID', '缺少原纯算子持久回执。');
      return { summary: '已读回本分支原纯算子回执和独立核验凭证。', data: view(receipt) };
    }
    if (!service) throw new TaskError('PRODUCTION_CALCULATION_UNAVAILABLE', '原日线任务服务未装配。');
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

  private fixedExecution(context: TaskExecutionContext, origin: ModelTaskOrigin, port: NonNullable<WorkspaceServices['r1Workspace']>,
    rulesVersion: number | undefined, assertAuthority: () => void, intent?: HistoricalIntent) {
    const initial = fixedWfdBinding(port);
    if (!initial) throw new TaskError('PRODUCTION_CALCULATION_UNAVAILABLE', '计算缺少已配置的 WFD 固定读取连接。');
    const binding = canonicalWfdJson(initial);
    const submission = intent && this.options.submissionContext?.(origin, intent);
    const originalSubmission = submission && canonicalWfdJson(submission);
    const purposeContext = submission && intent ? { ...submission, purpose: 'historical_compute' as const,
      historyMode: intent.historyMode, cutoff: intent.cutoff } : undefined;
    const assertCurrent = () => {
      assertAuthority(); this.options.companion.bd?.assertDispatch();
      if (this.options.companion.productionModuleSwitches?.calculate === false)
        throw new TaskError('PRODUCTION_CALCULATION_DISABLED', '计算模块已停用，未继续读取或返回结果。');
      const currentOrigin = this.options.origin(context.task.id);
      if (!currentOrigin || currentOrigin.conversationId !== origin.conversationId || currentOrigin.branchId !== origin.branchId
        || currentOrigin.parentGeneration !== origin.parentGeneration || currentOrigin.parentRunId !== origin.parentRunId || currentOrigin.inputId !== origin.inputId || currentOrigin.messageId !== origin.messageId)
        throw new TaskError('ALGORITHM_CONVERSATION_REQUIRED', '本次计算的会话身份发生变化。');
      if (this.options.companion.r1Workspace !== port || canonicalWfdJson(fixedWfdBinding(port)) !== binding)
        throw new TaskError('PRODUCTION_CALCULATION_UNAVAILABLE', '计算缺少已配置的 WFD 固定读取连接。');
      if (this.options.rulesVersion(origin.parentRunId) !== rulesVersion)
        throw new TaskError('ALGORITHM_METHOD_NOT_ALLOWED_BY_RULES', '运行中的冻结规则已变化。');
      if (originalSubmission && canonicalWfdJson(this.options.submissionContext?.(origin, intent) ?? null) !== originalSubmission)
        throw new TaskError('ALGORITHM_PURPOSE_EVIDENCE_REQUIRED', '历史用途的原用户输入或操作者声明已变化。');
    };
    return { assertCurrent, purposeContext, binding, connectionId: initial.connection.connectionId };
  }

  private async discoverSnapshot(snapshotId: unknown, rulesVersion: number | undefined, signal: AbortSignal, assertCurrent: () => void) {
    if (!fixedProductIdentifier(snapshotId)) throw new TaskError('ALGORITHM_SNAPSHOT_INVALID', '请提供合法且明确的固定快照编号。');
    if (!frozenAlgorithmCapabilities(rulesVersion).pureOperators)
      throw new TaskError('ALGORITHM_METHOD_NOT_ALLOWED_BY_RULES', '固定快照产品发现要求会话规则 v22 或以上。');
    const port = this.options.companion.r1Workspace;
    if (!port?.discoverProducts) return { status: 'unavailable', snapshotId, reason: 'WFD 固定产品发现端口未装配。' };
    signal.throwIfAborted(); assertCurrent();
    const found = await port.discoverProducts({ snapshotId }, signal);
    signal.throwIfAborted(); assertCurrent();
    if (port !== this.options.companion.r1Workspace || found.snapshotId !== snapshotId || found.historyMode !== 'snapshot_contents'
      || !Array.isArray(found.products) || !Array.isArray(found.selections))
      throw new TaskError('ALGORITHM_SNAPSHOT_INVALID', '产品发现的固定快照身份或清单不符。');
    const products = found.products.map(item => {
      if (!isWfdRecord(item) || !fixedProductIdentifier(item.product_id) || !isWfdRecord(item.declaration))
        throw new TaskError('ALGORITHM_SNAPSHOT_INVALID', '固定产品目录缺少可核对的声明。');
      const declaration = item.declaration, fields = declaration.field_definitions;
      const fieldDefinitions = Array.isArray(fields) ? fields.map(field => {
        if (!isWfdRecord(field) || typeof field.field_code !== 'string' || typeof field.data_type !== 'string' || typeof field.unit_code !== 'string')
          throw new TaskError('ALGORITHM_SNAPSHOT_INVALID', '固定产品的字段声明不完整。');
        return { fieldCode: field.field_code, dataType: field.data_type, unitCode: field.unit_code,
          measurementNature: field.measurement_nature, timeRole: field.time_role };
      }) : item.payload_kind === 'scalar_rows' ? [{ fieldCode: 'value_decimal', dataType: 'decimal', unitCode: declaration.unit_code }] : [];
      return { productId: item.product_id, datasetId: item.dataset_id, subject: item.subject, payloadKind: item.payload_kind,
        definitionRef: item.definition_ref ?? null, contractRef: item.contract_ref ?? null, fields: fieldDefinitions,
        declaration: { semanticCode: item.declaration.semantic_code, unitCode: item.declaration.unit_code,
          measurementNature: item.declaration.measurement_nature },
        contracts: isWfdRecord(item.contracts) ? { roles: Object.keys(item.contracts), read: item.contracts.read ?? null } : null };
    });
    return { status: 'available', snapshotId, historyMode: found.historyMode, products, selections: found.selections };
  }

  private screenCapability(rulesVersion?: number) {
    if (!algorithmAllowedByRules('strategy_screen', rulesVersion))
      return { available: false, executable: false, reason: '受控截面筛选要求本会话冻结规则 v21 或以上。' };
    const enabled = this.options.companion.productionModuleSwitches?.calculate !== false;
    const reader = !!fixedWfdBinding(this.options.companion.r1Workspace);
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
        : this.options.companion.productionModuleSwitches?.calculate === false ? '计算模块已停用。'
          : !this.options.companion.derivedPublisher ? '计算结果的原 R1/WFD 发布适配器未装配。' : null;
      if (reason) return { ...catalog, enabled: false, status: 'unavailable', reason,
        methods: methods.map(method => ({ ...method, status: 'unavailable', reason })) };
      return { ...catalog, methods };
    }
    const reason = '受控指标计算服务未装配。';
    const fixed = !!fixedWfdBinding(this.options.companion.r1Workspace);
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
        : isPureOperatorId(methodId) ? `本会话冻结的内置代理规则 v${rulesVersion} 未允许此方法。纯算子要求 v22 或以上。`
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
