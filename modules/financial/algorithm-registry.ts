import type { ToolLibraryState, ToolLibraryTool } from '../../contracts/tool-library.js';
import { ALGORITHM_METHODS } from './algorithm-types.js';

export const ALGORITHM_REGISTRY_VERSION = 'bd.macd-registry/1';
export const ALGORITHM_REGISTRY_REGISTERED_AT = '2026-11-13';
export const ALGORITHM_REGISTRY_NOTE = '当前只保留固定 12/26/9 MACD；是否可执行仍取决于真实运行条件和固定输入核验。';
const method = ALGORITHM_METHODS.macd;
export const ALGORITHM_REGISTRY: readonly ToolLibraryTool[] = Object.freeze([{
  id: 'macd', title: method.title, category: 'market', state: 'executable', status: 'ready', reason: null,
  description: method.description,
  parameters: [
    { key: 'short_period', label: '短周期', defaultValue: 12, min: 12, max: 12 },
    { key: 'long_period', label: '长周期', defaultValue: 26, min: 26, max: 26 },
    { key: 'signal_period', label: '信号周期', defaultValue: 9, min: 9, max: 9 },
  ],
  outputFields: [...method.outputFields], requiredInputs: [...method.requiredFields],
  sources: [method.source], missing: [], limitations: [...method.limitations],
}]);

export function registryCounts(): Record<ToolLibraryState, number> {
  const counts: Record<ToolLibraryState, number> = { executable: 0, assets_only: 0, not_implemented: 0, needs_data: 0 };
  for (const entry of ALGORITHM_REGISTRY) counts[entry.state ?? 'not_implemented'] += 1;
  return counts;
}
