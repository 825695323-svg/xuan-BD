/**
 * 算法处置设计建议（design_only）：只读展示元数据，不参与任何运行判断。
 *
 * 来源：工程外规划原件《BD 算法处置与 A 股数据产品 V1.0》与
 * 《Xuan_BD 算法分类与来源矩阵 V1.0》（2026-11-06，设计与样例复核）。
 * 25 条 proposed_* 文本、六项口径裁决、四项不采用与九项阻断均逐字取自矩阵；
 * 执行顺序逐字取自规划 md「建议执行顺序与验收证据」。
 *
 * 边界（必须保持）：
 * - 不改 ALGORITHM_REGISTRY 的 state / status / reason / missing / limitations / sources。
 * - 不改 EXECUTABLE_TOOL_IDS、ASSET_FILES、PYTHON_BRIDGE、采用记录或固定方法表。
 * - 不改发布资格；规划自述「没有查询工程仓库」「施工次序均为设计建议」
 *   「每个产品只在获得自身验收回执后前进」。
 * - 矩阵中 registry 的 state/status 是来源附件的历史快照（ma、bullish_engulfing
 *   标为「可提交（仅白名单证据）」），与现行工程登记不一致，故**不导入**，
 *   避免用建议覆盖真值。
 * - sourceLine/sourceRef 只是设计原件里的定位线索，不是工程实际行号证明。
 * - rulingKeys 是本工程按算法 ID 建立的展示关联（本次接线），不是规划原件字段。
 */
import type {
  ToolLibraryDesignDisposition, ToolLibraryDesignEntry, ToolLibraryDesignRuling,
  ToolLibraryDesignSummary,
} from '../../contracts/tool-library.js';

export const ALGORITHM_DESIGN_VERSION = 'bd.algorithm-dispositions/design-v1.0';
export const ALGORITHM_DESIGN_DATE = "2026-11-06";
export const ALGORITHM_DESIGN_STATUS_NOTE = "source state/status来自汇总附件；proposed字段为本次建议。接入、金融端口、发布与真实市场表现均未在本次验收。";

const DISPOSITION_DATA: Record<string, ToolLibraryDesignEntry> = {
  "ema": {
    "kind": "design_only",
    "sourceLine": 87,
    "sourceRef": "设计原件 HTML 第 87 行；工程源码 第 36 行起",
    "proposedOwner": "BD 固定频率周期批量，H-02 任意获准周期",
    "proposedMethod": "α=2/(n+1)，Eₜ=αCₜ+(1−α)Eₜ₋₁。首值初始化与前序状态两种产品分别登记，续算键含证券、频率、复权、种子及断点。",
    "proposedAcceptance": "n=3，首价10、次价14得12；从同一已确认断点续算应与全序列一致，错频状态拒绝。",
    "relatedProducts": [
      "M02"
    ],
    "rulingKeys": []
  },
  "rsi": {
    "kind": "design_only",
    "sourceLine": 96,
    "sourceRef": "设计原件 HTML 第 96 行；工程源码 第 61 行起",
    "proposedOwner": "BD 各约定周期独立列，H-02 按需阈值",
    "proposedMethod": "ΔC 的正部和绝对值分别按已登记种子做 RMA，RSI=100×RMA(正部)/RMA(绝对值)。工程 6/12/24、Wilder 14 各有版本。30/70 属阈值配置另存。",
    "proposedAcceptance": "连续上涨且有效分母>0得100，连续平盘且分母为0返回空；相同种子与参数才做跨实现比对。",
    "relatedProducts": [
      "M02"
    ],
    "rulingKeys": [
      "RSI"
    ]
  },
  "adx": {
    "kind": "design_only",
    "sourceLine": 105,
    "sourceRef": "设计原件 HTML 第 105 行；工程源码 第 70 行起",
    "proposedOwner": "BD 固定 DMI；H-02 可选择明确平滑版本",
    "proposedMethod": "相邻 H/L/C 得上行及下行变化。只有较大且为正者计入 +DM 或 −DM，TR=max(H−L,abs(H−前收),abs(L−前收))。累积方向移动除累积 TR 得 DI，DX=100×abs(DI+−DI−)/(DI++DI−)，按登记平滑得 ADX、滞后平均得 ADXR。",
    "proposedAcceptance": "HD=LD 时两个方向移动均为0；前序三值不成组或跨复权拒绝。用独立手算轨迹检查首个非空输出及 ADXR 滞后。",
    "relatedProducts": [
      "M02"
    ],
    "rulingKeys": []
  },
  "boll": {
    "kind": "design_only",
    "sourceLine": 114,
    "sourceRef": "设计原件 HTML 第 114 行；工程源码 第 79 行起",
    "proposedOwner": "BD 每个 ddof 独立版本",
    "proposedMethod": "中轨=MAₙ，方差=Σ(x−均值)²/(n−ddof)，上下轨=中轨±kσ。要求 n>ddof，调用必须显式提供 ddof。",
    "proposedAcceptance": "[1,3] 均值2，总体标准差1，样本标准差√2；k 改变只改变轨距。",
    "relatedProducts": [
      "M02"
    ],
    "rulingKeys": [
      "BOLL"
    ]
  },
  "obv": {
    "kind": "design_only",
    "sourceLine": 123,
    "sourceRef": "设计原件 HTML 第 123 行；工程源码 第 88 行起",
    "proposedOwner": "BD 已核单位的日线，分钟依赖 F08；H-02 指定起点",
    "proposedMethod": "按 sign(Cₜ−Cₜ₋₁)×Vₜ 累加，记录量单位、初值和缩放。工程输出按量单位/10000，MAOBV 再用完整窗口。",
    "proposedAcceptance": "股为单位且起始0，涨日1万股、平盘5千股、跌日2万股，累计缩放值为1、1、−1。手/股未知时阻断。",
    "relatedProducts": [
      "M02"
    ],
    "rulingKeys": []
  },
  "kline_patterns": {
    "kind": "design_only",
    "sourceLine": 132,
    "sourceRef": "设计原件 HTML 第 132 行；工程源码 第 97 行起",
    "proposedOwner": "BD 逐形态固定布尔列；H-02 解释或试阈值",
    "proposedMethod": "给晨星、暮星、锤头、三连阳、三连阴、向上/向下跳空、长上影分别写实体、影线、幅度、缺口与窗口定义。每个形态独立采用，TA-Lib 绑定需实装并核许可。",
    "proposedAcceptance": "每项做命中、差一个最小报价单位不命中、等号与历史不足四类金样；A 股除权跳空另标经济原因；单项通过不得放行全族。",
    "relatedProducts": [
      "M02"
    ],
    "rulingKeys": []
  },
  "volume_price": {
    "kind": "design_only",
    "sourceLine": 141,
    "sourceRef": "设计原件 HTML 第 141 行；工程源码 第 106 行起",
    "proposedOwner": "BD 固定放量突破；H-02 试其他量价关系",
    "proposedMethod": "先单独登记已有 volume_breakout 的阈值与参照区间。新候选可定义 Cₜ>过去 n 根最高价且 Vₜ>k×过去 n 根均量，两窗口均截至 t−1；相关系数另立算子。",
    "proposedAcceptance": "n=3，同窗旧量100/100/100，当天201，k=2且突破应命中；量恰200按严格大于不命中。单位未知或有效配对不足返回缺失。",
    "relatedProducts": [
      "M02",
      "M04"
    ],
    "rulingKeys": []
  },
  "roc": {
    "kind": "design_only",
    "sourceLine": 149,
    "sourceRef": "设计原件 HTML 第 149 行；工程源码 第 114 行起",
    "proposedOwner": "BD 百分数与小数不同产品，H-02 转换",
    "proposedMethod": "ROC%=100(Cₜ/Cₜ₋ₙ−1)，MTM=Cₜ−Cₜ₋ₙ。ROCMA 与 MAMTM 对有效值按登记窗口做均线。显式标为百分数、小数或价格差。",
    "proposedAcceptance": "10→11 得 10%、0.1、价格差1。缺 t−n 参考价或分母零输出空，单位不匹配禁止比较。",
    "relatedProducts": [
      "M01",
      "M02"
    ],
    "rulingKeys": [
      "ROC"
    ]
  },
  "rolling_mean": {
    "kind": "design_only",
    "sourceLine": 158,
    "sourceRef": "设计原件 HTML 第 158 行；工程源码 第 123 行起",
    "proposedOwner": "BD 固定字段/频率，H-02 参数窗",
    "proposedMethod": "对带单位的目标列使用严格完整 n 根窗口。区分 observation 序号窗口和交易日窗口，分别处理缺记录及空值。",
    "proposedAcceptance": "[2,null,4] 三期结果为空；价格列均值不得用于成交额结果键。不得用收盘价 MA 的白名单授权任意字段。",
    "relatedProducts": [
      "M02",
      "I04"
    ],
    "rulingKeys": []
  },
  "ichimoku": {
    "kind": "design_only",
    "sourceLine": 168,
    "sourceRef": "设计原件 HTML 第 168 行；工程源码 第 132 行起",
    "proposedOwner": "BD 保存截至当时可算的线值；H-02/H-03 投影视图",
    "proposedMethod": "9期及26期最高最低中点得转折/基准；二者均值得先行A，52期最高最低中点得先行B。每条保留计算时点与图上位置，迟行显示也遵守生成时刻。",
    "proposedAcceptance": "按原卡至少78根验证完整图；追加未来26根不会改变 t 当时可读记录，绘在 t−26 的迟行收盘不能被 t−26 的研究读取。",
    "relatedProducts": [
      "M02"
    ],
    "rulingKeys": []
  },
  "historical_percentile": {
    "kind": "design_only",
    "sourceLine": 178,
    "sourceRef": "设计原件 HTML 第 178 行；工程源码 第 142 行起",
    "proposedOwner": "BD 按指标固定窗口物化，H-02 自选",
    "proposedMethod": "提议排名版本为过去 n 个合资格值的 (#低于当前+0.5×#等于当前)/有效数；当前点不入历史窗。是否仅正数按指标指定，记录有效数、最低门槛。分位取值、截面排名另设算子。",
    "proposedAcceptance": "历史[1,2,2,3]，当前2应为0.5。PE 负值过滤按版本，样本不足显式为空。",
    "relatedProducts": [
      "M03",
      "V02",
      "I04"
    ],
    "rulingKeys": []
  },
  "volatility": {
    "kind": "design_only",
    "sourceLine": 186,
    "sourceRef": "设计原件 HTML 第 186 行；工程源码 第 150 行起",
    "proposedOwner": "BD 固定复权收益与窗口；H-02 可改定义",
    "proposedMethod": "以固定类型收益 r 的样本标准差×√K 得年化波动，输出期波动与年化值、ddof 和每年观测数 K。下行偏差另定目标收益与分母；长短比同基准。",
    "proposedAcceptance": "[−0.01,0.01]，ddof=1，期标准差约0.014142；K=252 的测试约0.22450。K 是该样例配置，跨市场、分钟不可套用。",
    "relatedProducts": [
      "M04",
      "R01"
    ],
    "rulingKeys": [
      "年化"
    ]
  },
  "drawdown": {
    "kind": "design_only",
    "sourceLine": 194,
    "sourceRef": "设计原件 HTML 第 194 行；工程源码 第 158 行起",
    "proposedOwner": "BD 固定基准历史统计，策略回撤由 BD 评测",
    "proposedMethod": "Dₜ=1−NAVₜ/历史至 t 最高 NAV，输出正幅度、峰谷和首次回峰时点。分别标明价格、总回报或净值类型及前区间峰值继承。",
    "proposedAcceptance": "[100,120,90,120] 最大回撤25%，末点修复；截在90时不得提前写修复时间。",
    "relatedProducts": [
      "M04",
      "R01"
    ],
    "rulingKeys": []
  },
  "returns": {
    "kind": "design_only",
    "sourceLine": 202,
    "sourceRef": "设计原件 HTML 第 202 行；工程源码 第 166 行起",
    "proposedOwner": "BD 点时证券收益，组合与现金流由 H-02/BD 评测",
    "proposedMethod": "简单收益=Pₜ/Pₜ₋₁−1，对数收益=ln(Pₜ/Pₜ₋₁)，累计=∏(1+r)−1。交易期 K/n 次幂与自然日 365.25/elapsedDays 两类年化分开；含外部现金流另分 TWR/MWR。",
    "proposedAcceptance": "100→110→99，累计−1%，不是0%。转入现金不算组合收益；现金分红在总回报中只计一次。",
    "relatedProducts": [
      "M01",
      "R01"
    ],
    "rulingKeys": [
      "年化"
    ]
  },
  "dividend_yield": {
    "kind": "design_only",
    "sourceLine": 211,
    "sourceRef": "设计原件 HTML 第 211 行；工程源码 第 174 行起",
    "proposedOwner": "BD 公司行动台账及 TTM/财年产品",
    "proposedMethod": "按可得日筛已实施且按定义除息的逐笔事件，对齐税基、币种、每股口径、送转基准；TTM现金每股股息合计/同日未复权价。独立控制总额来自独立披露或核准来源。",
    "proposedAcceptance": "最新未实施预案不加分子。TTM两笔0.2、0.3元，现价10元得5%；缺独立核对值时保留候选。",
    "relatedProducts": [
      "V03"
    ],
    "rulingKeys": []
  },
  "convertible_bond": {
    "kind": "design_only",
    "sourceLine": 219,
    "sourceRef": "设计原件 HTML 第 219 行；工程源码 第 182 行起",
    "proposedOwner": "BD 逐日有效条款/收盘派生，H-02 盘中情景",
    "proposedMethod": "按债券-正股映射及转股价生效区间连接同一时点行情。转股比=面值/有效转股价，转股价值=比率×正股价，溢价率=转债价/转股价值−1。统一每张价格与面值。",
    "proposedAcceptance": "面值100、转股价10、正股9、转债99得90元、10%。改转股价只从生效且可得时点生效；停牌旧价显式标记。",
    "relatedProducts": [
      "V03"
    ],
    "rulingKeys": []
  },
  "dupont": {
    "kind": "design_only",
    "sourceLine": 227,
    "sourceRef": "设计原件 HTML 第 227 行；工程源码 第 190 行起",
    "proposedOwner": "BD 历史五因子，H-02 调整和归因",
    "proposedMethod": "净利/税前利润 × 税前利润/EBIT × EBIT/营收 × 营收/资产 × 资产/权益。余额选期末或首末平均并分产品，归属、合并范围及同一利润链一致。",
    "proposedAcceptance": "核对乘积=同一净利/同口径权益；报告要求的六期可比年度历史单验。零中间分母不得用乘积恒等式反向虚填。",
    "relatedProducts": [
      "F04"
    ],
    "rulingKeys": [
      "期末/平均余额"
    ]
  },
  "earnings_quality": {
    "kind": "design_only",
    "sourceLine": 235,
    "sourceRef": "设计原件 HTML 第 235 行；工程源码 第 198 行起",
    "proposedOwner": "BD 四组比率和证据标注，H-02 专家解释",
    "proposedMethod": "分别建立应计(如净利−CFO相对平均资产)、现金转化 CFO/净利、应收存货与收入成本增长、扣非及补贴收入。约20科目、上期及附注逐项映射；红灯逐条保存证据和 unknown。",
    "proposedAcceptance": "净利≤0时现金转化不可适用；20条红灯中原件标出18条依赖外证，无附注不得记 clear。核对每个期间与引用页。",
    "relatedProducts": [
      "F06"
    ],
    "rulingKeys": []
  },
  "cash_conversion_cycle": {
    "kind": "design_only",
    "sourceLine": 243,
    "sourceRef": "设计原件 HTML 第 243 行；工程源码 第 206 行起",
    "proposedOwner": "BD 历史现金转换周期",
    "proposedMethod": "DSO=期间天数×应收/收入，DIO=天数×存货/营业成本，DPO=天数×应付/营业成本（成本为采购代理时标记）。CCC=DSO+DIO−DPO。统一平均或期末余额并单独定版。",
    "proposedAcceptance": "90天，平均应收20、收入100、存货30、成本60、应付10，得18+45−15=48天；缺应付只保留可算分项。",
    "relatedProducts": [
      "F05"
    ],
    "rulingKeys": [
      "期末/平均余额"
    ]
  },
  "financial_models": {
    "kind": "design_only",
    "sourceLine": 251,
    "sourceRef": "设计原件 HTML 第 251 行；工程源码 第 214 行起",
    "proposedOwner": "BD 固定历史模型特征/评分有独立模型标识，H-02 解释",
    "proposedMethod": "Altman 经典上市制造业年度 Z=1.2营运资本/资产+1.4留存收益/资产+3.3EBIT/资产+0.6权益市值/总负债+营收/资产。F 分拆9项同比布尔，M 先存八构成指标，再按冻结版本应用系数。",
    "proposedAcceptance": "Z 不适用行业返回 N/A；F 有一项未知时不报完整0–9分；M 的前一年同口径缺失则不报总分。每个构成指标逐项独立对照，模型阈值只作标签。",
    "relatedProducts": [
      "F06"
    ],
    "rulingKeys": []
  },
  "earnings_surprise": {
    "kind": "design_only",
    "sourceLine": 259,
    "sourceRef": "设计原件 HTML 第 259 行；工程源码 第 222 行起",
    "proposedOwner": "BD 发布前快照、发布后惊喜和独立到期反应；H-02 解释",
    "proposedMethod": "同指标、币种、报告期取披露前已可得的每机构最新有效预测，中位数且至少3机构。差额=实际−预期，比例=差额/abs(预期)。预期过45天标旧，0或跨盈亏不分级；±5/±10%等号须定版。",
    "proposedAcceptance": "三家90/100/110、首次实绩112，差额12、比例12%。盘后发布用下一可反应交易时段；未来三日行情仅到期后另产出。缺反应仍可独立交付基础惊喜，整套专家报告保留缺项。",
    "relatedProducts": [
      "E01",
      "E02",
      "E04"
    ],
    "rulingKeys": []
  },
  "adjustment": {
    "kind": "design_only",
    "sourceLine": 267,
    "sourceRef": "设计原件 HTML 第 267 行；工程源码 第 230 行起",
    "proposedOwner": "BD 基础行情派生及公司行动校验",
    "proposedMethod": "固定因子含义后再用公式。例如定义统一为未复权价×F可跨期比，则基于 B 的调整价=Pₜ×Fₜ/Fᴮ，B 对当前时间线可见且绑定版本。原价独立保留，缺因子不补1、不跨日延展旧值。",
    "proposedAcceptance": "一股拆两股样例：拆前100/因子1、拆后50/因子2，后日为基准均为50。回到拆前时点不能看到拆后因子，真实分红/送转另作对账。",
    "relatedProducts": [
      "M01"
    ],
    "rulingKeys": []
  },
  "macd": {
    "kind": "design_only",
    "sourceLine": 276,
    "sourceRef": "设计原件 HTML 第 276 行；工程源码 第 45 行起",
    "proposedOwner": "BD 固定工程版；H-02 查数或单独实验其他版本",
    "proposedMethod": "以所供连续窗口首个收盘为 EMA 种子，固定 12/26/9，DIFF=EMA12−EMA26、DEA=EMA9(DIFF)。工程柱为 2×(DIFF−DEA)，1 倍柱另设定义且独立声明初始化，保存窗口起点。",
    "proposedAcceptance": "预设 DIFF=3、DEA=1 时两倍柱为4，一倍为2。同样末端窗口但不同起点不得共用缓存；检查该版本拒绝续算状态。",
    "relatedProducts": [
      "M02"
    ],
    "rulingKeys": [
      "MACD 柱"
    ]
  },
  "ma": {
    "kind": "design_only",
    "sourceLine": 84,
    "sourceRef": "设计原件 HTML 第 84 行",
    "proposedOwner": "BD 固定日线观测均值，H-02 任意获准窗口",
    "proposedMethod": "只读同频已闭合收盘价，MAₙ 为连续 n 条的算术均值，记录所用时段和窗口。与固定表 observation_ma20 分别登记运行身份。",
    "proposedAcceptance": "[1,2,3] 的三期平均为 2，前两条为空。引入缺值或不同复权基准后不得静默缩窗。",
    "relatedProducts": [
      "M02"
    ],
    "rulingKeys": []
  },
  "bullish_engulfing": {
    "kind": "design_only",
    "sourceLine": 84,
    "sourceRef": "设计原件 HTML 第 84 行",
    "proposedOwner": "BD 收盘后严格形态布尔值，H-02 解释",
    "proposedMethod": "相邻两根有效 K 线计算前阴后阳及后实体严格包住前实体。建议将相等边界、相邻交易会话、复权和停牌断档写入采用记录，与现行实现逐项比对。",
    "proposedAcceptance": "前开10收9、后开8.9收10.1命中；把后收改为10，严格版本不命中。跨证券拼接必须拒绝。",
    "relatedProducts": [
      "M02"
    ],
    "rulingKeys": []
  }
};

export const ALGORITHM_DISPOSITIONS: Readonly<Record<string, ToolLibraryDesignEntry>> =
  Object.freeze(DISPOSITION_DATA);

export function designFor(id: string): ToolLibraryDesignEntry | null {
  return ALGORITHM_DISPOSITIONS[id] ?? null;
}

const RULINGS_DATA: readonly ToolLibraryDesignRuling[] = [
  {
    "conflict": "MACD 柱",
    "proposal": "工程固定 hist_scale=2；一倍柱另登记 hist_scale=1",
    "validation": "只有 DIFF、DEA、种子、预热、窗口完全一致时才可按两倍互换"
  },
  {
    "conflict": "ROC",
    "proposal": "原工程 percent，外部 return_n 为 ratio",
    "validation": "持有期、参考价与复权一致后乘100；MTM 仍保留价格单位"
  },
  {
    "conflict": "BOLL",
    "proposal": "ddof=0 与 ddof=1 分配不同定义标识",
    "validation": "必须传值，独立手算总体及样本标准差"
  },
  {
    "conflict": "RSI",
    "proposal": "6/12/24 各期与 Wilder 14 分别记录平滑、种子、阈值",
    "validation": "禁止将14期阈值直接套三组历史结果，平盘分母为零测试"
  },
  {
    "conflict": "年化",
    "proposal": "波动注明 K、频率与 ddof；收益注明自然日或交易期复利、资金加权规则",
    "validation": "年化收益与年化波动分别验证，不能用同一转换系数"
  },
  {
    "conflict": "期末/平均余额",
    "proposal": "杜邦、CCC 同时保留来源口径与经批准的平均口径",
    "validation": "在期初=期末与余额突变两组分别对照，缺期初不得临时改用期末"
  }
];
const EXCLUDED_DATA: readonly ToolLibraryDesignDisposition[] = [
  {
    "item": "WINNER 获利盘比例",
    "finding": "用全段最高最低建价格格，历史结果随未来改变；依赖、许可与登记有缺口",
    "followUp": "在研究分支以固定最小价位和当时已知范围建稀疏分布，保留换手率口径、当日成交分配和初值。验证追加未来极值后历史分布逐点不变、概率质量归一、拆股调整守恒。无实际持仓成本时输出估计量"
  },
  {
    "item": "COST 成本分位",
    "finding": "外部实现与标准逆分布分位不同",
    "followUp": "新定义 Q(p)=min{x:F(x)≥p}，单独检验 p 取等号、端点、空支持集；例如价格10/11的质量0.6/0.4，Q(0.6)=10、Q(0.61)=11。旧脚本只保留为研究对照"
  },
  {
    "item": "CM 成本分布",
    "finding": "只有语义候选",
    "followUp": "先定义分布支持集、成交量与换手输入、除权迁移和每日归一规则。若指定“等概率退出旧筹码”的模型，可试 Dₜ=(1−u)Dₜ₋₁+uVₜ，其中 Vₜ 为归一的新成交分布；换手超过1需另建机制，缺逐笔时不得默认均匀成交。未获确认前在 H-02 沙箱"
  },
  {
    "item": "SAR_S",
    "finding": "缺专门定义与初值",
    "followUp": "先确认它与一般 SAR 的异同，冻结首日方向、初始极点、加速、反转及极点夹限规则。若无原语义先保留缺口；批准后用上涨、下跌、跳空反转和前缀扩展四组轨迹逐点验收"
  }
];
const BLOCKERS_DATA: readonly ToolLibraryDesignDisposition[] = [
  {
    "item": "§1.3 Alpha101/191 索引、158/360 字段",
    "finding": "292+518 条索引标注 numerical_tested:false",
    "followUp": "索引作为候选字典。每个公式登记维度、窗口、排名轴、并列、缺值、市场样本和可得时点。选少量优先因子，对独立手算小面板与固定外部版本双校验；逐项回执"
  },
  {
    "item": "§1.3 61 个 CDL* 与 ADX",
    "finding": "包中只有 import talib 绑定",
    "followUp": "核对外部引擎许可、确切版本、对应源码与部署环境，再按形态独立对照。不能根据绑定名计入通过数"
  },
  {
    "item": "§1.3 ta_cn Alpha101/191 移植",
    "finding": "101 的通过清单为空，191 列 165/183，WMA/SMA 别名及 36/146 TODO",
    "followUp": "对每个目标解析原始公式；选非等差序列区分两种均线，逐项做数值对照。通过清单也只代表该来源的测试；未验证项保留 blocked"
  },
  {
    "item": "§1.3 DolphinDB 两份脚本",
    "finding": "脚本依赖专用引擎；源码与引擎各自许可",
    "followUp": "保留独立环境作为对照，获取引擎权利及版本验证；也可按公开公式自主实现，再做同输入结果匹配"
  },
  {
    "item": "§1.3 COST 静态审阅与目标数量",
    "finding": "外部 COST 仅静态审阅；原文称18项中11/4/3，但“完全缺失”文字实际列出一目、回撤、股息率、转股价值与溢价率四组表述",
    "followUp": "将来源数字与文字冲突标为待原作者澄清，按逐项证据处理。资料包 A 是否缺失与本工程是否有实现分别记录"
  },
  {
    "item": "§3.1 原 MA、12/26/9 MACD、严格看涨吞没的旧身份",
    "finding": "旧运行登记、资产、测试与快照已注销；现登记白名单另有三项",
    "followUp": "建新映射记录当前工具、方法版本、代码制品和目标；验收拒绝旧 adoption 与旧快照授权。老 MACD 八行通过记录不能证明长历史连续性"
  },
  {
    "item": "§3.2 P6 金融算法端口",
    "finding": "通用 fixed_read 已通过；金融入口因固定合同缺结构化语义未通过",
    "followUp": "在调用和读回两端校验 frequency、adjustment（含基准）、bar_closed、单位、证券、起止与可得版本，传入真实市场数据核对；再逐字段删除/篡改必须阻断。附新 P6 证据后才更新状态"
  },
  {
    "item": "§3.3 observation_ma20、financial_linear、macro_yoy",
    "finding": "固定方法表有3项，registeredCalculationMethods:0，结果 candidate_only",
    "followUp": "分别验证日线20期完整窗、单季/TTM由累计流量换算、宏观同季或同月同比的版本可见性，再走采用、发布与读回。缺源值或发生修订时旧快照仍可重演"
  },
  {
    "item": "§4 勘误与撤销",
    "finding": "14555.62 为正确文字差额，原结构化 JSON 正确；摘要比较误用序列化；“174条未实现规则”撤销",
    "followUp": "从缺陷队列剔除三项；核对原始结构化差额，摘要用 WFD canonical 及同输入重算，规则总数只有逐条证据才能重新统计"
  }
];
const ORDER_DATA: readonly string[] = [
  "先修 P6 合同并登记六项公式差异。对每个目标固定产品、公式和输入版本、时区、频率、价格调整、单位、预热和空值原因。给不满足字段的真实调用留拒绝回执。",
  "对白名单三项做真实同窗重算；随后按输入已齐程度逐个处理9个已有资产。受控 Python 进程固定制品哈希与依赖，对齐放行清单和采用记录，一次只增加已通过真值检验的操作。不同算子产品共享同一版本实现。",
  "对5项工程缺实现的算法，先定独立金样再移植；对8项缺数据的算法先核真实输入。单元用例覆盖等号、空、除零、错单位、错时点、版本切换；数学金样或参考代码复现都无法替代真实源联调。",
  "BD 批算与 H-02 在同一 Snapshot、输入、参数和实现下应一致。总量守恒、单位、布尔和时点逐项精确；浮点提前定义绝对/相对容差并记录最大误差。依赖未来的数据在对应 historical_as_of 下不可读；后续写入和修订不得污染已封存结果。最后由 WFD 发布新 Manifest，并以产品读取接口核对。"
];

export const ALGORITHM_DESIGN_SUMMARY: ToolLibraryDesignSummary = Object.freeze({
  kind: 'design_only',
  version: ALGORITHM_DESIGN_VERSION,
  designDate: ALGORITHM_DESIGN_DATE,
  statusNote: ALGORITHM_DESIGN_STATUS_NOTE,
  rulings: Object.freeze(RULINGS_DATA),
  excludedExternal: Object.freeze(EXCLUDED_DATA),
  externalBlockers: Object.freeze(BLOCKERS_DATA),
  implementationOrder: Object.freeze(ORDER_DATA),
});
