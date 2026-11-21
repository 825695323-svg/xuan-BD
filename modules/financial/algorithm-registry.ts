import type { ToolLibraryState, ToolLibraryTool } from '../../contracts/tool-library.js';
import { ALGORITHM_METHOD_IDS, ALGORITHM_METHODS } from './algorithm-types.js';
import { PURE_ALGORITHM_OPERATORS, PURE_VERIFICATION_SOURCE, pureOperatorInputContract } from './algorithm-pure-operators.js';

export const ALGORITHM_REGISTRY_VERSION = 'bd.algorithm-registry/3';
export const ALGORITHM_REGISTRY_REGISTERED_AT = '2026-11-22';
export const ALGORITHM_REGISTRY_NOTE = '日线指标通过 WFD 固定输入受控执行。财务和复权算子由 TypeScript 计算并独立核验，执行资格取决于冻结规则与实际读取端口。';
const fixedParameterLabels: Record<string, string> = { short_period: '短周期', long_period: '长周期', signal_period: '信号周期' };

const marketIndicators = ALGORITHM_METHOD_IDS.map((id): ToolLibraryTool => {
  const method = ALGORITHM_METHODS[id];
  const parameters = Object.entries(method.parameterSchema.properties).flatMap(([key, rule]) =>
    'const' in rule && typeof rule.const === 'number'
      ? [{ key, label: fixedParameterLabels[key] ?? key, defaultValue: rule.const, min: rule.const, max: rule.const }] : []);
  return { id, title: method.title, category: 'market', executor: 'python', state: 'executable', status: 'ready', reason: null,
    description: method.description, parameters, parameterSchema: method.parameterSchema,
    outputFields: [...method.outputFields], requiredInputs: [...method.requiredFields],
    sources: [method.source], missing: [], limitations: [...method.limitations] };
});

export const ALGORITHM_REGISTRY: readonly ToolLibraryTool[] = Object.freeze([
  ...marketIndicators,
  ...PURE_ALGORITHM_OPERATORS.map((operator): ToolLibraryTool => ({
    id: operator.id, title: operator.title, category: operator.category, executor: 'typescript', description: operator.description,
    state: 'executable', status: 'unavailable', reason: '须核实固定 WFD 读取端口和计算开关。',
    parameters: [], parameterSchema: operator.parameterSchema, inputContract: pureOperatorInputContract(operator),
    outputFields: operator.formula.map(line => line.output), requiredInputs: [...operator.requiredInputs],
    sources: [operator.source, PURE_VERIFICATION_SOURCE], missing: [], limitations: [operator.missingPolicy],
  })),
]);

export function registryCounts(entries = ALGORITHM_REGISTRY): Record<ToolLibraryState, number> {
  const counts: Record<ToolLibraryState, number> = { executable: 0, assets_only: 0, not_implemented: 0, needs_data: 0 };
  for (const entry of entries) counts[entry.state ?? 'not_implemented'] += 1;
  return counts;
}
