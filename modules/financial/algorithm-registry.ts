import type { ToolLibraryState, ToolLibraryTool } from '../../contracts/tool-library.js';
import { ALGORITHM_METHOD_IDS, ALGORITHM_METHODS } from './algorithm-types.js';
import { PURE_ALGORITHM_OPERATORS } from './algorithm-pure-operators.js';

export const ALGORITHM_REGISTRY_VERSION = 'bd.algorithm-registry/2';
export const ALGORITHM_REGISTRY_REGISTERED_AT = '2026-11-20';
export const ALGORITHM_REGISTRY_NOTE = '日线指标通过 WFD 固定输入受控执行。财务和复权算子已登记 TypeScript 实现及其输入契约。';
const fixedParameterLabels: Record<string, string> = { short_period: '短周期', long_period: '长周期', signal_period: '信号周期' };

const marketIndicators = ALGORITHM_METHOD_IDS.map((id): ToolLibraryTool => {
  const method = ALGORITHM_METHODS[id];
  const parameters = Object.entries(method.parameterSchema.properties).flatMap(([key, rule]) =>
    'const' in rule && typeof rule.const === 'number'
      ? [{ key, label: fixedParameterLabels[key] ?? key, defaultValue: rule.const, min: rule.const, max: rule.const }] : []);
  return { id, title: method.title, category: 'market', state: 'executable', status: 'ready', reason: null,
    description: method.description, parameters, parameterSchema: method.parameterSchema,
    outputFields: [...method.outputFields], requiredInputs: [...method.requiredFields],
    sources: [method.source], missing: [], limitations: [...method.limitations] };
});

export const ALGORITHM_REGISTRY: readonly ToolLibraryTool[] = Object.freeze([
  ...marketIndicators,
  ...PURE_ALGORITHM_OPERATORS.map((operator): ToolLibraryTool => ({
    id: operator.id, title: operator.title, category: operator.category, description: operator.description,
    state: 'assets_only', status: 'unavailable',
    reason: '纯 TS 受控算子已登记，尚未接入 `algorithms.calculate` 通用任务执行入口', parameters: [],
    outputFields: operator.formula.map(line => line.output), requiredInputs: [...operator.requiredInputs],
    sources: [operator.source], missing: [], limitations: [operator.missingPolicy],
  })),
]);

export function registryCounts(entries = ALGORITHM_REGISTRY): Record<ToolLibraryState, number> {
  const counts: Record<ToolLibraryState, number> = { executable: 0, assets_only: 0, not_implemented: 0, needs_data: 0 };
  for (const entry of entries) counts[entry.state ?? 'not_implemented'] += 1;
  return counts;
}
