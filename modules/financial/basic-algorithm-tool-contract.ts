import type { AlgorithmCatalogView } from './algorithm-types.js';
import { ALGORITHM_REGISTRY } from './algorithm-registry.js';

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
  // 观测均线归于基础算法目录，WFD 固定快照独立实现尚未完成，继续明确不可执行。
  const observationMA = {
    methodId: 'source_observation_ma', title: '观测均线 / Observation Moving Average',
    status: 'blocked', reason: '尚无 WFD 固定快照输入的独立观测均线实现；不复用原批次自动计算。',
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
  // 已登记但未启用的算法保留各自稳定 methodId，仅提供不可执行接口说明，
  // 不使用算法资料包存在性冒充可计算、可发布资格。
  const implemented = new Set<string>(methods.map(method => method.methodId));
  implemented.add(observationMA.methodId);
  const reserved = ALGORITHM_REGISTRY.filter(tool => !implemented.has(tool.id)).map(tool => ({
    methodId: tool.id, title: tool.title, status: 'blocked' as const,
    reason: tool.reason ?? '算法只有登记信息，尚无 WFD 固定快照的可执行实现。',
    interface: 'algorithms.calculate', methodVersion: 'not_adopted', implementationVersion: 'not_adopted',
    parameters: tool.parameters, requiredFields: tool.requiredInputs, outputFields: tool.outputFields,
    limitations: tool.limitations, missing: tool.missing,
    input: { kind: 'fixed_snapshot', referenceKind: 'wfd_fixed_snapshot',
      requiredIdentity: ['instanceId', 'productId', 'snapshotId', 'definitionRevision'],
      requiredEvidence: ['fields', 'fieldMapping', 'semantics', 'calendar'],
      historical: '明确 historyMode/cutoff 并经 WFD 历史资格核对' },
    output: { state: 'computed', persistence: 'not_requested', publication: 'not_requested' },
  }));
  const all = [...methods, observationMA, ...reserved];
  const selected = selectedMethod ? all.filter(method => method.methodId === selectedMethod) : all;
  return { version: BD_SESSION_TOOL_CONTRACT_VERSION, owner: 'bd_agents',
    catalogue: '基础算法 / Basic Algorithms', discoveryAction: 'algorithms.contract',
    calculateAction: 'algorithms.calculate', statusAction: 'algorithms.status',
    sourcePolicy: 'WFD fixed snapshot only; no managed file, no latest, no hidden data acquisition',
    agentTriggered: true, uiExecution: false, agentMayRead: true, agentMaySelfAuthorize: false,
    publication: 'one independent fixed-algorithm verification -> existing R1 WFD submit -> fixed readback',
    methods: selected, unknownMethod: selectedMethod !== undefined && selected.length === 0 };
}

/** 会话是唯一任务入口；采集/文件工具与算法不建立自动调用链。 */
export function bdSessionToolContract(catalog: AlgorithmCatalogView) {
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
        tools: ['data.r1.capabilities', 'data.r1.prepare', 'data.r1.submit', 'data.r1.get', 'data.r1.recover'],
        next: '正式发布、固定读回和历史资格仍归 WFD；本契约不授予数据库写权' },
      { id: 'basic_algorithms', title: '基础算法 / Basic Algorithms',
        tools: ['algorithms.contract', 'algorithms.capabilities', 'algorithms.calculate', 'algorithms.publish', 'algorithms.status'],
        next: 'AGENTS 调用 → WFD 固定快照 → 固定算法结构化结果 → 独立核对 → WFD 正式发布与固定读回' },
    ], algorithms: basicAlgorithmToolContract(catalog) };
}
