import type { AlgorithmDefinition, AlgorithmDefinitionSummary } from '../../contracts/algorithm-definition.js';
import { ALGORITHM_METHOD_IDS, ALGORITHM_METHODS } from './algorithm-types.js';
import { pureMethodVersion, PURE_ALGORITHM_OPERATORS, PURE_VERIFICATION_SOURCE, PURE_OPERATOR_VERSION, PURE_VERIFICATION_VERSION } from './algorithm-pure-operators.js';

const marketDefinitions = ALGORITHM_METHOD_IDS.map((registryId): AlgorithmDefinition => {
  const method = ALGORITHM_METHODS[registryId];
  const schema = method.parameterSchema;
  const parameters = Object.entries(schema.properties).map(([key, rule]) => {
    const constraint = 'const' in rule ? String(rule.const)
      : 'enum' in rule ? rule.enum.join(' | ') : `${rule.type} [${rule.minimum}–${rule.maximum}]`;
    return `${key}=${constraint}${schema.required.includes(key) ? '' : '（可选）'}`;
  }).join('，') || '无参数。';
  return {
    kind: 'definition', id: 'algo.' + registryId, registryId, title: method.title,
    definitionKind: method.kind, summary: method.description,
    formula: Object.entries(method.outputs).map(([output, { expression, note }]) =>
      ({ output, expression, ...(note ? { note } : {}) })),
    semantics: [
      { key: 'methodVersion', label: '数学定义版本', value: method.version, state: 'fixed' },
      { key: 'parameters', label: '参数', value: parameters, state: 'fixed' },
      { key: 'resultSemantics', label: '计算口径', value: method.resultSemantics, state: 'fixed' },
    ],
    warmup: method.warmup,
    missingPolicy: '缺失输入拒绝计算。只使用固定窗口内的观测，保留结果空值及其诊断。',
    implementations: [
      { id: 'impl.local.indicators.' + registryId, role: 'primary', language: 'Python',
        location: method.source, note: '本次执行的资产摘要见 implementationVersion。' },
      { id: 'ref.local.indicators.' + registryId, role: 'reference', language: 'TypeScript',
        location: 'modules/financial/algorithm-reference.ts', note: method.reference },
    ],
    configurations: [{ id: `cfg.${registryId}.base`, label: '受控 ' + method.operation, frequency: '日线', parameters, entry: 'library' }],
    products: [], legacyAliases: [],
    status: {
      definition: { state: 'frozen', basis: '按登记的数学版本、参数和计算口径固定。' },
      implementation: { state: 'present', basis: '已有受控 Python 执行与独立 TypeScript 数值核对。' },
      verification: { state: 'unrecorded', basis: '执行及发布资格以原任务核验为准。' },
    },
  };
});

export const ALGORITHM_DEFINITIONS: readonly AlgorithmDefinition[] = Object.freeze([
  ...marketDefinitions,
  ...PURE_ALGORITHM_OPERATORS.map((operator): AlgorithmDefinition => ({
    kind: 'definition', id: 'algo.' + operator.id, registryId: operator.id, title: operator.title,
    definitionKind: operator.category === 'financial' ? 'financial' : 'operator', summary: operator.description,
    formula: operator.formula,
    semantics: [{ key: 'methodVersion', label: '数学定义版本', value: pureMethodVersion(operator.id), state: 'fixed' },
      { key: 'parameters', label: '参数', value: operator.parameterDescription, state: 'fixed' },
      { key: 'input', label: '固定产品字段', value: operator.fields.required.join('、'), state: 'fixed' },
      { key: 'resultSemantics', label: '计算口径', value: operator.description, state: 'fixed' }],
    warmup: '按声明的期间或日线范围计算。', missingPolicy: operator.missingPolicy,
    implementations: [{ id: 'impl.local.' + operator.id, role: 'primary', language: 'TypeScript',
      location: operator.source, version: PURE_OPERATOR_VERSION, note: operator.entry },
      { id: 'ref.local.' + operator.id, role: 'reference', language: 'TypeScript',
        location: PURE_VERIFICATION_SOURCE, version: PURE_VERIFICATION_VERSION, note: '从密封原输入独立核对数值、恒等式与空值诊断。' }],
    configurations: [], products: [], legacyAliases: [],
    status: {
      definition: { state: 'frozen', basis: '按登记公式及输入契约计算。' },
      implementation: { state: 'present', basis: '受控 TypeScript 纯算子。' },
      verification: { state: 'unrecorded', basis: '实际输入资格及发布另行核验。' },
    },
  })),
]);

export function definitionFor(registryId: string): AlgorithmDefinition | undefined {
  return ALGORITHM_DEFINITIONS.find(item => item.registryId === registryId);
}

export const ALGORITHM_DEFINITION_SUMMARY: AlgorithmDefinitionSummary = Object.freeze({
  kind: 'definition', version: 'bd.algorithm-definition/3', note: '受控日线指标、财务及复权定义。执行与发布按实际输入核验。',
  counts: { definitions: ALGORITHM_DEFINITIONS.length,
    operators: ALGORITHM_DEFINITIONS.filter(item => item.definitionKind === 'operator').length, withProducts: 0, definitionConflicts: 0,
    implemented: ALGORITHM_DEFINITIONS.length, legacyAliases: 0 },
});
