import { isAlgorithmMethodId, isPureOperatorId, type AlgorithmCatalogView, type AlgorithmMethodId } from './algorithm-types.js';
import { MACD_SNAPSHOT_SEMANTIC_CONTRACT } from './product-machine-snapshot.js';
import { ALGORITHM_REGISTRY, ALGORITHM_REGISTRY_VERSION } from './algorithm-registry.js';
import { pureMethodVersion, PURE_OPERATOR_VERSION, PURE_PUBLICATION, pureOperatorDefinition, pureOperatorInputContract } from './algorithm-pure-operators.js';
import { pureOperatorAvailability, type AlgorithmRuntimeChecks } from './tool-library.js';
import { definitionFor } from './algorithm-definitions.js';
import { processingSessionContract } from '../collection/production-module-ports.js';

export const BD_SESSION_TOOL_CONTRACT_VERSION = 'bd.session-tools/6';

interface FrozenAlgorithmCapabilities {
  readonly methods: readonly AlgorithmMethodId[];
  readonly allFactorDefinitions: boolean;
  readonly screen: boolean;
  readonly pureOperators?: true;
}
// 固定 v20 已审核的方法，后续注册新公式不能给已经冻结的会话追授能力。
const dailyV20 = Object.freeze(['macd', 'ma', 'ema', 'rsi', 'boll', 'roc', 'obv', 'returns', 'volatility', 'max_drawdown'] as const satisfies readonly AlgorithmMethodId[]);
const dailyV21 = Object.freeze([...dailyV20, 'alpha191_014', 'alpha191_031', 'alpha191_116', 'alpha191_168', 'alpha191_189'] as const satisfies readonly AlgorithmMethodId[]);
const frozenCapabilities: readonly (FrozenAlgorithmCapabilities & { since: number })[] = [
  Object.freeze({ since: 22, methods: dailyV21, allFactorDefinitions: true, screen: true, pureOperators: true }),
  Object.freeze({ since: 21, methods: dailyV21, allFactorDefinitions: true, screen: true }),
  Object.freeze({ since: 20, methods: dailyV20, allFactorDefinitions: true, screen: false }),
  Object.freeze({ since: 18, methods: Object.freeze(['macd'] as const), allFactorDefinitions: false, screen: false }),
];
const unavailable: FrozenAlgorithmCapabilities = Object.freeze({ methods: Object.freeze([]), allFactorDefinitions: false, screen: false });

export function frozenAlgorithmCapabilities(version?: number): FrozenAlgorithmCapabilities {
  if (version === undefined || !Number.isSafeInteger(version)) return unavailable;
  return frozenCapabilities.find(entry => version >= entry.since) ?? unavailable;
}

export function algorithmAllowedByRules(methodId: unknown, rulesVersion?: number): boolean {
  const rules = frozenAlgorithmCapabilities(rulesVersion);
  if (isPureOperatorId(methodId)) return rules.pureOperators === true;
  return methodId === 'strategy_screen' ? rules.screen : isAlgorithmMethodId(methodId) && rules.methods.includes(methodId);
}

export function algorithmActionAllowed(action: string, version?: number): boolean {
  const rules = frozenAlgorithmCapabilities(version);
  if (action === 'algorithms.screen') return rules.screen;
  if (['algorithms.calculate', 'data.modules.calculate', 'algorithms.publish'].includes(action)) return rules.methods.length > 0;
  return true;
}

/** 目录暴露已登记的受控指标，实现就绪状态由受信执行器报告。 */
export function basicAlgorithmToolContract(catalog: AlgorithmCatalogView, selectedMethod?: string, rulesVersion?: number, checks: AlgorithmRuntimeChecks = {}) {
  const rules = frozenAlgorithmCapabilities(rulesVersion);
  const dailyEnabled = rules.methods.length > 0 && catalog.enabled;
  const dailyReady = dailyEnabled && catalog.status === 'available';
  const pure = rules.pureOperators ? pureOperatorAvailability(checks) : null;
  const enabled = dailyEnabled || pure?.status === 'ready';
  const status = dailyReady || pure?.status === 'ready' ? 'available' : 'unavailable';
  const methods = ALGORITHM_REGISTRY.filter(item => algorithmAllowedByRules(item.id, rulesVersion)
      && (selectedMethod === undefined || item.id === selectedMethod))
    .map(item => {
      if (isPureOperatorId(item.id)) {
        const spec = pureOperatorDefinition(item.id);
        return { methodId: item.id, title: item.title, ...pure!, executable: pure?.status === 'ready',
          methodVersion: pureMethodVersion(item.id), implementationVersion: PURE_OPERATOR_VERSION,
          parameters: spec.parameterSchema, requiredFields: spec.fields.required, outputFields: item.outputFields,
          limitations: item.limitations, definition: definitionFor(item.id), executor: 'typescript', interface: 'algorithms.calculate',
          input: pureOperatorInputContract(spec), output: { state: 'computed', publication: PURE_PUBLICATION } };
      }
      const actual = catalog.methods.find(method => method.id === item.id);
      return { methodId: item.id, title: item.title, status: actual?.status ?? 'unavailable',
        reason: actual?.reason ?? (actual?.status === 'ready' ? null : catalog.reason ?? `${item.title}执行器未装配。`),
        parameters: actual?.parameters ?? item.parameterSchema ?? item.parameters,
        requiredFields: actual?.requiredFields ?? item.requiredInputs, outputFields: item.outputFields,
        limitations: item.limitations, definition: definitionFor(item.id),
        executable: dailyReady && actual?.status === 'ready', executor: 'python', interface: 'algorithms.calculate',
        methodVersion: actual?.methodVersion ?? 'unavailable', implementationVersion: actual?.implementationVersion ?? 'unavailable',
        input: { kind: 'fixed_snapshot', referenceKind: 'wfd_fixed_snapshot',
          requiredIdentity: ['instanceId', 'productId', 'snapshotId', 'definitionRevision'],
          requiredEvidence: ['fields', 'fieldMapping', 'semantics', 'calendar'],
          semanticDeclaration: item.requiredInputs?.includes('volume') ? {
            ...MACD_SNAPSHOT_SEMANTIC_CONTRACT,
            semantics: { ...MACD_SNAPSHOT_SEMANTIC_CONTRACT.semantics, volumeUnit: '须与显式映射的 WFD 成交量字段单位一致' },
          } : MACD_SNAPSHOT_SEMANTIC_CONTRACT,
          historical: '历史用途必须给出明确模式与截止，并通过 WFD 资格核对。宿主核对当前用户声明“请按市场可知视角，以 <截止> 为截止执行历史计算。”（或“系统持有”），或用户原消息中的 purpose=historical_compute、action=algorithms.calculate、historyMode 和 cutoff 结构化声明。' },
        output: { state: 'computed', publication: 'independent_verification_then_existing_r1_fixed_readback' },
      };
    });
  return { enabled, status, version: BD_SESSION_TOOL_CONTRACT_VERSION, registryVersion: ALGORITHM_REGISTRY_VERSION,
    owner: 'bd_agents', discoveryAction: 'algorithms.contract', calculateAction: rules.methods.length ? 'algorithms.calculate' : null,
    screenAction: rules.screen ? 'algorithms.screen' : null,
    screenContract: rules.screen ? { action: 'algorithms.contract', methodId: 'strategy_screen' } : null,
    publishAction: rules.methods.length && !isPureOperatorId(selectedMethod) ? 'algorithms.publish' : null, statusAction: 'algorithms.status',
    sourcePolicy: 'WFD fixed snapshot only; no managed file, no latest, no hidden acquisition',
    agentTriggered: true, uiExecution: false, agentMaySelfAuthorize: false,
    methods, unknownMethod: selectedMethod !== undefined && methods.length === 0 };
}

export function bdSessionToolContract(catalog: AlgorithmCatalogView, rulesVersion?: number, checks: AlgorithmRuntimeChecks = {}) {
  const rules = frozenAlgorithmCapabilities(rulesVersion);
  const processing = processingSessionContract();
  return { version: BD_SESSION_TOOL_CONTRACT_VERSION, entry: 'bd_agents.conversation', owner: 'bd_agents',
    toolGroups: [
      { id: 'collection_sources', title: '采集源', tools: ['capture.*.read', 'web.read_public', 'web.search'],
        next: '取得原件和来源回执后，按实际反馈选择处理步骤。' },
      { id: 'api_sources', title: '接口源',
        tools: ['source.fetch', 'source.api.read', 'source.kline.read', 'source.werss.read', 'source.wechat.extract'],
        next: '取得原件与来源回执，不自动加工或计算。' },
      { id: 'files', title: '文件', tools: ['file.read', 'material.read', 'material.process', processing.discovery,
        processing.route, processing.plan, processing.execute, processing.status, processing.recover,
        ...processing.moduleActions], next: processing.feedback, legacyRecovery: processing.legacyRecovery },
      { id: 'wfd', title: 'WFD 正式数据',
        tools: ['data.r1.capabilities', 'data.r1.prepare', 'data.r1.get', 'data.r1.recover', 'data.wfd.query'],
        next: '正式发布仍经现有 R1 确认与固定读回；查询固定快照。' },
      { id: 'basic_algorithms', title: rules.pureOperators ? '受控日线、财务与复权算子' : '受控日线指标',
        tools: ['algorithms.contract', 'algorithms.capabilities', ...(rules.methods.length ? ['algorithms.calculate', 'algorithms.publish'] : []), 'algorithms.status'],
        next: rules.pureOperators ? '先以固定 snapshotId 发现实际产品与字段，再按所选方法契约执行。纯算子的正式发布须显式 R1 交接。'
          : '按登记的参数和字段选择指标，以固定 WFD 快照计算。独立核对数值和来源后，沿原 R1 请求发布与固定读回。' },
      ...(rules.screen ? [{ id: 'strategy_screening', title: '受控截面筛选',
        tools: ['algorithms.contract', 'algorithms.screen'],
        next: '先读取 methodId=strategy_screen 的合同，明确固定 WFD 产品、日期与历史视角；完整分页后执行有限筛选规则，候选与证据返回原任务，不自动发布或下单。' }] : []),
    ], algorithms: basicAlgorithmToolContract(catalog, undefined, rulesVersion, checks) };
}
