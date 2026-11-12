import type { AlgorithmCatalogView } from './algorithm-types.js';
import { ALGORITHM_REGISTRY } from './algorithm-registry.js';
import { FIXED_CALCULATION_METHODS } from '../../contracts/fixed-calculation-contracts.js';
import { FINANCIAL_FIXED_VERSION, FINANCIAL_LINEAR_ADMISSION_VERSION } from '../collection/data-processing/financial-fixed.js';

/**
 * BD AGENTS 只读统一入口契约（Unified Agent Tool Contract）。
 * 列出会话能读取/调用的既有工具，不创建第二套调度器、授权或计算运行时。
 * 可调用状态来自实际算法服务目录；尚未接入的算法只能声明为 blocked。
 */
export const BD_SESSION_TOOL_CONTRACT_VERSION = 'bd.session-tools/1';

/** 旧 Polars 方法 ID 只作为历史身份。迁移到 WFD 后使用统一算法方法 ID。 */
export const LEGACY_FIXED_METHOD_ALIASES = Object.freeze({
  observation_ma20: 'source_observation_ma', financial_linear: 'financial_linear', macro_yoy: 'macro_yoy',
} as const);
export function isUnmigratedLegacyAlgorithmMethod(value: unknown): boolean {
  return typeof value === 'string' &&
    (Object.hasOwn(LEGACY_FIXED_METHOD_ALIASES, value) ||
      Object.values(LEGACY_FIXED_METHOD_ALIASES).some(id => id === value));
}

/** Read-only capability supplied by the existing trusted Polars executor, not a second method registry. */
export interface UnifiedBackendCapability {
  status: 'ready' | 'blocked'; reason: string | null;
  methods: readonly string[]; version: string;
}
export function basicAlgorithmToolContract(
  catalog: AlgorithmCatalogView, selectedMethod?: string, unified?: UnifiedBackendCapability,
) {
  const methods = catalog.methods.map(method => ({
    methodId: method.id, title: method.title, status: method.status, reason: method.reason,
    executor: 'python', interface: 'algorithms.calculate', methodVersion: method.methodVersion,
    implementationVersion: method.implementationVersion,
    parameters: method.parameters, requiredFields: method.requiredFields,
    outputFields: method.outputFields, limitations: method.limitations,
    input: { kind: 'fixed_snapshot', referenceKind: 'wfd_fixed_snapshot',
      requiredIdentity: ['instanceId', 'productId', 'snapshotId', 'definitionRevision'],
      requiredEvidence: ['fields', 'fieldMapping', 'semantics', 'calendar'],
      historical: '明确 historyMode/cutoff 并经 WFD 历史资格核对' },
    output: { state: 'computed', persistence: 'not_requested', publication: 'not_requested' },
  }));
  // 旧 Polars 是计算实现，不是并行业务入口。迁移前统一目录可见，但不在
  // algorithms.calculate 中绕过 WFD 固定数据身份、独立核验和 WFD 正式读回。
  const legacyIds = LEGACY_FIXED_METHOD_ALIASES;
  const executableIds = new Set<string>(methods.map(method => method.methodId));
  const oldMethods = (Object.keys(FIXED_CALCULATION_METHODS) as Array<keyof typeof FIXED_CALCULATION_METHODS>)
    .filter(id => !executableIds.has(legacyIds[id]))
    .map(id => {
      const definition = FIXED_CALCULATION_METHODS[id], methodId = legacyIds[id];
      // The running backend is the sole authority for readiness. A catalog entry alone
      // must not claim that a Polars calculation can create a verified WFD derivative.
      const ready = unified?.status === 'ready' && unified.methods.includes(methodId);
      const methodVersion = id === 'macro_yoy' ? 'bd.macro-yoy/1' : id === 'financial_linear'
        ? FINANCIAL_LINEAR_ADMISSION_VERSION : 'not_adopted';
      const calculationVersion = id === 'financial_linear' ? FINANCIAL_FIXED_VERSION : methodVersion;
      return {
        methodId, legacyMethodId: id, title: definition.title, status: ready ? 'ready' as const : 'blocked' as const,
        reason: ready ? null : unified?.reason ?? '方法尚无可用的统一 WFD 固定输入、独立核验及正式发布适配。',
        executor: 'polars', interface: 'algorithms.calculate',
        methodVersion: ready ? methodVersion : 'not_adopted', implementationVersion: ready ? unified.version : 'not_adopted',
        parameters: ready ? {
          requestFields: ['methodId', 'source', 'calculation', 'usage'],
          source: { kind: 'fixed_snapshot' }, usage: { purpose: 'current_compute' },
          calculation: id === 'financial_linear' ? {
            version: calculationVersion, operations: ['quarter_difference', 'ttm'],
            inputs: '明确固定 snapshotId/productId/businessKeys 的财务记录',
          } : {
            version: methodVersion, historyMode: 'snapshot_contents',
            knowledgeCutoff: '明确 UTC 校验截止',
            inputs: '两条具体 snapshotId/productId/businessKey/recordVersion',
          },
        } : { legacyInput: definition.input, migrationRequired: true },
        requiredFields: id === 'financial_linear'
          ? ['accounting_standard', 'currency', 'scope', 'concept', 'period_type', 'value']
          : id === 'macro_yoy' ? ['series_code', 'region', 'base_period', 'published_at', 'value']
          : ['observation_time', 'value'],
        outputFields: id === 'financial_linear' ? ['value'] : id === 'macro_yoy' ? ['yoy'] : ['moving_average'],
        limitations: [definition.scope, '不得重开旧原报批次自动算法', '必须完成独立数值验收和统一 WFD 发布适配才能启用'],
        input: { kind: 'fixed_snapshot', referenceKind: 'wfd_fixed_snapshot',
          requiredIdentity: ['snapshotId', 'productId', 'businessKey', 'recordVersion'],
          requiredEvidence: ['原始 WFD 固定行', '记录版本', '同一受信连接', '财务或宏观独立数值复核'],
          historical: '仅固定快照内容；未证明历史时点可知' },
        output: { state: 'computed', persistence: 'not_requested', publication: 'not_requested' },
      };
    });
  // 已登记但未启用的算法保留各自稳定 methodId，仅提供不可执行接口说明，
  // 不使用算法资料包存在性冒充可计算、可发布资格。
  const implemented = new Set<string>(methods.map(method => method.methodId));
  oldMethods.forEach(method => implemented.add(method.methodId));
  const reserved = ALGORITHM_REGISTRY.filter(tool => !implemented.has(tool.id)).map(tool => ({
    methodId: tool.id, title: tool.title, status: 'blocked' as const,
    reason: tool.reason ?? '算法只有登记信息，尚无 WFD 固定快照的可执行实现。',
    executor: 'not_adopted', interface: 'algorithms.calculate', methodVersion: 'not_adopted', implementationVersion: 'not_adopted',
    parameters: tool.parameters, requiredFields: tool.requiredInputs, outputFields: tool.outputFields,
    limitations: tool.limitations, missing: tool.missing,
    input: { kind: 'fixed_snapshot', referenceKind: 'wfd_fixed_snapshot',
      requiredIdentity: ['instanceId', 'productId', 'snapshotId', 'definitionRevision'],
      requiredEvidence: ['fields', 'fieldMapping', 'semantics', 'calendar'],
      historical: '明确 historyMode/cutoff 并经 WFD 历史资格核对' },
    output: { state: 'computed', persistence: 'not_requested', publication: 'not_requested' },
  }));
  const all = [...methods, ...oldMethods, ...reserved];
  const selected = selectedMethod ? all.filter(method => method.methodId === selectedMethod) : all;
  return { version: BD_SESSION_TOOL_CONTRACT_VERSION, owner: 'bd_agents',
    catalogue: '基础算法 / Basic Algorithms', discoveryAction: 'algorithms.contract',
    calculateAction: 'algorithms.calculate', statusAction: 'algorithms.status',
    sourcePolicy: 'WFD fixed snapshot only; no managed file, no latest, no hidden data acquisition',
    agentTriggered: true, uiExecution: false, agentMayRead: true, agentMaySelfAuthorize: false,
    publication: 'data production shared verifier + method-specific proof -> existing R1 WFD submit -> fixed readback',
    methods: selected, unknownMethod: selectedMethod !== undefined && selected.length === 0 };
}

/** 会话是唯一任务入口；采集/文件工具与算法不建立自动调用链。 */
export function bdSessionToolContract(catalog: AlgorithmCatalogView, unified?: UnifiedBackendCapability) {
  return { version: BD_SESSION_TOOL_CONTRACT_VERSION, entry: 'bd_agents.conversation',
    owner: 'bd_agents', agentTriggeredCalculation: true, uiCalculation: false, backgroundCalculation: false,
    toolGroups: [
      { id: 'collection_sources', title: '采集源 / Collection Sources',
        tools: ['capture.*.read', 'web.read_public', 'web.search'],
        next: '材料先进入本会话明确选择的保管与五步加工，不自动运行算法' },
      { id: 'api_sources', title: '接口源 / API Sources',
        tools: ['source.fetch', 'source.api.read', 'source.kline.read', 'source.werss.read', 'source.wechat.extract'],
        next: '取得原件与来源回执；不自动计算' },
      { id: 'files', title: '文件 / Files',
        tools: ['file.read', 'material.read', 'material.process', 'data.processing.capabilities',
          'data.processing.route', 'data.processing.plan', 'data.processing.run'],
        next: '受控保管、识别、五步加工；原报通过 R1 单独交接' },
      { id: 'wfd', title: 'WFD 正式数据 / WFD Published Data',
        tools: ['data.r1.capabilities', 'data.r1.prepare', 'data.r1.get', 'data.r1.recover'],
        next: '正式发布、固定读回和历史资格仍归 WFD；本契约不授予数据库写权' },
      { id: 'basic_algorithms', title: '基础算法 / Basic Algorithms',
        tools: ['algorithms.contract', 'algorithms.capabilities', 'algorithms.calculate', 'algorithms.publish', 'algorithms.status'],
        next: 'AGENTS 调用同一数据生产计算模块 → WFD 固定快照 → 注册方法/Polars 或按需 pandas → 共用生产核对与方法独立复核 → R1/WFD 正式发布读回' },
    ], algorithms: basicAlgorithmToolContract(catalog, undefined, unified) };
}
