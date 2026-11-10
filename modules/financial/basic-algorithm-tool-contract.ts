import type { AlgorithmCatalogView } from './algorithm-types.js';

/**
 * BD AGENTS 只读统一入口契约（Unified Agent Tool Contract）。
 * 列出会话能读取/调用的既有工具，不创建第二套调度器、授权或计算运行时。
 * 可调用状态来自实际算法服务目录；尚未接入的算法只能声明为 blocked。
 */
export const BD_SESSION_TOOL_CONTRACT_VERSION = 'bd.session-tools/1';

export function basicAlgorithmToolContract(catalog: AlgorithmCatalogView, selectedMethod?: string) {
  const methods = catalog.methods.map(method => ({
    methodId: method.id, title: method.title, status: method.status, reason: method.reason,
    interface: 'algorithms.calculate', methodVersion: method.methodVersion,
    implementationVersion: method.implementationVersion,
    parameters: method.parameters, requiredFields: method.requiredFields,
    outputFields: method.outputFields, limitations: method.limitations,
    input: { kind: 'fixed_snapshot', referenceKind: 'wfd_fixed_snapshot',
      requiredIdentity: ['instanceId', 'productId', 'snapshotId', 'definitionRevision'],
      requiredEvidence: ['fields', 'fieldMapping', 'semantics', 'calendar'],
      historical: '明确 historyMode/cutoff 并经 WFD 历史资格核对' },
    output: { state: 'computed', persistence: 'not_requested', publication: 'not_requested' },
  }));
  // 原批次来源观测均线仍依赖原件和 R1 关联，不能冒充已经支持统一 WFD 算法入口。
  const observationMA = {
    methodId: 'source_observation_ma', title: '观测均线 / Observation Moving Average',
    status: 'blocked', reason: '旧实现仍绑定原报和批次计算证明；尚未移植为仅从 WFD 固定快照读取的独立方法。',
    interface: 'algorithms.calculate', methodVersion: 'not_adopted', implementationVersion: 'not_adopted',
    parameters: { type: 'object', required: ['period'], properties: { period: { type: 'integer', minimum: 2, maximum: 1000 } } },
    requiredFields: ['observation_time', 'value'], outputFields: ['moving_average'],
    limitations: ['不得调用旧自动均线批次路径', '正式实现与数值口径验收前不执行'],
    input: { kind: 'fixed_snapshot', referenceKind: 'wfd_fixed_snapshot',
      requiredIdentity: ['instanceId', 'productId', 'snapshotId', 'definitionRevision'],
      requiredEvidence: ['fields', 'fieldMapping', 'semantics', 'calendar'],
      historical: '明确 historyMode/cutoff 并经 WFD 历史资格核对' },
    output: { state: 'computed', persistence: 'not_requested', publication: 'not_requested' },
  };
  const all = [...methods, observationMA];
  const selected = selectedMethod ? all.filter(method => method.methodId === selectedMethod) : all;
  return { version: BD_SESSION_TOOL_CONTRACT_VERSION, owner: 'bd_agents',
    catalogue: '基础算法 / Basic Algorithms', discoveryAction: 'algorithms.contract',
    calculateAction: 'algorithms.calculate', statusAction: 'algorithms.status',
    sourcePolicy: 'WFD fixed snapshot only; no managed file, no latest, no hidden data acquisition',
    manualOnly: true, agentMayRead: true, agentMaySelfAuthorize: false,
    publication: 'separate explicit R1 request; never automatic',
    methods: selected, unknownMethod: selectedMethod !== undefined && selected.length === 0 };
}

/** 会话是唯一任务入口；采集/文件工具与算法不建立自动调用链。 */
export function bdSessionToolContract(catalog: AlgorithmCatalogView) {
  return { version: BD_SESSION_TOOL_CONTRACT_VERSION, entry: 'bd_agents.conversation',
    owner: 'bd_agents', manualCalculationOnly: true, backgroundCalculation: false,
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
        tools: ['algorithms.contract', 'algorithms.capabilities', 'algorithms.calculate', 'algorithms.status'],
        next: '人工明确计算请求 → WFD 固定快照读取 → 独立算法 → 本地计算结果；发布另走 R1' },
    ], algorithms: basicAlgorithmToolContract(catalog) };
}
