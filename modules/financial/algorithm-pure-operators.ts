import type { AlgorithmFormulaLine } from '../../contracts/algorithm-definition.js';

interface PureOperatorDefinition {
  id: string;
  category: 'financial' | 'adjustment';
  title: string;
  description: string;
  formula: AlgorithmFormulaLine[];
  requiredInputs: string[];
  missingPolicy: string;
  source: string;
  entry: string;
}

const financialSource = 'modules/financial/financial-l4-operators.ts';

export const PURE_ALGORITHM_OPERATORS: readonly PureOperatorDefinition[] = [
  {
    id: 'financial_single_quarter', category: 'financial', title: '财务累计转单季',
    description: '同一财年、科目和可比口径的可加性累计值转单季。',
    formula: [{ output: 'value', expression: 'Q1 = Q1_YTD, Q2 = H1 − Q1_YTD, Q3 = Q3_YTD − H1, Q4 = FY − Q3_YTD' }],
    requiredInputs: ['observations'],
    missingPolicy: '从第一季累计到目标期须连续，期间重复、缺值或口径冲突时拒绝。',
    source: financialSource, entry: 'computeFinancialSingleQuarter',
  },
  {
    id: 'financial_ttm', category: 'financial', title: '财务滚动十二个月',
    description: '按同一可比口径求四季合计或年度加同期累计差额。',
    formula: [{ output: 'value', expression: 'Σ(连续四单季) 或 FY + current_YTD − prior_same_YTD' }],
    requiredInputs: ['observations'],
    missingPolicy: '四单季必须连续，年度和两期累计须属于相邻财年且累计终点相同。期间或输入缺失时拒绝。',
    source: financialSource, entry: 'computeFinancialTtm',
  },
  {
    id: 'financial_growth', category: 'financial', title: '财务同比与环比',
    description: '计算可比观测的增长率或两个小数比率的百分点差。',
    formula: [{ output: 'value', expression: '(current − prior) / prior 或 100 × (current − prior)' }],
    requiredInputs: ['current', 'prior', 'comparison'],
    missingPolicy: '缺值、增长基期为零或未允许带符号基期且基期为负时返回空值并标明原因。',
    source: financialSource, entry: 'computeFinancialGrowth',
  },
  {
    id: 'financial_ratios', category: 'financial', title: '财务比率与现金流派生',
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
    id: 'price_adjustment', category: 'adjustment', title: '确定性日线复权',
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
