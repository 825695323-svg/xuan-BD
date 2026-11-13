import type { AlgorithmDefinition, AlgorithmDefinitionSummary } from '../../contracts/algorithm-definition.js';
import { ALGORITHM_REGISTRY } from './algorithm-registry.js';
import { ALGORITHM_METHODS } from './algorithm-types.js';

const registered = ALGORITHM_REGISTRY[0]!;
export const ALGORITHM_DEFINITIONS: readonly AlgorithmDefinition[] = Object.freeze([{
  kind: 'definition', id: 'algo.macd', registryId: 'macd', title: registered.title,
  definitionKind: 'indicator', summary: registered.description,
  formula: [
    { output: 'DIFF', expression: 'DIFF_t = EMA(C, 12)_t − EMA(C, 26)_t' },
    { output: 'DEA', expression: 'DEA_t = EMA(DIFF, 9)_t' },
    { output: 'MACD', expression: 'MACD_t = 2 × (DIFF_t − DEA_t)', note: '固定采用 2 倍柱值。' },
    { output: 'ZERO', expression: 'ZERO_t = 0' },
  ],
  semantics: [
    { key: 'parameters', label: '周期', value: '固定 12/26/9。', state: 'fixed' },
    { key: 'seed', label: '初始化', value: '按所供窗口首条有效收盘价初始化，不补窗口前历史或接续状态。', state: 'fixed' },
    { key: 'coefficient', label: '柱值系数', value: '2 × (DIFF − DEA)，不与 1 倍口径混用。', state: 'fixed' },
  ],
  warmup: '可用区间以原计算服务的预热标记为准；窗口首值初始化不等同完整长期历史。',
  missingPolicy: '不补历史、不扩窗、不推定价格单位、复权或可得时间。',
  implementations: [{ id: 'impl.local.indicators.macd', role: 'primary', language: 'Python',
    location: 'plugins/financial/local-compute/assets/indicators.py: MACD', version: ALGORITHM_METHODS.macd.version }],
  configurations: [{ id: 'cfg.macd.base', label: '受控 MACD', frequency: '日线',
    parameters: '12/26/9 固定；init=first_valid', entry: 'library' }],
  products: [], legacyAliases: [],
  status: {
    definition: { state: 'frozen', basis: '沿用当前 MACD 的固定周期、首值初始化和 2 倍柱值定义。' },
    implementation: { state: 'present', basis: '保留受控 Python MACD 与输入、结果校验。' },
    verification: { state: 'unrecorded', basis: '当前清理后的验证状态以交付记录为准，目录不替代实际验收。' },
  },
}]);
export function definitionFor(registryId: string): AlgorithmDefinition | undefined {
  return ALGORITHM_DEFINITIONS.find(item => item.registryId === registryId);
}
export const ALGORITHM_DEFINITION_SUMMARY: AlgorithmDefinitionSummary = Object.freeze({
  kind: 'definition', version: 'bd.macd-definition/1', note: '只登记一个固定 MACD 算法；执行与发布按实际任务核验。',
  counts: { definitions: 1, operators: 0, withProducts: 0, definitionConflicts: 0, implemented: 1, legacyAliases: 0 },
});
