import type { FixedCalculationMethodId } from '../../../../contracts/fixed-calculation-contracts';

/**
 * 算法页的展示分类与跨页定位声明。
 *
 * 这里只服务页面查找：不改变 modules/ 的登记分类，不把分类当作采用、输入就绪
 * 或发布状态，也不新增算法。接口返回未列入这里的条目时，统一落到 other 兜底。
 */
export type AlgorithmGroupId =
  | 'operator'
  | 'technical'
  | 'patterns'
  | 'financial'
  | 'valuation'
  | 'risk'
  | 'macro'
  | 'expectations'
  | 'common'
  | 'other';

export interface AlgorithmGroup {
  id: AlgorithmGroupId;
  zh: string;
  en: string;
}

/** 展示顺序沿用本批分类参考；空分类不会渲染。基础算子单列，不与 MA 等指标平级重复。 */
export const ALGORITHM_GROUPS: readonly AlgorithmGroup[] = Object.freeze([
  { id: 'operator', zh: '基础计算算子', en: 'Base operators' },
  { id: 'technical', zh: '基础技术指标', en: 'Technical indicators' },
  { id: 'patterns', zh: '形态与量价', en: 'Patterns and volume' },
  { id: 'financial', zh: '财报与财务指标', en: 'Reports and financial metrics' },
  { id: 'valuation', zh: '基础估值', en: 'Valuation basics' },
  { id: 'risk', zh: '收益与风险统计', en: 'Return and risk statistics' },
  { id: 'macro', zh: '宏观统计', en: 'Macro statistics' },
  { id: 'expectations', zh: '预期相关', en: 'Expectations' },
  { id: 'common', zh: '通用统计与数据处理', en: 'General statistics and data handling' },
]);

export const OTHER_GROUP: AlgorithmGroup = Object.freeze({
  id: 'other',
  zh: '其他登记方法/未分类',
  en: 'Other registered methods / uncategorized',
});

export function algorithmGroup(group: AlgorithmGroupId): AlgorithmGroup {
  return ALGORITHM_GROUPS.find((item) => item.id === group) ?? OTHER_GROUP;
}

/**
 * 25 个基础库条目的单一主分类。与 `modules/financial/algorithm-registry.ts`
 * 的 id 对齐；只决定页面显示，不写入或回传后端。
 */
export const LIBRARY_GROUPS: Readonly<Record<string, AlgorithmGroupId>> = Object.freeze({
  ma: 'technical',
  ema: 'technical',
  macd: 'technical',
  rsi: 'technical',
  adx: 'technical',
  boll: 'technical',
  obv: 'technical',
  ichimoku: 'technical',
  roc: 'technical',
  bullish_engulfing: 'patterns',
  kline_patterns: 'patterns',
  volume_price: 'patterns',
  dupont: 'financial',
  earnings_quality: 'financial',
  cash_conversion_cycle: 'financial',
  financial_models: 'financial',
  dividend_yield: 'valuation',
  convertible_bond: 'valuation',
  volatility: 'risk',
  drawdown: 'risk',
  returns: 'risk',
  earnings_surprise: 'expectations',
  rolling_mean: 'operator',
  historical_percentile: 'common',
  adjustment: 'common',
});

/** 固定计算方法到用途分类的展示映射；实际条目仍以 capabilities() 返回为准。 */
export const FIXED_GROUPS: Readonly<Record<FixedCalculationMethodId, AlgorithmGroupId>> = Object.freeze({
  observation_ma20: 'technical',
  financial_linear: 'financial',
  macro_yoy: 'macro',
});

export type BatchAlgorithmId = 'daily_bar' | 'minute_bar';

export interface BatchAlgorithmEntry {
  id: BatchAlgorithmId;
  zh: string;
  en: string;
  zhDescription: string;
  enDescription: string;
  zhKind: string;
  enKind: string;
  zhPeriod: string;
  enPeriod: string;
}

/**
 * 历史批次均线只保留旧界面和旧回执的只读兼容。
 * 新观测均线属于基础算法目录，必须由 BD AGENTS 人工请求并从 WFD 固定快照取数。
 */
export const BATCH_ALGORITHMS: readonly BatchAlgorithmEntry[] = Object.freeze([
  { id: 'daily_bar', zh: '旧日K批次均线（停用）', en: 'Legacy daily-batch mean (disabled)',
    zhDescription: '历史批次算法配置只读保留。新计算统一从 WFD 正式快照进入基础算法目录，由人工明确发起，不自动发布。',
    enDescription: 'Legacy batch setting is read-only. New calculations use WFD fixed snapshots and an explicit manual request, without automatic publication.',
    zhKind: '历史日K原报', enKind: 'Legacy daily source', zhPeriod: '旧周期仅供历史核对', enPeriod: 'Legacy period for audit only' },
  { id: 'minute_bar', zh: '旧分钟批次均线（停用）', en: 'Legacy minute-batch mean (disabled)',
    zhDescription: '历史批次算法配置只读保留。新计算统一从 WFD 正式快照进入基础算法目录，由人工明确发起，不自动发布。',
    enDescription: 'Legacy batch setting is read-only. New calculations use WFD fixed snapshots and an explicit manual request, without automatic publication.',
    zhKind: '历史分钟K原报', enKind: 'Legacy minute source', zhPeriod: '旧周期仅供历史核对', enPeriod: 'Legacy period for audit only' },
]);

export function batchAlgorithm(id: string): BatchAlgorithmEntry | null {
  return BATCH_ALGORITHMS.find((item) => item.id === id) ?? null;
}


/**
 * 设计登记条目（预计算产品、制度产品、情绪方法）归入现有分类。
 *
 * 只做展示归类：这些条目不是算法定义，不计入算法数量，也不改变任何登记状态。
 * 未列入这里的条目落到 common，避免出现「其他」大杂烩。
 */
export const DESIGN_GROUPS: Readonly<Record<string, AlgorithmGroupId>> = Object.freeze({
  F01: 'financial', F02: 'financial', F03: 'financial', F04: 'financial',
  F05: 'financial', F06: 'financial', F07: 'financial',
  M01: 'common', M02: 'technical', M03: 'common', M04: 'risk',
  V01: 'valuation', V02: 'valuation', V03: 'valuation',
  E01: 'expectations', E02: 'expectations', E03: 'expectations', E04: 'expectations',
  I01: 'macro', I02: 'macro', I03: 'macro', I04: 'macro',
  R01: 'risk', R02: 'risk',
  CN01: 'common', CN02: 'patterns', CN03: 'patterns', CN04: 'patterns', CN05: 'patterns',
  CN06: 'expectations', CN07: 'expectations', CN08: 'expectations', CN09: 'patterns',
  'AS-01': 'patterns', 'AS-02': 'patterns', 'AS-03': 'patterns', 'AS-04': 'patterns',
  'AS-05': 'patterns', 'AS-06': 'patterns', 'AS-07': 'patterns', 'AS-08': 'patterns',
  'AS-09': 'patterns', 'AS-10': 'patterns', 'AS-11': 'patterns', 'AS-12': 'patterns',
  'AS-13': 'patterns', 'AS-14': 'patterns', 'AS-15': 'patterns',
});


/**
 * 设计附录条目（情绪规范、落地批次、外部规则、方法说明）的分类归属。
 *
 * 附录不是独立分区：这些内容同样按现有分类逐条归入，详情保留原文。
 */
export const APPENDIX_GROUPS: Readonly<Record<string, AlgorithmGroupId>> = Object.freeze({
  'SPEC-01': 'patterns', 'SPEC-02': 'patterns', 'SPEC-03': 'patterns', 'SPEC-04': 'patterns',
  'BATCH-0': 'common', 'BATCH-1': 'financial', 'BATCH-2': 'common', 'BATCH-3': 'patterns',
  'BATCH-4': 'risk', 'BATCH-5': 'common',
  'EXT-01': 'common', 'EXT-02': 'patterns', 'EXT-03': 'patterns', 'EXT-04': 'financial',
  'NOTE-01': 'common', 'NOTE-02': 'financial', 'NOTE-03': 'common', 'NOTE-04': 'common',
});


/**
 * 设计条目与算法的对应关系：每条设计登记服务哪些算法。
 *
 * 只做关联展示：算法详情列出服务它的设计条目，设计条目详情列出它服务的算法；
 * 不改变任何一方的状态、验收或发布资格。
 */
export const DESIGN_RELATED: Readonly<Record<string, readonly string[]>> = Object.freeze({
  // 预计算产品
  F01: ['dupont', 'earnings_quality', 'cash_conversion_cycle', 'financial_models'],
  F02: ['dupont', 'earnings_quality'],
  F03: ['dupont', 'earnings_quality'],
  F04: ['dupont'],
  F05: ['cash_conversion_cycle'],
  F06: ['earnings_quality'],
  F07: ['financial_models'],
  M01: ['adjustment'],
  M02: ['ma', 'ema', 'macd', 'rsi', 'boll', 'adx', 'obv', 'roc'],
  M03: ['historical_percentile', 'rolling_mean'],
  M04: ['volatility', 'drawdown', 'returns'],
  V01: ['financial_models'],
  V02: ['historical_percentile'],
  V03: ['dividend_yield', 'convertible_bond'],
  E01: ['earnings_surprise'],
  E02: ['earnings_surprise'],
  E03: ['earnings_surprise'],
  E04: ['earnings_surprise'],
  I04: ['historical_percentile'],
  R01: ['returns', 'volatility', 'drawdown'],
  R02: ['financial_models'],
  // 制度与披露产品
  CN01: ['AS-01'],
  CN02: ['AS-09'],
  CN03: ['AS-09'],
  CN05: ['AS-09'],
  CN08: ['AS-01', 'E01', 'E02'],
  CN09: ['AS-01', 'AS-10'],
  // 情绪方法
  'AS-01': ['SPEC-01', 'SPEC-02'],
  'AS-02': ['SPEC-01', 'SPEC-02'],
  'AS-03': ['SPEC-01', 'SPEC-02'],
  'AS-04': ['SPEC-01', 'SPEC-02', 'SPEC-04'],
  'AS-05': ['SPEC-01'],
  'AS-06': ['SPEC-01'],
  'AS-07': ['SPEC-01'],
  'AS-08': ['SPEC-02'],
  'AS-09': ['SPEC-02'],
  'AS-10': ['SPEC-03'],
  // 附录条目
  'SPEC-01': ['AS-01', 'AS-02', 'AS-03', 'AS-04', 'AS-05'],
  'SPEC-02': ['AS-01', 'AS-02', 'AS-03', 'AS-04', 'AS-08', 'AS-09'],
  'SPEC-03': ['AS-04', 'AS-09', 'AS-10'],
  'SPEC-04': ['AS-04'],
  'BATCH-0': ['ma', 'macd', 'bullish_engulfing'],
  'BATCH-1': ['dupont', 'earnings_quality', 'AS-01', 'AS-02', 'AS-03'],
  'BATCH-2': ['ema', 'rsi', 'adx', 'boll', 'obv', 'roc', 'kline_patterns', 'volume_price',
    'dividend_yield', 'convertible_bond', 'dupont', 'earnings_quality', 'cash_conversion_cycle',
    'financial_models', 'earnings_surprise', 'adjustment'],
  'BATCH-3': ['AS-04', 'AS-08', 'AS-10'],
  'BATCH-4': ['financial_models', 'earnings_surprise'],
  'BATCH-5': ['ma', 'macd', 'bullish_engulfing'],
  'EXT-01': ['AS-01', 'CN01'],
  'EXT-02': ['CN04'],
  'EXT-03': ['CN02', 'AS-09'],
  'EXT-04': ['CN08', 'E01', 'E02'],
  'NOTE-02': ['dupont', 'cash_conversion_cycle', 'earnings_quality', 'financial_models'],
  'NOTE-03': ['dupont', 'cash_conversion_cycle', 'earnings_quality', 'financial_models',
    'convertible_bond', 'volatility', 'drawdown', 'returns', 'ichimoku', 'kline_patterns', 'bullish_engulfing'],
});

export function appendixGroup(id: string): AlgorithmGroupId {
  return APPENDIX_GROUPS[id] ?? 'common';
}

export function designGroup(id: string): AlgorithmGroupId {
  return DESIGN_GROUPS[id] ?? 'common';
}

export function libraryGroup(id: string): AlgorithmGroupId {
  return LIBRARY_GROUPS[id] ?? 'other';
}

export function fixedGroup(id: string): AlgorithmGroupId {
  return FIXED_GROUPS[id as FixedCalculationMethodId] ?? 'other';
}

/** 从一个查找入口跳到原入口时只携带目标位置，不携带表单载荷或执行动作。 */
export type AlgorithmFocusRequest =
  | { kind: 'fixed'; methodId: string }
  | { kind: 'batch'; methodId: BatchAlgorithmId };

export type AlgorithmEntryFocus = AlgorithmFocusRequest & { nonce: number };
