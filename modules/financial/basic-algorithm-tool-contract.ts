import type { AlgorithmCatalogView } from './algorithm-types.js';
import { MACD_SNAPSHOT_SEMANTIC_CONTRACT } from './product-machine-snapshot.js';
import { ALGORITHM_REGISTRY, ALGORITHM_REGISTRY_VERSION } from './algorithm-registry.js';
import { definitionFor } from './algorithm-definitions.js';
import { processingSessionContract } from '../collection/production-module-ports.js';

export const BD_SESSION_TOOL_CONTRACT_VERSION = 'bd.session-tools/3';

/** 目录只暴露当前 MACD，实现就绪状态由受信执行器报告。 */
export function basicAlgorithmToolContract(catalog: AlgorithmCatalogView, selectedMethod?: string) {
  const methods = ALGORITHM_REGISTRY.filter(item => selectedMethod === undefined || item.id === selectedMethod)
    .map(item => {
      const actual = catalog.methods.find(method => method.id === item.id);
      return { methodId: item.id, title: item.title, status: actual?.status ?? 'unavailable',
        reason: actual?.reason ?? (actual?.status === 'ready' ? null : catalog.reason ?? 'MACD 执行器未装配。'),
        parameters: actual?.parameters ?? item.parameters,
        requiredFields: actual?.requiredFields ?? item.requiredInputs, outputFields: item.outputFields,
        limitations: item.limitations, definition: definitionFor(item.id),
        executable: actual?.status === 'ready', executor: 'python', interface: 'algorithms.calculate',
        methodVersion: actual?.methodVersion ?? 'unavailable', implementationVersion: actual?.implementationVersion ?? 'unavailable',
        input: { kind: 'fixed_snapshot', referenceKind: 'wfd_fixed_snapshot',
          requiredIdentity: ['instanceId', 'productId', 'snapshotId', 'definitionRevision'],
          requiredEvidence: ['fields', 'fieldMapping', 'semantics', 'calendar'],
          semanticDeclaration: MACD_SNAPSHOT_SEMANTIC_CONTRACT,
          historical: '历史用途必须给出明确模式与截止，并通过 WFD 资格核对。' },
        output: { state: 'computed', publication: 'independent_verification_then_existing_r1_fixed_readback' },
      };
    });
  return { version: BD_SESSION_TOOL_CONTRACT_VERSION, registryVersion: ALGORITHM_REGISTRY_VERSION,
    owner: 'bd_agents', discoveryAction: 'algorithms.contract', calculateAction: 'algorithms.calculate',
    publishAction: 'algorithms.publish', statusAction: 'algorithms.status',
    sourcePolicy: 'WFD fixed snapshot only; no managed file, no latest, no hidden acquisition',
    agentTriggered: true, uiExecution: false, agentMaySelfAuthorize: false,
    methods, unknownMethod: selectedMethod !== undefined && methods.length === 0 };
}

export function bdSessionToolContract(catalog: AlgorithmCatalogView) {
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
      { id: 'basic_algorithms', title: 'MACD',
        tools: ['algorithms.contract', 'algorithms.capabilities', 'algorithms.calculate', 'algorithms.publish', 'algorithms.status'],
        next: '固定 WFD 输入 → MACD → 独立数值和来源核对 → 原 R1 发布与固定读回。' },
    ], algorithms: basicAlgorithmToolContract(catalog) };
}
