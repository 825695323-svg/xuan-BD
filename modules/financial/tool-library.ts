import type { ToolLibraryView } from '../../contracts/tool-library.js';
import type { LocalAlgorithmService } from './algorithm-service.js';
import { ALGORITHM_REGISTRY, ALGORITHM_REGISTRY_NOTE, ALGORITHM_REGISTRY_REGISTERED_AT,
  ALGORITHM_REGISTRY_VERSION, registryCounts } from './algorithm-registry.js';
import { ALGORITHM_DEFINITION_SUMMARY, definitionFor } from './algorithm-definitions.js';

export class ToolLibraryService {
  constructor(private readonly options: { algorithms?: Pick<LocalAlgorithmService, 'catalog'> } = {}) {}
  view(): ToolLibraryView {
    const catalog = this.options.algorithms?.catalog();
    const method = catalog?.methods.find(item => item.id === 'macd');
    const tools = ALGORITHM_REGISTRY.map(tool => ({ ...structuredClone(tool),
      status: method?.status ?? 'unavailable' as const,
      reason: method?.reason ?? (method?.status === 'ready' ? null : catalog?.reason ?? 'MACD 执行器未装配。'),
      definition: definitionFor(tool.id) }));
    const ready = tools.some(tool => tool.status === 'ready');
    return { tools, status: ready ? 'ready' : 'unavailable',
      reason: ready ? null : tools[0]?.reason ?? 'MACD 当前不可用。',
      registry: { version: ALGORITHM_REGISTRY_VERSION, registeredAt: ALGORITHM_REGISTRY_REGISTERED_AT,
        note: ALGORITHM_REGISTRY_NOTE, counts: registryCounts() }, definitions: ALGORITHM_DEFINITION_SUMMARY };
  }
}
