import type { AlgorithmFormulaLine } from '../../contracts/algorithm-definition.js';

import type { PureOperatorId } from './algorithm-types.js';
import { financialBasisAxes, financialRatioFields } from './financial-l4-operators.js';

export const PURE_OPERATOR_VERSION = 'bd.pure-operators/1';
export const PURE_VERIFICATION_VERSION = 'bd.pure-operator-verification/1';
export const PURE_VERIFICATION_SOURCE = 'modules/financial/pure-operator-verification.ts';
export const pureMethodVersion = (id: PureOperatorId) => id + '/1';
export const PURE_PUBLICATION = Object.freeze({ state: 'not_requested', mode: 'explicit_r1_handoff_required' } as const);

export interface PureFieldRoles { required: readonly string[]; optional: readonly string[] }
const basis = [...financialBasisAxes, 'fiscalCalendar'];
const observations = { required: [...basis, 'concept', 'fiscalYear', 'period', 'periodType', 'additive', 'value'], optional: [] };
export const actionRoles: PureFieldRoles = { required: ['subject', 'currency', 'id', 'kind', 'effectiveDate', 'claimStatus', 'effectiveStatus'],
  optional: ['cashPerShare', 'sharesPerShare', 'splitRatio'] };

interface PureOperatorDefinition {
  id: PureOperatorId;
  fields: PureFieldRoles;
  parameterSchema: { type: 'object'; properties: Record<string, { type: string; enum?: string[]; format?: string }>;
    required: string[]; additionalProperties: false };
  parameterDescription: string;
  category: 'financial' | 'adjustment';
  title: string;
  description: string;
  formula: AlgorithmFormulaLine[];
  requiredInputs: string[];
  missingPolicy: string;
  source: string;
  entry: string;
}

const noParameters: PureOperatorDefinition['parameterSchema'] = { type: 'object', properties: {}, required: [], additionalProperties: false };
const financialSource = 'modules/financial/financial-l4-operators.ts';

export const PURE_ALGORITHM_OPERATORS: readonly PureOperatorDefinition[] = [
  {
    id: 'financial_single_quarter', fields: observations, parameterSchema: noParameters, parameterDescription: '无参数。按连续累计期读取。',
    category: 'financial', title: '财务累计转单季',
    description: '同一财年、科目和可比口径的可加性累计值转单季。',
    formula: [{ output: 'value', expression: 'Q1 = Q1_YTD, Q2 = H1 − Q1_YTD, Q3 = Q3_YTD − H1, Q4 = FY − Q3_YTD' }],
    requiredInputs: ['observations'],
    missingPolicy: '从第一季累计到目标期须连续，期间重复、缺值或口径冲突时拒绝。',
    source: financialSource, entry: 'computeFinancialSingleQuarter',
  },
  {
    id: 'financial_ttm', fields: observations, parameterSchema: noParameters, parameterDescription: '无参数。由固定期间组合确定 TTM 公式。',
    category: 'financial', title: '财务滚动十二个月',
    description: '按同一可比口径求四季合计或年度加同期累计差额。',
    formula: [{ output: 'value', expression: 'Σ(连续四单季) 或 FY + current_YTD − prior_same_YTD' }],
    requiredInputs: ['observations'],
    missingPolicy: '四单季必须连续，年度和两期累计须属于相邻财年且累计终点相同。期间或输入缺失时拒绝。',
    source: financialSource, entry: 'computeFinancialTtm',
  },
  {
    id: 'financial_growth', fields: observations, parameterSchema: { type: 'object', required: ['comparison'], additionalProperties: false,
      properties: { comparison: { type: 'string', enum: ['yoy', 'qoq'] }, mode: { type: 'string', enum: ['growth_rate', 'percentage_points'] } } },
    parameterDescription: 'comparison 选 yoy 或 qoq。mode 缺省 growth_rate，可选 percentage_points。增长率的零或负基期保留空值。',
    category: 'financial', title: '财务同比与环比',
    description: '计算可比观测的增长率或两个小数比率的百分点差。',
    formula: [{ output: 'value', expression: '(current − prior) / prior 或 100 × (current − prior)' }],
    requiredInputs: ['current', 'prior', 'comparison'],
    missingPolicy: '缺值、增长率的零或负基期保留空值与原因。',
    source: financialSource, entry: 'computeFinancialGrowth',
  },
  {
    id: 'financial_ratios', fields: { required: [...basis, 'periodRef'], optional: financialRatioFields }, parameterSchema: noParameters,
    parameterDescription: '无参数。输入一行同期间快照，periodDays 为期间天数，capex 为支出绝对额。',
    category: 'financial', title: '财务比率与现金流派生',
    description: '按同一期间、币种及尺度计算比率、杜邦分解、营运资本和现金流。',
    formula: [
      { output: 'grossMargin', expression: '(revenue − costOfRevenue) / revenue' },
      { output: 'netMargin', expression: 'netProfit / revenue' },
      { output: 'roe', expression: 'netProfit / averageEquity' },
      { output: 'roa', expression: 'netProfit / averageAssets' },
      { output: 'assetTurnover', expression: 'revenue / averageAssets' },
      { output: 'equityMultiplier', expression: 'averageAssets / averageEquity' },
      { output: 'dupontRoe', expression: 'netMargin × assetTurnover × equityMultiplier' },
      { output: 'workingCapital', expression: 'currentAssets − currentLiabilities' },
      { output: 'dso', expression: 'periodDays × averageReceivables / revenue' },
      { output: 'dio', expression: 'periodDays × averageInventory / costOfRevenue' },
      { output: 'dpo', expression: 'periodDays × averagePayables / costOfRevenue', note: '以营业成本为分母代理。' },
      { output: 'ccc', expression: 'dso + dio − dpo' },
      { output: 'freeCashFlow', expression: 'cfo − capex', note: 'CAPEX 按支出绝对额传入。' },
      { output: 'earningsQuality', expression: 'cfo / netProfit' },
    ],
    requiredInputs: ['snapshot'],
    missingPolicy: '缺项或零分母只影响依赖该项的结果，保留空值与诊断。',
    source: financialSource, entry: 'computeFinancialRatios',
  },
  {
    id: 'price_adjustment', fields: { required: ['subject', 'currency', 'adjustment', 'frequency', 'date', 'open', 'high', 'low', 'close'], optional: [] },
    parameterSchema: { type: 'object', required: ['direction', 'anchorDate'], additionalProperties: false, properties: {
      direction: { type: 'string', enum: ['forward_qfq', 'backward_hfq'] }, anchorDate: { type: 'string', format: 'date' } } },
    parameterDescription: 'direction 选 forward_qfq 或 backward_hfq，anchorDate 为末日或首日（YYYY-MM-DD）。',
    category: 'adjustment', title: '确定性日线复权',
    description: '用已确认生效的现金分红、送股、转增及拆股生成方向和锚点明确的复权价格。',
    formula: [
      { output: 'adj_factor', expression: '链合理论除权价 / 前收盘的事件因子，按显式锚点归一' },
      { output: 'adjusted', expression: '原价 OHLC × adj_factor' },
    ],
    requiredInputs: ['adjustment', 'frequency', 'bars', 'actions', 'direction', 'anchorDate'],
    missingPolicy: '拒绝未确认生效的公司行动、缺少方向或锚点、以及区间内生效日缺原价。',
    source: 'modules/financial/market-adjustment-contract.ts', entry: 'computeAdjustedMarketSeries',
  },
];

export function pureOperatorDefinition(id: PureOperatorId) {
  return PURE_ALGORITHM_OPERATORS.find(item => item.id === id)!;
}

export function pureOperatorInputContract(operator: PureOperatorDefinition) {
  return { kind: 'fixed_snapshot', referenceKind: 'wfd_fixed_snapshot',
    requiredIdentity: ['snapshotId', 'productId', 'definitionRevision'],
    reference: 'source.reference 指向完整固定产品。fieldMapping 可将下列角色映射到发现的字段，fields 可省略未声明的可选列。默认使用同名字段。',
    inputs: [...operator.requiredInputs], fields: { required: [...operator.fields.required], optional: [...operator.fields.optional] },
    ...(operator.id === 'price_adjustment' ? { actionReference: {
      path: 'source.actionReference', fields: { required: [...actionRoles.required], optional: [...actionRoles.optional] }, scope: '同一快照、实例、主体和币种的独立行动产品。无事件也须完整读取。' } } : {}),
    history: 'reference.perspective 默认 snapshot_contents。历史计算须给 reference.at 与相符的 usage.purpose=historical_compute、historyMode、cutoff，以及宿主核实的原用户声明。system_held_at 还须 heldScope、usableStage。行动引用沿用同一历史选择。',
    sourcePolicy: 'wfd_fixed_snapshot_only', publication: PURE_PUBLICATION };
}
