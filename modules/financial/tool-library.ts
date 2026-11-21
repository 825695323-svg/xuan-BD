import type { ToolLibraryView } from '../../contracts/tool-library.js';
import type { WorkspaceServices } from '../../contracts/workspace-services.js';
import { isValidR1ReadBinding } from '../../contracts/r1-contracts.js';
import { isPureOperatorId } from './algorithm-types.js';
import type { LocalAlgorithmService } from './algorithm-service.js';
import { ALGORITHM_REGISTRY, ALGORITHM_REGISTRY_NOTE, ALGORITHM_REGISTRY_REGISTERED_AT,
  ALGORITHM_REGISTRY_VERSION, registryCounts } from './algorithm-registry.js';
import { ALGORITHM_DEFINITION_SUMMARY, definitionFor } from './algorithm-definitions.js';

export interface AlgorithmRuntimeChecks {
  hasWfdReader?: () => boolean;
  calculateEnabled?: () => boolean;
  hasDailyPublisher?: () => boolean;
}

export function fixedWfdBinding(port: WorkspaceServices['r1Workspace']) {
  if (typeof port?.readProduct !== 'function' || typeof port.capabilities !== 'function' || typeof port.readBinding !== 'function') return null;
  try {
    const caps = port.capabilities(), binding = port.readBinding();
    return caps?.connection?.connectionId?.trim() && caps.connection.profile === 'data_only' && caps.readProductSupported !== false
      && (caps.configuration === undefined || caps.configuration?.state === 'configured') && isValidR1ReadBinding(binding)
      ? { connection: caps.connection, binding } : null;
  } catch { return null; }
}

export function pureOperatorAvailability(checks: AlgorithmRuntimeChecks) {
  const reason = checks.calculateEnabled?.() === false ? '计算模块已停用。'
    : !checks.hasWfdReader?.() ? 'algorithms.calculate 需要已绑定且支持 read_product（固定产品读取）的 WFD 连接。' : null;
  return { status: reason ? 'unavailable' as const : 'ready' as const, reason };
}

export type ToolLibraryOptions = AlgorithmRuntimeChecks & { algorithms?: Pick<LocalAlgorithmService, 'catalog'> };
export class ToolLibraryService {
  constructor(private readonly options: ToolLibraryOptions = {}) {}
  view(): ToolLibraryView {
    const catalog = this.options.algorithms?.catalog();
    const pure = pureOperatorAvailability(this.options);
    const dailyReason = this.options.calculateEnabled?.() === false ? '计算模块已停用。'
      : this.options.hasDailyPublisher?.() === false ? '日线指标的 R1 发布适配器未装配。' : null;
    const tools = ALGORITHM_REGISTRY.map(tool => {
      const entry = { ...structuredClone(tool), definition: definitionFor(tool.id) };
      if (tool.state !== 'executable') return entry;
      if (isPureOperatorId(tool.id)) return { ...entry, ...pure };
      if (dailyReason) return { ...entry, status: 'unavailable' as const, reason: dailyReason };
      const method = catalog?.methods.find(item => item.id === tool.id);
      return { ...entry, status: method?.status ?? 'unavailable' as const,
        reason: method?.reason ?? (method?.status === 'ready' ? null : catalog?.reason ?? `${tool.title}执行器未装配。`) };
    });
    const ready = tools.some(tool => tool.status === 'ready');
    return { tools, status: ready ? 'ready' : 'unavailable',
      reason: ready ? null : tools[0]?.reason ?? '受控算法当前不可用。',
      registry: { version: ALGORITHM_REGISTRY_VERSION, registeredAt: ALGORITHM_REGISTRY_REGISTERED_AT,
        note: ALGORITHM_REGISTRY_NOTE, counts: registryCounts() }, definitions: ALGORITHM_DEFINITION_SUMMARY };
  }
}
