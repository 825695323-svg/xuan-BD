import type { ToolLibraryView, ToolLibraryTool } from '../../contracts/tool-library.js';
import type { FinancialService } from './service.js';
import type { LocalAlgorithmService } from './algorithm-service.js';
import type { AlgorithmMethodId } from './algorithm-types.js';
import {
  ALGORITHM_REGISTRY, ALGORITHM_REGISTRY_NOTE, ALGORITHM_REGISTRY_REGISTERED_AT, ALGORITHM_REGISTRY_VERSION,
  EXECUTABLE_TOOL_IDS, registryCounts,
} from './algorithm-registry.js';

const EXECUTABLE = new Set<string>(EXECUTABLE_TOOL_IDS);

/**
 * 只读基础算法目录；不读取业务快照、创建计算任务或持久化目录状态。
 *
 * 工具清单来自登记清单 `algorithm-registry.ts`：只有 executable 项会被受控入口放行，
 * 其余项保留登记时的状态与缺失说明，不会被入口状态覆盖成“可用”。
 */
export class ToolLibraryService {
  constructor(private readonly options: { financial?: FinancialService; algorithms?: LocalAlgorithmService }) {}

  view(): ToolLibraryView {
    const registry = { version: ALGORITHM_REGISTRY_VERSION, registeredAt: ALGORITHM_REGISTRY_REGISTERED_AT,
      note: ALGORITHM_REGISTRY_NOTE, counts: registryCounts() };
    const catalog = this.options.algorithms?.catalog();
    if (catalog) {
      const methods = new Map(catalog.methods.map(method => [method.id, method]));
      const tools = structuredClone(ALGORITHM_REGISTRY).map(tool => {
        if (!EXECUTABLE.has(tool.id)) return tool;
        const method = methods.get(tool.id as AlgorithmMethodId);
        if (!method) return { ...tool, status: 'unavailable' as const, reason: '算法计算入口没有声明此方法。' };
        return { ...tool, status: method.status, reason: method.reason };
      });
      const ready = tools.some(tool => tool.status === 'ready');
      return { tools, status: ready ? 'ready' : 'unavailable', registry,
        reason: ready ? null : catalog.reason ?? tools.find(tool => tool.reason)?.reason ?? '算法计算入口尚未就绪。' };
    }
    const enabled = this.options.financial?.status().enabled === true;
    const tools = structuredClone(ALGORITHM_REGISTRY).map(tool => EXECUTABLE.has(tool.id) ? { ...tool,
      status: enabled ? 'ready' as const : 'unavailable' as const, reason: enabled ? null : '本机计算资产尚未完成登记或启用。' } : tool);
    return { tools, status: tools.some(tool => tool.status === 'ready') ? 'ready' : 'unavailable', registry,
      reason: enabled ? null : '本机计算资产尚未完成登记或启用。' };
  }
}
