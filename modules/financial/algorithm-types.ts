import type { JsonValue } from '../../contracts/task-contracts.js';
import type { AlgorithmFormulaLine } from '../../contracts/algorithm-definition.js';
import type { EligibilityHistoryMode, FixedObjectEvidence, HoldingTimeEvidence, PublicationTimeEvidence, PurposeEligibilityResult,
  PurposeEvidenceClaim, RestrictionEvidence, RevisionEvidence, WfdDecisionEvidence, WfdHistorySupportEvidence } from '../collection/purpose-eligibility.js';

/** 已登记日线指标及其 WFD 固定输入契约。 */
export const ALGORITHM_CONTRACT_VERSION = 'bd-local-algorithms/1';
export const ALGORITHM_RUNTIME = 'bd.algorithms';
export const ALGORITHM_CALL_ACTION = 'algorithms.calculate';
export const ALGORITHM_INPUT_ADAPTER_VERSION = 'wfd-fixed-snapshot/1';
export type AlgorithmEnvironment = 'local-review' | 'synthetic-test';
export type AlgorithmMethodStatus = 'ready' | 'blocked' | 'unavailable';
export type AlgorithmDateFormats = 'YYYY-MM-DD' | 'YYYY/MM/DD' | 'YYYYMMDD';
export type AlgorithmAdjustment = 'unadjusted' | 'as_stored';

/** 数学含义的唯一登记；不含代码路径、执行器、依赖或实现摘要。更改此契约须核对方法版本。 */
export const MACD_SEMANTICS = Object.freeze({
  version: 'macd/12-26-9-first-valid-v1',
  parameters: Object.freeze({ short_period: 12, long_period: 26, signal_period: 9, init: 'first_valid' }),
  mathematicalDefinition: 'DIFF = EMA12(close) - EMA26(close); DEA = EMA9(DIFF); MACD = 2*(DIFF-DEA)',
  // 正式定义文字独立于目录标题、实现位置和 UI 说明；已发布含义不能随文案重构改变。
  resultSemantics: '固定 12/26/9；短、长 EMA 以所供窗口首条收盘价初始化，DEA 以首条 DIFF=0 初始化；输出 DIFF、DEA、2 倍 MACD 柱值与 ZERO，不补历史或缺失值。',
  initialization: 'short_long_ema_first_supplied_close_dea_zero',
  warmup: 'all_supplied_rows_valid_from_first_seed_not_full_history',
  missingPolicy: 'reject_missing_close_no_fill_no_padding_no_state_continuation',
  inputPolicy: 'fixed_closed_daily_close_explicit_currency_adjustment_timezone',
  outputFields: Object.freeze(['DIFF', 'DEA', 'MACD', 'ZERO'] as const),
  outputUnit: 'same_as_verified_input_close',
});

type ParameterRule = { type: 'integer' | 'number'; minimum: number; maximum: number }
  | { type: 'integer'; const: number }
  | { type: 'string'; const: string }
  | { type: 'string'; enum: string[] };

type ParameterSchema = { type: 'object'; required: string[]; additionalProperties: false;
  properties: Record<string, ParameterRule> };

type OutputDefinition = Omit<AlgorithmFormulaLine, 'output'> & { unit: 'close' | 'volume' | 'ratio' | 'percent' };

interface AlgorithmMethodDefinition {
  kind: 'indicator';
  operation: string;
  version: string;
  title: string;
  description: string;
  source: string;
  reference: string;
  parameterSchema: ParameterSchema;
  requiredFields: readonly ('timestamp' | 'close' | 'volume')[];
  closeDomain: 'positive' | 'finite';
  outputs: Readonly<Record<string, OutputDefinition>>;
  outputFields: readonly string[];
  resultSemantics: string;
  warmup: string;
  limitations: readonly string[];
}

function parameterSchema(properties: Record<string, ParameterRule>, optional: string[] = []): ParameterSchema {
  return { type: 'object', required: Object.keys(properties).filter(key => !optional.includes(key)),
    additionalProperties: false, properties };
}

const period = (minimum: number, maximum: number): ParameterRule => ({ type: 'integer', minimum, maximum });
const firstValid = { type: 'string', const: 'first_valid' } as const;
const closeFields = ['timestamp', 'close'] as const;
const noWarmup = '首行即有效。';
const quantitativeAnalysisReference = (formula: string) =>
  `公式参考 henrylin99/quantitative_analysis@2edbc3eaf799f4d8f42c99fccba3b8fc08554f10 app/services/alpha191_formulas.py:${formula}；按公开数学定义适配，独立 TypeScript 核对，不复制上游服务或存储代码。`;

function indicator(method: Omit<AlgorithmMethodDefinition, 'kind' | 'source' | 'outputFields' | 'requiredFields' | 'closeDomain' | 'limitations'>
  & Partial<Pick<AlgorithmMethodDefinition, 'source' | 'requiredFields' | 'closeDomain' | 'limitations'>>): AlgorithmMethodDefinition {
  return Object.freeze({ kind: 'indicator', source: `plugins/financial/local-compute/assets/indicators.py: ${method.operation}`,
    requiredFields: closeFields, closeDomain: 'positive', limitations: ['仅使用所供观测，缺失输入拒绝计算。'],
    ...method, outputFields: Object.freeze(Object.keys(method.outputs)) });
}

export const ALGORITHM_METHODS = Object.freeze({
  macd: indicator({ operation: 'MACD', version: MACD_SEMANTICS.version,
    title: 'MACD · 固定 12/26/9',
    description: '调用既有 12/26/9 MACD 实现，以所供窗口首条收盘价初始化短、长 EMA 与 DEA；返回 DIFF、DEA、MACD 和 ZERO。',
    source: 'plugins/financial/local-compute/assets/indicators.py: MACD; operators.py: smooth',
    reference: '独立 EMA/DEA 递推核对；首值初始化，不补窗口前历史',
    parameterSchema: parameterSchema({
      short_period: { type: 'integer', const: MACD_SEMANTICS.parameters.short_period },
      long_period: { type: 'integer', const: MACD_SEMANTICS.parameters.long_period },
      signal_period: { type: 'integer', const: MACD_SEMANTICS.parameters.signal_period }, init: firstValid,
    }),
    outputs: {
      DIFF: { expression: 'DIFF_t = EMA(C, 12)_t − EMA(C, 26)_t', unit: 'close' },
      DEA: { expression: 'DEA_t = EMA(DIFF, 9)_t', unit: 'close' },
      MACD: { expression: 'MACD_t = 2 × (DIFF_t − DEA_t)', unit: 'close', note: '固定采用 2 倍柱值。' },
      ZERO: { expression: 'ZERO_t = 0', unit: 'close' },
    },
    resultSemantics: MACD_SEMANTICS.resultSemantics,
    warmup: '可用区间以原计算服务的预热标记为准。窗口首值初始化仅覆盖所供观测。',
    limitations: ['仅按所供连续观测做首值初始化递推；不含窗口之前历史，不能视为完整历史 MACD。', '不接受递推状态续算、不补历史、不自动入库。'],
  }),
  ma: indicator({ operation: 'MA', version: 'ma/sma-v1', title: 'MA · 简单移动平均',
    description: '计算完整日线窗口内收盘价的算术平均。', reference: '独立逐窗口算术平均核对',
    parameterSchema: parameterSchema({ period: period(2, 250) }),
    outputs: { MA: { expression: 'MA_t = sum(C[t−N+1:t]) / N', unit: 'close' } },
    resultSemantics: 'N 为 period，窗口含当日收盘价。', warmup: '前 period−1 行为空，诊断为 insufficient_warmup。',
  }),
  ema: indicator({ operation: 'EMA', version: 'ema/first-valid-v1', title: 'EMA · 指数移动平均',
    description: '以所供窗口首条收盘价为种子计算指数移动平均。', reference: '独立加权递推核对',
    parameterSchema: parameterSchema({ period: period(2, 250), init: firstValid }),
    outputs: { EMA: { expression: 'EMA_t = α × C_t + (1−α) × EMA_(t−1), α = 2/(N+1)', unit: 'close' } },
    resultSemantics: 'N 为 period，首行 EMA 为该行收盘价，后续依序递推。', warmup: noWarmup,
  }),
  rsi: indicator({ operation: 'RSI', version: 'rsi/wilder-v1', title: 'RSI · 相对强弱指标',
    description: '使用 Wilder 平滑计算日线相对强弱指标。', reference: '独立涨跌幅均值及 Wilder 递推核对',
    parameterSchema: parameterSchema({ period: period(2, 100) }),
    outputs: { RSI: { expression: 'RSI_t = 100 × avg_gain / (avg_gain + avg_loss)', unit: 'percent' } },
    resultSemantics: '以首组 period 个相邻收盘价差的平均涨额和平均跌额初始化，此后用 1/period 做 Wilder 平滑。平均涨额及跌额均为零时输出空值并给出诊断，平均跌额为零且平均涨额为正时输出 100。',
    warmup: '前 period 行为空，诊断为 insufficient_warmup。',
  }),
  boll: indicator({ operation: 'BOLL', version: 'boll/population-std-v1', title: 'BOLL · 布林带',
    description: '按完整日线窗口的收盘价均值和总体标准差计算上下轨。', reference: '独立两遍总体方差核对',
    parameterSchema: parameterSchema({ period: period(2, 250), std_dev: { type: 'number', minimum: 0.5, maximum: 5 } }),
    outputs: {
      BOLL_MID: { expression: 'BOLL_MID_t = mean(C[t−N+1:t])', unit: 'close' },
      BOLL_UPPER: { expression: 'BOLL_UPPER_t = BOLL_MID_t + std_dev × σ_t', unit: 'close' },
      BOLL_LOWER: { expression: 'BOLL_LOWER_t = BOLL_MID_t − std_dev × σ_t', unit: 'close' },
    },
    resultSemantics: 'N 为 period，σ_t 为完整 N 条窗口的总体标准差，方差分母为 N。',
    warmup: '前 period−1 行三列均为空，诊断为 insufficient_warmup。',
  }),
  roc: indicator({ operation: 'ROC', version: 'roc/pct-v1', title: 'ROC · 价格变化率',
    description: '计算收盘价相对 period 个观测前的百分比变化。', reference: '独立固定滞后比值核对',
    parameterSchema: parameterSchema({ period: period(1, 250) }), closeDomain: 'finite',
    outputs: { ROC: { expression: 'ROC_t = 100 × (C_t − C_(t−N)) / C_(t−N)', unit: 'percent' } },
    resultSemantics: 'N 为 period，比较的是观测位置。分母为零时输出空值并给出诊断。',
    warmup: '前 period 行为空，诊断为 insufficient_warmup。',
  }),
  obv: indicator({ operation: 'OBV', version: 'obv/signed-volume-v1', title: 'OBV · 能量潮',
    description: '按收盘价涨跌方向累加已声明单位的成交量。', reference: '独立逐日成交量累加核对',
    parameterSchema: parameterSchema({}), requiredFields: ['timestamp', 'close', 'volume'],
    outputs: { OBV: { expression: 'OBV_t = OBV_(t−1) + sign(C_t − C_(t−1)) × volume_t', unit: 'volume' } },
    resultSemantics: '窗口首行 OBV 为 0。上涨加成交量，下跌减成交量，平盘维持前值。使用 WFD 固定字段定义核对的 volumeUnit，不换算单位。',
    warmup: noWarmup,
  }),
  returns: indicator({ operation: 'RETURNS', version: 'returns/simple-log-v1', title: 'RETURNS · 收益率',
    description: '按明确模式计算简单收益或自然对数收益。', reference: '独立固定滞后收益核对',
    parameterSchema: parameterSchema({ period: period(1, 250), mode: { type: 'string', enum: ['simple', 'log'] } }), closeDomain: 'finite',
    outputs: { RETURN: { expression: 'simple: (C_t − C_(t−N))/C_(t−N); log: ln(C_t) − ln(C_(t−N))', unit: 'ratio' } },
    resultSemantics: 'N 为 period。简单收益分母为零，或对数收益任一价格非正时输出空值并给出诊断。',
    warmup: '前 period 行为空，诊断为 insufficient_warmup。',
  }),
  volatility: indicator({ operation: 'VOLATILITY', version: 'volatility/sample-std-v1', title: 'VOLATILITY · 波动率',
    description: '计算简单日收益的滚动样本标准差，可显式指定年化因子。', reference: '独立收益窗口及两遍样本方差核对',
    parameterSchema: parameterSchema({ period: period(2, 250), annualization_factor: period(1, 366) }, ['annualization_factor']),
    closeDomain: 'finite',
    outputs: { VOLATILITY: { expression: 'VOLATILITY_t = sqrt(sum((r_i−mean(r))²)/(N−1)) × scale', unit: 'ratio' } },
    resultSemantics: '窗口须含 period 个连续简单日收益，含零分母的窗口为空并给出诊断。仅显式传入 annualization_factor 时乘以该因子的平方根，缺省为日波动率。',
    warmup: '前 period 行为空，诊断为 insufficient_warmup。',
  }),
  max_drawdown: indicator({ operation: 'MAX_DRAWDOWN', version: 'max_drawdown/window-v1', title: 'MAX_DRAWDOWN · 最大回撤',
    description: '计算窗口内按时间先峰后谷的最大跌幅，并报告窗口最高收盘价。', reference: '独立从后向前搜索峰谷核对',
    parameterSchema: parameterSchema({ period: period(2, 250) }, ['period']),
    outputs: {
      MAX_DRAWDOWN: { expression: 'MAX_DRAWDOWN_t = min(C_j/C_i − 1), i ≤ j 且两点均在窗口内', unit: 'ratio' },
      PEAK_CLOSE: { expression: 'PEAK_CLOSE_t = max(C_i), i 在窗口内', unit: 'close' },
    },
    resultSemantics: '缺省使用从首条观测至当日的累计窗口。显式 period 使用含当日的完整滚动窗口。最大回撤值小于或等于零，窗口最高收盘价可能出现在造成最大回撤的谷值之后。',
    warmup: '累计模式首行即有效。滚动模式前 period−1 行为空，诊断为 insufficient_warmup。',
  }),
  alpha191_014: indicator({ operation: 'ALPHA191_014', version: 'alpha191-014/close-delta-5-v1',
    title: 'Alpha191 014 · 五期绝对动量', description: '计算收盘价相对五个观测前的绝对价差。',
    reference: quantitativeAnalysisReference('alpha_014'), parameterSchema: parameterSchema({}),
    outputs: { ALPHA191_014: { expression: 'ALPHA191_014_t = C_t − C_(t−5)', unit: 'close' } },
    resultSemantics: '固定五个观测的价差，保持已核定收盘价单位；不是百分比收益。',
    warmup: '前 5 行为空，诊断为 insufficient_warmup。',
  }),
  alpha191_031: indicator({ operation: 'ALPHA191_031', version: 'alpha191-031/mean-bias-12-v1',
    title: 'Alpha191 031 · 十二期均值乖离', description: '计算当日收盘价相对十二期简单均值的百分比偏离。',
    reference: quantitativeAnalysisReference('alpha_031'), parameterSchema: parameterSchema({}),
    outputs: { ALPHA191_031: { expression: 'ALPHA191_031_t = 100 × (C_t − mean(C[t−11:t])) / mean(C[t−11:t])', unit: 'percent' } },
    resultSemantics: '固定十二条完整收盘观测，含当日；百分比数值 1 表示 1%。',
    warmup: '前 11 行为空，诊断为 insufficient_warmup。',
  }),
  alpha191_116: indicator({ operation: 'ALPHA191_116', version: 'alpha191-116/ols-slope-20-v1',
    title: 'Alpha191 116 · 二十期趋势斜率', description: '将二十期收盘价对等间隔观测序号做含截距线性回归，返回斜率。',
    reference: quantitativeAnalysisReference('alpha_116'), parameterSchema: parameterSchema({}),
    outputs: { ALPHA191_116: { expression: 'ALPHA191_116_t = sum((i−10.5) × C_(t−20+i), i=1..20) / 665',
      unit: 'close', note: '观测序号是无量纲计数，数值表示每观测步的价格变化；不是按自然日或年化斜率。' } },
    resultSemantics: '固定二十条完整收盘观测，回归含截距。横轴为观测序号 1..20，不填补未供交易日。',
    warmup: '前 19 行为空，诊断为 insufficient_warmup。',
  }),
  alpha191_168: indicator({ operation: 'ALPHA191_168', version: 'alpha191-168/negative-relative-volume-20-v1',
    title: 'Alpha191 168 · 负相对成交量', description: '计算当日成交量与二十期均量之比的相反数。',
    reference: quantitativeAnalysisReference('alpha_168'), parameterSchema: parameterSchema({}),
    requiredFields: ['timestamp', 'close', 'volume'],
    outputs: { ALPHA191_168: { expression: 'ALPHA191_168_t = −volume_t / mean(volume[t−19:t])', unit: 'ratio' } },
    resultSemantics: '固定二十条完整成交量观测，同一已核定 volumeUnit 相除后无量纲。全窗口成交量为零时输出空值并诊断，单条零成交量保持零。',
    warmup: '前 19 行为空，诊断为 insufficient_warmup。',
  }),
  alpha191_189: indicator({ operation: 'ALPHA191_189', version: 'alpha191-189/nested-absolute-deviation-6-v1',
    title: 'Alpha191 189 · 双层绝对偏离', description: '先取收盘价与其六期均值的绝对偏离，再计算偏离的六期均值。',
    reference: quantitativeAnalysisReference('alpha_189'), parameterSchema: parameterSchema({}),
    outputs: { ALPHA191_189: { expression: 'D_t = abs(C_t − mean(C[t−5:t])); ALPHA191_189_t = mean(D[t−5:t])', unit: 'close' } },
    resultSemantics: '两层均为完整六条窗口，需十一条收盘价才有首个结果。每个偏离使用其自身时点的均值，不使用最终窗口均值回填。',
    warmup: '前 10 行为空，诊断为 insufficient_warmup。',
  }),
});

export type AlgorithmMethodId = keyof typeof ALGORITHM_METHODS;
export const ALGORITHM_METHOD_IDS = Object.freeze(Object.keys(ALGORITHM_METHODS) as AlgorithmMethodId[]);

export const PURE_OPERATOR_IDS = Object.freeze(['financial_single_quarter', 'financial_ttm', 'financial_growth',
  'financial_ratios', 'price_adjustment'] as const);
export type PureOperatorId = typeof PURE_OPERATOR_IDS[number];
export function isPureOperatorId(value: unknown): value is PureOperatorId {
  return PURE_OPERATOR_IDS.some(id => id === value);
}

export function isAlgorithmMethodId(value: unknown): value is AlgorithmMethodId {
  return typeof value === 'string' && Object.hasOwn(ALGORITHM_METHODS, value);
}

/** 参数目录、宿主准入及 Python 白名单使用同一份约束。 */
export function invalidAlgorithmParameter(methodId: AlgorithmMethodId, value: unknown): string | null {
  const { required, properties } = ALGORITHM_METHODS[methodId].parameterSchema;
  if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return 'parameters';
  const params = value as Record<string, unknown>;
  const missing = required.find(key => !Object.hasOwn(params, key));
  if (missing !== undefined) return missing;
  for (const [key, parameter] of Object.entries(params)) {
    if (!Object.hasOwn(properties, key)) return key;
    const rule = properties[key]!;
    if ('const' in rule) {
      if (parameter !== rule.const) return key;
    } else if ('enum' in rule) {
      if (typeof parameter !== 'string' || !rule.enum.includes(parameter)) return key;
    } else if (typeof parameter !== 'number' || !Number.isFinite(parameter)
      || (rule.type === 'integer' && !Number.isInteger(parameter)) || parameter < rule.minimum || parameter > rule.maximum) {
      return key;
    }
  }
  return null;
}

export interface AlgorithmFieldMapping {
  timestamp: string;
  close: string;
  open?: string;
  high?: string;
  low?: string;
  volume?: string;
  available_at?: string;
}

export interface AlgorithmSemantics {
  /** 用户明确填写的标的或序列名称；不从文件名推断证券身份。 */
  subject: string;
  frequency: '1d';
  timezone: string;
  priceUnit: 'currency_per_share';
  currency: string;
  /** 必须与映射成交量列的 WFD 固定字段定义一致。 */
  volumeUnit?: string;
  adjustment: AlgorithmAdjustment;
  adjustmentBasis: string;
  barClosed: true;
  /** 全部所供观测均为已生成/合成测试数据时必须显式声明。 */
  synthetic: boolean;
  /** 逐行可得时刻，或用户明确声明的收盘后可得时刻；未提供即拒绝。 */
  availability: { kind: 'column' } | { kind: 'bar_close'; closeTime: string };
}

export type AlgorithmCalendar =
  | { mode: 'dense' }
  | { mode: 'declared'; expectedDates: string[] }
  | { mode: 'not_verified'; note: string };

export interface AlgorithmManagedTableSource {
  kind: 'managed_table';
  materialId: string;
  materialSha256: string;
  format: 'csv' | 'json';
  fieldMapping: AlgorithmFieldMapping;
  dateFormat?: AlgorithmDateFormats;
  semantics: AlgorithmSemantics;
  calendar: AlgorithmCalendar;
  /** 可选明确切片；缺省表示用户显式选择的整张受管表。 */
  range?: { start: string; end: string };
}

/**
 * 真实 WFD `wfd.data-service/v1` 固定快照引用。
 *
 * 只固定实际 `data.read` 能核对的实例、产品、具体快照与定义修订；不出现旧
 * `outputIdentity/unitId/schemaRevision` 假字段。分页由端口按 `next_cursor` 读取并校验
 * `rows_sha256`、`row_count`、字段集与提交身份，不能使用 latest 或隐式扩围。
 */
export interface AlgorithmSnapshotReference {
  kind: 'wfd_fixed_snapshot';
  instanceId: string;
  productId: string;
  snapshotId: string;
  definitionRevision: string;
  /** 实际 data.read 请求字段；必须覆盖 fieldMapping 与 availability 所需列。 */
  fields: string[];
  fieldMapping: AlgorithmFieldMapping;
  dateFormat?: AlgorithmDateFormats;
  semantics: AlgorithmSemantics;
  calendar: AlgorithmCalendar;
  range?: { start: string; end: string };
  /** 历史请求必须显式指定的现有 WFD 视角与实际截止；缺省只读快照内容。 */
  perspective?: EligibilityHistoryMode;
  at?: string;
  includeHistory?: boolean;
  /** system_held_at 必须显式固定的实例持有范围与可用阶段。 */
  heldScope?: string;
  usableStage?: 'acquired' | 'custodied' | 'published_readable';
  /** 可选现场核对摘要；实际页仍逐页核对并在封闭输入中记录解析后的真实摘要。 */
  expectedRowsSha256?: string;
  expectedRowCount?: number;
  expectedDefinitionSha256?: string;
  contractDigest?: string;
}

export interface AlgorithmFixedSnapshotSource {
  kind: 'fixed_snapshot';
  reference: AlgorithmSnapshotReference;
}

export type AlgorithmSource = AlgorithmManagedTableSource | AlgorithmFixedSnapshotSource;

export type AlgorithmParametersByMethod = {
  macd: typeof MACD_SEMANTICS.parameters;
  ma: { period: number };
  ema: { period: number; init: 'first_valid' };
  rsi: { period: number };
  boll: { period: number; std_dev: number };
  roc: { period: number };
  obv: Record<string, never>;
  returns: { period: number; mode: 'simple' | 'log' };
  volatility: { period: number; annualization_factor?: number };
  max_drawdown: { period?: number };
  alpha191_014: Record<string, never>;
  alpha191_031: Record<string, never>;
  alpha191_116: Record<string, never>;
  alpha191_168: Record<string, never>;
  alpha191_189: Record<string, never>;
};

export interface AlgorithmUsage {
  /** 只接受本机算法当前内容或历史计算两类；发布资格不属于本算法入口。 */
  purpose: 'current_compute' | 'historical_compute';
  /** 历史计算必须显式选择现有 WFD 历史模式并固定截止；当前计算保持 null。 */
  historyMode: EligibilityHistoryMode | null;
  cutoff: string | null;
  perspective: string | null;
  /** 由受信提交上下文写入，不接受请求正文自报。 */
  purposeEvidence?: PurposeEvidenceClaim[];
}

/** 真实提交来源：HTTP 操作者或受信会话宿主核对过的用户消息；模型不能自报。 */
export type AlgorithmSubmissionContext =
  | { authority: 'operator-http'; requestId: string; observedAtUtc: string }
  | { authority: 'user-message'; messageId: string; quote: string; observedAtUtc: string };

export type AlgorithmCallRequest = {
  [Id in AlgorithmMethodId]: { methodId: Id; parameters: AlgorithmParametersByMethod[Id] };
}[AlgorithmMethodId] & {
  source: AlgorithmSource;
  /** 缺省保持原有当前内容计算能力，不自动提升历史资格。 */
  usage?: AlgorithmUsage;
};

export interface AlgorithmMetadata {
  series_id: string;
  subject: string;
  frequency: '1d';
  timezone: string;
  price_unit: 'currency_per_share';
  currency: string;
  volume_unit?: string;
  adjustment: AlgorithmAdjustment;
  adjustment_basis: string;
  window_start: string;
  window_end: string;
  as_of: string;
  availability_basis: 'explicit_per_bar' | 'declared_bar_close';
  bar_closed: true;
  /** 只表示所供序列自身连续；不把未核对的交易日历说成完整。 */
  observations_are_consecutive: true;
  calendar_verification: 'dense' | 'declared' | 'not_verified';
  synthetic: boolean;
}

export interface AlgorithmBar {
  timestamp: string;
  close: number;
  open?: number;
  high?: number;
  low?: number;
  volume?: number;
  available_at: string;
  bar_closed: true;
}

export interface AlgorithmData { metadata: AlgorithmMetadata; rows: AlgorithmBar[] }

export interface AlgorithmSnapshotRead {
  /** 受信宿主实际核对的连接身份摘要，不接受调用者声明。 */
  connectionIdentityDigest?: string;
  /** 必须与请求逐字段相同；不接受 latest 或扩围。 */
  reference: AlgorithmSnapshotReference;
  /** data.read 返回的 JSON 行；由算法服务按显式字段映射与语义转成封闭输入。 */
  rows: Record<string, JsonValue>[];
  /**
   * 产品/快照/定义/分页/摘要解析证据；不含重复行。`rowsSha256` 始终是服务端完整行资源摘要，
   * `projection.sha256` 才是本地对选定字段的重算结果，二者不可互相冒充。
   */
  resolution: JsonValue;
  /**
   * 本次读取实际完成的验证范围：仅当请求字段覆盖全部声明字段时才在本地重算完整行资源，
   * 否则只核对服务端身份/descriptor 并单独证明本地投影摘要。
   */
  verifiedScope: 'server_identity_descriptor_and_projection' | 'server_identity_descriptor_and_full_rows';
  /** 逐行实际 WFD 资格/公开时间/修订/限制证据；与 rows 同序，供共用规则消费。 */
  evidence?: AlgorithmSnapshotRowEvidence[];
}

export interface AlgorithmSnapshotRowEvidence {
  object: FixedObjectEvidence;
  publicationTime: PublicationTimeEvidence;
  holdingTime: HoldingTimeEvidence | null;
  revision: RevisionEvidence | null;
  wfdHistory: WfdHistorySupportEvidence;
  restriction: RestrictionEvidence;
  wfdDecision: WfdDecisionEvidence | null;
}

/** 真实 `wfd.data-service/v1` 固定快照只读端口。 */
export interface AlgorithmSnapshotPort {
  status(): { status: 'available' | 'unavailable'; reason: string | null };
  read(reference: AlgorithmSnapshotReference, context: { signal: AbortSignal; taskId?: string }): Promise<AlgorithmSnapshotRead>;
}

export const ALGORITHM_NULL_STATES = Object.freeze({
  insufficient_warmup: 'insufficient_warmup',
  zero_denominator: 'not_applicable',
  undefined_zero_denominator: 'not_applicable',
  undefined_flat_rsi: 'not_applicable',
  undefined_nonpositive_log_price: 'not_applicable',
} as const);
export type AlgorithmDiagnosticReason = keyof typeof ALGORITHM_NULL_STATES;
export interface AlgorithmInvalidInterval { start: string; end: string; reason: 'insufficient_history' | AlgorithmDiagnosticReason; count: number }
export interface AlgorithmGap { code: string; message: string; scope?: string }

export interface AlgorithmResultRow { timestamp: string; available_at: string; [field: string]: JsonValue }

export interface AlgorithmComputedResult {
  status: 'computed';
  persistence: 'not_requested';
  publication: { state: 'not_requested'; performed: false };
  environment: AlgorithmEnvironment;
  taskId: string;
  methodId: AlgorithmMethodId;
  /** 已核定数学定义版本，不由实现文件摘要派生。 */
  methodVersion: string;
  contractVersion: string;
  /** 原任务实际执行资产摘要，只作执行与结果证据，不能成为正式定义身份。 */
  implementationVersion: string;
  parameters: JsonValue;
  metadata: AlgorithmMetadata;
  source: JsonValue;
  inputDigest: string;
  rows: AlgorithmResultRow[];
  validInterval: { start: string; end: string } | null;
  invalidIntervals: AlgorithmInvalidInterval[];
  coverage: { suppliedRows: number; validRows: number; leadingInvalidRows: number; windowStart: string; windowEnd: string };
  diagnostics: JsonValue[];
  gaps: AlgorithmGap[];
  method: JsonValue;
  limitations: string[];
  /** 使用边界实际执行的共用用途资格：输入冻结后、结果形成后分别保留。 */
  eligibility: { input: PurposeEligibilityResult; result: PurposeEligibilityResult } | null;
  /** 实际执行完成时间；历史回放不得倒填为截止前已存在。 */
  computedAt: string;
  externalActionExecuted: false;
}

export interface AlgorithmMethodView {
  id: AlgorithmMethodId;
  title: string;
  description: string;
  status: AlgorithmMethodStatus;
  reason: string | null;
  methodVersion: string;
  implementationVersion: string;
  parameters: JsonValue;
  requiredFields: string[];
  outputFields: string[];
  limitations: string[];
  methodEvidence: JsonValue;
}

export interface AlgorithmAdoptionRecord {
  version: 1;
  environment: AlgorithmEnvironment;
  assetsVersion: string;
  codeVersion: string;
  codeFiles: Record<string, string>;
  fileHashes: Record<string, string>;
  pythonDigest: string;
  assetsRoot: string;
  adoptedAt: string;
}
export interface AlgorithmAdoptionView {
  state: 'adopted' | 'not_adopted' | 'stale';
  reason: string | null;
  current: { environment: AlgorithmEnvironment; assetsVersion: string; codeVersion: string; pythonDigest: string };
  record: AlgorithmAdoptionRecord | null;
  required: { environment: 'local-review'; expectedAssetsVersion: string; expectedCodeVersion: string; confirmation: 'adopt-local-review' };
}

export interface AlgorithmCatalogView {
  contractVersion: string;
  runtime: string;
  environment: AlgorithmEnvironment;
  status: 'available' | 'unavailable';
  enabled: boolean;
  reason: string | null;
  adoption: AlgorithmAdoptionView;
  implementation: { version: string; files: Record<string, string>; codeVersion: string; codeFiles: Record<string, string>;
    binding: 'source-code'; bindingRequired: false };
  execution: { pythonDigest: string | null; permission: 'granted' | 'approval_required' | 'unavailable'; reason: string | null };
  methods: AlgorithmMethodView[];
  inputs: {
    managedTables: { status: 'unavailable'; reason: string | null; items: [] };
    fixedSnapshots: { status: 'available' | 'unavailable'; reason: string | null; contract: JsonValue };
  };
  limitations: string[];
}

export interface AlgorithmTaskError { code: string; message: string }
export interface AlgorithmTaskView {
  taskId: string;
  requestId: string;
  methodId: AlgorithmMethodId;
  status: string;
  taskVersion: number;
  requiresReview: boolean;
  createdAt: string;
  updatedAt: string;
  result: AlgorithmComputedResult | null;
  error: AlgorithmTaskError | null;
  publication: { state: 'not_requested' };
  guidance: string | null;
}
