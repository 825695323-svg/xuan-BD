import type { ToolLibraryState, ToolLibraryTool } from '../../contracts/tool-library.js';

/**
 * 基础算法登记清单（`basic-algorithms/registry-r1`）。
 *
 * 这份清单只登记"有哪些算法、现在到哪一步、还缺什么"，不启用任何计算。
 * 判定依据是三类实际证据，缺一类都不能把某项说成可算：
 * 1. 本工程计算资产内是否已有实现（`plugins/financial/local-compute/assets/`）；
 * 2. 受控执行入口是否放行该操作（`assets.ts` 的 `ASSET_FILES` 与 `PYTHON_BRIDGE` 白名单）；
 * 3. 该方法的输入数据本批是否存在（首批仅 `1min` 与 `每日日线` 两套行情原包）。
 *
 * 方法来源只记位置与口径，不表示已获数据授权、已通过数值验证或已可发布。
 */
export const ALGORITHM_REGISTRY_VERSION = 'basic-algorithms/registry-r1';
export const ALGORITHM_REGISTRY_REGISTERED_AT = '2026-10-24';
export const ALGORITHM_REGISTRY_NOTE = '登记不等于启用。executable 才是受控入口已放行的方法；其余项登记存在性与缺失项，提交计算会被明确拒绝。方法来源为外部资料包时，本工程没有移植其实现，也没有执行验证。';

const ASSET = 'plugins/financial/local-compute/assets';
const PACK_A = '基础因子与Alpha资料包';
const PACK_B = '技能与专家';

/** 本工程受控入口实际放行的操作；与 `algorithm-types.ts` 的 `ALGORITHM_METHOD_IDS` 一致。 */
export const EXECUTABLE_TOOL_IDS = ['ma', 'macd', 'bullish_engulfing'] as const;

function tool(entry: ToolLibraryTool): ToolLibraryTool { return entry; }

export const ALGORITHM_REGISTRY: ToolLibraryTool[] = [
  tool({
    id: 'ma', title: 'MA · 算术移动均线', category: 'market', state: 'executable', status: 'ready', reason: null,
    description: '按明确提供的有序日线收盘观测计算均线；前置记录不足的行保留为空。',
    parameters: [{ key: 'period', label: '观测周期', defaultValue: 5, min: 1, max: 10000 }],
    outputFields: ['MA'], requiredInputs: ['timestamp', 'close'],
    sources: [`本工程 ${ASSET}/indicators.py: MA（受控入口已放行）`, `${PACK_A}/sources/ta_lib/ta_SMA.c: TA_SMA`, `${PACK_A}/sources/alpha/ta_cn/wq/time_series.py: ts_mean`, `${PACK_B}/技能/标的诊断/本地技术面分析/scripts/analyze.mjs: sma`],
    missing: [],
    limitations: ['周期按已提供的有序观测计数，不证明完整交易日覆盖。', '当前受控入口最多接收 512 条日线观测；不补历史、不做复权，结果不自动入库。'] }),
  tool({
    id: 'ema', title: 'EMA · 指数移动平均', category: 'market', state: 'assets_only', status: 'blocked',
    reason: '实现已在计算资产内，但受控执行入口未放行 EMA：白名单仅含 MA、MACD、bullish_engulfing。',
    description: '按 alpha=2/(period+1) 递推的指数平滑均线；可显式给首值种子或上期状态。',
    parameters: [{ key: 'period', label: '平滑周期', defaultValue: 12, min: 1, max: 10000 }],
    outputFields: ['EMA'], requiredInputs: ['timestamp', 'close'],
    sources: [`本工程 ${ASSET}/indicators.py: EMA`, `${PACK_A}/sources/ta_lib/ta_EMA.c: TA_EMA / TA_S_EMA`, `${PACK_A}/sources/alpha/ta_cn/ema.py: EMA_0_TA`, `${PACK_B}/技能/标的诊断/本地技术面分析/scripts/analyze.mjs: ema`],
    missing: ['受控入口未放行：ASSET_FILES 与 PYTHON_BRIDGE 白名单只含 3 个操作', '未做独立数值预期验证', '未写入算法采用记录（adoption）'],
    limitations: ['首值初始化与续算状态是两种口径，调用时必须显式声明其中一种。', '未放行前不构成可调用能力。'] }),
  tool({
    id: 'macd', title: 'MACD · 指数平滑异同移动平均线', category: 'market', state: 'executable', status: 'ready', reason: null,
    description: '固定 12/26/9 参数，从已提供窗口首条收盘价初始化，计算差值线、平滑线和柱值。',
    parameters: [{ key: 'short_period', label: '短周期', defaultValue: 12, min: 12, max: 12 }, { key: 'long_period', label: '长周期', defaultValue: 26, min: 26, max: 26 },
      { key: 'signal_period', label: '信号周期', defaultValue: 9, min: 9, max: 9 }],
    outputFields: ['DIFF', 'DEA', 'MACD', 'ZERO'], requiredInputs: ['timestamp', 'close'],
    sources: [`本工程 ${ASSET}/indicators.py: MACD（受控入口已放行）`, `${PACK_A}/sources/ta_lib/ta_MACD.c: TA_MACD`, `${PACK_A}/sources/alpha/ta_cn/tdx/trend.py: MACD`, `${PACK_B}/技能/交易分析/K线沙盘推演/scripts/sandbox-calc.mjs`],
    missing: ['柱值系数口径未统一：本工程用 2×(DIFF−DEA)，TA-Lib 与部分资料包模板用 1×(DIFF−DEA)；对外引用前须固定其中一种'],
    limitations: ['仅按所供连续观测首条初始化，不等同包含长期历史的连续 MACD。', '不接受续算状态或扩窗补历史；结果不自动入库。'] }),
  tool({
    id: 'bullish_engulfing', title: '严格看涨吞没', category: 'market', state: 'executable', status: 'ready', reason: null,
    description: '前一条为阴线、当前为阳线，当前实体严格包住前一条实体；缺少前一条观测时返回空值。',
    parameters: [], outputFields: ['bullish_engulfing'], requiredInputs: ['timestamp', 'open', 'close'],
    sources: [`本工程 ${ASSET}/patterns.py: bullish_engulfing（受控入口已放行）`, `${PACK_A}/sources/alpha/ta_cn/candle.py: REALBODY / UPPERBODY / LOWERBODY`, `${PACK_B}/技能/标的诊断/蜡烛图信号扫描/scripts/candlestick-calc.mjs`],
    missing: [],
    limitations: ['仅判断明确提供的相邻日线开盘价和收盘价，不补历史。', '形态真假不构成交易建议；结果不自动入库。'] }),
  tool({
    id: 'rsi', title: 'RSI · 相对强弱指标', category: 'market', state: 'assets_only', status: 'blocked',
    reason: '实现已在计算资产内，但受控执行入口未放行 RSI。',
    description: '按 SMA(N,1)（即 RMA）平滑涨跌幅计算多条 RSI；缺首条前收盘时先输出空值。',
    parameters: [{ key: 'period', label: '主周期', defaultValue: 6, min: 2, max: 10000 }],
    outputFields: ['RSI1', 'RSI2', 'RSI3', 'LOWER', 'UPPER'], requiredInputs: ['timestamp', 'close', 'previous_close（可选）'],
    sources: [`本工程 ${ASSET}/indicators.py: RSI`, `${PACK_A}/sources/ta_lib/ta_RSI.c: TA_RSI`, `${PACK_A}/sources/alpha/ta_cn/tdx/over_bought_over_sold.py: RSI`, `${PACK_B}/技能/标的诊断/本地技术面分析/scripts/analyze.mjs: rsi（Wilder、默认 14）`],
    missing: ['受控入口未放行', '周期口径未统一：本工程默认 6/12/24，资料包B 用 Wilder 14 与 30/70 阈值', '未做独立数值预期验证'],
    limitations: ['连续平盘不填 50；负分母输出空值。', '两条来源的周期与阈值不可混用。'] }),
  tool({
    id: 'adx', title: 'ADX / DMI · 趋向指标', category: 'market', state: 'assets_only', status: 'blocked',
    reason: '实现已在计算资产内（DMI 输出 ADX 与 ADXR），但受控执行入口未放行。',
    description: '由 +DM/−DM 与真实波幅求和得到 DI1/DI2，再平滑出 ADX 与 ADXR；前后高、低、收盘成组提供。',
    parameters: [{ key: 'period', label: '周期', defaultValue: 14, min: 2, max: 10000 }, { key: 'average_period', label: 'ADX 平滑周期', defaultValue: 6, min: 2, max: 10000 }],
    outputFields: ['DI1', 'DI2', 'ADX', 'ADXR'], requiredInputs: ['timestamp', 'high', 'low', 'close', 'previous_close／previous_high／previous_low（三件成组）'],
    sources: [`本工程 ${ASSET}/indicators.py: DMI`, `${PACK_B}/技能/标的诊断/本地技术面分析/scripts/analyze.mjs: adx（Wilder 全链路）`],
    missing: ['受控入口未放行', '未做独立数值预期验证', '资料包A 无 ta_ADX.c，只有对已安装 TA-Lib 的调用绑定，不能作为实现来源'],
    limitations: ['HD 与 LD 相等时两边贡献都为 0。', '前值必须与当前数据同单位、同复权依据且紧邻上一条观测。'] }),
  tool({
    id: 'boll', title: 'BOLL · 布林带', category: 'market', state: 'assets_only', status: 'blocked',
    reason: '实现已在计算资产内，但受控执行入口未放行 BOLL。',
    description: '中轨为 MA(close,N)，上下轨为中轨加减 width 倍标准差；自由度修正必须显式声明。',
    parameters: [{ key: 'period', label: '中轨周期', defaultValue: 20, min: 2, max: 10000 }, { key: 'width', label: '标准差倍数', defaultValue: 2, min: 1, max: 10 }],
    outputFields: ['MID', 'UPPER', 'LOWER'], requiredInputs: ['timestamp', 'close', 'ddof（必填）'],
    sources: [`本工程 ${ASSET}/indicators.py: BOLL`, `${PACK_A}/sources/ta_lib/ta_BBANDS.c: TA_BBANDS`, `${PACK_B}/技能/标的诊断/本地技术面分析/scripts/analyze.mjs: rollStd（样本标准差，除 n−1）`],
    missing: ['受控入口未放行', 'ddof 口径未统一：本工程要求显式 0/1，资料包B 固定样本标准差', '未做独立数值预期验证'],
    limitations: ['不宣称任何外部程序的默认自由度。', '宽度参数不改变中轨。'] }),
  tool({
    id: 'obv', title: 'OBV · 能量潮', category: 'market', state: 'assets_only', status: 'blocked',
    reason: '实现已在计算资产内，但受控执行入口未放行 OBV；且分钟量额单位尚未确认。',
    description: '按收盘涨跌方向累计成交量，起点与初值必须显式给出。',
    parameters: [{ key: 'average_period', label: '均线周期', defaultValue: 30, min: 1, max: 10000 }],
    outputFields: ['OBV', 'MAOBV'], requiredInputs: ['timestamp', 'close', 'volume', 'volume_unit', 'start', 'initial_obv'],
    sources: [`本工程 ${ASSET}/indicators.py: OBV`, `${PACK_A}/sources/ta_lib/ta_OBV.c: TA_OBV`, `${PACK_A}/sources/alpha/ta_cn/tdx/volume.py: OBV`, `${PACK_B}/技能/标的诊断/本地技术面分析/scripts/analyze.mjs: obv（首值 0）`],
    missing: ['受控入口未放行', '分钟成交量与成交额单位未标（首批登记 F08），累计量无法定单位', '未做独立数值预期验证'],
    limitations: ['输出单位为量单位/10000，不等于未缩放原始量。', '不同起点产生不同绝对值，不能把窗口累计当全历史累计。'] }),
  tool({
    id: 'kline_patterns', title: '蜡烛图形态族', category: 'market', state: 'assets_only', status: 'blocked',
    reason: '16 类形态已在计算资产内，但只有严格看涨吞没被受控入口放行。',
    description: '单根、双根与三根组合形态判断，逐条输出命中或空值，不作交易解释。',
    parameters: [], outputFields: ['morning_star', 'evening_star', 'hammer', 'three_rising_bullish', 'three_falling_bearish', 'gap_up', 'gap_down', 'long_upper_shadow'],
    requiredInputs: ['timestamp', 'open', 'high', 'low', 'close'],
    sources: [`本工程 ${ASSET}/patterns.py: 16 类形态`, `${PACK_A}/sources/alpha/ta_cn/candle.py: 12 个 K 线构件`, `${PACK_B}/技能/标的诊断/蜡烛图信号扫描/scripts/candlestick-calc.mjs: 15 种几何形态`],
    missing: ['除 bullish_engulfing 外均未放行', '资料包A 的 61 个 CDL* 只是对已安装 TA-Lib 的绑定名，包内无 ta_CDL*.c', '资料包B「K线形态X光」离线只实现 4 类候选，另 11 类待接入'],
    limitations: ['形态真假不构成交易建议。', '各来源的实体与影线阈值不同，不能跨来源合并命中结果。'] }),
  tool({
    id: 'volume_price', title: '量价规则', category: 'market', state: 'assets_only', status: 'blocked',
    reason: '仅 volume_breakout 一个规则在资产内且未放行；“量价规则”尚未定义为一组冻结规则。',
    description: '量价配合与背离类规则集合，含放量突破、量价相关系数、价涨量缩等关系判定。',
    parameters: [], outputFields: ['volume_breakout'], requiredInputs: ['timestamp', 'close', 'volume', '同窗历史'],
    sources: [`本工程 ${ASSET}/patterns.py: volume_breakout`, `${ASSET}/definitions/formulas.json: VPT / VOSC / MAVOL / LIANGBI / DBLB`, `${PACK_A}/catalog/basic_factors.json: 量价背离 6 条模板`, `${PACK_B}/技能/标的诊断/量价背离扫描/scripts/calc-vp.mjs: 八类关系`],
    missing: ['没有冻结的规则集定义：资料包B 用八类关系，资料包A 给 6 条模板，本工程只有 1 条', '受控入口未放行', '分钟量额单位未标，量比类规则无法成立'],
    limitations: ['相关系数类规则依赖同窗完整数据，缺值不补。', '规则命中不等于信号有效。'] }),
  tool({
    id: 'roc', title: 'ROC / 变化率与动量', category: 'statistics', state: 'assets_only', status: 'blocked',
    reason: 'ROC、MTM 已在计算资产内，但受控执行入口未放行。',
    description: 'N 周期变化率与动量，附变化率的移动均线。',
    parameters: [{ key: 'period', label: '变化周期', defaultValue: 12, min: 1, max: 10000 }, { key: 'average_period', label: '均线周期', defaultValue: 6, min: 1, max: 10000 }],
    outputFields: ['ROC', 'ROCMA', 'MTM', 'MAMTM'], requiredInputs: ['timestamp', 'close', 'reference_close（窗口前一条）'],
    sources: [`本工程 ${ASSET}/indicators.py: ROC / MTM`, `${ASSET}/definitions/formulas.json: ZF5 / ZF10 / ZF30 / ZF60 / ZF250 涨幅`, `${PACK_A}/sources/ta_lib/ta_ROC.c: TA_ROC / TA_ROCP / TA_MOM`, `${PACK_A}/catalog/basic_factors.json: return_n / log_return_n / momentum_n`],
    missing: ['受控入口未放行', '输出口径未统一：本工程 ROC 为百分数，资料包A 的 return_n 为小数比率', '未做独立数值预期验证'],
    limitations: ['窗口前一条缺失时输出空值，不前向填充。', '百分数与小数比率不能混用于同一比较。'] }),
  tool({
    id: 'rolling_mean', title: '滚动均值（通用）', category: 'statistics', state: 'assets_only', status: 'blocked',
    reason: '均值算子在资产内，但按任意字段滚动聚合需要 operator 类入口，目前未放行。',
    description: '对任意已声明单位的有序数值列做完整窗口算术平均。',
    parameters: [{ key: 'period', label: '窗口', defaultValue: 5, min: 1, max: 10000 }],
    outputFields: ['MA'], requiredInputs: ['timestamp', '目标数值列'],
    sources: [`本工程 ${ASSET}/operators.py: window / smooth`, `${ASSET}/indicators.py: MA`, `${ASSET}/definitions/formulas.json: MAVOL / amount_ma_n / turnover_ma_n 等`, `${PACK_A}/sources/alpha/ta_cn/wq/time_series.py: ts_mean`],
    missing: ['operator 类未放行，只能按 MA 的固定输入（收盘价）计算', '跨字段窗口聚合的单位与空值策略未冻结'],
    limitations: ['未凑足完整窗口返回空值。', '不补交易日、不跨频率拼接。'] }),
  tool({
    id: 'ichimoku', title: '一目均衡表（云图）', category: 'market', state: 'not_implemented', status: 'unavailable',
    reason: '本工程没有一目均衡表实现；方法只在外部资料包内。',
    description: '转折线、基准线、先行带 A/B 与迟行线；按 9/26/52/26 默认参数与位移语义计算。',
    parameters: [{ key: 'conversion_period', label: '转折周期', defaultValue: 9, min: 2, max: 1000 }, { key: 'base_period', label: '基准周期', defaultValue: 26, min: 2, max: 1000 },
      { key: 'span_b_period', label: '先行B周期', defaultValue: 52, min: 2, max: 1000 }, { key: 'displacement', label: '位移', defaultValue: 26, min: 1, max: 1000 }],
    outputFields: [], requiredInputs: ['candles（t/open/high/low/close）', '至少 78 根观测'],
    sources: [`${PACK_B}/技能/标的诊断/一目云图诊股/scripts/ichimoku-calc.mjs（参数 9/26/52/26）`],
    missing: ['本工程无实现，需按受控入口移植并冻结方法版本', '资料包A 全包检索 ichimoku／一目／云图／kumo 为 0 命中', '先行带位移涉及未来引用，须明确回看模式与可得时点', '未做独立数值预期验证'],
    limitations: ['位移后的先行带含未来时点，不能当作已可得数值用于历史决策。'] }),
  tool({
    id: 'historical_percentile', title: '历史分位', category: 'statistics', state: 'not_implemented', status: 'unavailable',
    reason: '本工程没有历史分位实现；840 条公式与 22 个指标内检索“分位/百分位”为 0 命中。',
    description: '在同一历史窗口内计算当前值所处的分位（百分位排名）。',
    parameters: [], outputFields: [], requiredInputs: ['同一口径的历史序列', '当前值', '窗口长度'],
    sources: [`${PACK_B}/技能/标的诊断/个股贵不贵/scripts/calc-valuation.mjs: pctl / quant`, `${PACK_B}/技能/板块／行业分析/板块贵不贵/scripts/calc-valuation-percentile.mjs`, `${PACK_A}/sources/alpha/ta_cn/wq/time_series.py: ts_percentage / ts_rank（底层算子，依赖 bottleneck）`],
    missing: ['本工程无实现', '分位口径未冻结：有效正值样本筛选、并列值处理、窗口长度都需明确', '资料包A 无分位模板与类别，只有底层算子；其截面 quantile 不等于历史分位'],
    limitations: ['样本不足时不得输出分位。', '分位是相对位置，不是估值结论。'] }),
  tool({
    id: 'volatility', title: '波动率', category: 'statistics', state: 'not_implemented', status: 'unavailable',
    reason: '本工程只有 ATR、STD、成交量标准差等底层量，没有收益率波动率或年化波动率实现。',
    description: '由收益率序列计算波动率，可含年化、下行偏差与长短窗口比。',
    parameters: [], outputFields: [], requiredInputs: ['收益率序列', '窗口', 'ddof', '年化天数 K', '无风险利率（可选）'],
    sources: [`本工程 ${ASSET}/indicators.py: ATR`, `${ASSET}/operators.py: STD`, `${ASSET}/definitions/formulas.json: VSTD`, `${PACK_A}/catalog/basic_factors.json: return_vol_n / annualized_vol_n / downside_deviation_n / vol_ratio_s_l`, `${PACK_A}/sources/ta_lib/ta_STDDEV.c: TA_STDDEV`, `${PACK_B}/专家/投资研究/基金经理分析专家/scripts/calc-manager-metrics.mjs: annualizedVolatility`],
    missing: ['本工程无波动率与年化实现', '年化天数口径两包不一致：资料包B 一处用 observationsPerYear、一处用 TRADING_DAYS', '复权收益序列来源未绑定（首批只有复权因子原值，基准与方向未核）'],
    limitations: ['年化系数必须显式声明，不能沿用外部默认值。', '没有复权口径的收益序列时结果不可比。'] }),
  tool({
    id: 'drawdown', title: '回撤（最大回撤）', category: 'statistics', state: 'not_implemented', status: 'unavailable',
    reason: '本工程没有回撤实现；840 条公式与 18 类模板内检索“回撤/drawdown”为 0 命中。',
    description: '由净值或价格序列计算逐日回撤、最大回撤与修复区间。',
    parameters: [], outputFields: [], requiredInputs: ['复权净值或价格序列', '峰值口径', '起始基准'],
    sources: [`${PACK_B}/技能/基金交易/净值波动高抛低吸策略/scripts/offline_core.py: dd / max_drawdown`, `${PACK_B}/专家/投资研究/债券基金专家/scripts/calc-bond-fund-metrics.mjs: calculateDrawdown`, `${PACK_B}/专家/研究/ETF对比专家/scripts/calc-etf-comparison.mjs`],
    missing: ['本工程无实现', '资料包A 完全缺失该项', '序列口径未定：净值、总回报还是复权价格，三者回撤不同', '未做独立数值预期验证'],
    limitations: ['回撤依赖起点选择，起点未声明时不得称“历史最大回撤”。'] }),
  tool({
    id: 'returns', title: '收益率', category: 'statistics', state: 'not_implemented', status: 'unavailable',
    reason: '本工程只有 ZF* 涨幅公式，没有收益率序列、对数收益与年化收益实现。',
    description: '逐期收益率与对数收益率，以及由序列汇总的累计与年化收益。',
    parameters: [], outputFields: [], requiredInputs: ['同一复权基准的价格序列', '持有期', '现金流（可选）'],
    sources: [`本工程 ${ASSET}/definitions/formulas.json: ZF5 / ZF10 / ZF30 / ZF60 / ZF100 / ZF250`, `${PACK_A}/catalog/basic_factors.json: return_n / log_return_n`, `${PACK_A}/sources/alpha/ta_cn/wq/time_series.py: ts_returns`, `${PACK_B}/专家/投资研究/基金经理分析专家/scripts/calc-manager-metrics.mjs`],
    missing: ['本工程无收益率序列实现；ZF* 是单点涨幅公式，不是序列', '年化口径未统一：资料包B 用 (1+totalReturn)^(365.25/elapsedDays)−1，另有 money_weighted 版本', '含现金流时需明确是否用资金加权'],
    limitations: ['除权不调整时收益率失真。', '简单收益与对数收益不能混加。'] }),
  tool({
    id: 'dividend_yield', title: '股息率', category: 'statistics', state: 'needs_data', status: 'blocked',
    reason: '本工程只有美股股息率一条公式；A 股股息率缺逐笔分红台账与独立控制值。',
    description: '以逐笔分红记录与未复权现价计算股息率，并区分 TTM 与年度口径。',
    parameters: [], outputFields: [], requiredInputs: ['逐笔分红台账（事件、财年、每股股息、除权日、状态、类型）', '未复权现价与价格基准', '独立控制值'],
    sources: [`本工程 ${ASSET}/definitions/formulas.json: GXL_MG（仅美股）`, `${PACK_B}/专家/投资研究/高股息专家/scripts/calc-dividend-metrics.mjs（564 行引擎）`, `${PACK_B}/技能/标的选择/高股息收息池/scripts/calc-dividend-score.mjs`],
    missing: ['A 股股息率本工程无实现', '缺逐笔分红台账：资料包B 要求 eventId / fiscalYear / period / dps / cashDividend / status / exDate / kind', '缺独立控制值 dividendControls，包内明确不得由台账自行求和', '首批两套原包无分红数据；资料包A 全包检索“股息/dividend”为 0 命中', '税前税后与价格基准未定'],
    limitations: ['不得用供应商已给股息率反推分红事件。', '分红状态为「预案」时不能计入已实现股息。'] }),
  tool({
    id: 'convertible_bond', title: '转股价值与溢价率', category: 'statistics', state: 'needs_data', status: 'blocked',
    reason: '本工程只有权证溢价公式，没有可转债转股价值与溢价率；缺转债条款与正股映射。',
    description: '转股比例＝每张面值÷当前转股价；转股价值＝正股价×转股比例；溢价率＝转债价÷转股价值−1。',
    parameters: [], outputFields: [], requiredInputs: ['每张面值', '转债价', '正股价', '转股价及生效日', '交易日历'],
    sources: [`本工程 ${ASSET}/definitions/formulas.json: QZZJ（权证溢价）/ zgzt（债券转股状态）`, `${PACK_B}/专家/投资研究/可转债专家/scripts/calc-convertible-bond.mjs`],
    missing: ['本工程无转债实现；QZZJ 是权证溢价，zgzt 只是状态标记，均不能替代', '缺 faceValue / bondPrice / stockPrice / conversionPrice 及生效日', '缺转债品种、正股映射与逐日有效转股价', '资料包A 全包检索“转股/convertible/转债/溢价”仅剩权证条目'],
    limitations: ['转股价在存续期内会调整，用单一转股价回算全历史会出错。', '溢价率不能与权证溢价混用。'] }),
  tool({
    id: 'dupont', title: '杜邦分析', category: 'financial', state: 'needs_data', status: 'blocked',
    reason: '本工程只有净资产收益率单值，没有杜邦因子分解；缺财务报表科目与多期可比数据。',
    description: 'ROE ＝ 税负系数 × 利息负担系数 × 营业利润率 × 资产周转率 × 权益乘数。',
    parameters: [], outputFields: [], requiredInputs: ['净利润', '税前利润', 'EBIT', '营业收入', '总资产', '净资产', '至少 6 期可比年度'],
    sources: [`本工程 ${ASSET}/definitions/formulas.json: JZCSYL（净资产收益率）/ ZZCZZL / GDQYZZL`, `${PACK_B}/技能/标的诊断/财报照妖镜/scripts/fin-score-calc.mjs: dupont（121 行）`],
    missing: ['本工程无 5 因子分解实现', '缺 6 个科目与 6 期可比年度；首批两套原包只有行情，无财务三表', '资产口径未定：资料包B 脚本用期末资产，不是平均资产', '分红/送转影响的可比性未处理'],
    limitations: ['五因子相乘恒等，但因子口径不同会让同比失真。', '缺项时该期不得出分，也不用行业均值代替。'] }),
  tool({
    id: 'earnings_quality', title: '盈利质量比率', category: 'financial', state: 'needs_data', status: 'blocked',
    reason: '本工程无盈利质量实现；缺三表科目，尤其附注类字段（客户集中度、政府补助、扣非净利）。',
    description: '应计比率、现金转化率、收入质量与非经常性损益四组判据，另有红灯清单。',
    parameters: [], outputFields: [], requiredInputs: ['经营活动现金流', '净利润', '应收账款', '存货', '营业成本', '总资产与总负债', '治理与附注类证据'],
    sources: [`${PACK_B}/技能/标的诊断/财报照妖镜/scripts/fin-score-calc.mjs: quality（14 项）/ redFlags（20 条）`],
    missing: ['本工程无实现', '缺约 20 个科目及其上期值；6 期可比年度', '缺附注来源：customerTop5Ratio、governmentSubsidy、recurringNetProfit', '红灯 20 条中 18 条须外部证据，缺失时只能记 unknown'],
    limitations: ['净利≤0 时现金转化率不适用，不能按 0 处理。', 'unknown 不等于 clear。'] }),
  tool({
    id: 'cash_conversion_cycle', title: '现金转换周期（CCC）', category: 'financial', state: 'needs_data', status: 'blocked',
    reason: '本工程有存货周转天数与应收账款周转天数公式，缺应付账款周转天数，因此算不出 CCC。',
    description: 'CCC ＝ DSO ＋ DIO − DPO，三个周转天数按 365 天年化；非年报须给报告期天数。',
    parameters: [], outputFields: [], requiredInputs: ['应收账款', '营业收入', '存货', '营业成本', '应付账款', '非年报时的 periodDays'],
    sources: [`本工程 ${ASSET}/definitions/formulas.json: CHZZTS（存货周转天数）/ YSZKZZTS（应收账款周转天数）`, `${PACK_B}/技能/标的诊断/财报照妖镜/scripts/fin-score-calc.mjs: workingCap`],
    missing: ['本工程缺应付账款周转天数（全 840 条中检索“应付”为 0 命中）', '无 CCC 实现', '缺 payables 与营业成本科目；非年报缺 periodDays', '余额口径未定：资料包B 用期末余额'],
    limitations: ['非年度不得套用 365。', '期末余额与平均余额算出的 CCC 不可比。'] }),
  tool({
    id: 'financial_models', title: '财务模型（Altman Z / Piotroski F / Beneish M）', category: 'financial', state: 'needs_data', status: 'blocked',
    reason: '本工程无财务模型实现；Z/F/M 各需 7～22 个科目且多数要求年度与上期可比。',
    description: '三类财务健康与盈余操纵模型，各有适用前置条件与阈值区间。',
    parameters: [], outputFields: [], requiredInputs: ['Z：营运资本/留存收益/EBIT/市值/总负债/营收/总资产 + 制造业标记', 'F：本期与上期各 9 项', 'M：本期与上期各 11 项'],
    sources: [`${PACK_B}/技能/标的诊断/财报照妖镜/scripts/fin-score-calc.mjs: zScore / fScore / mScore`, `${PACK_B}/专家/专家团/财报分析专家团（仅研究要求，无脚本）`],
    missing: ['本工程无实现', '缺各模型科目；F 与 M 都需连续可比上期，Z 需制造业标记与年度口径', '缺总市值（首批日线有市值列但口径与可得性未核）', '资料包B 的财报分析专家团只有 44 行研究要求，无公式无脚本，不能作为第二来源'],
    limitations: ['Z 模型只适用于制造业且口径为年度。', '阈值区间是经验值，不构成违约预测。'] }),
  tool({
    id: 'earnings_surprise', title: '业绩预期差', category: 'financial', state: 'needs_data', status: 'blocked',
    reason: '本工程无预期差实现；缺披露前一致预期快照，本机也没有机构预测来源。',
    description: '预期差 ＝ (实际值 − 预期值) ÷ |预期值|，按 ±5%、±10% 分级；预期取样本中位数。',
    parameters: [], outputFields: [], requiredInputs: ['实际值（同币种、同单位、同指标、同期间）', '≥3 家机构预期及样本量', '预期发布日期（须早于实际公开）', '公司指引与反应交易日行情（可选）'],
    sources: [`本工程 ${ASSET}/definitions/formulas.json: C_17（业绩选股，不是预期差）`, `${PACK_B}/专家/专家团/业绩预期差研判专家团/scripts/calc-expectation-gap.mjs（239 行）`],
    missing: ['本工程无实现；C_17 是选股规则，不能替代', '缺披露前一致预期历史快照（机构/报告/发布日期/预测值/样本量）', '缺实际值首次公开时刻，时间资格无法核对（脚本自述不检来源与时间）', '缺公司指引与至少 3 个反应交易日行情'],
    limitations: ['预期为 0 或跨盈亏时不分级。', '距披露超过 45 天的样本须标旧。'] }),
  tool({
    id: 'adjustment', title: '复权工具', category: 'utility', state: 'needs_data', status: 'blocked',
    reason: '缺少可核对的同窗复权因子输入与受控实现；不补 1、不延展旧值，也不将调整后价格写入未复权行情目标。',
    description: '使用与价格同证券、同日期窗口的真实复权因子计算调整后价格。',
    parameters: [], outputFields: [], requiredInputs: ['同证券同窗复权因子', '未复权价格', '因子基准与方向'],
    sources: [`本工程 ${ASSET}/definitions/formulas.json（无复权实现）`, `首批两套原包均含复权因子原值（基准、方向、修订未核）`],
    missing: ['受控实现未装配', '复权因子的基准、方向、修订与可得时点未核（首批登记 F01）', '同证券同窗因子对齐规则未冻结'],
    limitations: ['原包中的复权因子原值不代表基准、调整状态和历史可得性已确认。', '既有合成算术检查不替代真实因子联合验证。'] }),
];

/** 把登记状态换算成当前可用性；executable 项在运行时还会按方法目录再校正一次。 */
export function statusForState(state: ToolLibraryState): 'ready' | 'blocked' | 'unavailable' {
  if (state === 'executable') return 'ready';
  return state === 'not_implemented' ? 'unavailable' : 'blocked';
}

export function registryCounts(): Record<ToolLibraryState, number> {
  const counts: Record<ToolLibraryState, number> = { executable: 0, assets_only: 0, not_implemented: 0, needs_data: 0 };
  for (const entry of ALGORITHM_REGISTRY) counts[entry.state ?? 'not_implemented'] += 1;
  return counts;
}
