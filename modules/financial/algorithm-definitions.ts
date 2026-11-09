import type {
  AlgorithmConfiguration, AlgorithmDefinition, AlgorithmDefinitionStatus, AlgorithmDefinitionSummary,
  AlgorithmFormulaLine, AlgorithmImplementationRef, AlgorithmLegacyAlias, AlgorithmProduct, AlgorithmSemantic,
} from '../../contracts/algorithm-definition.js';

/**
 * 算法定义层（`bd.algorithm-definitions/1`）。
 *
 * 只回答“这个算法是什么”：公式、口径、预热、缺失处理、实现、配置、数据产品与旧编号映射。
 * 不回答“现在能不能算”：那由登记清单、采用记录、受控白名单和每次请求的输入共同决定，
 * 页面必须按真实运行目录显示，不能由这份静态定义代替。
 *
 * 公式取自本工程计算资产里的 `definitions` 声明（`indicators.py` / `patterns.py`）与
 * 登记说明原文；未在本工程实现的方法只写登记已冻结的式子，并标明来源与未移植事实。
 */

export const ALGORITHM_DEFINITION_VERSION = 'bd.algorithm-definitions/1';
export const ALGORITHM_DEFINITION_NOTE =
  '定义层只固定“算法是什么”，不放行计算。公式与口径按本工程实现声明与登记原文登记；'
  + '未移植的方法保留来源与未冻结项，不用外部默认值补造。发布、数据与运行三维按每次请求的真实目录判定。';

const ASSET = 'plugins/financial/local-compute/assets';

const VERIFY_UNRECORDED = '未登记独立数值预期回执；登记与入口放行都不等于数值验证。';
const VERIFY_NOT_RUN = '登记明确「未做独立数值预期验证」，本工程也没有该方法的数值回执。';

const impl = (
  id: string, role: AlgorithmImplementationRef['role'], language: string, location: string,
  version?: string, note?: string,
): AlgorithmImplementationRef => ({ id, role, language, location, ...(version ? { version } : {}), ...(note ? { note } : {}) });

const cfg = (
  id: string, label: string, frequency: string, parameters: string, entry: AlgorithmConfiguration['entry'], note?: string,
): AlgorithmConfiguration => ({ id, label, frequency, parameters, entry, ...(note ? { note } : {}) });

const product = (
  id: string, label: string, kind: AlgorithmProduct['kind'], entryId: string, configurationId: string, note: string,
): AlgorithmProduct => ({ id, label, kind, entryId, configurationId, note });

const alias = (
  name: string, mapsTo: string, kind: AlgorithmLegacyAlias['kind'], note: string,
): AlgorithmLegacyAlias => ({ alias: name, mapsTo, kind, note });

const status = (
  definitionState: AlgorithmDefinitionStatus['definition']['state'], definitionBasis: string,
  implementationState: AlgorithmDefinitionStatus['implementation']['state'], implementationBasis: string,
  verificationState: AlgorithmDefinitionStatus['verification']['state'], verificationBasis: string,
): AlgorithmDefinitionStatus => ({
  definition: { state: definitionState, basis: definitionBasis },
  implementation: { state: implementationState, basis: implementationBasis },
  verification: { state: verificationState, basis: verificationBasis },
});

const line = (output: string, expression: string, note?: string): AlgorithmFormulaLine =>
  ({ output, expression, ...(note ? { note } : {}) });

const sem = (key: string, label: string, value: string, state: AlgorithmSemantic['state']): AlgorithmSemantic =>
  ({ key, label, value, state });

function definition(entry: Omit<AlgorithmDefinition, 'kind'>): AlgorithmDefinition {
  return { kind: 'definition', ...entry };
}

export const ALGORITHM_DEFINITIONS: readonly AlgorithmDefinition[] = Object.freeze([

  definition({
    id: 'algo.rolling_mean', registryId: 'rolling_mean', title: '滚动均值（通用算子）', definitionKind: 'operator',
    summary: '对任意已声明单位的有序数值列做完整窗口算术平均。MA 是它在收盘价上的固定用法，两者不并列重复登记。',
    formula: [line('mean', 'mean_t(N) = (1/N) × Σ_{i=0}^{N-1} x_{t−i}',
      '窗口必须完整且无空值；任一缺失即输出空值，不插补。')],
    semantics: [
      sem('window', '窗口口径', '按已提供的有序观测计数，不补交易日、不跨频率拼接。', 'fixed'),
      sem('unit', '单位', '继承输入列单位，不缩放、不做币种换算。', 'fixed'),
      sem('cross_field', '跨字段聚合', '目标列单位与空值策略尚未冻结；当前只能按 MA 的固定输入（收盘价）计算。', 'conflict'),
    ],
    warmup: '不足 N 条观测时输出空值。',
    missingPolicy: '窗口内含空值即输出空值；不前向填充、不跳过缺失行。',
    implementations: [
      impl('impl.local.operators.window', 'primary', 'Python', `${ASSET}/operators.py: window / smooth`),
      impl('impl.local.indicators.ma', 'reference', 'Python', `${ASSET}/indicators.py: MA`, 'ma/full-window-v1'),
    ],
    configurations: [cfg('cfg.rolling_mean.window', '通用窗口', '按调用方声明', '窗口 N（1–10000）；operator 类入口未放行', 'library')],
    products: [], legacyAliases: [],
    status: status('conflict', '跨字段窗口聚合的单位与空值策略未冻结。',
      'present', '均值算子在计算资产内；operator 类入口未放行。', 'unrecorded', VERIFY_UNRECORDED),
  }),

  definition({
    id: 'algo.ma', registryId: 'ma', title: 'MA · 算术移动均线', definitionKind: 'indicator',
    summary: '收盘价的完整窗口算术平均。日线 20 期均值与日K/分钟K批量均线都是它的固定参数配置与数据产品，不是独立算法。',
    formula: [line('MA', 'MA_t(N) = (1/N) × Σ_{i=0}^{N-1} C_{t−i}',
      'C 为已提供的有序收盘价；N 为观测周期。')],
    semantics: [
      sem('price', '价格口径', '收盘价 close；不使用开高低或典型价。', 'fixed'),
      sem('window', '窗口口径', '按已提供的有序观测计数，不证明完整交易日覆盖。', 'fixed'),
      sem('adjustment', '复权口径', '按输入序列原样计算，不执行复权、不补历史。', 'fixed'),
      sem('missing', '缺失处理', '不足 N 条或窗口内含空值即输出空值，不前向填充。', 'fixed'),
    ],
    warmup: '前 N−1 条输出空值；第 N 条起出值。',
    missingPolicy: '窗口内含空值即输出空值；不插补、不跳过。',
    implementations: [
      impl('impl.local.indicators.ma', 'primary', 'Python', `${ASSET}/indicators.py: MA`, 'ma/full-window-v1',
        '受控入口已放行；单次最多接收 512 条日线观测。'),
    ],
    configurations: [
      cfg('cfg.ma.base', '基础库受控计算', '日线', '周期 N 可调 1–10000；单表输入，需声明复权与可得时刻', 'library'),
      cfg('cfg.ma.fixed20', '固定产品配置', '日线原报', '周期固定 20；完整窗口；8 位小数半偶入', 'fixed'),
      cfg('cfg.ma.batch.daily', '批量日K配置', '日K原报', '周期取批次开始前保存的日K周期', 'batch'),
      cfg('cfg.ma.batch.minute', '批量分钟K配置', '分钟K原报', '周期取批次开始前保存的分钟K周期', 'batch'),
    ],
    products: [
      product('product.ma.daily20', '日线观测20期均值', 'fixed', 'fixed:observation_ma20', 'cfg.ma.fixed20',
        '固定参数产品，与 MA 共用公式；输入为来源原报的完整日线系列，结果仍为候选。'),
      product('product.ma.batch.daily', '日K均线系列', 'batch', 'batch:daily_bar', 'cfg.ma.batch.daily',
        '批量产物；按批次冻结的来源、授权与周期单独发布。'),
      product('product.ma.batch.minute', '分钟K均线系列', 'batch', 'batch:minute_bar', 'cfg.ma.batch.minute',
        '批量产物；实现、输入与结果边界与基础库 MA 不同，不能合并成同一次执行。'),
    ],
    legacyAliases: [
      alias('observation_ma20', 'algo.ma / cfg.ma.fixed20 / product.ma.daily20', 'fixed', '固定计算方法编号；不是独立算法。'),
      alias('daily_bar', 'algo.ma / cfg.ma.batch.daily / product.ma.batch.daily', 'batch', '批量执行链编号；不是独立算法。'),
      alias('minute_bar', 'algo.ma / cfg.ma.batch.minute / product.ma.batch.minute', 'batch', '批量执行链编号；不是独立算法。'),
    ],
    status: status('frozen', '公式与窗口、复权、缺失口径均已固定，无同名争议。',
      'present', '本工程计算资产已实现该算法；受控入口已放行。', 'unrecorded', VERIFY_UNRECORDED),
  }),

  definition({
    id: 'algo.ema', registryId: 'ema', title: 'EMA · 指数移动平均', definitionKind: 'indicator',
    summary: '递推加权平均，权重按 2/(N+1) 衰减。首值初始化与续算状态是两种口径，调用时必须显式声明其中一种。',
    formula: [
      line('EMA', 'Y_t = α × C_t + (1 − α) × Y_{t−1}', 'α = 2/(N+1)；Y_0 由首值或显式前期状态给出。'),
      line('α', 'α = 2 / (N + 1)'),
    ],
    semantics: [
      sem('seed', '首值口径', '首条收盘价初始化，或显式提供上期状态续算；两者必须二选一。', 'fixed'),
      sem('state', '续算状态', '提供 state 时按 state 续算，不接受同时给首值。', 'fixed'),
      sem('null', '空值处理', '空值延迟递推起点；序列中间出现空值会使递推中断。', 'fixed'),
    ],
    warmup: '首条即出值（首值初始化口径）；续算口径由显式状态决定。',
    missingPolicy: '不插补；空值处递推中断，后续不静默续接。',
    implementations: [impl('impl.local.indicators.ema', 'primary', 'Python', `${ASSET}/indicators.py: EMA`)],
    configurations: [cfg('cfg.ema.base', '基础库计算配置', '日线', '平滑周期 N（1–10000）；首值或状态二选一', 'library')],
    products: [], legacyAliases: [],
    status: status('frozen', '递推式与权重已固定；首值与续算是显式参数，不是未决口径。',
      'present', '本工程计算资产已实现该算法；受控入口未放行。', 'unrecorded', VERIFY_UNRECORDED),
  }),

  definition({
    id: 'algo.macd', registryId: 'macd', title: 'MACD · 指数平滑异同移动平均线', definitionKind: 'indicator',
    summary: '固定 12/26/9 参数，由两条 EMA 之差与信号线递推得到柱值。柱值系数是决定结果的口径，必须显式展示。',
    formula: [
      line('DIFF', 'DIFF_t = EMA(C, 12)_t − EMA(C, 26)_t'),
      line('DEA', 'DEA_t = EMA(DIFF, 9)_t'),
      line('MACD', 'MACD_t = 2 × (DIFF_t − DEA_t)', '本工程固定 2 倍；TA-Lib 与部分资料包模板用 1×(DIFF−DEA)。'),
      line('ZERO', 'ZERO_t = 0'),
    ],
    semantics: [
      sem('coefficient', '柱值系数', '本工程 2×(DIFF−DEA)；TA-Lib 与部分模板 1×(DIFF−DEA)。对外引用前必须固定其中一种。', 'conflict'),
      sem('seed', '初始化', '以所供窗口首条收盘价初始化 EMA12 / EMA26，不接受续算状态扩窗补历史。', 'fixed'),
      sem('params', '参数', '固定 12/26/9，不开放自定义。', 'fixed'),
    ],
    warmup: '首条即出值（首值初始化），但不等同包含长期历史的连续 MACD。',
    missingPolicy: '不补历史、不扩窗；结果不自动入库。',
    implementations: [impl('impl.local.indicators.macd', 'primary', 'Python', `${ASSET}/indicators.py: MACD`,
      'macd/12-26-9-first-valid-v1', '受控入口已放行；柱值按 2 倍计算并由服务端校验。')],
    configurations: [cfg('cfg.macd.base', '基础库受控计算', '日线', '12/26/9 固定；init=first_valid', 'library')],
    products: [], legacyAliases: [],
    status: status('conflict', '柱值系数 2× 与 1× 未统一；本工程按 2× 实现，引用前须固定。',
      'present', '本工程计算资产已实现该算法；受控入口已放行。', 'unrecorded', VERIFY_UNRECORDED),
  }),

  definition({
    id: 'algo.rsi', registryId: 'rsi', title: 'RSI · 相对强弱指标', definitionKind: 'indicator',
    summary: '按 SMA(N,1)（即 RMA）平滑涨跌幅计算多条 RSI。周期与阈值存在两套来源，不能混用。',
    formula: [line('RSI', 'RSI_t = 100 × SMA(max(ΔC,0), N, 1) / SMA(|ΔC|, N, 1)',
      'ΔC = C_t − C_{t−1}；SMA(·,N,1) 为权重 1/N 的递推平滑。')],
    semantics: [
      sem('period', '周期', '本工程默认 6/12/24；资料包B 用 Wilder 14。两套不可混用。', 'conflict'),
      sem('threshold', '阈值', '本工程输出 20/80 参考常量；资料包B 用 30/70。', 'conflict'),
      sem('flat', '连续平盘', '不填 50；分母为 0 时输出空值。', 'fixed'),
    ],
    warmup: '首条缺前收盘时先输出空值。',
    missingPolicy: '负分母输出空值；不把平盘折算成中性值。',
    implementations: [impl('impl.local.indicators.rsi', 'primary', 'Python', `${ASSET}/indicators.py: RSI`)],
    configurations: [cfg('cfg.rsi.base', '基础库计算配置', '日线', '主周期默认 6；实际按 6/12/24 三条输出', 'library')],
    products: [], legacyAliases: [],
    status: status('conflict', '周期 6/12/24 与 Wilder 14、阈值 20/80 与 30/70 均未统一。',
      'present', '本工程计算资产已实现该算法；受控入口未放行。', 'not_run', VERIFY_NOT_RUN),
  }),

  definition({
    id: 'algo.adx', registryId: 'adx', title: 'ADX / DMI · 趋向指标', definitionKind: 'indicator',
    summary: '由 +DM/−DM 与真实波幅求和得到 DI1/DI2，再平滑出 ADX 与 ADXR。前值三件必须成组提供。',
    formula: [
      line('DI1 / DI2', 'DI1_t = 100 × Σ(+DM, N) / Σ(TR, N)；DI2_t = 100 × Σ(−DM, N) / Σ(TR, N)'),
      line('ADX', 'ADX_t = MA(100 × |DI1 − DI2| / (DI1 + DI2), M)'),
      line('ADXR', 'ADXR_t = (ADX_t + ADX_{t−M}) / 2'),
      line('TR', 'TR_t = max(H_t − L_t, |H_t − C_{t−1}|, |L_t − C_{t−1}|)'),
    ],
    semantics: [
      sem('dm', 'DM 互斥', 'HD 与 LD 相等时两边贡献都为 0。', 'fixed'),
      sem('prior', '前值', '前收盘、前高、前低必须同单位、同复权依据、紧邻上一条并成组提供。', 'fixed'),
      sem('source', '实现来源', '资料包A 无 ta_ADX.c，只有对已安装 TA-Lib 的调用绑定，不能作为实现来源。', 'fixed'),
    ],
    warmup: '需 N 期 TR 与 DM 求和；前 N−1 条输出空值。',
    missingPolicy: '前值缺失即输出空值，不用当日值代替。',
    implementations: [impl('impl.local.indicators.dmi', 'primary', 'Python', `${ASSET}/indicators.py: DMI`)],
    configurations: [cfg('cfg.adx.base', '基础库计算配置', '日线', '周期 14；ADX 平滑周期 6', 'library')],
    products: [], legacyAliases: [],
    status: status('frozen', 'TR、DM 互斥与前值成组规则均已固定。',
      'present', '本工程计算资产已实现 DMI（输出 ADX 与 ADXR）；受控入口未放行。', 'not_run', VERIFY_NOT_RUN),
  }),

  definition({
    id: 'algo.boll', registryId: 'boll', title: 'BOLL · 布林带', definitionKind: 'indicator',
    summary: '中轨为收盘价均线，上下轨为中轨加减标准差倍数。自由度修正必须显式声明。',
    formula: [
      line('MID', 'MID_t = MA(C, N)_t'),
      line('UPPER / LOWER', 'UPPER/LOWER_t = MID_t ± width × sqrt( Σ(C_i − MID_t)² / (N − ddof) )',
        'ddof 必填 0 或 1；N 必须大于 ddof。'),
    ],
    semantics: [
      sem('ddof', '自由度修正', '本工程要求显式 ddof=0/1；资料包B 固定样本标准差（除 n−1）。', 'conflict'),
      sem('width', '宽度', '默认 2 倍；宽度不改变中轨。', 'fixed'),
    ],
    warmup: '需完整 N 期窗口，且 N > ddof；前 N−1 条输出空值。',
    missingPolicy: '窗口内含空值即输出空值；不宣称任何外部程序的默认自由度。',
    implementations: [impl('impl.local.indicators.boll', 'primary', 'Python', `${ASSET}/indicators.py: BOLL`)],
    configurations: [cfg('cfg.boll.base', '基础库计算配置', '日线', '中轨周期 20；宽度 2；ddof 必填', 'library')],
    products: [], legacyAliases: [],
    status: status('conflict', 'ddof 口径未统一：本工程显式 0/1，资料包B 固定样本标准差。',
      'present', '本工程计算资产已实现该算法；受控入口未放行。', 'not_run', VERIFY_NOT_RUN),
  }),

  definition({
    id: 'algo.obv', registryId: 'obv', title: 'OBV · 能量潮', definitionKind: 'indicator',
    summary: '按收盘涨跌方向累计成交量。起点与初值必须显式给出，输出单位为量单位/10000。',
    formula: [
      line('OBV', 'OBV_t = initial_obv + Σ_{k≤t} sign(C_k − C_{k−1}) × V_k / 10000',
        '首条在 first_close_baseline 口径下不计方向量。'),
      line('MAOBV', 'MAOBV_t = MA(OBV, average_period)_t'),
    ],
    semantics: [
      sem('start', '起点', 'first_close_baseline 与 before_first_observation 二选一；后者必须给前收盘。', 'fixed'),
      sem('unit', '输出单位', '输入量单位/10000，不等于未缩放原始量。', 'fixed'),
      sem('minute_unit', '分钟量额单位', '分钟成交量与成交额单位未标（首批登记 F08），累计量无法定单位。', 'conflict'),
    ],
    warmup: '首条按所选起点给出初值；均线部分需 average_period 期。',
    missingPolicy: '不同起点产生不同绝对值，不能把窗口累计当全历史累计。',
    implementations: [impl('impl.local.indicators.obv', 'primary', 'Python', `${ASSET}/indicators.py: OBV`)],
    configurations: [cfg('cfg.obv.base', '基础库计算配置', '日线', '均线周期 30；起点与初值必填', 'library')],
    products: [], legacyAliases: [],
    status: status('conflict', '分钟量额单位未标，累计量的单位无法定。',
      'present', '本工程计算资产已实现该算法；受控入口未放行。', 'not_run', VERIFY_NOT_RUN),
  }),

  definition({
    id: 'algo.ichimoku', registryId: 'ichimoku', title: '一目均衡表（云图）', definitionKind: 'indicator',
    summary: '转折线、基准线、先行带 A/B 与迟行线；按 9/26/52/26 默认参数与位移语义计算。',
    formula: [
      line('转折线', 'tenkan_t = (HHV(H, 9) + LLV(L, 9)) / 2'),
      line('基准线', 'kijun_t = (HHV(H, 26) + LLV(L, 26)) / 2'),
      line('先行带 A', 'spanA_t = (tenkan_t + kijun_t) / 2，前移 26 期'),
      line('先行带 B', 'spanB_t = (HHV(H, 52) + LLV(L, 52)) / 2，前移 26 期'),
      line('迟行线', 'chikou_t = C_t，后移 26 期'),
    ],
    semantics: [
      sem('displacement', '位移语义', '先行带前移、迟行线后移都涉及未来引用，回看模式与可得时点未冻结。', 'conflict'),
      sem('params', '参数', '默认 9/26/52/26；外部脚本参数一致。', 'fixed'),
    ],
    warmup: '至少 78 根观测才可能出全五项。',
    missingPolicy: '位移后的先行带含未来时点，不能当作已可得数值用于历史决策。',
    implementations: [impl('impl.external.ichimoku', 'reference', 'JavaScript',
      '技能与专家/技能/标的诊断/一目云图诊股/scripts/ichimoku-calc.mjs', undefined, '外部资料包实现，本工程未移植。')],
    configurations: [], products: [], legacyAliases: [],
    status: status('conflict', '位移涉及未来引用，回看模式与可得时点未冻结。',
      'absent', '本工程无实现；资料包A 全包检索 ichimoku／一目／云图／kumo 为 0 命中。', 'not_run', VERIFY_NOT_RUN),
  }),

  definition({
    id: 'algo.roc', registryId: 'roc', title: 'ROC / 变化率与动量', definitionKind: 'indicator',
    summary: 'N 周期变化率与动量，附变化率的移动均线。输出是百分数还是小数比率必须固定。',
    formula: [
      line('ROC', 'ROC_t = 100 × (C_t − C_{t−N}) / C_{t−N}'),
      line('ROCMA', 'ROCMA_t = MA(ROC, M)_t'),
      line('MTM', 'MTM_t = C_t − C_{t−N}'),
      line('MAMTM', 'MAMTM_t = MA(MTM, M)_t'),
    ],
    semantics: [
      sem('scale', '输出口径', '本工程 ROC 为百分数；资料包A 的 return_n 为小数比率。', 'conflict'),
      sem('window', '窗口前值', '窗口前一条缺失时输出空值，不前向填充。', 'fixed'),
    ],
    warmup: '需 N 期前值；前 N 条输出空值。',
    missingPolicy: '缺前值输出空值；百分数与小数比率不能混用于同一比较。',
    implementations: [impl('impl.local.indicators.roc', 'primary', 'Python', `${ASSET}/indicators.py: ROC / MTM`)],
    configurations: [cfg('cfg.roc.base', '基础库计算配置', '日线', '变化周期 12；均线周期 6', 'library')],
    products: [], legacyAliases: [],
    status: status('conflict', '输出口径未统一：本工程百分数，资料包A 小数比率。',
      'present', '本工程计算资产已实现 ROC 与 MTM；受控入口未放行。', 'not_run', VERIFY_NOT_RUN),
  }),

  definition({
    id: 'algo.kline_patterns', registryId: 'kline_patterns', title: '蜡烛图形态族', definitionKind: 'pattern_family',
    summary: '单根、双根与三根组合形态判断，逐条输出命中或空值。族内各形态共用判定框架，但不共享同一套阈值。',
    formula: [line('各形态', '逐条布尔判定：命中为 true，未命中或历史不足为 null。',
      '示例（严格看涨吞没）：C_{t−1} < O_{t−1} ∧ C_t > O_t ∧ O_t < C_{t−1} ∧ C_t > O_{t−1}。')],
    semantics: [
      sem('threshold', '实体与影线阈值', '各来源阈值不同，不能跨来源合并命中结果。', 'conflict'),
      sem('history', '历史要求', '单根需 0 条历史；双根需 1 条；三根需 2 条。', 'fixed'),
    ],
    warmup: '按形态分别需要 0/1/2 条前序观测；不足即输出空值。',
    missingPolicy: '不补历史；命中与否不构成交易建议。',
    implementations: [impl('impl.local.patterns', 'primary', 'Python', `${ASSET}/patterns.py: 16 类形态`)],
    configurations: [cfg('cfg.kline_patterns.base', '基础库计算配置', '日线', '无参数；逐条输出命中', 'library')],
    products: [], legacyAliases: [],
    status: status('conflict', '各来源实体与影线阈值不同，跨来源合并会改变命中结果。',
      'present', '本工程计算资产已实现 16 类形态；仅严格看涨吞没被受控入口放行。', 'not_run', VERIFY_NOT_RUN),
  }),

  definition({
    id: 'algo.bullish_engulfing', registryId: 'bullish_engulfing', title: '严格看涨吞没', definitionKind: 'pattern',
    summary: '前一条为阴线、当前为阳线，当前实体严格包住前一条实体。它是形态族中唯一被受控入口放行的单项。',
    formula: [line('bullish_engulfing', 'C_{t−1} < O_{t−1} ∧ C_t > O_t ∧ O_t < C_{t−1} ∧ C_t > O_{t−1}')],
    semantics: [
      sem('strict', '严格实体', '比较开盘价与收盘价，不使用影线；等于边界不算吞没。', 'fixed'),
      sem('history', '历史', '需要紧邻前一条日线；缺失时输出空值。', 'fixed'),
    ],
    warmup: '首条输出空值；第 2 条起可判定。',
    missingPolicy: '不补历史；形态真假不构成交易建议。',
    implementations: [impl('impl.local.patterns.bullish_engulfing', 'primary', 'Python', `${ASSET}/patterns.py: bullish_engulfing`,
      'bullish-engulfing/strict-v1', '受控入口已放行。')],
    configurations: [cfg('cfg.bullish_engulfing.base', '基础库受控计算', '日线', '无参数；需开盘价与收盘价', 'library')],
    products: [], legacyAliases: [],
    relation: { parentId: 'algo.kline_patterns', role: 'member', note: '属形态族单项；族内其余 15 项共用同一实现与判定框架，但未放行。' },
    status: status('frozen', '严格实体判定式已固定，无同名争议。',
      'present', '本工程计算资产已实现该形态；受控入口已放行。', 'unrecorded', VERIFY_UNRECORDED),
  }),

  definition({
    id: 'algo.volume_price', registryId: 'volume_price', title: '量价规则', definitionKind: 'pattern',
    summary: '量价配合与背离类规则集合。当前只有放量突破一条在资产内，规则集尚未冻结。',
    formula: [
      line('volume_breakout', 'V_t > mean(V, N) ∧ C_t > C_{t−1}', '本工程唯一在资产内的规则。'),
      line('其余规则', '未冻结：资料包A 给 6 条模板、资料包B 用八类关系、本工程只有 1 条。'),
    ],
    semantics: [
      sem('ruleset', '规则集', '三处来源规则数量与判定不同，尚未冻结成一组可执行规则。', 'conflict'),
      sem('volume_unit', '量单位', '分钟量额单位未标，量比类规则无法成立。', 'conflict'),
    ],
    warmup: '依赖同窗完整历史；窗口不足输出空值。',
    missingPolicy: '相关系数类规则依赖同窗完整数据，缺值不补。',
    implementations: [impl('impl.local.patterns.volume', 'primary', 'Python', `${ASSET}/patterns.py: volume_breakout`)],
    configurations: [cfg('cfg.volume_price.base', '基础库计算配置', '日线', '无参数；仅 volume_breakout 一条', 'library')],
    products: [], legacyAliases: [],
    status: status('conflict', '规则集未冻结：三处来源数量与判定都不同。',
      'partial', '只有 volume_breakout 一条规则在资产内且未放行。', 'not_run', VERIFY_NOT_RUN),
  }),

  definition({
    id: 'algo.historical_percentile', registryId: 'historical_percentile', title: '历史分位', definitionKind: 'indicator',
    summary: '在同一历史窗口内计算当前值所处的分位（百分位排名）。样本筛选与并列值处理必须冻结后才能实现。',
    formula: [line('pct', 'pct_t = rank(x_t; window) / count(window)', 'rank 为窗口内不大于当前值的样本数；并列值处理未冻结。')],
    semantics: [
      sem('sample', '样本筛选', '有效正值样本的筛选规则未冻结。', 'unresolved'),
      sem('ties', '并列值', '并列值取平均秩还是最大秩未冻结。', 'unresolved'),
      sem('window', '窗口长度', '窗口长度与滚动方式未冻结。', 'unresolved'),
    ],
    warmup: '样本不足时不得输出分位。',
    missingPolicy: '样本不足输出空值；分位是相对位置，不是估值结论。',
    implementations: [],
    configurations: [], products: [], legacyAliases: [],
    status: status('conflict', '样本筛选、并列值与窗口长度三项均未冻结。',
      'absent', '本工程无实现；840 条公式与 22 个指标内检索“分位/百分位”为 0 命中。', 'not_run', VERIFY_NOT_RUN),
  }),

  definition({
    id: 'algo.volatility', registryId: 'volatility', title: '波动率', definitionKind: 'indicator',
    summary: '由收益率序列计算波动率，可含年化、下行偏差与长短窗口比。年化天数必须显式声明。',
    formula: [line('σ', 'σ = sqrt( Σ(r_i − r̄)² / (n − ddof) ) × sqrt(K)',
      'K 为年化天数；r 为同一复权基准的收益率序列。')],
    semantics: [
      sem('annualization', '年化天数', '资料包B 一处用 observationsPerYear、一处用 TRADING_DAYS，口径不一致。', 'conflict'),
      sem('adjusted', '复权收益序列', '首批只有复权因子原值，基准与方向未核，收益序列未绑定。', 'conflict'),
    ],
    warmup: '需 n 期完整收益率样本；不足时输出空值。',
    missingPolicy: '没有复权口径的收益序列时结果不可比；年化系数不得沿用外部默认值。',
    implementations: [impl('impl.local.indicators.atr', 'reference', 'Python', `${ASSET}/indicators.py: ATR`, undefined,
      '只有 ATR 等底层量，不是收益率波动率。')],
    configurations: [], products: [], legacyAliases: [],
    status: status('conflict', '年化天数两处不一致；复权收益序列来源未绑定。',
      'absent', '本工程无收益率波动率与年化实现。', 'not_run', VERIFY_NOT_RUN),
  }),

  definition({
    id: 'algo.drawdown', registryId: 'drawdown', title: '回撤（最大回撤）', definitionKind: 'indicator',
    summary: '由净值或价格序列计算逐期回撤、最大回撤与修复区间。起点与序列口径必须声明。',
    formula: [
      line('DD', 'DD_t = P_t / max_{s≤t} P_s − 1'),
      line('MDD', 'MDD = min_t DD_t'),
    ],
    semantics: [
      sem('series', '序列口径', '净值、总回报与复权价格三者回撤不同，尚未指定。', 'unresolved'),
      sem('start', '起点', '回撤依赖起点选择；起点未声明时不得称“历史最大回撤”。', 'fixed'),
    ],
    warmup: '首条无回撤；至少 2 条观测才可能出值。',
    missingPolicy: '起点未声明不输出“历史最大回撤”。',
    implementations: [],
    configurations: [], products: [], legacyAliases: [],
    status: status('conflict', '序列口径（净值/总回报/复权价格）未定。',
      'absent', '本工程无实现；840 条公式与 18 类模板内检索“回撤/drawdown”为 0 命中。', 'not_run', VERIFY_NOT_RUN),
  }),

  definition({
    id: 'algo.returns', registryId: 'returns', title: '收益率', definitionKind: 'indicator',
    summary: '逐期收益率与对数收益率，以及由序列汇总的累计与年化收益。当前只有单点涨幅公式，没有收益率序列实现。',
    formula: [
      line('r', 'r_t = P_t / P_{t−1} − 1'),
      line('ln r', 'ln r_t = ln(P_t / P_{t−1})'),
      line('年化', 'annual = (1 + totalReturn)^(365.25 / elapsedDays) − 1', '资料包B 另有资金加权版本，口径未统一。'),
    ],
    semantics: [
      sem('annualization', '年化口径', '时间加权与资金加权两版并存，未统一。', 'conflict'),
      sem('cashflow', '现金流', '含现金流时是否用资金加权未定。', 'unresolved'),
    ],
    warmup: '首条无收益率；至少 2 条同复权基准观测。',
    missingPolicy: '除权不调整时收益率失真；简单收益与对数收益不能混加。',
    implementations: [impl('impl.local.formulas.zf', 'reference', 'JSON 公式', `${ASSET}/definitions/formulas.json: ZF5 / ZF10 / ZF30 / ZF60 / ZF250`,
      undefined, '单点涨幅公式，不是收益率序列。')],
    configurations: [], products: [], legacyAliases: [],
    status: status('conflict', '年化口径两版并存；含现金流的加权方式未定。',
      'partial', '本工程只有 ZF* 单点涨幅公式，没有收益率序列实现。', 'not_run', VERIFY_NOT_RUN),
  }),

  definition({
    id: 'algo.dividend_yield', registryId: 'dividend_yield', title: '股息率', definitionKind: 'financial',
    summary: '以逐笔分红记录与未复权现价计算股息率，并区分 TTM 与年度口径。A 股缺逐笔分红台账。',
    formula: [line('DY', 'DY = DPS_TTM / P', 'DPS_TTM 由逐笔分红台账按除权日滚动汇总；P 为未复权现价。')],
    semantics: [
      sem('tax', '税前税后', '税前与税后口径未定。', 'unresolved'),
      sem('price', '价格基准', '未复权现价基准未定。', 'unresolved'),
      sem('control', '控制值', '包内明确不得由台账自行求和，须独立控制值 dividendControls。', 'fixed'),
    ],
    warmup: '需至少 12 个月分红事件覆盖才能称 TTM。',
    missingPolicy: '分红状态为「预案」时不能计入已实现股息；不得用供应商已给股息率反推分红事件。',
    implementations: [impl('impl.local.formulas.gxl', 'reference', 'JSON 公式', `${ASSET}/definitions/formulas.json: GXL_MG`, undefined,
      '仅美股股息率一条公式，不能用于 A 股。')],
    configurations: [], products: [], legacyAliases: [],
    status: status('conflict', '税前税后与价格基准均未定。',
      'partial', '本工程只有美股一条公式；A 股无实现。', 'not_run', VERIFY_NOT_RUN),
  }),

  definition({
    id: 'algo.convertible_bond', registryId: 'convertible_bond', title: '转股价值与溢价率', definitionKind: 'financial',
    summary: '转股比例＝每张面值÷当前转股价；转股价值＝正股价×转股比例；溢价率＝转债价÷转股价值−1。',
    formula: [
      line('转股比例', 'ratio = faceValue / conversionPrice'),
      line('转股价值', 'parity = stockPrice × ratio'),
      line('溢价率', 'premium = bondPrice / parity − 1'),
    ],
    semantics: [
      sem('conversion_price', '转股价', '存续期内会调整，须用逐日有效转股价；单一转股价回算全历史会出错。', 'conflict'),
      sem('mapping', '正股映射', '转债品种与正股映射未登记。', 'unresolved'),
    ],
    warmup: '需转股价生效日与交易日历对齐。',
    missingPolicy: '溢价率不能与权证溢价混用。',
    implementations: [impl('impl.local.formulas.qzzj', 'reference', 'JSON 公式', `${ASSET}/definitions/formulas.json: QZZJ / zgzt`,
      undefined, 'QZZJ 是权证溢价、zgzt 只是状态标记，均不能替代转债计算。')],
    configurations: [], products: [], legacyAliases: [],
    status: status('conflict', '转股价逐日调整规则与正股映射未登记。',
      'absent', '本工程无转债实现；资料包A 全包检索“转股/convertible/转债/溢价”仅剩权证条目。', 'not_run', VERIFY_NOT_RUN),
  }),

  definition({
    id: 'algo.dupont', registryId: 'dupont', title: '杜邦分析', definitionKind: 'financial',
    summary: 'ROE 分解为税负系数、利息负担、营业利润率、资产周转率与权益乘数五因子乘积。',
    formula: [line('ROE', 'ROE = 税负系数 × 利息负担系数 × 营业利润率 × 资产周转率 × 权益乘数',
      '五因子相乘恒等；因子口径不同会让同比失真。')],
    semantics: [
      sem('asset_base', '资产口径', '资料包B 脚本用期末资产，不是平均资产。', 'conflict'),
      sem('comparable', '可比性', '分红/送转影响未处理。', 'unresolved'),
    ],
    warmup: '需至少 6 期可比年度。',
    missingPolicy: '缺项时该期不得出分，也不用行业均值代替。',
    implementations: [impl('impl.local.formulas.roe', 'reference', 'JSON 公式', `${ASSET}/definitions/formulas.json: JZCSYL / ZZCZZL / GDQYZZL`,
      undefined, '只有净资产收益率单值，没有五因子分解。')],
    configurations: [], products: [], legacyAliases: [],
    status: status('conflict', '资产口径（期末 vs 平均）未统一。',
      'partial', '本工程只有 ROE 单值，无五因子分解实现。', 'not_run', VERIFY_NOT_RUN),
  }),

  definition({
    id: 'algo.earnings_quality', registryId: 'earnings_quality', title: '盈利质量比率', definitionKind: 'financial',
    summary: '应计比率、现金转化率、收入质量与非经常性损益四组判据，另有红灯清单。',
    formula: [
      line('应计比率', 'accrual = (净利润 − 经营活动现金流) / 总资产'),
      line('现金转化率', 'conversion = 经营活动现金流 / 净利润', '净利≤0 时不适用，不能按 0 处理。'),
      line('红灯清单', '20 条判据，其中 18 条须外部证据；缺失只能记 unknown。'),
    ],
    semantics: [
      sem('unknown', '未知处理', 'unknown 不等于 clear；不得把缺证据当通过。', 'fixed'),
      sem('notes', '附注字段', '客户集中度、政府补助、扣非净利缺来源。', 'unresolved'),
    ],
    warmup: '需约 20 个科目及其上期值、6 期可比年度。',
    missingPolicy: '缺项记 unknown，不按通过或 0 处理。',
    implementations: [],
    configurations: [], products: [], legacyAliases: [],
    status: status('unrecorded', '本工程未移植，判据与阈值版本未登记冻结。',
      'absent', '本工程无实现；缺三表科目与附注类字段。', 'not_run', VERIFY_NOT_RUN),
  }),

  definition({
    id: 'algo.cash_conversion_cycle', registryId: 'cash_conversion_cycle', title: '现金转换周期（CCC）', definitionKind: 'financial',
    summary: 'CCC 由存货周转天数、应收账款周转天数与应付账款周转天数合成。本工程缺应付账款周转天数。',
    formula: [line('CCC', 'CCC = DSO + DIO − DPO',
      '三个周转天数按 365 天年化；非年报须给报告期天数 periodDays。')],
    semantics: [
      sem('balance', '余额口径', '期末余额与平均余额算出的 CCC 不可比；资料包B 用期末余额。', 'conflict'),
      sem('days', '年化天数', '非年度不得套用 365，须显式给 periodDays。', 'fixed'),
    ],
    warmup: '需同期应收、存货、应付与损益科目。',
    missingPolicy: '缺任一项不得输出 CCC。',
    implementations: [impl('impl.local.formulas.turnover', 'reference', 'JSON 公式',
      `${ASSET}/definitions/formulas.json: CHZZTS / YSZKZZTS`, undefined, '只有存货与应收周转天数，缺应付周转天数。')],
    configurations: [], products: [], legacyAliases: [],
    status: status('conflict', '余额口径（期末 vs 平均）未统一。',
      'partial', '本工程有 DSO 与 DIO 公式，缺 DPO，因此算不出 CCC。', 'not_run', VERIFY_NOT_RUN),
  }),

  definition({
    id: 'algo.financial_models', registryId: 'financial_models', title: '财务模型（Altman Z / Piotroski F / Beneish M）', definitionKind: 'financial',
    summary: '三类财务健康与盈余操纵模型，各有适用前置条件与阈值区间。系数版本以资料包B 脚本为准，本工程未移植。',
    formula: [
      line('Z', 'Z = 1.2 X1 + 1.4 X2 + 3.3 X3 + 0.6 X4 + 1.0 X5',
        'X1 营运资本/总资产；X2 留存收益/总资产；X3 EBIT/总资产；X4 市值/总负债；X5 营收/总资产。仅适用制造业且口径为年度。'),
      line('F', 'F = Σ_{i=1..9} signal_i，signal ∈ {0,1}', '9 项信号求和，取值 0–9；需本期与上期各 9 项。'),
      line('M', 'M = 8 变量线性组合', '系数与阈值以资料包B 脚本为准；本工程未移植，版本未冻结。'),
    ],
    semantics: [
      sem('scope', '适用范围', 'Z 只适用于制造业且口径为年度。', 'fixed'),
      sem('threshold', '阈值', '阈值区间是经验值，不构成违约预测。', 'fixed'),
      sem('coefficients', '系数版本', 'M 的系数与阈值未在本工程登记冻结。', 'unresolved'),
    ],
    warmup: 'Z 需年度口径；F 与 M 都需连续可比上期。',
    missingPolicy: '缺科目不出分；阈值不替代违约判断。',
    implementations: [],
    configurations: [], products: [], legacyAliases: [],
    status: status('unrecorded', '本工程未移植，系数与阈值版本未登记冻结。',
      'absent', '本工程无实现；Z/F/M 各需 7～22 个科目。', 'not_run', VERIFY_NOT_RUN),
  }),

  definition({
    id: 'algo.earnings_surprise', registryId: 'earnings_surprise', title: '业绩预期差', definitionKind: 'financial',
    summary: '预期差＝(实际值 − 预期值) ÷ |预期值|，按 ±5%、±10% 分级；预期取样本中位数。',
    formula: [line('surprise', 'surprise = (actual − expected) / |expected|',
      'expected 为披露前一致预期样本中位数；实际与预期须同币种、同单位、同指标、同期间。')],
    semantics: [
      sem('expected', '预期口径', '取样本中位数；样本量须 ≥3 家机构。', 'fixed'),
      sem('timing', '时间资格', '预期发布日期须早于实际公开；距披露超过 45 天的样本须标旧。', 'fixed'),
      sem('grade', '分级', '±5%、±10% 分级；预期为 0 或跨盈亏时不分级。', 'fixed'),
    ],
    warmup: '需披露前一致预期快照与首次公开时刻。',
    missingPolicy: '缺时间资格不计算；不把过期预期当披露前预期。',
    implementations: [],
    configurations: [], products: [], legacyAliases: [],
    status: status('frozen', '公式、样本中位数与分级在登记说明中已固定。',
      'absent', '本工程无实现；C_17 是选股规则，不能替代预期差。', 'not_run', VERIFY_NOT_RUN),
  }),

  definition({
    id: 'algo.adjustment', registryId: 'adjustment', title: '复权工具', definitionKind: 'utility',
    summary: '使用与价格同证券、同日期窗口的真实复权因子计算调整后价格。因子基准与方向必须先核。',
    formula: [line('P_adj', 'P_adj,t = P_t × F_t',
      'F 为同证券同窗复权因子；方向（前复权/后复权）与基准尚未核对。')],
    semantics: [
      sem('basis', '因子基准', '首批复权因子的基准、方向、修订与可得时点均未核。', 'conflict'),
      sem('align', '对齐规则', '同证券同窗因子对齐规则未冻结。', 'unresolved'),
    ],
    warmup: '需与价格同窗的因子序列。',
    missingPolicy: '不补 1、不延展旧值，也不将调整后价格写入未复权行情目标。',
    implementations: [],
    configurations: [], products: [], legacyAliases: [],
    status: status('conflict', '因子基准、方向、修订与可得时点未核。',
      'absent', '受控实现未装配。', 'not_run', VERIFY_NOT_RUN),
  }),
]);

const byRegistryId = new Map(ALGORITHM_DEFINITIONS.map((item) => [item.registryId, item]));

export function definitionFor(registryId: string): AlgorithmDefinition | undefined {
  return byRegistryId.get(registryId);
}

function countDefinitions(): AlgorithmDefinitionSummary['counts'] {
  return {
    definitions: ALGORITHM_DEFINITIONS.length,
    operators: ALGORITHM_DEFINITIONS.filter((item) => item.definitionKind === 'operator').length,
    withProducts: ALGORITHM_DEFINITIONS.filter((item) => item.products.length > 0).length,
    definitionConflicts: ALGORITHM_DEFINITIONS.filter((item) => item.status.definition.state === 'conflict').length,
    implemented: ALGORITHM_DEFINITIONS.filter((item) => item.status.implementation.state !== 'absent').length,
    legacyAliases: ALGORITHM_DEFINITIONS.reduce((sum, item) => sum + item.legacyAliases.length, 0),
  };
}

export const ALGORITHM_DEFINITION_SUMMARY: AlgorithmDefinitionSummary = Object.freeze({
  kind: 'definition',
  version: ALGORITHM_DEFINITION_VERSION,
  note: ALGORITHM_DEFINITION_NOTE,
  counts: countDefinitions(),
});
